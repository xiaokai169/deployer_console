import { spawn, type ChildProcess } from 'child_process'
import type { ServerConfig } from '@shared/types'
import { expandHome } from './ssh-client'

export interface RsyncOptions {
  target: ServerConfig
  localDir: string
  remoteDir: string
  excludePaths: string[]
  timeoutMs: number
  signal?: AbortSignal
  onProgress: (percent: number) => void
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
}

function checkRsyncAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('rsync', ['--version'], { windowsHide: true })
    let settled = false
    child.on('error', () => {
      if (settled) return
      settled = true
      reject(new Error('本机未安装 rsync（或未加入 PATH）。可改用 SFTP 传输，或先安装 rsync。'))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else reject(new Error('rsync 不可用，请检查安装'))
    })
  })
}

function killChild(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

export async function runRsync(options: RsyncOptions): Promise<void> {
  const { target } = options
  if (target.authType !== 'key') {
    throw new Error('rsync 传输仅支持密钥认证，请切换认证方式或改用 SFTP')
  }

  await checkRsyncAvailable()

  const sshParts = ['ssh', '-p', String(target.port || 22)]
  if (target.privateKeyPath) {
    sshParts.push('-i', `"${expandHome(target.privateKeyPath)}"`)
  }
  sshParts.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes')
  const connectTimeout = Math.max(5, Math.min(60, Math.round(options.timeoutMs / 1000)))
  sshParts.push('-o', `ConnectTimeout=${connectTimeout}`)

  const args = ['-az', '--delete', '--info=progress2', '-e', sshParts.join(' ')]
  for (const exclude of options.excludePaths) {
    if (exclude) args.push('--exclude', exclude)
  }
  args.push(
    `${options.localDir.replace(/\\/g, '/')}/`,
    `${target.username}@${target.host}:${options.remoteDir}/`
  )

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn('rsync', args, { windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined
    let buffer = ''

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = (): void => {
      killChild(child)
      finish(() => reject(new Error('已取消')))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        killChild(child)
        reject(new Error('已取消'))
        return
      }
      options.signal.addEventListener('abort', onAbort)
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild(child)
        finish(() => reject(new Error(`rsync 超时（${Math.round(options.timeoutMs / 1000)}s）`)))
      }, options.timeoutMs)
    }

    const handleChunk = (text: string, kind: 'stdout' | 'stderr'): void => {
      buffer += text.replace(/\r/g, '\n')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const matches = trimmed.match(/(\d{1,3})%/g)
        if (matches && matches.length > 0) {
          const percent = Number(matches[matches.length - 1].replace('%', ''))
          if (Number.isFinite(percent)) options.onProgress(Math.max(0, Math.min(100, percent)))
        } else {
          options.onLine(trimmed, kind)
        }
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => handleChunk(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: string) => handleChunk(chunk, 'stderr'))

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve()
        else reject(new Error(`rsync 同步失败（exit ${code}）`))
      })
    })
  })
}
