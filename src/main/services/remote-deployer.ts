import { randomBytes } from 'crypto'
import { hostname } from 'os'
import type { DiffResult, LogLevel, Target } from '@shared/types'
import { pjoin, posixDirname, resolveRemote, shq } from '../utils/shell'
import { formatBytes, toError } from '../utils/time'
import type { SshClient } from './ssh-client'

export type RemoteLog = (level: LogLevel, msg: string) => void

export interface RemotePaths {
  root: string
  releases: string
  uploads: string
  current: string
}

export function remotePaths(target: Target): RemotePaths {
  return {
    root: pjoin(target.rootDir || '/'),
    releases: resolveRemote(target.rootDir, target.releasesDir || 'releases'),
    uploads: resolveRemote(target.rootDir, target.uploadDir || 'uploads'),
    current: resolveRemote(target.rootDir, target.currentLink || 'current')
  }
}

function normalizeProtectPath(raw: string): string {
  return (raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

const LOCK_NAME = '.deploye.lock'
const LOCK_STALE_SEC = 10 * 60
const LOCK_HEARTBEAT_MS = 45 * 1000

export interface DeployLockOwner {
  operator?: string
  host?: string
  project?: string
  release?: string
  startedAt?: string
  token?: string
}

export interface DeployLockHandle {
  path: string
  release: () => Promise<void>
}

export interface LockMeta {
  operator: string
  projectName: string
  releaseName?: string
}

export function deployLockPath(target: Target): string {
  return pjoin(target.rootDir || '/', LOCK_NAME)
}

/**
 * mkdir 锁目录失败且确认没有锁时，逐项定位真实原因。
 * 原始实现把所有失败都归为“根目录不可写”，最常见的情况其实是根目录不存在。
 */
async function diagnoseLockFailure(
  ssh: SshClient,
  target: Target,
  timeoutMs: number
): Promise<string> {
  const root = target.rootDir || '/'
  const lockPath = deployLockPath(target)
  const exitOk = async (command: string): Promise<boolean> =>
    (await ssh.exec(command, { timeoutMs })).code === 0

  if (!(await exitOk(`test -d ${shq(root)}`))) {
    return `无法获取部署锁：根目录不存在 ${root}。请先在服务器创建该目录（如 mkdir -p），或修正环境设置中的根目录。`
  }

  if (await exitOk(`test -e ${shq(lockPath)}`)) {
    if (!(await exitOk(`test -d ${shq(lockPath)}`))) {
      return `无法获取部署锁：${lockPath} 已存在且不是目录，请在服务器执行 rm -f ${lockPath} 后重试。`
    }
  }

  if (!(await exitOk(`test -w ${shq(root)}`))) {
    const user = await ssh.exec('id -un 2>/dev/null || whoami', { timeoutMs })
    const perm = await ssh.exec(
      `stat -c '%U:%G %a' ${shq(root)} 2>/dev/null || ls -ld ${shq(root)} 2>/dev/null || true`,
      { timeoutMs }
    )
    return `无法获取部署锁：当前用户 ${user.stdout.trim() || '未知'} 对根目录 ${root} 没有写权限（${
      perm.stdout.trim() || '权限未知'
    }）。请调整目录属主/权限（chown、chmod），或改用有写权限的登录用户。`
  }

  const retry = await ssh.exec(`mkdir ${shq(lockPath)}`, { timeoutMs })
  if (retry.code === 0) {
    return '无法获取部署锁：锁目录刚被其他流程创建，请稍后重试。'
  }
  const detail = retry.stderr.trim()
  return `无法获取部署锁：在 ${root} 下创建 ${lockPath} 失败${
    detail ? `（${detail}）` : `（exit ${retry.code}）`
  }。请检查磁盘空间、只读挂载或 SELinux 策略。`
}

export interface LockInspectResult {
  locked: boolean
  stale: boolean
  owner?: DeployLockOwner
  ageSec?: number
}

/** 检查目标根目录上的部署锁（不创建、不修改） */
export async function inspectDeployLock(
  ssh: SshClient,
  target: Target,
  timeoutMs: number
): Promise<LockInspectResult> {
  const lockPath = deployLockPath(target)
  const dirCheck = await ssh.exec(`test -d ${shq(lockPath)}`, { timeoutMs })
  if (dirCheck.code !== 0) return { locked: false, stale: false }

  const ownerFile = pjoin(lockPath, 'owner')
  const cat = await ssh.exec(`cat ${shq(ownerFile)} 2>/dev/null || true`, { timeoutMs })
  let owner: DeployLockOwner | undefined
  try {
    owner = JSON.parse(cat.stdout) as DeployLockOwner
  } catch {
    owner = undefined
  }

  const stat = await ssh.exec(
    `stat -c %Y ${shq(ownerFile)} 2>/dev/null || stat -f %m ${shq(ownerFile)} 2>/dev/null || stat -c %Y ${shq(lockPath)} 2>/dev/null || echo 0`,
    { timeoutMs }
  )
  const mtime = Number(stat.stdout.trim()) || 0
  const ageSec = mtime > 0 ? Math.max(0, Math.round(Date.now() / 1000 - mtime)) : LOCK_STALE_SEC + 1
  return { locked: true, stale: ageSec > LOCK_STALE_SEC, owner, ageSec }
}

function describeLockOwner(info: LockInspectResult): string {
  const owner = info.owner
  if (owner) {
    return `使用者 ${owner.operator || '未知'}（${owner.host || '未知主机'}），项目 ${
      owner.project || '-'
    }，版本 ${owner.release || '-'}，开始于 ${owner.startedAt || '-'}`
  }
  return `开始于约 ${Math.round((info.ageSec || 0) / 60)} 分钟前（无法读取锁定信息）`
}

/**
 * 获取远端部署锁。同一根目录同一时刻只允许一个发布流程。
 * 使用 mkdir 的原子性；持有期间每 45 秒 touch 心跳；
 * 超过 10 分钟且无心跳视为过期锁，自动清理后重试一次。
 */
export async function acquireDeployLock(
  ssh: SshClient,
  target: Target,
  meta: LockMeta,
  timeoutMs: number,
  log: RemoteLog
): Promise<DeployLockHandle> {
  const lockPath = deployLockPath(target)
  const ownerFile = pjoin(lockPath, 'owner')
  const tokenFile = pjoin(lockPath, 'token')
  const token = randomBytes(8).toString('hex')

  const tryCreate = async (): Promise<boolean> => {
    const result = await ssh.exec(`mkdir ${shq(lockPath)}`, { timeoutMs })
    return result.code === 0
  }

  let acquired = await tryCreate()
  if (!acquired) {
    const info = await inspectDeployLock(ssh, target, timeoutMs)
    if (!info.locked) {
      throw new Error(await diagnoseLockFailure(ssh, target, timeoutMs))
    }
    if (info.stale) {
      log(
        'WARN',
        `发现过期部署锁（约 ${Math.round((info.ageSec || 0) / 60)} 分钟前，可能上次发布异常中断），自动清理`
      )
      await ssh.exec(`rm -rf ${shq(lockPath)}`, { timeoutMs })
      acquired = await tryCreate()
      if (!acquired) {
        throw new Error('清理过期部署锁失败，请手动检查服务器上的 .deploye.lock')
      }
    } else {
      throw new Error(
        `目标目录正在被其他发布占用：${describeLockOwner(info)}。本次发布已停止，请等待对方完成后再试。` +
          `如确认对方已异常退出，可在服务器执行：rm -rf ${lockPath}`
      )
    }
  }

  const owner: DeployLockOwner = {
    operator: meta.operator,
    host: hostname(),
    project: meta.projectName,
    release: meta.releaseName,
    startedAt: new Date().toISOString(),
    token
  }
  try {
    await ssh.writeFile(ownerFile, JSON.stringify(owner, null, 2))
    await ssh.writeFile(tokenFile, token)
  } catch (err) {
    log('WARN', `写入部署锁信息失败：${toError(err).message}`)
  }
  log('OK', `已获取部署锁：${lockPath}`)

  const heartbeat = setInterval(() => {
    void ssh.exec(`touch ${shq(ownerFile)}`, { timeoutMs: 10000 }).catch(() => undefined)
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref?.()

  let released = false
  return {
    path: lockPath,
    release: async () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      try {
        await ssh.exec(
          `if [ "$(cat ${shq(tokenFile)} 2>/dev/null)" = ${shq(token)} ]; then rm -rf ${shq(lockPath)}; fi`,
          { timeoutMs }
        )
        log('INFO', '已释放部署锁')
      } catch (err) {
        log('WARN', `释放部署锁失败：${toError(err).message}`)
      }
    }
  }
}

async function execChecked(
  ssh: SshClient,
  command: string,
  timeoutMs: number,
  log: RemoteLog,
  label = '命令执行'
): Promise<string> {
  log('CMD', command)
  const result = await ssh.exec(command, { timeoutMs })
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim()) log('INFO', line)
  }
  for (const line of result.stderr.split(/\r?\n/)) {
    if (line.trim()) log('WARN', line)
  }
  if (result.code !== 0) {
    throw new Error(`${label}失败（exit ${result.code}）${result.stderr.trim() ? `：${result.stderr.trim()}` : ''}`)
  }
  return result.stdout
}

export interface RemoteRelease {
  name: string
  mtimeMs: number
}

export async function listReleaseDirs(
  ssh: SshClient,
  releasesDir: string,
  timeoutMs: number
): Promise<RemoteRelease[]> {
  const cmd = `find ${shq(releasesDir)} -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\\n' 2>/dev/null | sort -rn`
  const result = await ssh.exec(cmd, { timeoutMs })
  const releases: RemoteRelease[] = []
  if (result.code === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const spaceIndex = trimmed.indexOf(' ')
      if (spaceIndex <= 0) continue
      const mtime = Number(trimmed.slice(0, spaceIndex))
      const name = trimmed.slice(spaceIndex + 1).trim()
      if (!name || !Number.isFinite(mtime)) continue
      releases.push({ name, mtimeMs: mtime * 1000 })
    }
  }
  if (releases.length === 0) {
    // 兼容不支持 -printf 的远端
    const fallback = await ssh.exec(`ls -1t ${shq(releasesDir)} 2>/dev/null`, { timeoutMs })
    for (const line of fallback.stdout.split(/\r?\n/)) {
      const name = line.trim()
      if (name) releases.push({ name, mtimeMs: 0 })
    }
  }
  return releases
}

