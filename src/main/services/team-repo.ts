import type {
  EncryptedPayload,
  Project,
  ServerConfig,
  TeamOperationResult,
  TeamProjectInfo,
  TeamRepoConfig,
  TeamRepoListResult,
  TeamRepoTestResult
} from '@shared/types'
import { normalizeProject } from '@shared/defaults'
import { pjoin, shq } from '../utils/shell'
import { configStore } from './config-store'
import { resolveOperator } from './operator'
import { buildImportedProject, collectImportWarnings } from './project-import'
import { friendlySshError, SshClient, type SshSecret } from './ssh-client'
import { decryptJson, encryptJson } from './transfer-crypto'

const FILE_FORMAT = 'deploye-team-share'
const DEFAULT_DIR = '.deploye-config'

interface ShareMeta {
  name: string
  publisher?: string
  publishedAt?: string
  targets?: number
}

interface ShareFile {
  format: string
  version: number
  meta: ShareMeta
  payload: EncryptedPayload
}

interface RepoConnection {
  server: ServerConfig
  secret: SshSecret
  label: string
}

/** 解析仓库连接：优先复用已配置的服务器，其次使用自定义连接 */
function resolveRepoConnection(config: TeamRepoConfig): RepoConnection {
  if (config.linkTargetId) {
    for (const project of configStore.getProjectsRaw()) {
      const server = project.targets.find((t) => t.id === config.linkTargetId)
      if (server) {
        return {
          server,
          secret: configStore.getSecret(server.id),
          label: `${project.name} / ${server.name}`
        }
      }
    }
    throw new Error('关联的服务器已被删除，请重新选择团队配置仓库连接')
  }

  const server: ServerConfig = {
    id: 'team-repo',
    name: '团队配置仓库',
    host: config.host,
    port: config.port || 22,
    username: config.username,
    authType: config.authType,
    privateKeyPath: config.privateKeyPath
  }
  return { server, secret: configStore.getTeamRepoSecret(), label: '自定义连接' }
}

function requireRepoConfig(): { config: TeamRepoConfig; connection: RepoConnection } {
  const config = configStore.getTeamRepo()
  if (!config?.linkTargetId && !config?.host) {
    throw new Error('请先配置团队配置仓库连接')
  }
  return { config, connection: resolveRepoConnection(config) }
}

async function resolveBaseDir(ssh: SshClient, baseDir: string): Promise<string> {
  const raw = (baseDir || DEFAULT_DIR).trim()
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/'
  const home = (await ssh.exec('printf %s "$HOME"')).stdout.trim()
  if (!home) throw new Error('无法解析服务器用户主目录')
  const rel = raw.replace(/^~[\\/]?/, '')
  return pjoin(home, rel)
}

function slugify(name: string): string {
  return (
    (name || 'project')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project'
  )
}

function stripCredentials(project: Project): Project {
  const clone = normalizeProject(project)
  clone.targets = clone.targets.map((target) => ({
    ...target,
    password: undefined,
    passphrase: undefined,
    hasPassword: undefined,
    hasPassphrase: undefined
  }))
  return clone
}

export async function testTeamRepo(): Promise<TeamRepoTestResult> {
  let config: TeamRepoConfig
  let connection: RepoConnection
  try {
    const resolved = requireRepoConfig()
    config = resolved.config
    connection = resolved.connection
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  const ssh = new SshClient(connection.server, connection.secret, 20000)
  try {
    await ssh.connect()
    const dir = await resolveBaseDir(ssh, config.baseDir)
    const check = await ssh.exec(`mkdir -p ${shq(dir)} && test -w ${shq(dir)}`, {
      timeoutMs: 15000
    })
    if (check.code !== 0) return { ok: false, message: `已连接，但无法写入仓库目录：${dir}` }
    return { ok: true, message: `连接成功（${connection.label}），仓库目录：${dir}` }
  } catch (err) {
    return { ok: false, message: friendlySshError(err) }
  } finally {
    ssh.close()
  }
}

export async function listTeamProjects(): Promise<TeamRepoListResult> {
  let config: TeamRepoConfig
  let connection: RepoConnection
  try {
    const resolved = requireRepoConfig()
    config = resolved.config
    connection = resolved.connection
  } catch (err) {
    return { ok: false, message: (err as Error).message, projects: [] }
  }
  const ssh = new SshClient(connection.server, connection.secret, 20000)
  let dir: string | undefined
  try {
    await ssh.connect()
    dir = await resolveBaseDir(ssh, config.baseDir)
    const exists = await ssh.exec(`test -d ${shq(dir)}`)
    if (exists.code !== 0) {
      return {
        ok: true,
        projects: [],
        dir,
        message: `仓库目录尚不存在：${dir}（发布配置时会自动创建）`
      }
    }

    const entries = await ssh.listDir(dir)
    const projects: TeamProjectInfo[] = []
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        const content = await ssh.readFile(pjoin(dir, entry.name))
        const parsed = JSON.parse(content.toString('utf8')) as ShareFile
        if (parsed?.format !== FILE_FORMAT || !parsed.meta) continue
        projects.push({
          fileName: entry.name,
          name: String(parsed.meta.name || entry.name),
          publisher: parsed.meta.publisher ? String(parsed.meta.publisher) : undefined,
          publishedAt: parsed.meta.publishedAt ? String(parsed.meta.publishedAt) : undefined,
          targets: typeof parsed.meta.targets === 'number' ? parsed.meta.targets : undefined
        })
      } catch {
        /* 跳过损坏或非项目文件 */
      }
    }
    projects.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
    return {
      ok: true,
      projects,
      dir,
      message:
        projects.length > 0
          ? `共 ${projects.length} 个项目（仓库目录：${dir}）`
          : `仓库目录 ${dir} 中没有找到项目配置`
    }
  } catch (err) {
    return { ok: false, message: friendlySshError(err), projects: [], dir }
  } finally {
    ssh.close()
  }
}

