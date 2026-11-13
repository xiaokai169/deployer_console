import type { EnvironmentConfig, Project } from '@shared/types'

export interface BuildProfile {
  buildCommand: string
  distDir: string
  envVars: string
}

export interface BuildGroup {
  key: string
  profile: BuildProfile
  environments: EnvironmentConfig[]
}

/** 环境级构建配置优先，留空继承项目默认 */
export function profileFor(project: Project, environment?: EnvironmentConfig): BuildProfile {
  const override = environment?.build
  return {
    buildCommand:
      (override?.buildCommand || '').trim() || (project.build.buildCommand || '').trim(),
    distDir: (override?.distDir || '').trim() || project.build.distDir,
    envVars: override?.envVars || ''
  }
}

export function buildProfileKey(profile: BuildProfile): string {
  return `${profile.buildCommand} ${profile.distDir} ${profile.envVars}`
}

/** 按有效构建配置分组：配置相同的环境共享一次构建 */
export function groupEnvironments(
  project: Project,
  environments: EnvironmentConfig[]
): BuildGroup[] {
  const map = new Map<string, BuildGroup>()
  for (const environment of environments) {
    const profile = profileFor(project, environment)
    const key = buildProfileKey(profile)
    let group = map.get(key)
    if (!group) {
      group = { key, profile, environments: [] }
      map.set(key, group)
    }
    group.environments.push(environment)
  }
  return Array.from(map.values())
}

/** 解析构建期环境变量（每行 KEY=VALUE，支持 # 注释） */
export function parseBuildEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of (raw || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    if (!key) continue
    env[key] = trimmed.slice(index + 1).trim()
  }
  return env
}
