/** POSIX 单引号转义，防止远端命令注入 */
export function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 拼接远端正斜杠路径 */
export function pjoin(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
  if (!joined) return '/'
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined
}

export function posixDirname(p: string): string {
  const normalized = p.replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

/** rootDir 为绝对路径，rel 支持绝对路径覆盖 */
export function resolveRemote(rootDir: string, rel: string): string {
  if (!rel) return pjoin(rootDir)
  if (rel.startsWith('/')) return pjoin(rel)
  return pjoin(rootDir, rel)
}
