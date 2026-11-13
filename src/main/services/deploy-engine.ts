import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app, type WebContents } from 'electron'
import type {
  DiffResult,
  EnvironmentConfig,
  JobKind,
  JobStartPayload,
  JobState,
  JobStatus,
  LogEntry,
  LogLevel,
  Manifest,
  Project,
  ServerConfig,
  Target
} from '@shared/types'
import { configStore } from './config-store'
import { buildManifest, validateArtifacts, walkFiles, type WalkedFile } from './artifact'
import { runCommand } from './build-runner'
import { groupEnvironments, parseBuildEnv, profileFor, type BuildProfile } from './build-profile'
import { createSnapshot, profileFingerprint, resolveSnapshot } from './artifact-store'
import { createArchive } from './packager'
import { SshClient, friendlySshError } from './ssh-client'
import {
  acquireDeployLock,
  deployRemote,
  getCurrentRelease,
  listReleaseDirs,
  preflightRemote,
  remotePaths,
  rollbackRemote,
  type DeployLockHandle
} from './remote-deployer'
import { diffManifests } from './diff'
import { prepareWorkspace, removeWorkspace, workspaceDir } from './git-workspace'
import { runtimeTargetFor, serverFor } from './runtime-target'
import { resolveOperator } from './operator'
import { runRsync } from './rsync'
import { runWithConcurrency } from '../utils/semaphore'
import { withRetry } from '../utils/retry'
import { archiveTimestamp, formatBytes, logTime, releaseTimestamp, toError } from '../utils/time'
import { pjoin, shq } from '../utils/shell'

interface BuildArtifacts {
  distDir: string
  files: WalkedFile[]
  manifest: Manifest
  totalBytes: number
  archivePath?: string
  archiveName?: string
  /** 本次产物固化成的快照 */
  snapshotId?: string
  snapshotFingerprint?: string
  snapshotCommit?: string
}

interface BuildOptions {
  base: number
  span: number
  needArchive: boolean
  skipPaths: string[]
  /** 仅发布模式：跳过构建命令，直接使用现有产物 */
  skipBuildCommand?: boolean
  /** 从独立部署工作区构建（不影响用户当前分支） */
  workspace?: { commit: string; branch?: string }
  /** 本组目标的有效构建配置 */
  profile: BuildProfile
  /** 本组构建结果服务的环境（写入快照元信息） */
  environments: EnvironmentConfig[]
}

function kindName(kind: JobKind): string {
  switch (kind) {
    case 'preflight':
      return '预检'
    case 'build':
      return '构建'
    case 'deploy':
      return '发布'
    case 'deploy-only':
      return '快照发布'
    case 'rollback':
      return '回滚'
    default:
      return '任务'
  }
}

function skipProtectedPaths(environments: EnvironmentConfig[]): string[] {
  const set = new Set<string>()
  for (const environment of environments) {
    for (const item of environment.protectPaths || []) {
      if (item.mode !== 'skip' || !item.path) continue
      const rel = item.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel) set.add(rel)
    }
  }
  return Array.from(set)
}

function materializeArchiveName(project: Project): string {
  const template = (project.build.archiveName || '{name}-{timestamp}.tar.gz').trim()
  const safeName =
    project.name
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'app'
  const now = new Date()
  const name = template
    .replace(/\{timestamp\}/g, archiveTimestamp(now))
    .replace(/\{(name|project)\}/g, safeName)
    .replace(/[\\/]+/g, '-')
  return name || `${safeName}-${archiveTimestamp(now)}.tar.gz`
}

export class DeployEngine {
  private state: JobState = { kind: null, status: 'idle', stage: '', percent: 0, text: '空闲' }
  private controller: AbortController | null = null
  private sender: WebContents | null = null
  private logSeq = 0
  /** 本次任务产生或使用的快照，用于写入流水记录 */
  private lastSnapshotId?: string
  /** 全局进度只增不减，避免并发目标互相把进度条拉回去 */
  private lastPercent = 0
  /** 当前构建分组的进度上下文（构建 0-40%，部署 40-100%） */
  private groupProgress: {
    base: number
    span: number
    fractions: Map<string, number>
  } | null = null

  getState(): JobState {
    return { ...this.state }
  }

  isRunning(): boolean {
    return this.controller !== null
  }

  async start(
    payload: JobStartPayload,
    sender: WebContents | null
  ): Promise<{ started: boolean; message?: string }> {
    if (this.controller) {
      return { started: false, message: '已有任务正在执行，请等待结束或先取消' }
    }
    const project = configStore.getProjectRaw(payload.projectId)
    if (!project) return { started: false, message: '项目不存在或已被删除' }

    let worktreeSource: { commit: string; branch?: string } | undefined
    if (payload.source?.mode === 'worktree') {
      const commit = payload.source.commit || ''
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
        return { started: false, message: '自动发布的提交信息无效' }
      }
      worktreeSource = { commit, branch: payload.source.branch }
    }

