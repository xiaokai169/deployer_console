import type { DiffResult, FileChange, Manifest } from '@shared/types'

export function diffManifests(previous: Manifest | null, next: Manifest): DiffResult {
  const files: FileChange[] = []
  let added = 0
  let modified = 0
  let deleted = 0

  for (const [path, entry] of Object.entries(next)) {
    const old = previous?.[path]
    if (!old) {
      added += 1
      files.push({ path, status: 'added', size: entry.size })
    } else if (old.hash !== entry.hash) {
      modified += 1
      files.push({ path, status: 'modified', size: entry.size })
    }
  }

  if (previous) {
    for (const path of Object.keys(previous)) {
      if (!next[path]) {
        deleted += 1
        files.push({ path, status: 'deleted' })
      }
    }
  }

  const order: Record<FileChange['status'], number> = { added: 0, modified: 1, deleted: 2 }
  files.sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path))

  return { added, modified, deleted, files }
}
