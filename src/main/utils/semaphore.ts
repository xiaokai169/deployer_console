export type WorkerResult<T, R> =
  | { item: T; ok: true; value: R }
  | { item: T; ok: false; error: Error }

export interface ConcurrencyOptions {
  signal?: AbortSignal
  shouldStop?: () => boolean
}

/**
 * 简单并发池：最多 limit 个 worker 同时执行，结果按输入顺序返回。
 * worker 抛出的错误会被捕获为 { ok: false }，不会中断其他任务。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: ConcurrencyOptions = {}
): Promise<Array<WorkerResult<T, R>>> {
  const results: Array<WorkerResult<T, R>> = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit || 1, items.length || 1))

  const runner = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted || options.shouldStop?.()) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      try {
        const value = await worker(item, index)
        results[index] = { item, ok: true, value }
      } catch (err) {
        results[index] = { item, ok: false, error: err instanceof Error ? err : new Error(String(err)) }
      }
    }
  }

  await Promise.all(Array.from({ length: size }, () => runner()))
  return results.filter((r): r is WorkerResult<T, R> => Boolean(r))
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