export async function getCurrentRelease(
  ssh: SshClient,
  target: Target,
  timeoutMs: number
): Promise<string> {
  const paths = remotePaths(target)
  const result = await ssh.exec(`readlink -f ${shq(paths.current)} 2>/dev/null || true`, { timeoutMs })
  return result.stdout.trim()
}

export async function preflightRemote(
  ssh: SshClient,
  target: Target,
  log: RemoteLog,
  timeoutMs: number,
  artifactBytes = 0
): Promise<string[]> {
  const paths = remotePaths(target)
  const errors: string[] = []

  log('INFO', `检查根目录：${paths.root}`)
  const rootExists = await ssh.exec(`test -d ${shq(paths.root)}`, { timeoutMs })
  if (rootExists.code !== 0) {
    log('ERROR', `根目录不存在：${paths.root}`)
    errors.push(`根目录不存在：${paths.root}`)
  } else {
    const writable = await ssh.exec(`test -w ${shq(paths.root)}`, { timeoutMs })
    if (writable.code !== 0) {
      log('ERROR', `根目录不可写：${paths.root}（请检查目录属主与权限）`)
      errors.push(`根目录不可写：${paths.root}`)
    } else {
      log('OK', '根目录可写')
    }
  }

  const lockInfo = await inspectDeployLock(ssh, target, timeoutMs)
  if (lockInfo.locked) {
    if (lockInfo.stale) {
      log(
        'WARN',
        `存在过期部署锁（约 ${Math.round((lockInfo.ageSec || 0) / 60)} 分钟前，可能上次发布异常中断），发布时会自动清理`
      )
    } else {
      log('WARN', `目标目录正被发布占用：${describeLockOwner(lockInfo)}`)
      errors.push('目标目录正被其他发布占用，请等待对方完成')
    }
  } else {
    log('OK', '目标目录未被其他发布占用')
  }

  const releasesCheck = await ssh.exec(`test -d ${shq(paths.releases)}`, { timeoutMs })
  if (releasesCheck.code === 0) {
    const releases = await listReleaseDirs(ssh, paths.releases, timeoutMs)
    log('INFO', `releases 目录已有 ${releases.length} 个版本`)
  } else {
    log('INFO', 'releases 目录尚未创建，发布时会自动创建')
  }

  const current = await getCurrentRelease(ssh, target, timeoutMs)
  log('INFO', current ? `当前版本：${current}` : '当前无生效版本')

  try {
    const df = await ssh.exec(`df -Pk ${shq(paths.root)} | tail -1 | awk '{print $4}'`, { timeoutMs })
    const availableKb = Number(df.stdout.trim())
    if (Number.isFinite(availableKb) && availableKb > 0) {
      log('INFO', `磁盘可用空间：${formatBytes(availableKb * 1024)}`)
      if (artifactBytes > 0 && availableKb * 1024 < artifactBytes * 2) {
        log('WARN', '磁盘可用空间可能不足（低于产物大小的 2 倍）')
        errors.push('磁盘可用空间不足')
      }
    }
  } catch (err) {
    log('WARN', `读取磁盘空间失败：${toError(err).message}`)
  }

  return errors
}

