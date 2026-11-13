import { defineStore } from 'pinia'
import type {
  ArtifactSnapshot,
  EnvironmentConfig,
  FlowRecord,
  JobKind,
  Project,
  ReleaseInfo,
  ServerConfig,
  TargetTestResult
} from '@shared/types'
import { createDefaultEnvironment, createDefaultProject } from '@shared/defaults'

export type SettingsTab = 'basic' | 'build' | 'strategy' | 'autodeploy' | 'servers'

interface ServerStatus {
  ok: boolean
  message: string
}

interface ServerDialogState {
  open: boolean
  mode: 'add' | 'edit'
  serverId: string
}

export const useProjectStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    currentId: null as string | null,
    activeEnvironmentId: null as string | null,
    selectedEnvironmentIds: [] as string[],
    releases: [] as ReleaseInfo[],
    releasesLoading: false,
    releasesError: '',
    serverStatus: {} as Record<string, ServerStatus>,
    serverDialog: { open: false, mode: 'add', serverId: '' } as ServerDialogState,
    snapshots: [] as ArtifactSnapshot[],
    snapshotLoading: false,
    activeSnapshotId: null as string | null,
    flows: [] as FlowRecord[],
    /** 弹窗开关集中放在 store，便于侧栏 / 顶部操作区 / 流列表共同触发 */
    projectSettingsOpen: false,
    projectSettingsTab: 'basic' as SettingsTab,
    environmentSettingsOpen: false,
    environmentSettingsId: null as string | null,
    snapshotDialogOpen: false,
    publishDialog: { open: false, kind: 'deploy' as JobKind },
    operator: '',
    loaded: false,
    saving: false
  }),
  getters: {
    current(state): Project | null {
      return state.projects.find((p) => p.id === state.currentId) ?? null
    },
    activeEnvironment(): EnvironmentConfig | null {
      const project = this.current
      if (!project) return null
      return project.environments.find((e) => e.id === this.activeEnvironmentId) ?? null
    },
    publishEnvironmentIds(state): string[] {
      const project = this.current
      if (!project) return []
      return project.environments
        .filter((e) => state.selectedEnvironmentIds.includes(e.id))
        .map((e) => e.id)
    }
  },
  actions: {
    async load() {
      this.projects = await window.api.listProjects()
      this.loaded = true
      if (this.projects.length > 0) {
        this.selectProject(this.projects[0].id)
      }
    },
    findProject(id: string): Project | undefined {
      return this.projects.find((p) => p.id === id)
    },
    selectProject(id: string) {
      this.currentId = id
      const project = this.findProject(id)
      // 默认不勾选任何环境：发布目标必须在发布时显式选择，避免误发生产
      this.selectedEnvironmentIds = []
      this.activeEnvironmentId = project?.environments[0]?.id ?? null
      this.activeSnapshotId = null
      this.releases = []
      this.releasesError = ''
      void this.loadOperator()
      void this.loadSnapshots()
      void this.loadFlows()
    },
    async loadOperator() {
      if (!this.currentId) {
        this.operator = ''
        return
      }
      try {
        this.operator = await window.api.getOperator(this.currentId)
      } catch {
        this.operator = ''
      }
    },
    async save() {
      const project = this.current
      if (!project || this.saving) return
      this.saving = true
      try {
        // 去掉 Vue 响应式代理后再走 IPC，否则结构化克隆会失败
        const plain = JSON.parse(JSON.stringify(project)) as Project
        const saved = await window.api.saveProject(plain)
        for (const server of project.targets) {
          const match = saved.targets.find((s) => s.id === server.id)
          if (match) {
            server.hasPassword = match.hasPassword
            server.hasPassphrase = match.hasPassphrase
          }
        }
        void this.loadOperator()
      } catch (err) {
        console.error('[project] 保存失败', err)
      } finally {
        this.saving = false
      }
    },
    async addProject() {
      const project = createDefaultProject('未命名项目')
      this.projects.push(project)
      await window.api.saveProject(project)
      this.selectProject(project.id)
    },
    async removeProject(id: string) {
      await window.api.deleteProject(id)
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.currentId !== id) return
      const next = this.projects[0]
      if (next) {
        this.selectProject(next.id)
        return
      }
      this.currentId = null
      this.activeEnvironmentId = null
      this.selectedEnvironmentIds = []
      this.releases = []
      this.releasesError = ''
      this.operator = ''
    },

    openProjectSettings(tab: SettingsTab = 'basic') {
      this.projectSettingsTab = tab
      this.projectSettingsOpen = true
    },
    closeProjectSettings() {
      this.projectSettingsOpen = false
    },
    openEnvironmentSettings(environmentId?: string) {
      const id = environmentId || this.activeEnvironmentId
      if (!id) return
      this.activeEnvironmentId = id
      this.environmentSettingsId = id
      this.environmentSettingsOpen = true
    },
    closeEnvironmentSettings() {
      this.environmentSettingsOpen = false
      this.environmentSettingsId = null
    },
    openSnapshotDialog() {
      this.snapshotDialogOpen = true
      void this.loadSnapshots()
    },
    closeSnapshotDialog() {
      this.snapshotDialogOpen = false
    },
    openPublishDialog(kind: JobKind) {
      this.publishDialog = { open: true, kind }
    },
    closePublishDialog() {
      this.publishDialog = { open: false, kind: 'deploy' }
    },
    async loadSnapshots() {
      if (!this.currentId) {
        this.snapshots = []
        return
      }
      this.snapshotLoading = true
      try {
        this.snapshots = await window.api.listSnapshots(this.currentId)
        if (
          this.activeSnapshotId &&
          !this.snapshots.some((snapshot) => snapshot.id === this.activeSnapshotId)
        ) {
          this.activeSnapshotId = null
        }
      } catch {
        this.snapshots = []
      } finally {
        this.snapshotLoading = false
      }
    },
    async removeSnapshot(snapshotId: string) {
      if (!this.currentId) return
      await window.api.deleteSnapshot(this.currentId, snapshotId)
      if (this.activeSnapshotId === snapshotId) this.activeSnapshotId = null
      await this.loadSnapshots()
    },
    async loadFlows() {
      if (!this.currentId) {
        this.flows = []
        return
      }
      try {
        this.flows = await window.api.listFlows(this.currentId)
      } catch {
        this.flows = []
      }
    },
    async clearFlows() {
      if (!this.currentId) return
      await window.api.clearFlows(this.currentId)
      this.flows = []
    },
    openServerDialog(mode: 'add' | 'edit' = 'add', serverId?: string) {
      this.serverDialog = { open: true, mode, serverId: serverId ?? '' }
    },
    closeServerDialog() {
      this.serverDialog = { open: false, mode: 'add', serverId: '' }
    },
    async addServerFrom(server: ServerConfig) {
      const project = this.current
      if (!project) return
      project.targets.push(server)
      const environment = this.activeEnvironment
      if (environment && !environment.serverId) environment.serverId = server.id
      await this.save()
    },
    async updateServerConnection(serverId: string, patch: Partial<ServerConfig>) {
      const project = this.current
      if (!project) return
      const server = project.targets.find((s) => s.id === serverId)
      if (!server) return
      Object.assign(server, patch)
      await this.save()
    },
    async removeServer(serverId: string) {
      const project = this.current
      if (!project) return
      project.targets = project.targets.filter((s) => s.id !== serverId)
      for (const environment of project.environments) {
        if (environment.serverId === serverId) environment.serverId = ''
      }
      const status = { ...this.serverStatus }
      delete status[serverId]
      this.serverStatus = status
      await this.save()
    },
    async testServer(serverId: string): Promise<TargetTestResult> {
      const project = this.current
      if (!project) return { ok: false, message: '项目不存在' }
      const result = await window.api.testServer(project.id, serverId)
      this.serverStatus[serverId] = { ok: result.ok, message: result.message }
      return result
    },

    async addEnvironment() {
      const project = this.current
      if (!project) return
      const environment = createDefaultEnvironment(`环境 ${project.environments.length + 1}`, {
        serverId: project.targets[0]?.id ?? ''
      })
      project.environments.push(environment)
      this.activeEnvironmentId = environment.id
      await this.save()
      this.openEnvironmentSettings(environment.id)
    },
    async removeEnvironment(environmentId: string) {
      const project = this.current
      if (!project) return
      project.environments = project.environments.filter((e) => e.id !== environmentId)
      this.selectedEnvironmentIds = this.selectedEnvironmentIds.filter(
        (id) => id !== environmentId
      )
      if (this.activeEnvironmentId === environmentId) {
        this.activeEnvironmentId = project.environments[0]?.id ?? null
        this.releases = []
      }
      await this.save()
    },
    selectEnvironment(id: string) {
      this.activeEnvironmentId = id
    },
    toggleEnvironmentSelected(id: string) {
      if (this.selectedEnvironmentIds.includes(id)) {
        this.selectedEnvironmentIds = this.selectedEnvironmentIds.filter((x) => x !== id)
      } else {
        this.selectedEnvironmentIds = [...this.selectedEnvironmentIds, id]
      }
    },
    async loadReleases() {
      const project = this.current
      const environmentId = this.activeEnvironmentId
      if (!project || !environmentId) {
        this.releases = []
        return
      }
      this.releasesLoading = true
      this.releasesError = ''
      try {
        this.releases = await window.api.listEnvironmentReleases(project.id, environmentId)
      } catch (err) {
        this.releases = []
        this.releasesError = err instanceof Error ? err.message : String(err)
      } finally {
        this.releasesLoading = false
      }
    }
  }
})
