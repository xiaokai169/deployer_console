import { ipcMain } from 'electron'
import { updateService } from '../services/update-service'

export function registerUpdateIpc(): void {
  ipcMain.handle('update:state', () => updateService.getState())
  ipcMain.handle('update:check', () => updateService.check())
  ipcMain.handle('update:install', () => updateService.quitAndInstall())
}
