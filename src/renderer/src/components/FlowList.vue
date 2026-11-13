<script setup lang="ts">
import { computed, ref } from 'vue'
import type { JobKind, JobStatus } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'

const store = useProjectStore()
const jobStore = useJobStore()
const expanded = ref<string | null>(null)

const kindLabels: Record<JobKind, string> = {
  preflight: '预检',
  build: '构建',
  deploy: '构建并发布',
  'deploy-only': '快照发布',
  rollback: '回滚'
}

const statusLabels: Record<JobStatus, string> = {
  idle: '空闲',
  running: '进行中',
  success: '成功',
  failed: '失败',
  canceled: '已取消'
}

const environmentName = computed(() => {
  const map = new Map<string, string>()
  for (const env of store.current?.environments ?? []) map.set(env.id, env.name)
  return map
})

function envNames(ids: string[]): string {
  if (ids.length === 0) return '项目默认'
  return ids.map((id) => environmentName.value.get(id) ?? id).join('、')
}

function formatTime(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id
}

async function clear(): Promise<void> {
  if (!window.confirm('确定清空发布流记录？服务器上的版本历史不受影响。')) return
  await store.clearFlows()
}

function statusLabel(status: JobStatus): string {
  return statusLabels[status] ?? status
}
</script>

<template>
  <div class="flow-wrap">
    <div class="flow-head">
      <span class="title">发布流</span>
      <span class="hint">{{ store.flows.length }} 条记录</span>
      <span class="spacer"></span>
      <span class="tool" @click="store.loadFlows()">刷新</span>
      <span class="tool" @click="clear">清空</span>
    </div>

    <div class="flow-body">
      <div v-if="jobStore.running" class="flow-item running">
        <div class="fi-line">
          <span class="flow-dot running"></span>
          <b>{{ kindLabels[jobStore.state.kind ?? 'deploy'] }}</b>
          <span class="fi-msg-inline">{{ jobStore.state.text }}</span>
          <span class="spacer"></span>
          <span class="fi-percent">{{ jobStore.state.percent }}%</span>
        </div>
        <div class="flow-progress">
          <div class="flow-progress-fill" :style="{ width: `${jobStore.state.percent}%` }"></div>
        </div>
      </div>

      <div
        v-for="flow in store.flows"
        :key="flow.id"
        class="flow-item"
        :class="flow.status"
        @click="toggle(flow.id)"
      >
        <div class="fi-line">
          <span class="flow-dot" :class="flow.status"></span>
          <span class="fi-kind">{{ kindLabels[flow.kind] }}</span>
          <span class="fi-envs">{{ envNames(flow.environmentIds) }}</span>
          <span class="spacer"></span>
          <span class="fi-status" :class="flow.status">{{ statusLabel(flow.status) }}</span>
          <span class="fi-time">{{ formatTime(flow.startedAt) }}</span>
        </div>
        <div v-if="flow.message" class="fi-msg">{{ flow.message }}</div>
        <div v-if="expanded === flow.id" class="fi-detail">
          <div>开始：{{ formatTime(flow.startedAt) }} · 结束：{{ formatTime(flow.finishedAt) }}</div>
          <div v-if="flow.snapshotId">
            产物快照：<span class="mono">{{ flow.snapshotId }}</span>
          </div>
          <div>本次任务产生 {{ flow.logCount }} 条日志，可在下方日志面板查看。</div>
        </div>
      </div>

      <div v-if="store.flows.length === 0 && !jobStore.running" class="empty">
        暂无发布记录<br /><b>执行一次预检 / 构建 / 发布后显示</b>
      </div>
    </div>
  </div>
</template>