export interface DeployRemoteOptions {
  ssh: SshClient
  target: Target
  releaseName: string
  timeoutMs: number
  log: RemoteLog
  operator: string
  projectName: string
  diff?: DiffResult | null
  archiveRemotePath?: string
  skipExtract?: boolean
  onSwitched?: () => void
}

export async function deployRemote(options: DeployRemoteOptions): Promise<string> {
  const { ssh, target, releaseName, timeoutMs, log } = options
  const paths = remotePaths(target)
  const releaseDir = pjoin(paths.releases, releaseName)

  // 记录开始时 current 指向，切换前再校验，防止发布期间被其他操作改动
  const currentBefore = await getCurrentRelease(ssh, target, timeoutMs)

  await execChecked(
    ssh,
    `mkdir -p ${shq(paths.releases)} ${shq(paths.uploads)}`,
    timeoutMs,
    log,
    '创建远端目录'
  )

  if (!options.skipExtract) {
    if (!options.archiveRemotePath) throw new Error('缺少待解压的压缩包')
    await execChecked(ssh, `mkdir -p ${shq(releaseDir)}`, timeoutMs, log, '创建版本目录')
    log('INFO', `解压到 ${releaseDir}`)
    await execChecked(
      ssh,
      `tar -xzf ${shq(options.archiveRemotePath)} -C ${shq(releaseDir)}`,
      timeoutMs,
      log,
      '解压产物'
    )
    log('OK', '解压完成')
    // 解压成功后立即删除上传包，不在服务器上保留
    try {
      const removed = await ssh.exec(`rm -f ${shq(options.archiveRemotePath)}`, { timeoutMs })
      if (removed.code === 0) log('INFO', '上传包已删除（解压完成）')
      else log('WARN', '删除上传包失败')
    } catch (err) {
      log('WARN', `删除上传包失败：${toError(err).message}`)
    }
  } else {
    await execChecked(ssh, `mkdir -p ${shq(releaseDir)}`, timeoutMs, log, '创建版本目录')
  }

  // 保护路径
  for (const item of target.protectPaths || []) {
    const rel = normalizeProtectPath(item.path)
    if (!rel) continue
    if (item.mode === 'skip') {
      log('INFO', `保护路径 ${rel} 已跳过`)
      continue
    }
    if (item.mode !== 'symlink') continue
    const source = pjoin(paths.root, rel)
    const dest = pjoin(releaseDir, rel)
    const exists = await ssh.exec(`test -e ${shq(source)}`, { timeoutMs })
    if (exists.code !== 0) {
      log('WARN', `共享源 ${source} 不存在，已跳过软链`)
      continue
    }
    try {
      await execChecked(
        ssh,
        `rm -rf ${shq(dest)} && mkdir -p ${shq(posixDirname(dest))} && ln -sfn ${shq(source)} ${shq(dest)}`,
        timeoutMs,
        log,
        `共享路径 ${rel}`
      )
      log('OK', `共享路径 ${rel} → ${source}`)
    } catch (err) {
      log('WARN', `保护路径 ${rel} 处理失败：${toError(err).message}`)
    }
  }

  // 从上一版本复制：在切换 current 之前完成，避免线上短暂缺文件
  const copyItems = (target.protectPaths || []).filter(
    (item) => item.mode === 'copy' && normalizeProtectPath(item.path) !== ''
  )
  if (copyItems.length > 0) {
    const previousRelease = await getCurrentRelease(ssh, target, timeoutMs)
    if (!previousRelease) {
      log('INFO', '首个版本，没有上一版本可复制，跳过复制项')
    } else {
      for (const item of copyItems) {
        const rel = normalizeProtectPath(item.path)
        const source = pjoin(previousRelease, rel)
        const dest = pjoin(releaseDir, rel)
        const exists = await ssh.exec(`test -e ${shq(source)}`, { timeoutMs })
        if (exists.code !== 0) {
          log('WARN', `上一版本中不存在 ${rel}，已跳过复制`)
          continue
        }
        try {
          await execChecked(
            ssh,
            `rm -rf ${shq(dest)} && mkdir -p ${shq(posixDirname(dest))} && cp -a ${shq(source)} ${shq(dest)}`,
            timeoutMs,
            log,
            `复制 ${rel}`
          )
          log('OK', `已从上一版本复制 ${rel}（${previousRelease}）`)
        } catch (err) {
          log('WARN', `从上一版本复制 ${rel} 失败：${toError(err).message}`)
        }
      }
    }
  }

  // 写入版本元信息（供历史/审计读取）
  try {
    const meta = {
      release: releaseName,
      project: options.projectName,
      operator: options.operator,
      createdAt: new Date().toISOString(),
      changes: options.diff
        ? { added: options.diff.added, modified: options.diff.modified, deleted: options.diff.deleted }
        : undefined
    }
    await ssh.writeFile(pjoin(releaseDir, '.deploy.json'), JSON.stringify(meta, null, 2))
  } catch (err) {
    log('WARN', `写入版本元信息失败：${toError(err).message}`)
  }

  const runHook = async (label: string, hook: string | undefined): Promise<void> => {
    const command = (hook || '').trim()
    if (!command) return
    log('CMD', `[${label}钩子] ${command}`)
    const result = await ssh.exec(`cd ${shq(paths.root)} && bash -lc ${shq(command)}`, { timeoutMs })
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim()) log('INFO', line)
    }
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.trim()) log('WARN', line)
    }
    if (result.code !== 0) throw new Error(`${label}钩子失败（exit ${result.code}）`)
    log('OK', `${label}钩子执行完成`)
  }

  await runHook('发布前', target.hooks?.pre)

  const currentNow = await getCurrentRelease(ssh, target, timeoutMs)
  if (currentNow !== currentBefore) {
    throw new Error(
      `发布期间 ${target.currentLink} 被其他操作修改（${currentBefore || '空'} → ${
        currentNow || '空'
      }），已停止发布，未切换版本`
    )
  }

  await execChecked(
    ssh,
    `ln -sfn ${shq(releaseDir)} ${shq(paths.current)} && readlink -f ${shq(paths.current)}`,
    timeoutMs,
    log,
    '切换 current 软链'
  )
  log('OK', `发布完成，${target.currentLink} → ${releaseDir}`)
  options.onSwitched?.()

  await runHook('发布后', target.hooks?.post)

  // 清理旧版本与过期上传包（失败只告警）
  try {
    await cleanupReleases(ssh, paths.releases, target.keepVersions, timeoutMs, log)
    await purgeUploads(ssh, paths.uploads, timeoutMs, log)
  } catch (err) {
    log('WARN', `清理远端旧文件失败：${toError(err).message}`)
  }

  return releaseDir
}

