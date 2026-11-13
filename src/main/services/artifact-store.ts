import { app } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  ArtifactSnapshot,
  EnvironmentConfig,
  Manifest,
  Project,
  SnapshotMeta
} from '@shared/types'
import { walkFiles, type WalkedFile } from './artifact'
import { buildProfileKey, type BuildProfile } from './build-profile'

/** 每个项目保留的快照数量，超出后按时间删除最旧的 */
const SNAPSHOT_KEEP = 20

const META_FILE = 'meta.json'
const MANIFEST_FILE = 'manifest.json'
const FILES_DIR = 'files'

export interface CreateSnapshotInput {
  project: Project
  environments: EnvironmentConfig[]
  /** 构建产出的原始目录（本地 dist 或部署工作区 dist） */
  srcDir: string
  profile: BuildProfile
  files: WalkedFile[]
  manifest: Manifest
  totalBytes: number
  source: 'local' | 'worktree'
  branch?: string
  commit?: string
}

export interface SnapshotArtifacts {
  snapshot: ArtifactSnapshot
  /** 快照根目录 */
  dir: string
  /** 快照内的产物目录（部署与打包都从这里读） */
  filesDir: string
  manifest: Manifest
  files: WalkedFile[]
}

function artifactsRoot(): string {
  return join(app.getPath('userData'), 'artifacts')
}

function projectDir(projectId: string): string {
  return join(artifactsRoot(), projectId)
}

function snapshotDir(projectId: string, snapshotId: string): string {
  return join(projectDir(projectId), snapshotId)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timeStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 文件清单根哈希：文件名 + 内容哈希排序后取 sha256 */
export function manifestRootHash(manifest: Manifest): string {
  const lines = Object.keys(manifest)
    .sort()
    .map((key) => `${key}:${manifest[key].hash}`)
    .join('\n')
  return createHash('sha256').update(lines).digest('hex')
}

function profileFingerprint(profile: BuildProfile): string {
  return createHash('sha256').update(buildProfileKey(profile)).digest('hex').slice(0, 12)
}

async function readMeta(projectId: string, snapshotId: string): Promise<SnapshotMeta | null> {
  try {
    const raw = await fs.readFile(join(snapshotDir(projectId, snapshotId), META_FILE), 'utf8')
    const parsed = JSON.parse(raw) as SnapshotMeta
    if (!parsed || parsed.id !== snapshotId) return null
    return parsed
  } catch {
    return null
  }
}

/** 构建结束后把产物固化为快照：之后 dist 被覆盖也不会影响这份包 */
export async function createSnapshot(input: CreateSnapshotInput): Promise<SnapshotArtifacts> {
  const hash = manifestRootHash(input.manifest)
  const createdAt = new Date()
  const baseId = `${timeStamp(createdAt)}-${hash.slice(0, 6)}`

  let id = baseId
  let suffix = 2
  while (
    await fs
      .stat(snapshotDir(input.project.id, id))
      .then(() => true)
      .catch(() => false)
  ) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }

  const dir = snapshotDir(input.project.id, id)
  const filesDir = join(dir, FILES_DIR)
  await fs.mkdir(dir, { recursive: true })
  await fs.cp(input.srcDir, filesDir, { recursive: true })

  const meta: SnapshotMeta = {
    id,
    projectId: input.project.id,
    projectName: input.project.name,
    createdAt: createdAt.toISOString(),
    branch: input.branch,
    commit: input.commit,
    buildCommand: input.profile.buildCommand,
    distDir: input.profile.distDir,
    profileKey: buildProfileKey(input.profile),
    profileFingerprint: profileFingerprint(input.profile),
    environmentIds: input.environments.map((env) => env.id),
    environmentNames: input.environments.map((env) => env.name),
    fileCount: input.files.length,
    totalBytes: input.totalBytes,
    manifestHash: hash,
    source: input.source
  }

  await fs.writeFile(join(dir, MANIFEST_FILE), JSON.stringify(input.manifest), 'utf8')
  await fs.writeFile(join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')

  await pruneSnapshots(input.project.id, SNAPSHOT_KEEP)

  return {
    snapshot: { ...meta, available: true },
    dir,
    filesDir,
    manifest: input.manifest,
    files: input.files.map((file) => ({
      ...file,
      abs: join(filesDir, file.rel)
    }))
  }
}

export async function listSnapshots(projectId: string): Promise<ArtifactSnapshot[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(projectDir(projectId))
  } catch {
    return []
  }

  const snapshots: ArtifactSnapshot[] = []
  for (const entry of entries) {
    const meta = await readMeta(projectId, entry)
    if (!meta) continue
    const available = await fs
      .stat(join(snapshotDir(projectId, entry), FILES_DIR))
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    snapshots.push({ ...meta, available })
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return snapshots
}

export async function resolveSnapshot(
  projectId: string,
  snapshotId: string
): Promise<SnapshotArtifacts> {
  const meta = await readMeta(projectId, snapshotId)
  if (!meta) throw new Error(`产物快照不存在：${snapshotId}`)
  const dir = snapshotDir(projectId, snapshotId)
  const filesDir = join(dir, FILES_DIR)

  let manifest: Manifest
  try {
    manifest = JSON.parse(await fs.readFile(join(dir, MANIFEST_FILE), 'utf8')) as Manifest
  } catch {
    throw new Error(`产物快照缺少文件清单，无法发布：${snapshotId}`)
  }

  const files = await walkFiles(filesDir)
  if (files.length === 0) throw new Error(`产物快照为空：${snapshotId}`)

  return {
    snapshot: { ...meta, available: true },
    dir,
    filesDir,
    manifest,
    files
  }
}

export async function deleteSnapshot(
  projectId: string,
  snapshotId: string
): Promise<{ ok: boolean; message?: string }> {
  if (!/^[\w.-]+$/.test(snapshotId)) {
    return { ok: false, message: '快照标识不合法' }
  }
  const dir = snapshotDir(projectId, snapshotId)
  const exists = await fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
  if (!exists) return { ok: false, message: '快照不存在或已删除' }
  await fs.rm(dir, { recursive: true, force: true })
  return { ok: true }
}

export async function pruneSnapshots(projectId: string, keep: number): Promise<void> {
  const snapshots = await listSnapshots(projectId)
  for (const snapshot of snapshots.slice(Math.max(1, keep))) {
    try {
      await fs.rm(snapshotDir(projectId, snapshot.id), { recursive: true, force: true })
    } catch {
      /* 清理失败不影响本次发布 */
    }
  }
}

/** 删除项目时清理它的全部产物快照 */
export async function removeProjectArtifacts(projectId: string): Promise<void> {
  await fs.rm(projectDir(projectId), { recursive: true, force: true })
}

export { profileFingerprint }
