import { app, ipcMain } from 'electron'
import type { CleanWorkspaceResult } from '@shared/types'
import { configStore } from '../services/config-store'
import { getWorkspaceStatus, removeWorkspace, workspaceDir } from '../services/git-workspace'
import { gitWatcher } from '../services/git-watcher'

export function registerGitIpc(): void {
  ipcMain.handle('git:status', (_event, projectId: string) => gitWatcher.getStatus(projectId))
  ipcMain.handle('git:check', (_event, projectId: string) => gitWatcher.checkNow(projectId))

  ipcMain.handle('git:workspace', async (_event, projectId: string) => {
    const project = configStore.getProjectRaw(projectId)
    if (!project) return { path: '', exists: false }
    return getWorkspaceStatus(project.localPath, workspaceDir(app.getPath('userData'), project.id))
  })

  ipcMain.handle(
    'git:cleanWorkspace',
    async (_event, projectId: string): Promise<CleanWorkspaceResult> => {
      const project = configStore.getProjectRaw(projectId)
      if (!project) return { ok: false, message: '项目不存在' }
      try {
        await removeWorkspace(
          project.localPath,
          workspaceDir(app.getPath('userData'), project.id)
        )
        return { ok: true, message: '部署工作区已清理' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
