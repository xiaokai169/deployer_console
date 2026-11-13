import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

/** 启动后延迟检查，避免和窗口初始化抢资源 */
const STARTUP_DELAY_MS = 20 * 1000
/** 之后每 4 小时检查一次 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

class UpdateService {
  private state: UpdateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    enabled: app.isPackaged
  }
  private onChange: ((state: UpdateState) => void) | null = null
  private initialized = false
  private timer: NodeJS.Timeout | undefined
  private startupTimer: NodeJS.Timeout | undefined

  /** 只初始化一次；窗口重建时更新回调即可 */
  init(onChange: (state: UpdateState) => void): void {
    this.onChange = onChange
    if (this.initialized) {
      onChange(this.getState())
      return
    }
    this.initialized = true

    if (!app.isPackaged) {
      this.setState({
        status: 'unavailable',
        message: '开发模式不检查更新，安装打包版本后生效'
      })
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false

    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking', percent: undefined, message: '正在检查更新...' })
    })
    autoUpdater.on('update-available', (info) => {
      this.setState({
        status: 'downloading',
        version: info.version,
        percent: 0,
        message: `发现新版本 v${info.version}，正在后台下载...`
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.setState({ status: 'up-to-date', percent: undefined, message: '当前已是最新版本' })
    })
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.min(100, Math.max(0, Math.round(progress.percent)))
      this.setState({
        percent,
        message: `正在下载新版本 ${percent}%`
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        version: info.version,
        percent: 100,
        message: `新版本 v${info.version} 已下载完成，重启应用后生效`
      })
    })
    autoUpdater.on('error', (err) => {
      this.setState({
        status: 'error',
        percent: undefined,
        message: `检查更新失败：${err instanceof Error ? err.message : String(err)}`
      })
    })

    this.startupTimer = setTimeout(() => void this.check(), STARTUP_DELAY_MS)
    this.startupTimer.unref?.()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 更新窗口回调，用于窗口关闭/重建后继续推送状态 */
  setListener(onChange: (state: UpdateState) => void): void {
    this.onChange = onChange
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState()
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return this.getState()
    }
    this.setState({ status: 'checking', percent: undefined, message: '正在检查更新...' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.setState({
        status: 'error',
        percent: undefined,
        message: `检查更新失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
    return this.getState()
  }

  /** 仅在已下载完成时可用 */
  quitAndInstall(): void {
    if (this.state.status !== 'downloaded') return
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.timer) clearInterval(this.timer)
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange?.(this.getState())
  }
}

export const updateService = new UpdateService()
