import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import archiver from 'archiver'

export interface PackageOptions {
  distDir: string
  outFile: string
  /** 相对产物根目录的路径，打包时排除（保护路径 = 跳过） */
  excludePaths: string[]
  onProgress?: (percent: number) => void
}

export async function createArchive(options: PackageOptions): Promise<void> {
  await mkdir(dirname(options.outFile), { recursive: true })

  const excludes = options.excludePaths
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter(Boolean)

  const shouldExclude = (name: string): boolean => {
    const normalized = name.replace(/\\/g, '/')
    return excludes.some((p) => normalized === p || normalized.startsWith(`${p}/`))
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(options.outFile)
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } })

    output.on('close', () => resolve())
    output.on('error', reject)

    archive.on('warning', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reject(err)
    })
    archive.on('error', reject)

    let lastEmit = 0
    archive.on('progress', (data) => {
      if (!options.onProgress) return
      const total = data?.entries?.total ?? 0
      const processed = data?.entries?.processed ?? 0
      if (total <= 0) return
      const now = Date.now()
      if (now - lastEmit > 120 || processed === total) {
        lastEmit = now
        options.onProgress(Math.min(100, Math.round((processed / total) * 100)))
      }
    })

    archive.pipe(output)
    archive.directory(options.distDir, false, (entry) => (shouldExclude(entry.name) ? false : entry))
    archive.finalize().catch(reject)
  })
}
