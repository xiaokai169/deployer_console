<script setup lang="ts">
import { computed } from 'vue'
import type { ReleaseInfo } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'

const store = useProjectStore()
const jobStore = useJobStore()
const releases = computed(() => store.releases)

function formatTime(iso?: string): string {
  if (!iso) return '时间未知'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function rollback(release: ReleaseInfo): void {
  const environmentId = store.activeEnvironmentId
  if (!environmentId) return
  if (!window.confirm(`确定回滚到版本 ${release.name}？`)) return
  void jobStore.start('rollback', [environmentId], release.name)
}
</script>

<template>
  <div style="padding-top: 12px">
    <div class="history-head">
      <span class="hint">{{
        store.activeEnvironment ? store.activeEnvironment.name : '未选择环境'
      }}</span>
      <button class="rb-btn" :disabled="store.releasesLoading" @click="store.loadReleases()">
        {{ store.releasesLoading ? '加载中...' : '刷新' }}
      </button>
    </div>
    <div v-if="!store.activeEnvironmentId" class="empty">请先在右侧选择环境</div>
    <div v-else-if="store.releasesLoading" class="empty">正在读取远端版本...</div>
    <div v-else-if="store.releasesError" class="empty">{{ store.releasesError }}</div>
    <div v-else-if="releases.length === 0" class="empty">暂无发布历史</div>
    <div
      v-for="release in releases"
      :key="release.name"
      class="release-item"
      :class="{ current: release.current }"
    >
      <div class="ver">
        <b class="mono">{{ release.name }}</b>
        <span>{{ formatTime(release.mtime) }}<template v-if="release.operator"> · {{ release.operator }}</template></span>
      </div>
      <span v-if="release.current" class="cur-tag">当前</span>
      <button v-else class="rb-btn" :disabled="jobStore.running" @click="rollback(release)">回滚</button>
    </div>
  </div>
</template>
