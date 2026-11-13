export type ProjectType = 'vue' | 'static'
export type TransferMethod = 'sftp' | 'rsync'
export type FailPolicy = 'stop' | 'continue' | 'rollback'
export type ProtectMode = 'skip' | 'symlink' | 'copy'
export type AuthType = 'key' | 'password'

export type LogLevel = 'INFO' | 'OK' | 'WARN' | 'ERROR' | 'CMD'

export interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  msg: string
  targetId?: string
}

export interface ProtectPath {
  id: string
  path: string
  mode: ProtectMode
}

export interface TargetHooks {
  pre: string
  post: string
  rollback: string
}

export interface TargetBuildConfig {
  /** 留空继承项目构建命令 */
  buildCommand: string
  /** 留空继承项目产物目录 */
  distDir: string
  /** 构建期环境变量，每行 KEY=VALUE */
  envVars: string
}

/** 服务器连接配置（项目下共享的服务器池） */
export interface ServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  /** 仅提交时写入，落盘前加密，读取时永远不下发 */
  password?: string
  passphrase?: string
  hasPassword?: boolean
  hasPassphrase?: boolean
}

/** 环境部署配置（测试环境 / 生产环境） */
export interface EnvironmentConfig {
  id: string
  name: string
  /** 引用 ServerConfig.id */
  serverId: string
  rootDir: string
  uploadDir: string
  releasesDir: string
  currentLink: string
  keepVersions: number
  protectPaths: ProtectPath[]
  hooks: TargetHooks
  /** 环境级构建覆盖（留空继承项目） */
  build: TargetBuildConfig
  /** 自动发布监听分支；留空时使用项目全局分支 */
  gitBranch: string
  /** 是否参与 Git 自动发布 */
  autoDeploy: boolean
}

/** 运行时合并后的部署目标（服务器连接 + 环境部署配置） */
export interface Target extends ServerConfig {
  rootDir: string
  uploadDir: string
  releasesDir: string
  currentLink: string
  keepVersions: number
  protectPaths: ProtectPath[]
  hooks: TargetHooks
  build: TargetBuildConfig
  gitBranch: string
  autoDeploy: boolean
}

export interface ValidationConfig {
  enabled: boolean
  entryFile: string
  minMB: number
  maxMB: number
}

export interface BuildConfig {
  buildCommand: string
  distDir: string
  package: boolean
  archiveName: string
  transfer: TransferMethod
  stagingDir: string
}

export interface StrategyConfig {
  failPolicy: FailPolicy
  concurrency: number
  timeoutSec: number
  retries: number
}

export type GitTriggerMode = 'own' | 'any'

export interface GitWatchConfig {
  enabled: boolean
  /** 触发来源：own = 只响应本机推送；any = 任意人推送（依赖定时 fetch） */
  triggerMode: GitTriggerMode
  /** 以逗号/空格分隔的分支名，默认 main, master */
  branches: string
  /** 远程名，默认 origin */
  remote: string
  /** 检查间隔（秒） */
  intervalSec: number
  /** 是否定期 git fetch 以感知他人推送 */
  fetchRemote: boolean
  /** fetch 间隔（秒） */
  fetchIntervalSec: number
  /** 使用独立 worktree 构建，不影响当前分支与工作区 */
  isolatedWorkspace: boolean
  /** 锁文件变化时自动安装依赖 */
  installDeps: boolean
  /** 保留部署工作区以复用依赖 */
  keepWorkspace: boolean
  /** 构建前从主工作区复制的路径（逗号/换行分隔，如 .env） */
  copyPaths: string
}

export interface JobSource {
  mode: 'local' | 'worktree'
  commit?: string
  branch?: string
}

export interface Project {
  id: string
  name: string
  type: ProjectType
  localPath: string
  validation: ValidationConfig
  build: BuildConfig
  strategy: StrategyConfig
  gitWatch: GitWatchConfig
  /** 服务器连接池（只保存连接信息） */
  targets: ServerConfig[]
  /** 环境（测试 / 生产），每个环境选择一个服务器并配置部署参数 */
  environments: EnvironmentConfig[]
  createdAt: string
  updatedAt: string
}

