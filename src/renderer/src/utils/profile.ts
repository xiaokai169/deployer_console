import type { EnvironmentConfig, Project } from '@shared/types'

export interface EffectiveProfile {
  buildCommand: string
  distDir: string
  envVars: string
}

/** 环境级构建配置优先，留空继承项目默认（与主进程 build-profile.ts 保持一致） */
export function effectiveProfile(
  project: Project,
  environment?: EnvironmentConfig | null
): EffectiveProfile {
  const override = environment?.build
  return {
    buildCommand:
      (override?.buildCommand || '').trim() || (project.build.buildCommand || '').trim(),
    distDir: (override?.distDir || '').trim() || project.build.distDir,
    envVars: override?.envVars || ''
  }
}

/** 与主进程 buildProfileKey 完全一致：快照是否匹配目标环境靠这个字符串比较 */
export function profileKeyOf(
  project: Project,
  environment?: EnvironmentConfig | null
): string {
  const profile = effectiveProfile(project, environment)
  return `${profile.buildCommand} ${profile.distDir} ${profile.envVars}`
}
