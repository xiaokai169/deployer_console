import { spawn, type ChildProcess } from 'child_process'

export interface RunCommandOptions {
  command: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
  env?: NodeJS.ProcessEnv
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 在本地项目目录执行构建命令，流式输出 stdout/stderr，支持超时与取消。
 * 返回退出码（非 0 时由调用方决定是否中止流水线）。
 */
export function runCommand(options: RunCommandOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(options.command, {
        cwd: options.cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...options.env },
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      reject(err)
      return
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = (): void => {
      killTree(child)
      finish(() => reject(new Error('已取消')))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        killTree(child)
        reject(new Error('已取消'))
        return
      }
      options.signal.addEventListener('abort', onAbort)
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child)
        finish(() => reject(new Error(`构建超时（${Math.round((options.timeoutMs ?? 0) / 1000)}s）`)))
      }, options.timeoutMs)
    }

    const pipe = (stream: NodeJS.ReadableStream, kind: 'stdout' | 'stderr'): void => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() !== '') options.onLine(line, kind)
        }
      })
      stream.on('end', () => {
        if (buffer.trim() !== '') options.onLine(buffer, kind)
      })
    }

    if (child.stdout) pipe(child.stdout, 'stdout')
    if (child.stderr) pipe(child.stderr, 'stderr')

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve(code ?? 1)))
  })
}