async function cleanupReleases(
  ssh: SshClient,
  releasesDir: string,
  keep: number,
  timeoutMs: number,
  log: RemoteLog
): Promise<void> {
  const keepCount = Math.floor(Number(keep) || 0)
  if (keepCount <= 0) return
  const cmd = `find ${shq(releasesDir)} -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\\n' | sort -rn | tail -n +${keepCount + 1} | cut -d' ' -f2- | xargs -r rm -rf`
  const result = await ssh.exec(cmd, { timeoutMs })
  if (result.code === 0) log('INFO', `已保留最近 ${keepCount} 个版本`)
  else log('WARN', '清理旧版本失败')
}

/** 清空 uploads 下遗留的发布包（本次的包已在解压后立即删除） */
async function purgeUploads(
  ssh: SshClient,
  uploadsDir: string,
  timeoutMs: number,
  log: RemoteLog
): Promise<void> {
  const cmd = `find ${shq(uploadsDir)} -maxdepth 1 -type f \\( -name '*.tar.gz' -o -name '*.tgz' \\) -delete`
  const result = await ssh.exec(cmd, { timeoutMs })
  if (result.code === 0) log('INFO', '已清理上传目录中的发布包')
  else log('WARN', '清理上传目录失败')
}

export interface RollbackRemoteOptions {
  ssh: SshClient
  target: Target
  releaseName?: string
  timeoutMs: number
  log: RemoteLog
}

