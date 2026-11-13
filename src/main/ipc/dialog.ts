import { dialog, ipcMain, BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { homedir } from 'os'
import { writeFile } from 'fs/promises'
import type { ExportLogsResult } from '@shared/types'

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function registerDialogIpc(): void {
  ipcMain.handle('dialog:pickDirectory', async () => {
    const options: OpenDialogOptions = { title: '选择本地项目目录', properties: ['openDirectory'] }
    const win = focusedWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:pickKeyFile', async () => {
    const options: OpenDialogOptions = {
      title: '选择 SSH 私钥',
      defaultPath: homedir(),
      properties: ['openFile'],
      filters: [
        { name: 'SSH 密钥', extensions: ['pem', 'key', 'ppk', '*'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const win = focusedWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('logs:export', async (_event, content: string): Promise<ExportLogsResult> => {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const options: SaveDialogOptions = {
      title: '导出发布日志',
      defaultPath: `deploye-logs-${stamp}.log`,
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }]
    }
    const win = focusedWindow()
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, content, 'utf8')
    return { saved: true, path: result.filePath }
  })
}