    const environments = project.environments.filter((env) =>
      payload.environmentIds.includes(env.id)
    )
    if (
      (payload.kind === 'preflight' ||
        payload.kind === 'deploy' ||
        payload.kind === 'deploy-only' ||
        payload.kind === 'rollback') &&
      environments.length === 0
    ) {
      return { started: false, message: '请先勾选要操作的环境' }
    }
    if (
      (payload.kind === 'build' || payload.kind === 'deploy' || payload.kind === 'preflight') &&
      !project.localPath.trim()
    ) {
      return { started: false, message: '请先配置本地项目目录' }
    }
    if (payload.kind === 'deploy-only' && !payload.snapshotId) {
      return { started: false, message: '仅发布必须选择一个产物快照，禁止直接发布本地 dist' }
    }

    this.sender = sender
    this.controller = new AbortController()
    this.lastPercent = 0
    this.groupProgress = null
    this.setState({ kind: payload.kind, status: 'running', stage: 'start', percent: 0, text: '准备中...' })
    const environmentNames = environments.map((env) => env.name).join('、')
    this.log(
      'INFO',
      `${kindName(payload.kind)}开始：${project.name}${
        environmentNames ? ` → ${environmentNames}` : ''
      }${worktreeSource ? '（独立工作区）' : ''}`
    )

