import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  EnvironmentConfig,
  FlowRecord,
  Manifest,
  Project,
  ReleaseRecord,
  ServerConfig,
  TeamRepoConfig
} from '@shared/types'
import {
  normalizeEnvironment,
  normalizeProject,
  normalizeServer,
  nowIso
} from '@shared/defaults'
import { decryptSecret, encryptSecret } from './secrets'

export interface TargetSecret {
  password?: string
  passphrase?: string
}

interface PersistedData {
  version: number
  projects: Project[]
  secrets: Record<string, TargetSecret>
  manifests: Record<string, Manifest>
  history: Record<string, ReleaseRecord[]>
  /** projectId -> 构建/发布流水记录 */
  flows: Record<string, FlowRecord[]>
  /** projectId -> branch -> 最近一次已处理的提交 SHA */
  gitStates: Record<string, Record<string, string>>
  /** projectId -> 触发来源，用于切换模式时重置基线 */
  gitTriggerModes: Record<string, string>
  /** 团队配置仓库连接（本机专用，不含密码明文） */
  teamRepo?: TeamRepoConfig
  teamRepoSecret?: TargetSecret
}

const EMPTY_DATA: PersistedData = {
  version: 1,
  projects: [],
  secrets: {},
  manifests: {},
  history: {},
  flows: {},
  gitStates: {},
  gitTriggerModes: {}
}

