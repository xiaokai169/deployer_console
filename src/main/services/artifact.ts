import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import type { Manifest, ValidationConfig } from '@shared/types'

export interface WalkedFile {
  rel: string
  abs: string
  size: number
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

export async function walkFiles(root: string): Promise<WalkedFile[]> {
  const result: WalkedFile[] = []

  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(abs)
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs)
        result.push({ rel: toPosix(relative(root, abs)), abs, size: stat.size })
      }
    }
  }

  await visit(root)
  result.sort((a, b) => a.rel.localeCompare(b.rel))
  return result
}

export function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(abs)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function buildManifest(root: string, files?: WalkedFile[]): Promise<Manifest> {
  const list = files ?? (await walkFiles(root))
  const manifest: Manifest = {}
  for (const file of list) {
    manifest[file.rel] = { size: file.size, hash: await hashFile(file.abs) }
  }
  return manifest
}

export interface ValidationOutcome {
  ok: boolean
  errors: string[]
  totalBytes: number
  fileCount: number
}

export async function validateArtifacts(
  distDir: string,
  config: ValidationConfig
): Promise<ValidationOutcome> {
  const errors: string[] = []
  const exists = await fs
    .stat(distDir)
    .then((s) => s.isDirectory())
    .catch(() => false)

  if (!exists) {
    return {
      ok: false,
      errors: [`产物目录不存在: ${distDir}`],
      totalBytes: 0,
      fileCount: 0
    }
  }

  const files = await walkFiles(distDir)
  const fileCount = files.length
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)

  if (config.enabled) {
    if (fileCount === 0) errors.push('产物目录为空')

    if (config.entryFile) {
      const entryExists = await fs
        .stat(join(distDir, config.entryFile))
        .then((s) => s.isFile())
        .catch(() => false)
      if (!entryExists) errors.push(`缺少入口文件: ${config.entryFile}`)
    }

    const sizeMB = totalBytes / 1024 / 1024
    if (config.minMB > 0 && sizeMB < config.minMB) {
      errors.push(`产物体积 ${sizeMB.toFixed(1)} MB 低于下限 ${config.minMB} MB`)
    }
    if (config.maxMB > 0 && sizeMB > config.maxMB) {
      errors.push(`产物体积 ${sizeMB.toFixed(1)} MB 超过上限 ${config.maxMB} MB`)
    }
  } else if (fileCount === 0) {
    errors.push('产物目录为空')
  }

  return { ok: errors.length === 0, errors, totalBytes, fileCount }
}
