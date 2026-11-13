import { execFile } from 'child_process'
import { hostname, userInfo } from 'os'
import type { Project } from '@shared/types'

const cache = new Map<string, { name: string; at: number }>()
const CACHE_TTL_MS = 60 * 1000

function gitUserName(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['config', 'user.name'],
      {
        cwd,
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout) => {
        if (error) resolve('')
        else resolve((stdout || '').trim())
      }
    )
  })
}

function fallbackName(): string {
  try {
    const name = userInfo().username
    if (name) return name
  } catch {
    /* ignore */
  }
  return hostname() || 'unknown'
}

/**
 * 操作员 / 发布人：优先取项目本地仓库的 git user.name（本地配置优先于全局），
 * 取不到时回退到系统用户名。
 */
export async function resolveOperator(project: Partial<Project>): Promise<string> {
  const localPath = (project.localPath || '').trim()
  const cacheKey = localPath || '__global__'
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.name

  const name = (await gitUserName(localPath || process.cwd())) || fallbackName()
  cache.set(cacheKey, { name, at: Date.now() })
  return name
}