export type JobKind = 'preflight' | 'build' | 'deploy' | 'deploy-only' | 'rollback'
export type JobStatus = 'idle' | 'running' | 'success' | 'failed' | 'canceled'

export interface JobState {
  kind: JobKind | null
  status: JobStatus
  stage: string
  percent: number
  text: string
}

export interface JobStartPayload {
  kind: JobKind
  projectId: string
  /** 参与本次任务的环境 ID */
  environmentIds: string[]
  releaseName?: string
  /** 构建来源：默认使用用户本地工作区；worktree 表示从独立部署工作区构建 */
  source?: JobSource
  /** 仅发布模式必须指定：要发布的产物快照 */
  snapshotId?: string
}

export interface ManifestEntry {
  size: number
  hash: string
}

export type Manifest = Record<string, ManifestEntry>

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  size?: number
}

export interface DiffResult {
  added: number
  modified: number
  deleted: number
  files: FileChange[]
}

export interface DiffPayload {
  targetId?: string
  diff: DiffResult
}

export interface ReleaseInfo {
  name: string
  current: boolean
  mtime?: string
  operator?: string
  rollbackable: boolean
}

export interface ReleaseRecord {
  name: string
  operator: string
  createdAt: string
  /** 本次发布使用的产物快照 */
  snapshotId?: string
  commit?: string
}

/** 产物快照的元信息：记录这份产物由什么配置、为哪些环境构建 */
export interface SnapshotMeta {
  id: string
  projectId: string
  projectName: string
  createdAt: string
  branch?: string
  commit?: string
  buildCommand: string
  distDir: string
  /** 构建配置签名（命令 + 产物目录 + 环境变量） */
  profileKey: string
  /** profileKey 的短指纹，用于和目标环境当前配置比对 */
  profileFingerprint: string
  environmentIds: string[]
  environmentNames: string[]
  fileCount: number
  totalBytes: number
  /** 文件清单根哈希，用于追溯与校验 */
  manifestHash: string
  source: 'local' | 'worktree'
}

export interface ArtifactSnapshot extends SnapshotMeta {
  /** 快照文件是否还在磁盘上 */
  available: boolean
}

/** 一次构建 / 发布 / 回滚的流水记录 */
export interface FlowRecord {
  id: string
  projectId: string
  kind: JobKind
  status: JobStatus
  startedAt: string
  finishedAt?: string
  message?: string
  environmentIds: string[]
  snapshotId?: string
  /** 本次任务产生的日志条数，详情请查看当日志 */
  logCount: number
}

export interface EncryptedPayload {
  alg: string
  kdf: string
  salt: string
  iv: string
  tag: string
  data: string
}

export interface ProjectExportOptions {
  includeSecrets: boolean
  passphrase?: string
}

export interface ExportProjectResult {
  saved: boolean
  canceled?: boolean
  path?: string
  message?: string
  includedSecrets?: boolean
}

export interface SelectImportResult {
  canceled: boolean
  fileName?: string
  needsPassphrase?: boolean
  projectName?: string
  error?: string
}

export interface ImportProjectResult {
  ok: boolean
  project?: Project
  warnings?: string[]
  needsPassphrase?: boolean
  message?: string
}

export interface ProjectExportFile {
  format: 'deploye-project'
  version: number
  exportedAt: string
  project: Project
  secrets?: EncryptedPayload
}

export interface TeamRepoConfig {
  /** 复用某个已配置目标服务器的连接（推荐），设置后忽略下面的自定义连接字段 */
  linkTargetId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  /** 仓库目录，相对于服务器用户主目录或绝对路径，默认 ~/.deploye-config */
  baseDir: string
  /** 以下字段只在本机使用，保存时加密，永远不会随项目配置共享 */
  password?: string
  passphrase?: string
  hasPassword?: boolean
  hasPassphrase?: boolean
}

export interface TeamProjectInfo {
  fileName: string
  name: string
  publisher?: string
  publishedAt?: string
  targets?: number
}

