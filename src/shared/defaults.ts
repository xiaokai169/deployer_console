import type { EnvironmentConfig, Project, ServerConfig } from './types'

export function uid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function createDefaultServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: uid(),
    name: '新服务器',
    host: '',
    port: 22,
    username: 'root',
    authType: 'key',
    privateKeyPath: '~/.ssh/id_rsa',
    ...overrides
  }
}

export function createDefaultEnvironment(
  name = '新环境',
  overrides: Partial<EnvironmentConfig> = {}
): EnvironmentConfig {
  return {
    id: uid(),
    name,
    serverId: '',
    rootDir: '/var/www/app',
    uploadDir: 'uploads',
    releasesDir: 'releases',
    currentLink: 'current',
    keepVersions: 5,
    protectPaths: [],
    hooks: { pre: '', post: '', rollback: '' },
    build: { buildCommand: '', distDir: '', envVars: '' },
    gitBranch: '',
    autoDeploy: true,
    ...overrides
  }
}

export function createDefaultProject(name = '新项目', overrides: Partial<Project> = {}): Project {
  const now = nowIso()
  return {
    id: uid(),
    name,
    type: 'vue',
    localPath: '',
    validation: {
      enabled: true,
      entryFile: 'index.html',
      minMB: 0,
      maxMB: 500
    },
    build: {
      buildCommand: 'npm run build',
      distDir: 'dist',
      package: true,
      archiveName: '{name}-{timestamp}.tar.gz',
      transfer: 'sftp',
      stagingDir: 'tmp/deploy-staging'
    },
    strategy: {
      failPolicy: 'stop',
      concurrency: 2,
      timeoutSec: 300,
      retries: 1
    },
    gitWatch: {
      enabled: false,
      triggerMode: 'own',
      branches: 'main, master',
      remote: 'origin',
      intervalSec: 15,
      fetchRemote: true,
      fetchIntervalSec: 300,
      isolatedWorkspace: true,
      installDeps: true,
      keepWorkspace: true,
      copyPaths: ''
    },
    targets: [],
    environments: [createDefaultEnvironment('测试环境'), createDefaultEnvironment('生产环境')],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

type LegacyTarget = Partial<ServerConfig> &
  Partial<EnvironmentConfig> & {
    backupDir?: string
  }

export function normalizeServer(input: Partial<ServerConfig>): ServerConfig {
  const base = createDefaultServer()
  // 旧结构中服务器对象还带有部署字段，保存时丢弃，避免残留
  const {
    rootDir: _rootDir,
    uploadDir: _uploadDir,
    releasesDir: _releasesDir,
    currentLink: _currentLink,
    keepVersions: _keepVersions,
    protectPaths: _protectPaths,
    hooks: _hooks,
    build: _build,
    gitBranch: _gitBranch,
    autoDeploy: _autoDeploy,
    backupDir: _backupDir,
    ...rest
  } = input as Partial<ServerConfig> & Record<string, unknown>
  return {
    ...base,
    ...(rest as Partial<ServerConfig>),
    id: input.id || base.id,
    name: input.name || base.name,
    host: input.host || '',
    port: Number(input.port) || 22,
    username: input.username || base.username,
    authType: input.authType === 'password' ? 'password' : 'key',
    privateKeyPath: input.privateKeyPath,
    password: undefined,
    passphrase: undefined,
    hasPassword: undefined,
    hasPassphrase: undefined
  }
}

export function normalizeEnvironment(input: Partial<EnvironmentConfig>): EnvironmentConfig {
  const base = createDefaultEnvironment(input.name || '新环境')
  return {
    ...base,
    ...input,
    id: input.id || base.id,
    name: input.name || base.name,
    serverId: input.serverId || '',
    rootDir: input.rootDir || base.rootDir,
    uploadDir: input.uploadDir || base.uploadDir,
    releasesDir: input.releasesDir || base.releasesDir,
    currentLink: input.currentLink || base.currentLink,
    keepVersions: Number(input.keepVersions) || base.keepVersions,
    protectPaths: input.protectPaths || [],
    hooks: { ...base.hooks, ...(input.hooks || {}) },
    build: { ...base.build, ...(input.build || {}) },
    gitBranch: input.gitBranch || '',
    autoDeploy: input.autoDeploy !== false
  }
}

export function normalizeProject(input: Partial<Project>): Project {
  const base = createDefaultProject(input.name || '未命名项目')
  // 兼容旧配置：上传包有效期已移除，压缩包改为解压后立即删除
  const buildInput = { ...(input.build || {}) } as Partial<Project['build']> & {
    retentionHours?: number
  }
  delete buildInput.retentionHours
  // 兼容旧配置：操作员不再手工配置，改为运行时读取 git user.name
  const strategyInput = { ...(input.strategy || {}) } as Partial<Project['strategy']> & {
    operator?: string
  }
  delete strategyInput.operator
  // 兼容旧配置：已移除 PHP 类型，统一迁移为静态站点
  const rawType = (input as { type?: string }).type
  let type: Project['type'] = base.type
  if (rawType === 'vue' || rawType === 'static') type = rawType
  else if (rawType === 'php') type = 'static'

  const raw = input as Partial<Project> & { environments?: unknown; targets?: unknown }
  const hasNewSchema = Array.isArray(raw.environments)
  let targets: ServerConfig[]
  let environments: EnvironmentConfig[]

  if (hasNewSchema) {
    targets = (Array.isArray(raw.targets) ? raw.targets : []).map((server) =>
      normalizeServer(server as Partial<ServerConfig>)
    )
    environments = (raw.environments as Partial<EnvironmentConfig>[]).map((env, index) =>
      normalizeEnvironment({ name: `环境 ${index + 1}`, ...env })
    )
  } else {
    // 旧结构：target = 服务器 + 部署配置，拆分为服务器连接 + 环境
    const legacyTargets = (Array.isArray(raw.targets) ? raw.targets : []) as LegacyTarget[]
    if (legacyTargets.length === 0) {
      targets = []
      environments = base.environments
    } else {
      targets = []
      environments = []
      for (const legacy of legacyTargets) {
        const server = normalizeServer({ ...legacy, id: uid() })
        targets.push(server)
        environments.push(
          normalizeEnvironment({
            id: legacy.id || uid(),
            name: legacy.name || '环境',
            serverId: server.id,
            rootDir: legacy.rootDir,
            uploadDir: legacy.uploadDir,
            releasesDir: legacy.releasesDir,
            currentLink: legacy.currentLink,
            keepVersions: legacy.keepVersions,
            protectPaths: legacy.protectPaths,
            hooks: legacy.hooks,
            build: legacy.build,
            gitBranch: legacy.gitBranch,
            autoDeploy: legacy.autoDeploy
          })
        )
      }
    }
  }

  return {
    ...base,
    ...input,
    type,
    validation: { ...base.validation, ...(input.validation || {}) },
    build: { ...base.build, ...buildInput },
    strategy: { ...base.strategy, ...strategyInput },
    gitWatch: { ...base.gitWatch, ...(input.gitWatch || {}) },
    targets,
    environments
  }
}
