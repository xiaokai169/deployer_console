<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useJobStore } from '../stores/job'

const emit = defineEmits<{ collapse: [] }>()

const store = useJobStore()
const body = ref<HTMLElement | null>(null)
const nearBottom = ref(true)

const filters = [
  { key: 'all', label: '全部' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
  { key: 'cmd', label: '命令' }
] as const

const logs = computed(() => store.filteredLogs)

function onScroll(): void {
  const el = body.value
  if (!el) return
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => store.logs.length,
  async () => {
    if (!nearBottom.value) return
    await nextTick()
    const el = body.value
    if (el) el.scrollTop = el.scrollHeight
  }
)
</script>

<template>
  <div class="logbar">
    <div class="log-head">
      <span class="title">发布日志</span>
      <div class="log-filter">
        <span
          v-for="filter in filters"
          :key="filter.key"
          :class="{ on: store.logFilter === filter.key }"
          @click="store.logFilter = filter.key"
        >
          {{ filter.label }}
        </span>
      </div>
      <span class="spacer"></span>
      <span class="tool" @click="store.exportLogs()">导出</span>
      <span class="tool" @click="store.clearLogs()">清空</span>
      <span class="tool" @click="emit('collapse')">收起</span>
    </div>
    <div ref="body" class="log-body" @scroll="onScroll">
      <div v-for="entry in logs" :key="entry.id" class="log-line">
        <span class="log-time">{{ entry.ts }}</span>
        <span class="log-lv" :class="entry.level">{{ entry.level }}</span>
        <span class="log-msg">{{ entry.msg }}</span>
      </div>
      <div v-if="logs.length === 0" class="empty">暂无日志</div>
    </div>
  </div>
</template>
