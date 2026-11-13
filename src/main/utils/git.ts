import { execFile } from 'child_process'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** 执行 git 命令（非交互，禁止终端凭据弹窗） */
export function runGit(cwd: string, args: string[], timeoutMs = 20000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, stdout: stdout ?? '', stderr: stderr || error.message })
        } else {
          resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '' })
        }
      }
    )
  })
}

export async function gitTopLevel(path: string): Promise<string | null> {
  if (!path) return null
  const result = await runGit(path, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return null
  const root = result.stdout.trim()
  return root || null
}

/**
 * 读取远程跟踪分支 reflog 中最近一次"本机 push"的提交。
 * 只认 `update by push` 记录，fetch / pull 更新不会被当成自己的推送。
 */
export async function latestPushedSha(
  gitRoot: string,
  remote: string,
  branch: string
): Promise<string | null> {
  const ref = `refs/remotes/${remote}/${branch}`
  const result = await runGit(gitRoot, ['reflog', 'show', '--format=%H%x09%gs', ref, '-n', '80'])
  if (!result.ok) return null
  for (const line of result.stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const sha = line.slice(0, tab).trim()
    const message = line.slice(tab + 1)
    if (/^[0-9a-f]{7,64}$/i.test(sha) && /update by push/i.test(message)) return sha
  }
  return null
}

export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] || '').slice(0, 220)
}