export async function publishTeamProject(
  projectId: string,
  password: string
): Promise<TeamOperationResult> {
  if (!password || password.length < 6) {
    return { ok: false, message: '团队配置密码至少 6 位' }
  }
  const project = configStore.getProjectRaw(projectId)
  if (!project) return { ok: false, message: '项目不存在' }
  let config: TeamRepoConfig
  let connection: RepoConnection
  try {
    const resolved = requireRepoConfig()
    config = resolved.config
    connection = resolved.connection
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }

  const shared = stripCredentials(project)
  const meta: ShareMeta = {
    name: shared.name,
    publisher: await resolveOperator(project),
    publishedAt: new Date().toISOString(),
    targets: shared.environments.length
  }
  const payload = encryptJson({ project: shared }, password)
  const file = JSON.stringify({ format: FILE_FORMAT, version: 1, meta, payload }, null, 2)
  const fileName = `${slugify(shared.name)}.json`

  const ssh = new SshClient(connection.server, connection.secret, 20000)
  try {
    await ssh.connect()
    const dir = await resolveBaseDir(ssh, config.baseDir)
    await ssh.exec(`mkdir -p ${shq(dir)}`, { timeoutMs: 15000 })
    const remotePath = pjoin(dir, fileName)
    const tmpPath = `${remotePath}.tmp`
    await ssh.writeFile(tmpPath, file)
    const moved = await ssh.exec(`mv -f ${shq(tmpPath)} ${shq(remotePath)}`, { timeoutMs: 15000 })
    if (moved.code !== 0) {
      throw new Error(`写入仓库失败：${moved.stderr.trim() || moved.code}`)
    }
    return { ok: true, message: `已发布到团队配置仓库：${fileName}` }
  } catch (err) {
    return { ok: false, message: friendlySshError(err) }
  } finally {
    ssh.close()
  }
}

export async function fetchTeamProject(
  fileName: string,
  password: string
): Promise<TeamOperationResult> {
  if (!password) return { ok: false, message: '请输入团队配置密码' }
  const safeName = (fileName || '').replace(/[\\/]/g, '')
  if (!safeName.endsWith('.json')) return { ok: false, message: '文件名无效' }

  let config: TeamRepoConfig
  let connection: RepoConnection
  try {
    const resolved = requireRepoConfig()
    config = resolved.config
    connection = resolved.connection
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }

  const ssh = new SshClient(connection.server, connection.secret, 20000)
  try {
    await ssh.connect()
    const dir = await resolveBaseDir(ssh, config.baseDir)
    const content = await ssh.readFile(pjoin(dir, safeName))
    const parsed = JSON.parse(content.toString('utf8')) as ShareFile
    if (parsed?.format !== FILE_FORMAT || !parsed.payload) {
      return { ok: false, message: '文件格式不正确' }
    }
    let data: { project?: Partial<Project> }
    try {
      data = decryptJson<{ project?: Partial<Project> }>(parsed.payload, password)
    } catch {
      return { ok: false, message: '密码错误或文件已损坏' }
    }
    if (!data?.project) return { ok: false, message: '配置内容为空' }

    const project = buildImportedProject(data.project)
    const warnings = await collectImportWarnings(project)
    const saved = await configStore.saveProject(project)
    return { ok: true, project: saved, warnings, message: `已导入项目：${saved.name}` }
  } catch (err) {
    return { ok: false, message: friendlySshError(err) }
  } finally {
    ssh.close()
  }
}
