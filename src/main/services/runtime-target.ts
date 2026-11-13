import type { EnvironmentConfig, Project, ServerConfig, Target } from '@shared/types'

export function serverFor(project: Project, environment: EnvironmentConfig): ServerConfig {
  const server = project.targets.find((s) => s.id === environment.serverId)
  if (!server) {
    throw new Error(`环境「${environment.name}」未选择服务器，请先在环境配置里选择服务器`)
  }
  return server
}

/** 把「服务器连接 + 环境部署配置」合并成远端部署使用的运行时目标 */
export function runtimeTargetFor(project: Project, environment: EnvironmentConfig): Target {
  const server = serverFor(project, environment)
  return {
    ...server,
    id: environment.id,
    name: environment.name,
    rootDir: environment.rootDir,
    uploadDir: environment.uploadDir,
    releasesDir: environment.releasesDir,
    currentLink: environment.currentLink,
    keepVersions: environment.keepVersions,
    protectPaths: environment.protectPaths,
    hooks: environment.hooks,
    build: environment.build,
    gitBranch: environment.gitBranch,
    autoDeploy: environment.autoDeploy
  }
}
