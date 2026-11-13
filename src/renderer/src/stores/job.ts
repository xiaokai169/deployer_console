import { defineStore } from 'pinia'
import type {
  DiffPayload,
  DiffResult,
  JobKind,
  JobState,
  LogEntry,
  LogLevel,
  ProgressPayload,
  StartJobResult
} from '@shared/types'
import { useProjectStore } from './project'

type LogFilter = 'all' | 'info' | 'warn' | 'error' | 'cmd'

let bound = false
let subscriptions: number[] = []
let localLogSeq = 0

function localTime(): string {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

export const useJobStore = defineStore('job', {
  state: () => ({
    state: { kind: null, status: 'idle', stage: '', percent: 0, text: '空闲' } as JobState,
    logs: [] as LogEntry[],
    diffByTarget: {} as Record<string, DiffResult>,
    lastDiff: null as DiffResult | null,
    logFilter: 'all' as LogFilter
  }),
  getters: {
    running(state): boolean {
      return state.state.status === 'running'
    },
    filteredLogs(state): LogEntry[] {
      switch (state.logFilter) {
        case 'info':
          return state.logs.filter((l) => l.level === 'INFO' || l.level === 'OK')
        case 'warn':
          return state.logs.filter((l) => l.level === 'WARN')
        case 'error':
          return state.logs.filter((l) => l.level === 'ERROR')
        case 'cmd':
          return state.logs.filter((l) => l.level === 'CMD')
        default:
          return state.logs
      }
    },
    statusText(state): string {
      const s = state.state
      if (s.status === 'running') {
        return s.kind === 'deploy' || s.kind === 'deploy-only'
          ? '发布中'
          : s.kind === 'build'
            ? '构建中'
            : s.kind === 'preflight'
              ? '预检中'
              : s.kind === 'rollback'
                ? '回滚中'
                : '执行中'
      }
      if (s.status === 'success') {
        return s.kind === 'deploy' || s.kind === 'deploy-only'
          ? '发布成功'
          : s.kind === 'build'
            ? '构建成功'
            : s.kind === 'preflight'
              ? '预检通过'
              : '回滚完成'
      }
      if (s.status === 'failed') return '失败'
      if (s.status === 'canceled') return '已取消'
      return '空闲'
    }
  },
  actions: {
    bind() {
      if (bound) return
      bound = true
      subscriptions = [
        window.api.onLog((entry) => this.pushLog(entry)),
        window.api.onProgress((payload: ProgressPayload) => {
          this.state = { ...this.state, percent: payload.percent, text: payload.text }
        }),
        window.api.onStage((payload) => {
          this.state = { ...this.state, stage: payload.stage }
        }),
        window.api.onState((state) => this.applyState(state)),
        window.api.onDiff((payload: DiffPayload) => {
          this.lastDiff = payload.diff
          if (payload.targetId) this.diffByTarget[payload.targetId] = payload.diff
        }),
        window.api.onDone(() => {
          void this.refreshState()
          // 主进程在写入流水记录后才派发 done，这里刷新才能看到本次记录与快照
          const store = useProjectStore()
          void store.loadFlows()
          void store.loadSnapshots()
        })
      ]
      void this.refreshState()
    },
    unbind() {
      for (const id of subscriptions) window.api.off(id)
      subscriptions = []
      bound = false
    },
    async refreshState() {
      this.state = await window.api.getJobState()
    },
    applyState(state: JobState) {
      const previousStatus = this.state.status
      this.state = { ...state }
      if (previousStatus !== 'running') return
      if (
        state.status !== 'success' &&
        state.status !== 'failed' &&
        state.status !== 'canceled'
      ) {
        return
      }
      const store = useProjectStore()
      void store.loadFlows()
      if (state.status !== 'success') return
      if (state.kind === 'build' || state.kind === 'deploy' || state.kind === 'deploy-only') {
        void store.loadSnapshots()
      }
      if (state.kind === 'deploy' || state.kind === 'rollback') {
        void store.loadReleases()
      }
    },
    pushLog(entry: LogEntry) {
      this.logs.push(entry)
      if (this.logs.length > 3000) this.logs.splice(0, this.logs.length - 3000)
    },
    pushLocal(level: LogLevel, msg: string) {
      localLogSeq += 1
      this.logs.push({ id: -localLogSeq, ts: localTime(), level, msg })
    },
    async start(
      kind: JobKind,
      environmentIds: string[],
      releaseName?: string,
      snapshotId?: string
    ): Promise<StartJobResult> {
      const projectStore = useProjectStore()
      const projectId = projectStore.currentId
      if (!projectId) {
        this.pushLocal('WARN', '请先选择项目')
        return { started: false, message: '请先选择项目' }
      }
      const result = await window.api.startJob({
        kind,
        projectId,
        environmentIds,
        releaseName,
        snapshotId
      })
      if (!result.started && result.message) this.pushLocal('WARN', result.message)
      return result
    },
    async cancel() {
      await window.api.cancelJob()
    },
    clearLogs() {
      this.logs = []
    },
    async exportLogs() {
      const content = this.logs
        .map((entry) => `${entry.ts} ${entry.level.padEnd(5)} ${entry.msg}`)
        .join('\n')
      if (!content) {
        this.pushLocal('INFO', '暂无日志可导出')
        return
      }
      try {
        const result = await window.api.exportLogs(content)
        if (result.saved && result.path) this.pushLocal('OK', `日志已导出：${result.path}`)
        else this.pushLocal('INFO', '已取消导出')
      } catch (err) {
        this.pushLocal('ERROR', `导出日志失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
})
