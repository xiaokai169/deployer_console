import { delay } from './semaphore'

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  onRetry?: (error: Error, attempt: number) => void,
  signal?: AbortSignal
): Promise<T> {
  const total = Math.max(0, retries) + 1
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= total; attempt += 1) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < total) {
        onRetry?.(lastError, attempt)
        await delay(1000 * attempt)
      }
    }
  }
  throw lastError ?? new Error('执行失败')
}
