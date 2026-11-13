import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type { GitWatchConfig, LogLevel, WorkspaceStatus } from '@shared/types'
import { runGit, gitTopLevel, lastLine } from '../utils/git'
import { toError } from '../utils/time'
import { runCommand } from './build-runner'

export type WorkspaceLog = (level: LogLevel, msg: string) => void

export interface PrepareWorkspaceOptions {
  repoPath: string
  dir: string
  commit: string
  gitWatch: GitWatchConfig
  log: WorkspaceLog
  progress?: (fraction: number, text: string) => void
  signal?: AbortSignal
  gitTimeoutMs?: number
  installTimeoutMs?: number
}

interface DepCache {
  lockHash?: string
  manager?: string
  installedAt?: string
}

interface PackageManager {
  name: string
  lockFile: string
  command: string
  args: string[]
}

export function workspaceDir(userDataPath: string, projectId: string): string {
  return join(userDataPath, 'workspaces', projectId)
}

async function existsFile(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then((s) => s.isFile())
    .catch(() => false)
}

async function existsDir(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

function parseCopyPaths(raw: string): string[] {
  return (raw || '')
    .split(/[,，\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}

/** 创建或复用 worktree，并检出到指定提交 */
async function ensureWorktree(
  options: PrepareWorkspaceOptions,
  repoRoot: string
): Promise<void> {
  const { dir, commit, log } = options
  const gitTimeout = options.gitTimeoutMs ?? 60000
  const existed = await existsDir(dir)
  let initialized = false

  if (existed) {
    const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
    initialized = inside.ok && inside.stdout.trim() === 'true'
  }

  if (!initialized) {
    if (existed) await removeDir(dir)
    await runGit(repoRoot, ['worktree', 'prune'])
    const add = await runGit(
      repoRoot,
      ['worktree', 'add', '--detach', '--force', dir, commit],
      gitTimeout
    )
    if (!add.ok) throw new Error(`创建部署工作区失败：${lastLine(add.stderr)}`)
    log('OK', '已创建部署工作区')
    return
  }

  const checkout = await runGit(dir, ['checkout', '--force', '--detach', commit], gitTimeout)
  if (checkout.ok) {
    // 保留被忽略的文件（如 node_modules），只清理受版本控制的残留
    await runGit(dir, ['clean', '-ffd'], gitTimeout)
    log('INFO', `部署工作区已切换到 ${commit.slice(0, 7)}`)
    return
  }

  log('WARN', `更新部署工作区失败（${lastLine(checkout.stderr)}），尝试重建`)
  await runGit(repoRoot, ['worktree', 'remove', '--force', dir], gitTimeout)
  await removeDir(dir)
  await runGit(repoRoot, ['worktree', 'prune'])
  const add = await runGit(
    repoRoot,
    ['worktree', 'add', '--detach', '--force', dir, commit],
    gitTimeout
  )
  if (!add.ok) throw new Error(`重建部署工作区失败：${lastLine(add.stderr)}`)
  log('OK', '已重建部署工作区')
}

async function updateSubmodules(options: PrepareWorkspaceOptions): Promise<void> {
  const { dir, log } = options
  const hasGitmodules = await existsFile(join(dir, '.gitmodules'))
  if (!hasGitmodules) return
  log('INFO', '更新子模块...')
  const result = await runGit(
    dir,
    ['submodule', 'update', '--init', '--recursive'],
    Math.max(120000, options.gitTimeoutMs ?? 0)
  )
  if (result.ok) log('OK', '子模块已更新')
  else log('WARN', `子模块更新失败：${lastLine(result.stderr)}`)
}

async function copyExtraPaths(options: PrepareWorkspaceOptions, repoRoot: string): Promise<void> {
  const { dir, gitWatch, log } = options
  const paths = parseCopyPaths(gitWatch.copyPaths)
  for (const rel of paths) {
    const source = resolve(repoRoot, rel)
    const relPath = relative(repoRoot, source)
    if (!relPath || relPath.startsWith('..') || isAbsolute(relPath)) {
      log('WARN', `复制路径越界或为空，已跳过：${rel}`)
      continue
    }
    const exists = await fs
      .stat(source)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      log('WARN', `待复制路径在项目目录中不存在，已跳过：${rel}`)
      continue
    }
    try {
      const dest = resolve(dir, relPath)
      await fs.rm(dest, { recursive: true, force: true })
      await fs.cp(source, dest, { recursive: true, force: true })
      log('INFO', `已复制 ${rel} 到部署工作区`)
    } catch (err) {
      log('WARN', `复制 ${rel} 失败：${toError(err).message}`)
    }
  }
}

export async function detectPackageManager(dir: string): Promise<PackageManager | null> {
  if (await existsFile(join(dir, 'pnpm-lock.yaml'))) {
    return { name: 'pnpm', lockFile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile'] }
  }
  if (await existsFile(join(dir, 'yarn.lock'))) {
    return { name: 'yarn', lockFile: 'yarn.lock', command: 'yarn', args: ['install', '--frozen-lockfile'] }
  }
  if ((await existsFile(join(dir, 'bun.lockb'))) || (await existsFile(join(dir, 'bun.lock')))) {
    return {
      name: 'bun',
      lockFile: 'bun.lockb',
      command: 'bun',
      args: ['install', '--frozen-lockfile']
    }
  }
  if (await existsFile(join(dir, 'package-lock.json'))) {
    return { name: 'npm', lockFile: 'package-lock.json', command: 'npm', args: ['ci'] }
  }
  if (await existsFile(join(dir, 'package.json'))) {
    return { name: 'npm', lockFile: '', command: 'npm', args: ['install'] }
  }
  return null
}

async function ensureDependencies(options: PrepareWorkspaceOptions): Promise<void> {
  const { dir, log, signal } = options
  const manager = await detectPackageManager(dir)
  if (!manager) {
    log('INFO', '未检测到 Node 包管理器，跳过依赖安装')
    return
  }

  const hashSource = manager.lockFile || 'package.json'
  let lockHash = ''
  try {
    const content = await fs.readFile(join(dir, hashSource))
    lockHash = createHash('sha256').update(content).digest('hex')
  } catch (err) {
    log('WARN', `读取 ${hashSource} 失败：${toError(err).message}`)
  }

  const cachePath = `${dir}.deps.json`
  let cache: DepCache = {}
  try {
    cache = JSON.parse(await fs.readFile(cachePath, 'utf8')) as DepCache
  } catch {
    /* 首次部署 */
  }

  const nodeModulesReady = await existsDir(join(dir, 'node_modules'))
  if (nodeModulesReady && lockHash && cache.lockHash === lockHash && cache.manager === manager.name) {
    log('INFO', '依赖未变化，跳过安装')
    return
  }

  const command = `${manager.command} ${manager.args.join(' ')}`
  log('CMD', command)
  options.progress?.(0.75, `安装依赖（${manager.name}）...`)
  const code = await runCommand({
    command,
    cwd: dir,
    timeoutMs: options.installTimeoutMs ?? Math.max(600000, (options.gitTimeoutMs ?? 0) * 4),
    signal,
    onLine: (line, stream) => log(stream === 'stderr' ? 'WARN' : 'INFO', line)
  })
  if (code !== 0) throw new Error(`${manager.name} 安装依赖失败（exit ${code}）`)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    cachePath,
    JSON.stringify(
      { lockHash, manager: manager.name, installedAt: new Date().toISOString() },
      null,
      2
    ),
    'utf8'
  )
  log('OK', '依赖安装完成')
}

/**
 * 准备部署工作区：不使用用户当前分支，而是把指定提交检出到独立 worktree。
 * 全程不影响原仓库的工作区和分支。
 */
export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<void> {
  const repoRoot = await gitTopLevel(options.repoPath)
  if (!repoRoot) throw new Error('本地项目目录不是 Git 仓库，无法创建部署工作区')

  options.progress?.(0.05, '创建 / 更新部署工作区...')
  await fs.mkdir(join(options.dir, '..'), { recursive: true })
  await ensureWorktree(options, repoRoot)

  const head = await runGit(options.dir, ['rev-parse', 'HEAD'])
  if (!head.ok || head.stdout.trim() !== options.commit) {
    const reset = await runGit(options.dir, ['reset', '--hard', options.commit], 60000)
    if (!reset.ok) throw new Error('部署工作区未能切换到目标提交')
  }

  await updateSubmodules(options)
  await copyExtraPaths(options, repoRoot)

  if (options.gitWatch.installDeps) {
    await ensureDependencies(options)
  } else {
    options.log('INFO', '已关闭自动安装依赖')
  }

  options.progress?.(1, '部署工作区就绪')
}

export async function removeWorkspace(repoPath: string, dir: string): Promise<void> {
  const repoRoot = await gitTopLevel(repoPath)
  if (repoRoot) {
    await runGit(repoRoot, ['worktree', 'remove', '--force', dir], 30000)
  }
  await removeDir(dir)
  await fs.rm(`${dir}.deps.json`, { force: true }).catch(() => undefined)
  if (repoRoot) await runGit(repoRoot, ['worktree', 'prune'], 30000)
}

export async function getWorkspaceStatus(repoPath: string, dir: string): Promise<WorkspaceStatus> {
  const exists = await existsDir(dir)
  let head: string | undefined
  if (exists) {
    const result = await runGit(dir, ['rev-parse', 'HEAD'])
    if (result.ok) head = result.stdout.trim()
  }
  return { path: dir, exists, head }
}