export async function rollbackRemote(options: RollbackRemoteOptions): Promise<string> {
  const { ssh, target, timeoutMs, log } = options
  const paths = remotePaths(target)
  const current = await getCurrentRelease(ssh, target, timeoutMs)
  const releases = await listReleaseDirs(ssh, paths.releases, timeoutMs)
  if (releases.length === 0) throw new Error('没有可回滚的发布版本')

  let chosen = options.releaseName
    ? releases.find((r) => r.name === options.releaseName)
    : releases.find((r) => pjoin(paths.releases, r.name) !== current)

  if (options.releaseName && !chosen) throw new Error(`版本 ${options.releaseName} 不存在`)
  if (!chosen) throw new Error('没有更早的版本可回滚')

  const dest = pjoin(paths.releases, chosen.name)
  if (dest === current) throw new Error('目标版本已是当前版本')

  await execChecked(ssh, `ln -sfn ${shq(dest)} ${shq(paths.current)}`, timeoutMs, log, '切换 current 软链')
  log('OK', `已回滚：${target.currentLink} → ${dest}`)

  const hook = (target.hooks?.rollback || '').trim()
  if (hook) {
    log('CMD', `[回滚后钩子] ${hook}`)
    const result = await ssh.exec(`cd ${shq(paths.root)} && bash -lc ${shq(hook)}`, { timeoutMs })
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim()) log('INFO', line)
    }
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.trim()) log('WARN', line)
    }
    if (result.code !== 0) throw new Error(`回滚后钩子失败（exit ${result.code}）`)
    log('OK', '回滚后钩子执行完成')
  }

  return chosen.name
}
