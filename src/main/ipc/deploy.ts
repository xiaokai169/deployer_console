import { ipcMain } from 'electron'
import type { JobStartPayload, ServerConfig } from '@shared/types'
import { deployEngine } from '../services/deploy-engine'
import { deleteSnapshot, listSnapshots } from '../services/artifact-store'
import { configStore } from '../services/config-store'
import {
  listEnvironmentReleases,
  testServerConnection,
  testServerDraft
} from '../services/inspect'

export function registerDeployIpc(): void {
  ipcMain.handle('job:start', (event, payload: JobStartPayload) => deployEngine.start(payload, event.sender))
  ipcMain.handle('job:cancel', () => deployEngine.cancel())
  ipcMain.handle('job:state', () => deployEngine.getState())

  ipcMain.handle('server:test', (_event, projectId: string, serverId: string) =>
    testServerConnection(projectId, serverId)
  )
  ipcMain.handle('server:testDraft', (_event, projectId: string, server: ServerConfig) =>
    testServerDraft(projectId, server)
  )
  ipcMain.handle('environment:releases', (_event, projectId: string, environmentId: string) =>
    listEnvironmentReleases(projectId, environmentId)
  )

  ipcMain.handle('snapshot:list', (_event, projectId: string) => listSnapshots(projectId))
  ipcMain.handle('snapshot:delete', (_event, projectId: string, snapshotId: string) =>
    deleteSnapshot(projectId, snapshotId)
  )
  ipcMain.handle('flow:list', (_event, projectId: string) => configStore.listFlows(projectId))
  ipcMain.handle('flow:clear', (_event, projectId: string) => configStore.clearFlows(projectId))
}
