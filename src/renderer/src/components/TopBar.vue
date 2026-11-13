<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'
import { useUpdateStore } from '../stores/update'

const projectStore = useProjectStore()
const jobStore = useJobStore()
const updateStore = useUpdateStore()

const operator = computed(() => projectStore.operator || '—')

const themes = [
  { value: 'forest', label: '森林绿' },
  { value: 'ocean', label: '深海蓝' },
  { value: 'aurora', label: '极光紫' },
  { value: 'amber', label: '琥珀夜' },
  { value: 'light', label: '明亮白' },
  { value: 'indigo', label: '现代靛蓝' },
  { value: 'mono', label: '极简黑白' },
  { value: 'github', label: 'GitHub 深灰' },
  { value: 'nord', label: '北欧极地' },
  { value: 'slate', label: '现代浅灰' }
]

const theme = ref(localStorage.getItem('deploye-theme') || 'forest')

watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value
    localStorage.setItem('deploye-theme', value)
  },
  { immediate: true }
)
</script>

<template>
  <div class="topbar">
    <div class="logo">Deploy<span>Console</span></div>
    <div class="spacer"></div>
    <button
      class="update-chip"
      :class="updateStore.tone"
      :title="updateStore.state?.message || '检查更新'"
      @click="updateStore.open = true"
    >
      <span class="update-chip-dot"></span>
      <span>v{{ updateStore.version || '—' }}</span>
      <b v-if="updateStore.badge">{{ updateStore.badge }}</b>
    </button>
    <div class="meta theme-picker">
      主题：
      <select v-model="theme" class="theme-select">
        <option v-for="item in themes" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
    </div>
    <div class="meta">
      状态：<b class="job-status" :class="jobStore.state.status">{{ jobStore.statusText }}</b>
    </div>
    <div class="meta">操作员：<b>{{ operator }}</b></div>
  </div>
</template>
