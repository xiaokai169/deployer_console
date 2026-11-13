import { BrowserWindow, type WebContents } from 'electron'
import type {
  GitBranchStatus,
  GitWatchStatus,
  LogEntry,
  LogLevel,
  Project
} from '@shared/types'
import { configStore } from './config-store'
import { deployEngine } from './deploy-engine'
import { lastLine, latestPushedSha, runGit } from '../utils/git'
import { logTime } from '../utils/time'

interface ProjectRuntime {
  status: GitWatchStatus
  nextCheckAt: number
  nextFetchAt: number
  lastWarnings: Map<string, number>
}

const TICK_MS = 5000
const WARN_COOLDOWN_MS = 5 * 60 * 1000

function parseBranches(raw: string): string[] {
  return (raw || 'main, master')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function resolveRef(gitRoot: string, ref: string): Promise<string | null> {
  const result = await runGit(gitRoot, ['rev-parse', '--verify', '--quiet', ref])
  const sha = result.stdout.trim()
  if (!result.ok || !/^[0-9a-f]{7,64}$/i.test(sha)) return null
  return sha
}

/**
 * Git 主分支监听：轮询本地仓库的远程跟踪分支，发现新提交后自动触发发布。
 * 首次开启只记录基线，不会立即发布；工作区 HEAD 与新提交不一致时跳过并告警。
 */
export class GitWatcher {
  private timer: NodeJS.Timeout | null = null
  private initialTimer: NodeJS.Timeout | null = null
  private runtimes = new Map<string, ProjectRuntime>()
  private ticking = false
  private logSeq = 0

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.initialTimer = setTimeout(() => {
      void this.tick()
    }, 2500)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.timer = null
    this.initialTimer = null
  }

  getStatus(projectId: string): GitWatchStatus {
    const project = configStore.getProjectRaw(projectId)
    if (!project) {
      return { projectId, enabled: false, branches: [], error: '项目不存在' }
    }
    const runtime = this.runtimes.get(projectId)
    return (
      runtime?.status ?? {
        projectId,
        enabled: Boolean(project.gitWatch?.enabled),
        branches: []
      }
    )
  }

  /** 立即检查一次（可能触发发布），用于界面上的「立即检查」 */
  async checkNow(projectId: string): Promise<GitWatchStatus> {
    const project = configStore.getProjectRaw(projectId)
    if (!project) {
      return { projectId, enabled: false, branches: [], error: '项目不存在' }
    }
    if (!project.gitWatch?.enabled) {
      return { projectId, enabled: false, branches: [], error: '未开启 Git 自动发布' }
    }
    const runtime = this.runtime(projectId)
    await this.checkProject(project, runtime, true)
    return runtime.status
  }

  private runtime(projectId: string): ProjectRuntime {
    let runtime = this.runtimes.get(projectId)
    if (!runtime) {
      runtime = {
        status: { projectId, enabled: true, branches: [] },
        nextCheckAt: 0,
        nextFetchAt: 0,
        lastWarnings: new Map()
      }
      this.runtimes.set(projectId, runtime)
    }
    return runtime
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const alive = new Set<string>()
      for (const project of configStore.getProjectsRaw()) {
        const config = project.gitWatch
        if (!config?.enabled) {
          const runtime = this.runtimes.get(project.id)
          if (runtime) {
            // 应用运行期间关闭监听：清空基线，再次开启时重新记录，避免补发历史提交
            this.runtimes.delete(project.id)
            await configStore.setGitStates(project.id, {})
          }
          continue
        }
        alive.add(project.id)
        const runtime = this.runtime(project.id)
        if (now < runtime.nextCheckAt) continue
        runtime.nextCheckAt = now + Math.max(5, Number(config.intervalSec) || 15) * 1000
        await this.checkProject(project, runtime, false)
      }
      for (const projectId of Array.from(this.runtimes.keys())) {
        if (!alive.has(projectId)) this.runtimes.delete(projectId)
      }
    } finally {
      this.ticking = false
    }
  }

  private async checkProject(
    project: Project,
    runtime: ProjectRuntime,
    manual: boolean
  ): Promise<void> {
    const config = project.gitWatch
    const now = Date.now()
    const projectId = project.id
    const localPath = (project.localPath || '').trim()

    runtime.status = {
      projectId,
      enabled: Boolean(config.enabled),
      branches: [],
      lastChecked: new Date().toISOString()
    }

    if (!localPath) {
      this.setError(runtime, '未配置本地项目目录')
      return
    }

    const topLevel = await runGit(localPath, ['rev-parse', '--show-toplevel'])
    if (!topLevel.ok) {
      this.setError(runtime, '本地目录不是 Git 仓库，或系统未安装 git')
      return
    }
    const gitRoot = topLevel.stdout.trim() || localPath
    const remote = (config.remote || 'origin').trim() || 'origin'
    const triggerMode: 'own' | 'any' = config.triggerMode === 'any' ? 'any' : 'own'

    // 触发来源变化时重置基线，避免用旧模式的记录误触发
    const persistedMode = configStore.getGitTriggerMode(projectId)
    if (persistedMode !== triggerMode) {
      await configStore.setGitStates(projectId, {})
      await configStore.setGitTriggerMode(projectId, triggerMode)
      if (persistedMode) {
        this.log('INFO', `[${project.name}] 触发来源已切换，重新记录基线（不会立即发布）`)
      }
    }

    // 仅本机推送模式不需要感知别人的提交，因此不执行 fetch
    if (triggerMode === 'any' && config.fetchRemote && (manual || now >= runtime.nextFetchAt)) {
      runtime.nextFetchAt = now + Math.max(30, Number(config.fetchIntervalSec) || 300) * 1000
      const fetched = await runGit(gitRoot, ['fetch', remote, '--prune'], 60000)
      if (!fetched.ok) {
        this.warnOnce(runtime, 'fetch', `git fetch ${remote} 失败：${lastLine(fetched.stderr)}`)
      }
    }

    // 分支来源：环境级「自动发布分支」优先；没有配置时使用项目全局分支
    const autoEnvironments = project.environments.filter((env) => env.autoDeploy !== false)
    const environmentBranchEntries = autoEnvironments
      .map((environment) => ({
        environment,
        branch: (environment.gitBranch || '').trim()
      }))
      .filter((entry) => entry.branch !== '')

    const environmentsByBranch = new Map<string, string[]>()
    let branches: string[] = []
    if (environmentBranchEntries.length > 0) {
      for (const entry of environmentBranchEntries) {
        const list = environmentsByBranch.get(entry.branch) ?? []
        list.push(entry.environment.id)
        environmentsByBranch.set(entry.branch, list)
      }
      branches = Array.from(environmentsByBranch.keys())
    } else {
      branches = parseBranches(config.branches)
      const ids = autoEnvironments.map((env) => env.id)
      for (const branch of branches) environmentsByBranch.set(branch, ids)
    }
    if (branches.length === 0) {
      this.setError(runtime, '未配置监听分支：请为环境设置「自动发布分支」，或填写项目全局分支')
      return
    }

    const remotesResult = await runGit(gitRoot, ['remote'])
    const remotes = remotesResult.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const hasRemote = remotes.includes(remote)

    const snapshot: Record<string, string> = {}
    const branchStatuses: GitBranchStatus[] = []
    for (const branch of branches) {
      let sha: string | undefined
      if (triggerMode === 'own') {
        sha = (await latestPushedSha(gitRoot, remote, branch)) ?? undefined
      } else {
        const remoteSha = await resolveRef(gitRoot, `refs/remotes/${remote}/${branch}`)
        const localSha =
          !remoteSha && !hasRemote ? await resolveRef(gitRoot, `refs/heads/${branch}`) : null
        sha = remoteSha ?? localSha ?? undefined
      }
      if (sha) snapshot[branch] = sha
      branchStatuses.push({ branch, sha, checkedAt: runtime.status.lastChecked })
    }
    runtime.status.branches = branchStatuses
    runtime.status.error = undefined

    if (Object.keys(snapshot).length === 0) {
      this.setError(
        runtime,
        triggerMode === 'own'
          ? `未检测到本机向 ${remote}/${branches.join('、')} 的推送记录；请在本地执行 git push，或把触发来源改为“任意人推送”`
          : hasRemote
            ? `未找到 ${remote}/${branches.join('、')}，请确认分支已推送到远程`
            : `未找到本地分支 ${branches.join('、')}`
      )
      return
    }

    const stored = configStore.getGitStates(projectId)
    const baselines: Record<string, string> = {}
    const changed: Array<{ branch: string; sha: string }> = []
    for (const [branch, sha] of Object.entries(snapshot)) {
      if (!stored[branch]) baselines[branch] = sha
      else if (stored[branch] !== sha) changed.push({ branch, sha })
    }

    if (changed.length === 0) {
      if (Object.keys(baselines).length > 0) {
        await configStore.setGitStates(projectId, { ...stored, ...baselines })
        const detail = Object.entries(baselines)
          .map(([branch, sha]) => `${remote}/${branch}=${sha.slice(0, 7)}`)
          .join('，')
        this.log('INFO', `[${project.name}] 已记录主分支基线：${detail}（不触发发布）`)
      }
      return
    }

    const isolated = Boolean(config.isolatedWorkspace)
    let trigger: { branch: string; sha: string }

    if (isolated) {
      // 独立工作区模式：从指定提交检出构建，不要求用户工作区在该提交上
      trigger = changed[0]
    } else {
      // 默认模式：工作区 HEAD 必须正好在触发提交上，避免构建未推送/未拉取的代码
      const headResult = await runGit(gitRoot, ['rev-parse', 'HEAD'])
      const head = headResult.ok ? headResult.stdout.trim() : ''
      const matched = changed.find((c) => c.sha === head)
      if (!matched) {
        const first = changed[0]
        this.warnOnce(
          runtime,
          `head:${first.sha}`,
          `[${project.name}] 检测到 ${remote}/${first.branch} 更新（${first.sha.slice(0, 7)}），但当前工作区 HEAD 不在该提交上；请切换到该分支并 git pull，之后会自动发布`
        )
        return
      }
      trigger = matched
    }

    if (deployEngine.isRunning()) {
      this.warnOnce(
        runtime,
        `busy:${trigger.sha}`,
        `[${project.name}] 检测到 ${remote}/${trigger.branch} 更新（${trigger.sha.slice(0, 7)}），但已有任务在执行，稍后重试`
      )
      return
    }

    const environmentIds = environmentsByBranch.get(trigger.branch) ?? []
    if (environmentIds.length === 0) {
      this.warnOnce(
        runtime,
        `notarget:${trigger.sha}`,
        `[${project.name}] 分支 ${trigger.branch} 没有关联的自动发布环境，已跳过`
      )
      await configStore.setGitStates(projectId, { ...stored, ...snapshot })
      return
    }
    const triggerEnvironments = project.environments.filter((env) =>
      environmentIds.includes(env.id)
    )

    const commitResult = await runGit(gitRoot, ['log', '-1', '--format=%h|%an|%s', trigger.sha])
    const commitInfo = commitResult.ok ? commitResult.stdout.trim() : ''
    const [shortSha, author, subject] = commitInfo.split('|')
    this.log(
      'OK',
      `[${project.name}] 检测到 ${remote}/${trigger.branch} 更新：${shortSha || trigger.sha.slice(0, 7)}${
        author ? `（${author}）` : ''
      }${subject ? ` ${subject}` : ''}`
    )
    this.log(
      'INFO',
      `[${project.name}] 触发自动发布${isolated ? '（独立工作区）' : ''} → ${triggerEnvironments
        .map((env) => env.name)
        .join('、')}`
    )

    const started = await deployEngine.start(
      {
        kind: 'deploy',
        projectId,
        environmentIds,
        source: isolated
          ? { mode: 'worktree', commit: trigger.sha, branch: trigger.branch }
          : undefined
      },
      this.activeWebContents()
    )
    if (!started.started) {
      this.warnOnce(
        runtime,
        `startfail:${trigger.sha}`,
        `[${project.name}] 自动发布启动失败：${started.message || '未知原因'}`
      )
      return
    }
    await configStore.setGitStates(projectId, { ...stored, ...snapshot })
  }

  private setError(runtime: ProjectRuntime, message: string): void {
    runtime.status.error = message
    this.warnOnce(runtime, `error:${message}`, message)
  }

  private warnOnce(runtime: ProjectRuntime, key: string, message: string): void {
    const last = runtime.lastWarnings.get(key) ?? 0
    if (Date.now() - last < WARN_COOLDOWN_MS) return
    runtime.lastWarnings.set(key, Date.now())
    this.log('WARN', message)
  }

  private log(level: LogLevel, msg: string): void {
    this.logSeq += 1
    const entry: LogEntry = { id: 1_000_000_000 + this.logSeq, ts: logTime(), level, msg }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('job:log', entry)
    }
    console.log(`[git-watch][${level}] ${msg}`)
  }

  private activeWebContents(): WebContents | null {
    const win = BrowserWindow.getAllWindows()[0]
    return win && !win.isDestroyed() ? win.webContents : null
  }
}

export const gitWatcher = new GitWatcher()
