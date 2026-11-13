import { promises as fs } from 'fs'
import type { Project, ServerConfig } from '@shared/types'
import { normalizeProject, nowIso, uid } from '@shared/defaults'
import { configStore } from './config-store'
import { expandHome } from './ssh-client'

export type ImportedSecretMap = Record<string, { password?: string; passphrase?: string }>

async function existsAs(path: string, kind: 'file' | 'dir'): Promise<boolean> {
  return fs
    .stat(path)
    .then((s) => (kind === 'file' ? s.isFile() : s.isDirectory()))
    .catch(() => false)
}

function makeUniqueName(base: string): string {
  const existing = new Set(configStore.getProjectsRaw().map((p) => p.name))
  const source = base || '导入项目'
  if (!existing.has(source)) return source
  let index = 1
  let name = `${source}（导入）`
  while (existing.has(name)) {
    index += 1
    name = `${source}（导入 ${index}）`
  }
  return name
}

/** 导入时重新生成 ID，避免与本机已有配置冲突 */
export function buildImportedProject(
  source: Partial<Project>,
  secrets?: ImportedSecretMap
): Project {
  const project = normalizeProject(source)
  project.id = uid()
  project.name = makeUniqueName(project.name)
  project.createdAt = nowIso()
  project.updatedAt = nowIso()

  const serverIdMap = new Map<string, string>()
  project.targets = project.targets.map((server) => {
    const newId = uid()
    serverIdMap.set(server.id, newId)
    const next: ServerConfig = {
      ...server,
      id: newId,
      hasPassword: undefined,
      hasPassphrase: undefined
    }
    return next
  })

  // 旧数据中密钥可能按环境（旧 target）ID 存储
  const environmentServerMap = new Map<string, string>()
  for (const environment of project.environments) {
    environmentServerMap.set(environment.id, serverIdMap.get(environment.serverId) || '')
  }

  project.environments = project.environments.map((environment) => ({
    ...environment,
    id: uid(),
    serverId: serverIdMap.get(environment.serverId) || ''
  }))

  if (secrets) {
    for (const [oldKey, secret] of Object.entries(secrets)) {
      const newServerId = serverIdMap.get(oldKey) || environmentServerMap.get(oldKey)
      if (!newServerId) continue
      const server = project.targets.find((s) => s.id === newServerId)
      if (!server) continue
      if (secret.password) server.password = secret.password
      if (secret.passphrase) server.passphrase = secret.passphrase
    }
  }
  return project
}

/** 检查本机缺失的本地目录 / 密钥文件 / 未选择服务器的环境 */
export async function collectImportWarnings(project: Project): Promise<string[]> {
  const warnings: string[] = []
  if (project.localPath && !(await existsAs(project.localPath, 'dir'))) {
    warnings.push(`本地项目目录在当前机器不存在：${project.localPath}，请重新选择目录`)
  }
  for (const server of project.targets) {
    if (server.authType === 'key' && server.privateKeyPath) {
      const keyPath = expandHome(server.privateKeyPath)
      if (!(await existsAs(keyPath, 'file'))) {
        warnings.push(`服务器「${server.name}」的密钥文件不存在：${keyPath}`)
      }
    }
  }
  for (const environment of project.environments) {
    if (!environment.serverId) {
      warnings.push(`环境「${environment.name}」尚未选择服务器`)
    }
  }
  return warnings
}
