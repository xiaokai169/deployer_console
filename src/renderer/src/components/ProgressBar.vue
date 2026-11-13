<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../stores/job'

const jobStore = useJobStore()

const visible = computed(
  () => jobStore.state.status === 'running' || jobStore.state.status === 'failed'
)
const percent = computed(() => jobStore.state.percent)
const text = computed(() => jobStore.state.text)
const failed = computed(() => jobStore.state.status === 'failed')
</script>

<template>
  <div v-if="visible" class="progress-wrap">
    <div class="progress-bar">
      <div class="progress-fill" :class="{ error: failed }" :style="{ width: `${percent}%` }"></div>
    </div>
    <div class="progress-text">
      <span>{{ text }}</span>
      <span>{{ percent }}%</span>
    </div>
  </div>
</template>