export interface TeamRepoTestResult {
  ok: boolean
  message: string
}

export interface TeamRepoListResult {
  ok: boolean
  message?: string
  projects: TeamProjectInfo[]
  /** 实际解析到的仓库目录，便于排查“看不到项目” */
  dir?: string
}

export interface TeamOperationResult {
  ok: boolean
  message?: string
  project?: Project
  warnings?: string[]
}

export interface GitBranchStatus {
  branch: string
  sha?: string
  checkedAt?: string
}

export interface GitWatchStatus {
  projectId: string
  enabled: boolean
  lastChecked?: string
  branches: GitBranchStatus[]
  error?: string
}

export interface WorkspaceStatus {
  path: string
  exists: boolean
  head?: string
}

export interface CleanWorkspaceResult {
  ok: boolean
  message: string
}

export interface TargetTestResult {
  ok: boolean
  message: string
}

export interface StartJobResult {
  started: boolean
  message?: string
}

export interface ExportLogsResult {
  saved: boolean
  path?: string
}

export type UpdateStatus =
  | 'idle'
  | 'unavailable'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  /** 新版本号（发现更新后才有） */
  version?: string
  /** 下载进度 0-100 */
  percent?: number
  message?: string
  /** 是否支持自动更新（打包安装后为 true，开发模式为 false） */
  enabled: boolean
}

export interface ProgressPayload {
  percent: number
  text: string
}

export interface StagePayload {
  stage: string
  label: string
}

export interface DeployeApi {
  listProjects(): Promise<Project[]>
  saveProject(project: Project): Promise<Project>
  deleteProject(id: string): Promise<void>
  exportProject(projectId: string, options: ProjectExportOptions): Promise<ExportProjectResult>
  selectImportFile(): Promise<SelectImportResult>
  importProject(passphrase?: string): Promise<ImportProjectResult>
  getTeamRepo(): Promise<TeamRepoConfig | null>
  saveTeamRepo(config: TeamRepoConfig): Promise<TeamRepoConfig>
  testTeamRepo(): Promise<TeamRepoTestResult>
  listTeamProjects(): Promise<TeamRepoListResult>
  publishTeamProject(projectId: string, password: string): Promise<TeamOperationResult>
  fetchTeamProject(fileName: string, password: string): Promise<TeamOperationResult>
  pickDirectory(): Promise<string | null>
  pickKeyFile(): Promise<string | null>
  testServer(projectId: string, serverId: string): Promise<TargetTestResult>
  /** 测试尚未保存的服务器配置（表单里的「测试连接」） */
  testServerDraft(projectId: string, server: ServerConfig): Promise<TargetTestResult>
  listEnvironmentReleases(projectId: string, environmentId: string): Promise<ReleaseInfo[]>
  listSnapshots(projectId: string): Promise<ArtifactSnapshot[]>
  deleteSnapshot(projectId: string, snapshotId: string): Promise<{ ok: boolean; message?: string }>
  listFlows(projectId: string): Promise<FlowRecord[]>
  clearFlows(projectId: string): Promise<void>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdateState(cb: (state: UpdateState) => void): number
  getOperator(projectId: string): Promise<string>
  getGitStatus(projectId: string): Promise<GitWatchStatus>
  checkGitNow(projectId: string): Promise<GitWatchStatus>
  getWorkspaceStatus(projectId: string): Promise<WorkspaceStatus>
  cleanWorkspace(projectId: string): Promise<CleanWorkspaceResult>
  startJob(payload: JobStartPayload): Promise<StartJobResult>
  cancelJob(): Promise<void>
  getJobState(): Promise<JobState>
  exportLogs(content: string): Promise<ExportLogsResult>
  onLog(cb: (entry: LogEntry) => void): number
  onProgress(cb: (payload: ProgressPayload) => void): number
  onStage(cb: (payload: StagePayload) => void): number
  onState(cb: (state: JobState) => void): number
  onDiff(cb: (payload: DiffPayload) => void): number
  onDone(cb: (payload: { status: JobStatus; message?: string }) => void): number
  off(subscriptionId: number): void
}
