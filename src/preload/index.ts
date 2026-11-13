import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DeployeApi } from '@shared/types'

let nextSubscriptionId = 0
const subscriptions = new Map<
  number,
  { channel: string; handler: (event: IpcRendererEvent, payload: unknown) => void }
>()

function subscribe<T>(channel: string, callback: (payload: T) => void): number {
  const id = nextSubscriptionId + 1
  nextSubscriptionId = id
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    callback(payload as T)
  }
  ipcRenderer.on(channel, handler)
  subscriptions.set(id, { channel, handler })
  return id
}

function unsubscribe(id: number): void {
  const entry = subscriptions.get(id)
  if (!entry) return
  ipcRenderer.removeListener(entry.channel, entry.handler)
  subscriptions.delete(id)
}

const api: DeployeApi = {
  listProjects: () => ipcRenderer.invoke('project:list'),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  exportProject: (projectId, options) => ipcRenderer.invoke('project:export', projectId, options),
  selectImportFile: () => ipcRenderer.invoke('project:selectImportFile'),
  importProject: (passphrase) => ipcRenderer.invoke('project:importSelected', passphrase),
  getOperator: (projectId) => ipcRenderer.invoke('project:operator', projectId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickKeyFile: () => ipcRenderer.invoke('dialog:pickKeyFile'),
  testServer: (projectId, serverId) => ipcRenderer.invoke('server:test', projectId, serverId),
  testServerDraft: (projectId, server) =>
    ipcRenderer.invoke('server:testDraft', projectId, server),
  listEnvironmentReleases: (projectId, environmentId) =>
    ipcRenderer.invoke('environment:releases', projectId, environmentId),
  listSnapshots: (projectId) => ipcRenderer.invoke('snapshot:list', projectId),
  deleteSnapshot: (projectId, snapshotId) =>
    ipcRenderer.invoke('snapshot:delete', projectId, snapshotId),
  listFlows: (projectId) => ipcRenderer.invoke('flow:list', projectId),
  clearFlows: (projectId) => ipcRenderer.invoke('flow:clear', projectId),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => subscribe('update:changed', cb),
  getGitStatus: (projectId) => ipcRenderer.invoke('git:status', projectId),
  checkGitNow: (projectId) => ipcRenderer.invoke('git:check', projectId),
  getWorkspaceStatus: (projectId) => ipcRenderer.invoke('git:workspace', projectId),
  cleanWorkspace: (projectId) => ipcRenderer.invoke('git:cleanWorkspace', projectId),
  getTeamRepo: () => ipcRenderer.invoke('teamRepo:get'),
  saveTeamRepo: (config) => ipcRenderer.invoke('teamRepo:save', config),
  testTeamRepo: () => ipcRenderer.invoke('teamRepo:test'),
  listTeamProjects: () => ipcRenderer.invoke('teamRepo:list'),
  publishTeamProject: (projectId, password) =>
    ipcRenderer.invoke('teamRepo:publish', projectId, password),
  fetchTeamProject: (fileName, password) =>
    ipcRenderer.invoke('teamRepo:fetch', fileName, password),
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  getJobState: () => ipcRenderer.invoke('job:state'),
  exportLogs: (content) => ipcRenderer.invoke('logs:export', content),
  onLog: (cb) => subscribe('job:log', cb),
  onProgress: (cb) => subscribe('job:progress', cb),
  onStage: (cb) => subscribe('job:stage', cb),
  onState: (cb) => subscribe('job:state', cb),
  onDiff: (cb) => subscribe('job:diff', cb),
  onDone: (cb) => subscribe('job:done', cb),
  off: unsubscribe
}

contextBridge.exposeInMainWorld('api', api)