export function manifestKey(projectId: string, targetId: string): string {
  return `${projectId}:${targetId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export class ConfigStore {
  private filePath = ''
  private data: PersistedData = { ...EMPTY_DATA }
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  private resolveFilePath(): string {
    if (!this.filePath) this.filePath = join(app.getPath('userData'), 'deploye.json')
    return this.filePath
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const file = this.resolveFilePath()
    let migrated = false
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed)) {
        const rawProjects = Array.isArray(parsed.projects)
          ? (parsed.projects as Partial<Project>[])
          : []
        const projects = rawProjects.map((project) => normalizeProject(project))
        this.data = {
          version: 1,
          projects,
          secrets: isRecord(parsed.secrets) ? (parsed.secrets as Record<string, TargetSecret>) : {},
          manifests: isRecord(parsed.manifests) ? (parsed.manifests as Record<string, Manifest>) : {},
          history: isRecord(parsed.history) ? (parsed.history as Record<string, ReleaseRecord[]>) : {},
          flows: isRecord(parsed.flows) ? (parsed.flows as Record<string, FlowRecord[]>) : {},
          gitStates: isRecord(parsed.gitStates)
            ? (parsed.gitStates as Record<string, Record<string, string>>)
            : {},
          gitTriggerModes: isRecord(parsed.gitTriggerModes)
            ? (parsed.gitTriggerModes as Record<string, string>)
            : {},
          teamRepo: isRecord(parsed.teamRepo)
            ? (parsed.teamRepo as unknown as TeamRepoConfig)
            : undefined,
          teamRepoSecret: isRecord(parsed.teamRepoSecret)
            ? (parsed.teamRepoSecret as TargetSecret)
            : undefined
        }

        // 旧结构迁移：target 拆分为「服务器 + 环境」，密钥从旧 target id 移到新服务器 id
        for (let index = 0; index < rawProjects.length; index += 1) {
          const rawProject = rawProjects[index] as Record<string, unknown>
          if (Array.isArray(rawProject.environments)) continue
          const legacyTargets = Array.isArray(rawProject.targets)
            ? (rawProject.targets as Record<string, unknown>[])
            : []
          if (legacyTargets.length > 0) migrated = true
          const normalized = projects[index]
          for (const legacy of legacyTargets) {
            const legacyId = typeof legacy.id === 'string' ? legacy.id : ''
            if (!legacyId) continue
            const environment = normalized.environments.find((env) => env.id === legacyId)
            if (!environment) continue
            const stored = this.data.secrets[legacyId]
            if (stored) {
              this.data.secrets[environment.serverId] = stored
              delete this.data.secrets[legacyId]
            }
          }
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error('[config] 配置读取失败，已重置:', err)
        try {
          await fs.rename(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          /* ignore */
        }
      }
      this.data = {
        ...EMPTY_DATA,
        projects: [],
        secrets: {},
        manifests: {},
        history: {},
        flows: {},
        gitStates: {},
        gitTriggerModes: {}
      }
    }
    this.loaded = true
    // 旧结构迁移后立即落盘，避免每次启动重新生成服务器 ID
    if (migrated) await this.persist()
  }

  private persist(): Promise<void> {
    if (!this.loaded) return Promise.resolve()
    const payload = JSON.stringify(this.data, null, 2)
    const file = this.resolveFilePath()
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${file}.tmp`
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, file)
      })
    return this.writeQueue
  }

  private toClient(project: Project): Project {
    return {
      ...project,
      targets: project.targets.map((server) => ({
        ...server,
        password: undefined,
        passphrase: undefined,
        hasPassword: Boolean(this.data.secrets[server.id]?.password),
        hasPassphrase: Boolean(this.data.secrets[server.id]?.passphrase)
      }))
    }
  }

  listProjects(): Project[] {
    return this.data.projects.map((p) => this.toClient(p))
  }

  getProjectRaw(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id)
  }

  getProjectsRaw(): Project[] {
    return this.data.projects
  }

  getGitStates(projectId: string): Record<string, string> {
    return this.data.gitStates[projectId] ?? {}
  }

  async setGitStates(projectId: string, states: Record<string, string>): Promise<void> {
    if (Object.keys(states).length === 0) delete this.data.gitStates[projectId]
    else this.data.gitStates[projectId] = { ...states }
    await this.persist()
  }

  getGitTriggerMode(projectId: string): string | undefined {
    return this.data.gitTriggerModes[projectId]
  }

  async setGitTriggerMode(projectId: string, mode: string): Promise<void> {
    this.data.gitTriggerModes[projectId] = mode
    await this.persist()
  }

  getTeamRepo(): TeamRepoConfig | null {
    if (!this.data.teamRepo) return null
    return {
      ...this.data.teamRepo,
      password: undefined,
      passphrase: undefined,
      hasPassword: Boolean(this.data.teamRepoSecret?.password),
      hasPassphrase: Boolean(this.data.teamRepoSecret?.passphrase)
    }
  }

  getTeamRepoSecret(): TargetSecret {
    const stored = this.data.teamRepoSecret
    if (!stored) return {}
    return {
      password: stored.password ? decryptSecret(stored.password) : undefined,
      passphrase: stored.passphrase ? decryptSecret(stored.passphrase) : undefined
    }
  }

  async saveTeamRepo(input: TeamRepoConfig): Promise<TeamRepoConfig> {
    const secret: TargetSecret = { ...(this.data.teamRepoSecret || {}) }
    if (input.password) secret.password = encryptSecret(input.password)
    if (input.passphrase) secret.passphrase = encryptSecret(input.passphrase)
    this.data.teamRepoSecret = secret
    this.data.teamRepo = {
      linkTargetId: input.linkTargetId,
      host: input.linkTargetId ? '' : input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      privateKeyPath: input.linkTargetId ? undefined : input.privateKeyPath,
      baseDir: input.baseDir
    }
    await this.persist()
    return this.getTeamRepo() as TeamRepoConfig
  }

  getServer(projectId: string, serverId: string): ServerConfig | undefined {
    return this.getProjectRaw(projectId)?.targets.find((s) => s.id === serverId)
  }

  getEnvironment(projectId: string, environmentId: string): EnvironmentConfig | undefined {
    return this.getProjectRaw(projectId)?.environments.find((e) => e.id === environmentId)
  }

  async saveProject(input: Project): Promise<Project> {
    const now = nowIso()
    const index = this.data.projects.findIndex((p) => p.id === input.id)
    const createdAt = index >= 0 ? this.data.projects[index].createdAt : input.createdAt || now

    for (const server of input.targets) {
      const existing = this.data.secrets[server.id] || {}
      const next: TargetSecret = { ...existing }
      if (server.password) next.password = encryptSecret(server.password)
      if (server.passphrase) next.passphrase = encryptSecret(server.passphrase)
      if (next.password || next.passphrase) this.data.secrets[server.id] = next
    }

    const project: Project = {
      ...input,
      createdAt,
      updatedAt: now,
      targets: input.targets.map((server) => normalizeServer(server)),
      environments: input.environments.map((env) => normalizeEnvironment(env))
    }

    if (index >= 0) this.data.projects[index] = project
    else this.data.projects.push(project)

    // 清理已删除服务器的密钥
    const validIds = new Set(this.data.projects.flatMap((p) => p.targets.map((s) => s.id)))
    for (const key of Object.keys(this.data.secrets)) {
      if (!validIds.has(key)) delete this.data.secrets[key]
    }

    await this.persist()
    return this.toClient(project)
  }

  async deleteProject(id: string): Promise<void> {
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    delete this.data.flows[id]
    for (const key of Object.keys(this.data.manifests)) {
      if (key.startsWith(`${id}:`)) delete this.data.manifests[key]
    }
    for (const key of Object.keys(this.data.history)) {
      if (key.startsWith(`${id}:`)) delete this.data.history[key]
    }
    await this.persist()
  }

  getSecret(targetId: string): TargetSecret {
    const stored = this.data.secrets[targetId]
    if (!stored) return {}
    return {
      password: stored.password ? decryptSecret(stored.password) : undefined,
      passphrase: stored.passphrase ? decryptSecret(stored.passphrase) : undefined
    }
  }

  getManifest(projectId: string, targetId: string): Manifest | null {
    return this.data.manifests[manifestKey(projectId, targetId)] ?? null
  }

  async setManifest(projectId: string, targetId: string, manifest: Manifest): Promise<void> {
    this.data.manifests[manifestKey(projectId, targetId)] = manifest
    await this.persist()
  }

  getHistory(projectId: string, targetId: string): ReleaseRecord[] {
    return this.data.history[manifestKey(projectId, targetId)] ?? []
  }

  async addHistory(projectId: string, targetId: string, record: ReleaseRecord): Promise<void> {
    const key = manifestKey(projectId, targetId)
    const list = (this.data.history[key] || []).filter((r) => r.name !== record.name)
    list.unshift(record)
    this.data.history[key] = list.slice(0, 100)
    await this.persist()
  }

  listFlows(projectId: string): FlowRecord[] {
    return this.data.flows[projectId] ?? []
  }

  async addFlow(projectId: string, record: FlowRecord): Promise<void> {
    const list = this.data.flows[projectId] ?? []
    list.unshift(record)
    this.data.flows[projectId] = list.slice(0, 200)
    await this.persist()
  }

  async clearFlows(projectId: string): Promise<void> {
    delete this.data.flows[projectId]
    await this.persist()
  }
}

export const configStore = new ConfigStore()
