import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { configStore } from './services/config-store'
import { gitWatcher } from './services/git-watcher'
import { updateService } from './services/update-service'

let mainWindow: BrowserWindow | null = null

// 支持通过环境变量指定独立的配置目录（便于测试 / 便携模式）
if (process.env.DEPLOYE_USER_DATA) {
  app.setPath('userData', process.env.DEPLOYE_USER_DATA)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'Deploye 发布控制台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function pushUpdateState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:changed', updateService.getState())
  }
}

app.whenReady().then(async () => {
  await configStore.load()
  registerIpc()
  createWindow()
  gitWatcher.start()
  updateService.init(pushUpdateState)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  gitWatcher.stop()
  updateService.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
