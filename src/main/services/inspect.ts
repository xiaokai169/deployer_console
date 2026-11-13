import type { ReleaseInfo, ServerConfig, TargetTestResult } from '@shared/types'
import { pjoin } from '../utils/shell'
import { configStore } from './config-store'
import { getCurrentRelease, listReleaseDirs, remotePaths } from './remote-deployer'
import { runtimeTargetFor } from './runtime-target'
import { SshClient, friendlySshError } from './ssh-client'

async function connectServer(
  server: ServerConfig,
  secret: { password?: string; passphrase?: string }
): Promise<TargetTestResult> {
  if (!server.host?.trim()) return { ok: false, message: '请先填写主机地址' }
  if (!server.username?.trim()) return { ok: false, message: '请先填写登录用户名' }
  if (server.authType === 'key' && !(server.privateKeyPath || '').trim()) {
    return { ok: false, message: '请先选择密钥文件' }
  }
  if (server.authType === 'password' && !secret.password) {
    return { ok: false, message: '请先填写登录密码' }
  }

  const ssh = new SshClient(
    { ...server, port: Number(server.port) || 22 },
    secret,
    15000
  )
  try {
    await ssh.connect()
    return {
      ok: true,
      message: `连接成功（${server.username}@${server.host}:${server.port || 22}）`
    }
  } catch (err) {
    return { ok: false, message: friendlySshError(err) }
  } finally {
    ssh.close()
  }
}

export async function testServerConnection(
  projectId: string,
  serverId: string
): Promise<TargetTestResult> {
  const project = configStore.getProjectRaw(projectId)
  if (!project) return { ok: false, message: '项目不存在' }
  const server = project.targets.find((s) => s.id === serverId)
  if (!server) return { ok: false, message: '服务器不存在' }
  return connectServer(server, configStore.getSecret(server.id))
}

/**
 * 测试表单里尚未保存的配置：密码/口令留空时回退到该服务器已保存的密钥，
 * 与「编辑时留空表示不修改」的保存语义保持一致。
 */
export async function testServerDraft(
  projectId: string,
  draft: ServerConfig
): Promise<TargetTestResult> {
  const stored = draft.id ? configStore.getSecret(draft.id) : {}
  return connectServer(draft, {
    password: draft.password || stored.password,
    passphrase: draft.passphrase || stored.passphrase
  })
}

export async function listEnvironmentReleases(
  projectId: string,
  environmentId: string
): Promise<ReleaseInfo[]> {
  const project = configStore.getProjectRaw(projectId)
  if (!project) throw new Error('项目不存在')
  const environment = project.environments.find((e) => e.id === environmentId)
  if (!environment) throw new Error('环境不存在')
  const target = runtimeTargetFor(project, environment)
  const server = project.targets.find((s) => s.id === environment.serverId)
  if (!server) throw new Error('环境未选择服务器')

  const ssh = new SshClient(server, configStore.getSecret(server.id), 20000)
  try {
    await ssh.connect()
    const paths = remotePaths(target)
    const current = await getCurrentRelease(ssh, target, 15000)
    const releases = await listReleaseDirs(ssh, paths.releases, 15000)
    const history = configStore.getHistory(projectId, environmentId)
    return releases.map((release) => {
      const absolute = pjoin(paths.releases, release.name)
      return {
        name: release.name,
        current: absolute === current,
        mtime: release.mtimeMs > 0 ? new Date(release.mtimeMs).toISOString() : undefined,
        operator: history.find((h) => h.name === release.name)?.operator,
        rollbackable: absolute !== current
      }
    })
  } finally {
    ssh.close()
  }
}