    void this.run(payload, project, environments, this.controller.signal)
    return { started: true }
  }

  cancel(): void {
    if (!this.controller) return
    this.log('WARN', '收到取消指令，正在终止任务...')
    this.controller.abort()
  }

  private async run(
    payload: JobStartPayload,
    project: Project,
    environments: EnvironmentConfig[],
    signal: AbortSignal
  ): Promise<void> {
    const startedAt = new Date().toISOString()
    const logBase = this.logSeq
    this.lastSnapshotId = payload.snapshotId
    let status: JobStatus = 'failed'
    try {
      let message = ''
      const workspace =
        payload.source?.mode === 'worktree' && payload.source.commit
          ? { commit: payload.source.commit, branch: payload.source.branch }
          : undefined
      if (payload.kind === 'preflight')
        message = await this.doPreflight(project, environments, signal)
      else if (payload.kind === 'build')
        message = await this.doBuildOnly(project, environments, signal)
      else if (payload.kind === 'deploy')
        message = await this.doDeploy(project, environments, signal, false, workspace)
      else if (payload.kind === 'deploy-only')
        message = await this.doDeploy(project, environments, signal, true, workspace, payload.snapshotId)
      else message = await this.doRollback(project, environments, payload.releaseName, signal)

      if (signal.aborted) throw new Error('已取消')
      status = 'success'
      this.setState({ ...this.state, status: 'success', percent: 100, text: message })
      this.log('OK', message)
    } catch (err) {
      const canceled = signal.aborted
      const message = canceled ? '任务已取消' : friendlySshError(err)
      status = canceled ? 'canceled' : 'failed'
      if (!canceled) this.log('ERROR', `任务失败：${message}`)
      this.setState({ ...this.state, status, text: message })
    } finally {
      const finalMessage = this.state.text
      try {
        await configStore.addFlow(project.id, {
          id: `${Date.now().toString(36)}-${(this.logSeq + 1).toString(36)}`,
          projectId: project.id,
          kind: payload.kind,
          status,
          startedAt,
          finishedAt: new Date().toISOString(),
          message: finalMessage,
          environmentIds: environments.map((env) => env.id),
          snapshotId: this.lastSnapshotId,
          logCount: Math.max(0, this.logSeq - logBase)
        })
      } catch (err) {
        console.error('[flow] 流水记录写入失败', err)
      }
      // 流水落盘后再通知渲染进程，保证刷新时能看到本次记录
      this.emit('job:done', { status, message: finalMessage })
      this.controller = null
      this.sender = null
    }
  }

  private async doPreflight(
    project: Project,
    environments: EnvironmentConfig[],
    signal: AbortSignal
  ): Promise<string> {
    this.setStage('preflight', '环境预检')
    this.setProgress(0, '检查本地环境...')
    const errors: string[] = []
    const localPath = project.localPath.trim()

    if (!localPath) {
      errors.push('未配置本地项目目录')
      this.log('ERROR', '未配置本地项目目录')
    } else {
      const isDir = await fs
        .stat(localPath)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!isDir) {
        errors.push('本地项目目录不存在')
        this.log('ERROR', `本地项目目录不存在：${localPath}`)
      } else {
        this.log('OK', `本地项目目录：${localPath}`)
        if (/npm|pnpm|yarn/.test(project.build.buildCommand)) {
          const hasPkg = await fs
            .stat(join(localPath, 'package.json'))
            .then((s) => s.isFile())
            .catch(() => false)
          if (hasPkg) this.log('INFO', '检测到 package.json')
          else {
            errors.push('项目缺少 package.json')
            this.log('ERROR', '项目缺少 package.json，无法执行包管理器构建命令')
          }
        }
        this.log('INFO', `构建产物目录（构建后校验）：${join(localPath, project.build.distDir)}`)
      }
    }

    this.setProgress(10, '检查环境服务器...')
    if (environments.length === 0) {
      this.log('WARN', '未勾选环境，仅完成本地检查')
    } else {
      await runWithConcurrency(
        environments,
        Math.max(1, project.strategy.concurrency || 1),
        async (environment) => {
          if (signal.aborted) throw new Error('已取消')
          this.setProgress(20, `[${environment.name}] 连接测试...`)
          let server: ServerConfig
          let target: Target
          try {
            server = serverFor(project, environment)
            target = runtimeTargetFor(project, environment)
          } catch (err) {
            const msg = toError(err).message
            this.log('ERROR', `[${environment.name}] ${msg}`, environment.id)
            errors.push(`[${environment.name}] ${msg}`)
            return
          }
          const ssh = new SshClient(
            server,
            configStore.getSecret(server.id),
            Math.min((project.strategy.timeoutSec || 60) * 1000, 60000)
          )
          try {
            await ssh.connect()
            this.log(
              'OK',
              `[${environment.name}] SSH 连接成功（${server.username}@${server.host}:${server.port}）`,
              environment.id
            )
            const profile = profileFor(project, environment)
            this.log(
              'INFO',
              `[${environment.name}] 构建命令：${profile.buildCommand || '（跳过）'}；产物目录：${
                profile.distDir
              }`,
              environment.id
            )
            const remoteErrors = await preflightRemote(
              ssh,
              target,
              (level, msg) => this.log(level, `[${environment.name}] ${msg}`, environment.id),
              (project.strategy.timeoutSec || 300) * 1000
            )
            for (const remoteError of remoteErrors) {
              errors.push(`[${environment.name}] ${remoteError}`)
            }
          } catch (err) {
            const msg = friendlySshError(err)
            this.log('ERROR', `[${environment.name}] ${msg}`, environment.id)
            errors.push(`[${environment.name}] ${msg}`)
          } finally {
            ssh.close()
          }
        },
        { signal }
      )
    }

    this.setProgress(95, '汇总预检结果...')
    if (errors.length > 0) throw new Error(`预检未通过：${errors.length} 项错误`)
    return '预检通过，可以发布'
  }

  private async doBuildOnly(
    project: Project,
    environments: EnvironmentConfig[],
    signal: AbortSignal
  ): Promise<string> {
    const effectiveEnvironments =
      environments.length > 0 ? environments : project.environments
    const groups = groupEnvironments(project, effectiveEnvironments)
    if (groups.length === 0) {
      groups.push({ key: 'default', profile: profileFor(project), environments: [] })
    }
    let fileCount = 0
    let totalBytes = 0
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]
      const base = (index / groups.length) * 95
      const span = 95 / groups.length
      const label =
        group.environments.length > 0
          ? group.environments.map((env) => env.name).join('、')
          : '项目默认'
      this.log(
        'INFO',
        `构建配置 ${index + 1}/${groups.length}：${label}（命令：${
          group.profile.buildCommand || '跳过'
        }）`
      )
      const artifacts = await this.runBuild(project, signal, {
        base,
        span,
        needArchive: project.build.package,
        skipPaths: skipProtectedPaths(group.environments),
        profile: group.profile,
        environments: group.environments
      })
      const diffEnvironments =
        group.environments.length > 0 ? group.environments : project.environments
      this.emitDiffs(project, diffEnvironments, artifacts.manifest)
      fileCount += artifacts.files.length
      totalBytes += artifacts.totalBytes
    }
    this.setProgress(100, '构建完成')
    return `构建完成：${fileCount} 个文件，${formatBytes(totalBytes)}`
  }

  private async doDeploy(
    project: Project,
    environments: EnvironmentConfig[],
    signal: AbortSignal,
    skipBuildCommand = false,
    workspace?: { commit: string; branch?: string },
    snapshotId?: string
  ): Promise<string> {
    let snapshotArtifacts: BuildArtifacts | null = null
    let groups: ReturnType<typeof groupEnvironments>
    if (skipBuildCommand) {
      snapshotArtifacts = await this.loadSnapshotArtifacts(
        project,
        environments,
        snapshotId || '',
        signal
      )
      groups = [{ key: 'snapshot', profile: profileFor(project, environments[0]), environments }]
    } else {
      groups = groupEnvironments(project, environments)
    }
    const releaseName = releaseTimestamp()
    const timeoutMs = (project.strategy.timeoutSec || 300) * 1000
    const concurrency = Math.max(1, project.strategy.concurrency || 1)
    const retries = Math.max(0, project.strategy.retries || 0)
    const policy = project.strategy.failPolicy
    let stopped = false
    let successCount = 0
    const failures: string[] = []
    this.groupProgress = null

    const totalGroups = Math.max(1, groups.length)
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      if (stopped || signal.aborted) break
      const group = groups[groupIndex]
      const base = (groupIndex / totalGroups) * 100
      const span = 100 / totalGroups
      const groupNames = group.environments.map((env) => env.name).join('、')
      if (groups.length > 1) {
        this.log(
          'INFO',
          `构建环境 ${groupIndex + 1}/${groups.length}：${groupNames}（命令：${
            group.profile.buildCommand || '跳过'
          }）`
        )
      }

      let artifacts: BuildArtifacts
      try {
        artifacts =
          snapshotArtifacts ??
          (await this.runBuild(project, signal, {
            base,
            span: span * 0.4,
            needArchive: project.build.package && project.build.transfer !== 'rsync',
            skipPaths: skipProtectedPaths(group.environments),
            skipBuildCommand,
            workspace,
            profile: group.profile,
            environments: group.environments
          }))
      } catch (err) {
        if (signal.aborted) throw new Error('已取消')
        const message = friendlySshError(err)
        this.log('ERROR', `构建失败（${groupNames}）：${message}`)
        failures.push(`${groupNames}：${message}`)
        if (policy === 'stop') {
          stopped = true
          throw new Error(`构建失败：${message}`)
        }
        continue
      }

      this.beginGroupProgress(base + span * 0.4, span * 0.6, group.environments)
      const results = await runWithConcurrency(
        group.environments,
        concurrency,
        async (environment) => {
          const previous = configStore.getManifest(project.id, environment.id)
          const diff = diffManifests(previous, artifacts.manifest)
          this.emit('job:diff', { targetId: environment.id, diff })

          let server: ServerConfig
          let target: Target
          try {
            server = serverFor(project, environment)
            target = runtimeTargetFor(project, environment)
          } catch (err) {
            const error = toError(err)
            this.log('ERROR', `[${environment.name}] ${error.message}`, environment.id)
            throw error
          }

          try {
            await withRetry(
              async (attempt) => {
                if (signal.aborted) throw new Error('已取消')
                if (attempt > 1)
                  this.log(
                    'WARN',
                    `[${environment.name}] 第 ${attempt} 次尝试...`,
                    environment.id
                  )
                await this.deployToTarget({
                  project,
                  server,
                  target,
                  artifacts,
                  releaseName,
                  diff,
                  signal,
                  timeoutMs
                })
              },
              retries,
              (error, attempt) =>
                this.log(
                  'WARN',
                  `[${environment.name}] 部署失败（${friendlySshError(error)}），准备第 ${attempt} 次重试`,
                  environment.id
                ),
              signal
            )

            successCount += 1
            await configStore.setManifest(project.id, environment.id, artifacts.manifest)
            await configStore.addHistory(project.id, environment.id, {
              name: releaseName,
              operator: await resolveOperator(project),
              createdAt: new Date().toISOString(),
              snapshotId: artifacts.snapshotId,
              commit: artifacts.snapshotCommit
            })
          } catch (err) {
            const error = toError(err)
            this.log(
              'ERROR',
              `[${environment.name}] 发布失败：${friendlySshError(error)}`,
              environment.id
            )
            if (policy === 'stop') stopped = true
            if (policy === 'rollback' && !signal.aborted) {
              await this.autoRollback(project, server, target, releaseName, timeoutMs)
            }
            throw error
          }
        },
        { signal, shouldStop: () => stopped }
      )

      for (const result of results) {
        if (!result.ok) failures.push(`[${result.item.name}] ${friendlySshError(result.error)}`)
      }
    }

    if (signal.aborted) throw new Error('已取消')
    if (failures.length > 0) {
      throw new Error(`${failures.length} 项发布失败：${failures.join('；')}`)
    }
    if (workspace && !project.gitWatch.keepWorkspace) {
      try {
        await removeWorkspace(
          project.localPath.trim(),
          workspaceDir(app.getPath('userData'), project.id)
        )
        this.log('INFO', '已清理部署工作区')
      } catch (err) {
        this.log('WARN', `清理部署工作区失败：${toError(err).message}`)
      }
    }

    this.setProgress(100, skipBuildCommand ? '快照发布完成' : '发布完成')
    return `${skipBuildCommand ? '快照发布' : '发布'}完成：${successCount} 个目标，版本 ${releaseName}`
  }

  private async deployToTarget(args: {
    project: Project
    server: ServerConfig
    target: Target
    artifacts: BuildArtifacts
    releaseName: string
    diff: DiffResult
    signal: AbortSignal
    timeoutMs: number
  }): Promise<void> {
    const { project, server, target, artifacts, releaseName, diff, signal, timeoutMs } = args
    const report = (fraction: number, text: string): void => {
      this.reportTargetProgress(target.id, fraction, `[${target.name}] ${text}`)
    }

    const ssh = new SshClient(
      server,
      configStore.getSecret(server.id),
      Math.min(timeoutMs, 60000)
    )
    let lock: DeployLockHandle | null = null
    try {
      report(0.02, '连接服务器...')
      this.log('INFO', `[${target.name}] 连接 ${target.username}@${target.host}:${target.port}`, target.id)
      await ssh.connect()
      this.log('OK', `[${target.name}] SSH 连接成功`, target.id)

      lock = await acquireDeployLock(
        ssh,
        target,
        {
          operator: await resolveOperator(project),
          projectName: project.name,
          releaseName
        },
        timeoutMs,
        (level, msg) => this.log(level, `[${target.name}] ${msg}`, target.id)
      )

      const paths = remotePaths(target)
      const releaseDir = pjoin(paths.releases, releaseName)
      const skipPaths = Array.from(
        new Set(
          (target.protectPaths || [])
            .filter((item) => item.mode === 'skip' && item.path)
            .map((item) => item.path.replace(/\\/g, '/').replace(/^\/+/, ''))
            .filter(Boolean)
        )
      )
      const remoteOptions = {
        ssh,
        target,
        releaseName,
        timeoutMs,
        log: (level: LogLevel, msg: string) => this.log(level, `[${target.name}] ${msg}`, target.id),
        operator: await resolveOperator(project),
        projectName: project.name,
        diff
      }

      if (project.build.transfer === 'rsync') {
        report(0.08, 'rsync 同步中...')
        await ssh.exec(`mkdir -p ${shq(paths.releases)} ${shq(releaseDir)}`, { timeoutMs })
        await runRsync({
          target,
          localDir: artifacts.distDir,
          remoteDir: releaseDir,
          excludePaths: skipPaths,
          timeoutMs,
          signal,
          onProgress: (percent) => report(0.08 + 0.57 * (percent / 100), `rsync 同步中 ${percent}%`),
          onLine: (line, stream) =>
            this.log(stream === 'stderr' ? 'WARN' : 'INFO', `[${target.name}] ${line}`, target.id)
        })
        this.log('OK', `[${target.name}] rsync 同步完成`, target.id)
        report(0.7, '远端切换...')
        await deployRemote({ ...remoteOptions, skipExtract: true })
      } else if (artifacts.archivePath && artifacts.archiveName) {
        report(0.08, '上传压缩包...')
        const remoteArchive = pjoin(paths.uploads, artifacts.archiveName)
        await ssh.exec(`mkdir -p ${shq(paths.uploads)}`, { timeoutMs })
        await ssh.upload(artifacts.archivePath, remoteArchive, (transferred, total) => {
          const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
          report(0.08 + 0.57 * (percent / 100), `上传中 ${percent}%`)
        })
        this.log('OK', `[${target.name}] 上传完成：${artifacts.archiveName}`, target.id)
        report(0.7, '远端解压与切换...')
        await deployRemote({ ...remoteOptions, archiveRemotePath: remoteArchive })
      } else {
        const excluded = new Set(skipPaths)
        const files = artifacts.files.filter(
          (file) => !Array.from(excluded).some((p) => file.rel === p || file.rel.startsWith(`${p}/`))
        )
        report(0.08, '逐文件上传...')
        await ssh.uploadDirectory(
          artifacts.distDir,
          releaseDir,
          files,
          (percent, text) => report(0.08 + 0.57 * (percent / 100), `上传中 ${percent}%（${text.split('/').pop()}）`),
          signal
        )
        this.log('OK', `[${target.name}] 上传完成：${files.length} 个文件`, target.id)
        report(0.7, '远端切换...')
        await deployRemote({ ...remoteOptions, skipExtract: true })
      }

      report(1, `版本 ${releaseName}`)
      this.log('OK', `[${target.name}] 发布完成（版本 ${releaseName}）`, target.id)
    } finally {
      if (lock) await lock.release()
      ssh.close()
    }
  }

  private async autoRollback(
    project: Project,
    server: ServerConfig,
    target: Target,
    failedReleaseName: string,
    timeoutMs: number
  ): Promise<void> {
    const ssh = new SshClient(
      server,
      configStore.getSecret(server.id),
      Math.min(timeoutMs, 60000)
    )
    let lock: DeployLockHandle | null = null
    try {
      await ssh.connect()
      lock = await acquireDeployLock(
        ssh,
        target,
        { operator: '自动回滚', projectName: project.name, releaseName: failedReleaseName },
        timeoutMs,
        (level, msg) => this.log(level, `[${target.name}] ${msg}`, target.id)
      )
      const paths = remotePaths(target)
      const current = await getCurrentRelease(ssh, target, timeoutMs)
      const failedDir = pjoin(paths.releases, failedReleaseName)
      if (current !== failedDir) {
        this.log('WARN', `[${target.name}] current 尚未切换到失败版本，无需自动回滚`, target.id)
        return
      }
      const releases = await listReleaseDirs(ssh, paths.releases, timeoutMs)
      const previous = releases.find((r) => r.name !== failedReleaseName)
      if (!previous) {
        this.log('WARN', `[${target.name}] 没有可回滚的历史版本`, target.id)
        return
      }
      await rollbackRemote({
        ssh,
        target,
        releaseName: previous.name,
        timeoutMs,
        log: (level, msg) => this.log(level, `[${target.name}] ${msg}`, target.id)
      })
      this.log('OK', `[${target.name}] 已自动回滚到 ${previous.name}`, target.id)
    } catch (err) {
      this.log('ERROR', `[${target.name}] 自动回滚失败：${friendlySshError(err)}`, target.id)
    } finally {
      if (lock) await lock.release()
      ssh.close()
    }
  }

  private async doRollback(
    project: Project,
    environments: EnvironmentConfig[],
    releaseName: string | undefined,
    signal: AbortSignal
  ): Promise<string> {
    this.setStage('rollback', '回滚版本')
    const timeoutMs = (project.strategy.timeoutSec || 300) * 1000
    const results = await runWithConcurrency(
      environments,
      Math.max(1, project.strategy.concurrency || 1),
      async (environment, index) => {
        if (signal.aborted) throw new Error('已取消')
        const server = serverFor(project, environment)
        const target = runtimeTargetFor(project, environment)
        const ssh = new SshClient(
          server,
          configStore.getSecret(server.id),
          Math.min(timeoutMs, 60000)
        )
        let lock: DeployLockHandle | null = null
        try {
          this.log('INFO', `[${environment.name}] 连接服务器...`, environment.id)
          await ssh.connect()
          lock = await acquireDeployLock(
            ssh,
            target,
            {
              operator: await resolveOperator(project),
              projectName: project.name,
              releaseName: releaseName || '回滚'
            },
            timeoutMs,
            (level, msg) => this.log(level, `[${environment.name}] ${msg}`, environment.id)
          )
          const name = await rollbackRemote({
            ssh,
            target,
            releaseName,
            timeoutMs,
            log: (level, msg) => this.log(level, `[${environment.name}] ${msg}`, environment.id)
          })
          this.setProgress(
            ((index + 1) / Math.max(1, environments.length)) * 100,
            `[${environment.name}] 已回滚到 ${name}`
          )
          return name
        } finally {
          if (lock) await lock.release()
          ssh.close()
        }
      },
      { signal }
    )

    if (signal.aborted) throw new Error('已取消')
    const failures = results.filter((r) => !r.ok)
    if (failures.length > 0) {
      const detail = failures
        .map((r) => (r.ok ? '' : friendlySshError(r.error)))
        .filter(Boolean)
        .join('；')
      throw new Error(`回滚失败 ${failures.length} 个环境：${detail}`)
    }
    return `回滚完成：${results.length} 个环境`
  }

  private async runBuild(project: Project, signal: AbortSignal, options: BuildOptions): Promise<BuildArtifacts> {
    const { base, span } = options
    const localPath = project.localPath.trim()
    let buildRoot = localPath
    let distDir = join(localPath, options.profile.distDir)
    const timeoutMs = (project.strategy.timeoutSec || 300) * 1000
    let usedWorkspace = false

    if (options.workspace) {
      if (!localPath) throw new Error('请先配置本地项目目录')
      const dir = workspaceDir(app.getPath('userData'), project.id)
      this.setStage('workspace', '准备部署工作区')
      this.setProgress(base + span * 0.02, '准备部署工作区...')
      await prepareWorkspace({
        repoPath: localPath,
        dir,
        commit: options.workspace.commit,
        gitWatch: project.gitWatch,
        log: (level, msg) => this.log(level, msg),
        progress: (fraction, text) =>
          this.setProgress(base + span * (0.02 + 0.18 * fraction), text),
        signal,
        gitTimeoutMs: 60000,
        installTimeoutMs: Math.max(600000, timeoutMs * 2)
      })
      buildRoot = dir
      distDir = join(dir, options.profile.distDir)
      usedWorkspace = true
      this.log('OK', `部署工作区已就绪：${dir}`)
    }

    const phase = usedWorkspace
      ? { build: 0.22, validate: 0.4, manifest: 0.5, package: 0.62 }
      : { build: 0.05, validate: 0.35, manifest: 0.45, package: 0.6 }

    this.setStage('build', options.skipBuildCommand ? '使用现有产物' : '构建产物')
    const command = (options.profile.buildCommand || '').trim()
    const buildEnv = parseBuildEnv(options.profile.envVars)
    const envKeys = Object.keys(buildEnv)
    if (envKeys.length > 0) this.log('INFO', `构建环境变量：${envKeys.join('、')}`)
    if (options.skipBuildCommand) {
      this.log('INFO', '仅发布模式：跳过构建命令，直接使用现有产物')
    } else if (command) {
      this.log('CMD', command)
      this.setProgress(base + span * phase.build, '执行构建命令...')
      const code = await runCommand({
        command,
        cwd: buildRoot,
        timeoutMs,
        signal,
        env: buildEnv,
        onLine: (line, stream) => this.log(stream === 'stderr' ? 'WARN' : 'INFO', line)
      })
      if (code !== 0) throw new Error(`构建命令退出码 ${code}`)
      this.log('OK', '构建命令执行完成')
    } else {
      this.log('INFO', '未配置构建命令，跳过构建')
    }

    this.setStage('validate', '产物校验')
    this.setProgress(base + span * phase.validate, '校验产物完整性...')
    const validation = await validateArtifacts(distDir, project.validation)
    if (!validation.ok) throw new Error(`产物校验失败：${validation.errors.join('；')}`)
    this.log(
      'OK',
      `校验通过：${validation.fileCount} 个文件，共 ${formatBytes(validation.totalBytes)}`
    )

    this.setStage('manifest', '生成文件清单')
    this.setProgress(base + span * phase.manifest, '生成文件清单...')
    const files = await walkFiles(distDir)
    const manifest = await buildManifest(distDir, files)
    this.log('INFO', `文件清单已生成：${files.length} 个文件`)

    // 固化产物快照：之后的发布只从快照读取，dist 再被覆盖也不会发错包
    this.setStage('snapshot', '生成产物快照')
    this.setProgress(
      base + span * (phase.manifest + (phase.package - phase.manifest) * 0.5),
      '生成产物快照...'
    )
    const snapshot = await createSnapshot({
      project,
      environments: options.environments,
      srcDir: distDir,
      profile: options.profile,
      files,
      manifest,
      totalBytes: validation.totalBytes,
      source: usedWorkspace ? 'worktree' : 'local',
      branch: options.workspace?.branch,
      commit: options.workspace?.commit
    })
    distDir = snapshot.filesDir
    this.lastSnapshotId = snapshot.snapshot.id
    this.log(
      'OK',
      `产物快照：${snapshot.snapshot.id}（指纹 ${snapshot.snapshot.manifestHash.slice(0, 8)}）`
    )

    const artifacts: BuildArtifacts = {
      distDir,
      files: snapshot.files,
      manifest,
      totalBytes: validation.totalBytes,
      snapshotId: snapshot.snapshot.id,
      snapshotFingerprint: snapshot.snapshot.profileFingerprint,
      snapshotCommit: snapshot.snapshot.commit
    }

    if (options.needArchive) {
      this.setStage('package', '打包压缩')
      this.setProgress(base + span * phase.package, '打包压缩...')
      const archiveName = materializeArchiveName(project)
      const tempDir = join(tmpdir(), 'deploye', project.id)
      await fs.mkdir(tempDir, { recursive: true })
      const archivePath = join(tempDir, archiveName)
      await createArchive({
        distDir,
        outFile: archivePath,
        excludePaths: options.skipPaths,
        onProgress: (percent) =>
          this.setProgress(
            base + span * (phase.package + (1 - phase.package) * (percent / 100)),
            `打包压缩 ${percent}%`
          )
      })
      artifacts.archivePath = archivePath
      artifacts.archiveName = archiveName
      const size = await fs.stat(archivePath).then((s) => s.size).catch(() => 0)
      this.log('OK', `打包完成：${archiveName}（${formatBytes(size)}）`)
    }

    this.setProgress(base + span, '构建就绪')
    return artifacts
  }

  /**
   * 仅发布模式：从磁盘上的产物快照加载部署内容。
   * 绝不读取本地 dist，避免把上一次构建（可能是别的环境）的产物发出去。
   */
  private async loadSnapshotArtifacts(
    project: Project,
    environments: EnvironmentConfig[],
    snapshotId: string,
    signal: AbortSignal
  ): Promise<BuildArtifacts> {
    if (!snapshotId) throw new Error('仅发布必须选择一个产物快照，禁止直接发布本地 dist')
    this.setStage('snapshot', '加载产物快照')
    this.setProgress(5, '读取产物快照...')
    if (signal.aborted) throw new Error('已取消')

    const resolved = await resolveSnapshot(project.id, snapshotId)
    const meta = resolved.snapshot
    this.log(
      'OK',
      `使用产物快照 ${meta.id}：${meta.fileCount} 个文件，${formatBytes(meta.totalBytes)}`
    )
    this.log(
      'INFO',
      `快照构建信息：${meta.buildCommand || '（跳过构建）'} · ${meta.distDir}${
        meta.commit ? ` · ${meta.commit.slice(0, 8)}` : ''
      } · ${meta.source === 'worktree' ? '独立工作区' : '本地工作区'}`
    )

    for (const environment of environments) {
      const current = profileFingerprint(profileFor(project, environment))
      if (current !== meta.profileFingerprint) {
        this.log(
          'WARN',
          `[${environment.name}] 快照的构建配置与环境当前配置不一致，请确认这是要发布的产物`,
          environment.id
        )
      }
    }

    const artifacts: BuildArtifacts = {
      distDir: resolved.filesDir,
      files: resolved.files,
      manifest: resolved.manifest,
      totalBytes: meta.totalBytes,
      snapshotId: meta.id,
      snapshotFingerprint: meta.profileFingerprint,
      snapshotCommit: meta.commit
    }

    if (project.build.package && project.build.transfer !== 'rsync') {
      this.setStage('package', '打包压缩')
      const archiveName = materializeArchiveName(project)
      const tempDir = join(tmpdir(), 'deploye', project.id)
      await fs.mkdir(tempDir, { recursive: true })
      const archivePath = join(tempDir, archiveName)
      await createArchive({
        distDir: resolved.filesDir,
        outFile: archivePath,
        excludePaths: skipProtectedPaths(environments),
        onProgress: (percent) => this.setProgress(5 + percent * 0.1, `打包压缩 ${percent}%`)
      })
      artifacts.archivePath = archivePath
      artifacts.archiveName = archiveName
    }

    return artifacts
  }

  private emitDiffs(
    project: Project,
    environments: EnvironmentConfig[],
    manifest: Manifest
  ): void {
    for (const environment of environments) {
      const previous = configStore.getManifest(project.id, environment.id)
      const diff = diffManifests(previous, manifest)
      this.emit('job:diff', { targetId: environment.id, diff })
      this.log(
        'INFO',
        `[${environment.name}] 变更预览：新增 ${diff.added} / 更新 ${diff.modified} / 删除 ${diff.deleted}`,
        environment.id
      )
    }
  }

  private log(level: LogLevel, msg: string, targetId?: string): void {
    this.logSeq += 1
    const entry: LogEntry = { id: this.logSeq, ts: logTime(), level, msg, targetId }
    this.emit('job:log', entry)
  }

  /** 汇总多目标进度：构建阶段占 0-30%，发布阶段占 30-100%，取各目标进度的平均值 */
  private beginGroupProgress(
    base: number,
    span: number,
    environments: EnvironmentConfig[]
  ): void {
    this.groupProgress = {
      base,
      span,
      fractions: new Map(environments.map((environment) => [environment.id, 0]))
    }
  }

  private reportTargetProgress(targetId: string, fraction: number, text: string): void {
    const clamped = Math.max(0, Math.min(1, fraction))
    const group = this.groupProgress
    if (!group) {
      this.setProgress(clamped * 100, text)
      return
    }
    const previous = group.fractions.get(targetId) ?? 0
    group.fractions.set(targetId, Math.max(previous, clamped))
    let sum = 0
    for (const value of group.fractions.values()) sum += value
    const average = group.fractions.size > 0 ? sum / group.fractions.size : 0
    this.setProgress(group.base + group.span * (0.4 + 0.6 * average), text)
  }

  private setProgress(percent: number, text: string): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    // 全局单调：并发目标的上报交错时永不回退
    this.lastPercent = Math.max(this.lastPercent, clamped)
    this.state = { ...this.state, percent: this.lastPercent, text }
    this.emit('job:progress', { percent: this.lastPercent, text })
  }

  private setStage(stage: string, _label: string): void {
    this.state = { ...this.state, stage }
    this.emit('job:stage', { stage, label: _label })
    this.emit('job:state', { ...this.state })
  }

  private setState(state: JobState): void {
    this.state = state
    this.emit('job:state', { ...state })
  }

  private emit(channel: string, payload: unknown): void {
    if (this.sender && !this.sender.isDestroyed()) {
      this.sender.send(channel, payload)
    }
  }
}

export const deployEngine = new DeployEngine()
