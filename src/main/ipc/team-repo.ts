import { ipcMain } from 'electron'
import type { TeamRepoConfig } from '@shared/types'
import { configStore } from '../services/config-store'
import {
  fetchTeamProject,
  listTeamProjects,
  publishTeamProject,
  testTeamRepo
} from '../services/team-repo'

export function registerTeamRepoIpc(): void {
  ipcMain.handle('teamRepo:get', () => configStore.getTeamRepo())
  ipcMain.handle('teamRepo:save', (_event, config: TeamRepoConfig) =>
    configStore.saveTeamRepo(config)
  )
  ipcMain.handle('teamRepo:test', () => testTeamRepo())
  ipcMain.handle('teamRepo:list', () => listTeamProjects())
  ipcMain.handle('teamRepo:publish', (_event, projectId: string, password: string) =>
    publishTeamProject(projectId, password)
  )
  ipcMain.handle('teamRepo:fetch', (_event, fileName: string, password: string) =>
    fetchTeamProject(fileName, password)
  )
}
