import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { ServerConfig } from '@shared/types'
import type { WalkedFile } from './artifact'
import { pjoin, posixDirname, shq } from '../utils/shell'

export interface SshSecret {
  password?: string
  passphrase?: string
}

export function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1)
  return p
}

export function friendlySshError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { address?: string; port?: number }
  const message = e?.message || String(err)
  if (e?.code === 'ECONNREFUSED') {
    return `连接被拒绝（${e.address || ''}:${e.port || ''}），请检查主机、端口与防火墙`
  }
  if (e?.code === 'ENOTFOUND') return '无法解析主机地址，请检查主机名'
  if (e?.code === 'ETIMEDOUT' || /timed?\s?out/i.test(message)) return '连接超时，请检查网络或 SSH 端口'
  if (/authentication methods failed/i.test(message)) return '认证失败，请检查用户名、密码或密钥'
  if (/Cannot parse privateKey|parse error/i.test(message)) return '私钥无法解析（支持 OpenSSH / PEM 格式），请检查密钥文件'
  if (e?.code === 'ENOENT') return '文件不存在或不可读，请检查密钥路径'
  return message
}

export class SshClient {
  private client = new Client()
  private ready = false
  private closed = false

  constructor(
    private readonly target: ServerConfig,
    private readonly secret: SshSecret,
    private readonly readyTimeoutMs = 30000
  ) {
    this.client.on('error', () => {
      this.ready = false
    })
    this.client.on('close', () => {
      this.ready = false
      this.closed = true
    })
  }

  async connect(): Promise<void> {
    if (this.ready) return
    if (this.closed) throw new Error('SSH 连接已关闭')

    const config: ConnectConfig = {
      host: this.target.host,
      port: this.target.port || 22,
      username: this.target.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3
    }

    if (this.target.authType === 'password') {
      if (!this.secret.password) throw new Error('目标未配置登录密码')
      config.password = this.secret.password
    } else {
      if (!this.target.privateKeyPath) throw new Error('目标未配置密钥文件路径')
      const keyPath = expandHome(this.target.privateKeyPath)
      try {
        config.privateKey = await readFile(keyPath)
      } catch (err) {
        throw new Error(`读取密钥失败（${keyPath}）：${friendlySshError(err)}`)
      }
      if (this.secret.passphrase) config.passphrase = this.secret.passphrase
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup()
        this.ready = true
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const cleanup = (): void => {
        this.client.removeListener('ready', onReady)
        this.client.removeListener('error', onError)
      }
      this.client.once('ready', onReady)
      this.client.once('error', onError)
      try {
        this.client.connect(config)
      } catch (err) {
        cleanup()
        reject(err)
      }
    })
  }

  async exec(
    command: string,
    options: { timeoutMs?: number; onOutput?: (chunk: string, isStderr: boolean) => void } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const timeoutMs = options.timeoutMs ?? this.readyTimeoutMs
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        let timer: NodeJS.Timeout | undefined

        const done = (fn: () => void): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          fn()
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try {
              stream.close()
            } catch {
              /* ignore */
            }
            done(() => reject(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）`)))
          }, timeoutMs)
        }

        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stdout += text
          options.onOutput?.(text, false)
        })
        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stderr += text
          options.onOutput?.(text, true)
        })
        stream.on('close', (code: number | null) => {
          done(() => resolve({ code: code ?? 0, stdout, stderr }))
        })
        stream.on('error', (streamErr: Error) => {
          done(() => reject(streamErr))
        })
      })
    })
  }

  async sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) reject(err)
        else resolve(sftp)
      })
    })
  }

  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          concurrency: 16,
          chunkSize: 32768,
          step: (transferred: number, _chunk: number, total: number) => {
            onProgress?.(transferred, total)
          }
        },
        (err) => {
          if (err) reject(err)
          else resolve()
        }
      )
    })
  }

  async writeFile(remotePath: string, data: Buffer | string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, data, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => {
        if (err) reject(err)
        else resolve(data)
      })
    })
  }

  async listDir(
    remotePath: string
  ): Promise<Array<{ name: string; isFile: boolean; size: number; mtimeMs: number }>> {
    const sftp = await this.sftp()
    const entries = await new Promise<
      Array<{
        filename: string
        attrs: { mode?: number; size?: number; mtime?: number }
        isFile?: () => boolean
      }>
    >((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) reject(err)
        else
          resolve(
            list as unknown as Array<{
              filename: string
              attrs: { mode?: number; size?: number; mtime?: number }
              isFile?: () => boolean
            }>
          )
      })
    })
    return entries.map((entry) => ({
      name: entry.filename,
      // 优先使用 ssh2 的 isFile()；部分服务器不返回 mode 时避免误判为目录
      isFile:
        typeof entry.isFile === 'function'
          ? entry.isFile()
          : ((entry.attrs.mode ?? 0) & 0o170000) === 0o100000,
      size: entry.attrs.size ?? 0,
      mtimeMs: (entry.attrs.mtime ?? 0) * 1000
    }))
  }

  /** 未打包时逐文件上传目录，返回上传文件数 */
  async uploadDirectory(
    localRoot: string,
    remoteRoot: string,
    files: WalkedFile[],
    onProgress?: (percent: number, text: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (files.length === 0) return

    const dirs = new Set<string>([remoteRoot])
    for (const file of files) {
      dirs.add(posixDirname(pjoin(remoteRoot, file.rel)))
    }
    const dirList = Array.from(dirs)
    for (let i = 0; i < dirList.length; i += 50) {
      const chunk = dirList.slice(i, i + 50).map((d) => shq(d)).join(' ')
      const res = await this.exec(`mkdir -p ${chunk}`)
      if (res.code !== 0) throw new Error(`创建远端目录失败：${res.stderr.trim() || res.code}`)
    }

    const sftp = await this.sftp()
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    let uploaded = 0
    const queue = [...files]

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (signal?.aborted) throw new Error('已取消')
        const file = queue.shift()
        if (!file) return
        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(file.abs, pjoin(remoteRoot, file.rel), (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        uploaded += file.size
        const percent = totalBytes > 0 ? Math.min(99, Math.round((uploaded / totalBytes) * 100)) : 0
        onProgress?.(percent, file.rel)
      }
    }

    const workers = Array.from({ length: Math.min(4, files.length) }, () => worker())
    await Promise.all(workers)
    onProgress?.(100, '上传完成')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
  }
}
