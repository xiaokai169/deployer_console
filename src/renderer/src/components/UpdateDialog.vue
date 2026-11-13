<script setup lang="ts">
import { computed } from 'vue'
import { useUpdateStore } from '../stores/update'

const store = useUpdateStore()
const state = computed(() => store.state)

const installing = computed(() => state.value?.status === 'downloaded')
const busy = computed(
  () => store.busy || state.value?.status === 'checking' || state.value?.status === 'downloading'
)

async function close(): Promise<void> {
  store.open = false
}
</script>

<template>
  <div v-if="store.open" class="overlay" @click.self="close">
    <div class="modal" style="width: 520px">
      <div class="modal-head">
        版本更新
        <span class="x" @click="close">×</span>
      </div>

      <div class="modal-body">
        <div class="update-version">
          <span>当前版本</span>
          <b class="mono">v{{ state?.currentVersion || '—' }}</b>
          <span class="spacer"></span>
          <span v-if="state?.version" class="mono update-new">新版本 v{{ state.version }}</span>
        </div>

        <div v-if="!state" class="empty">正在读取更新状态...</div>
        <template v-else>
          <div v-if="state.status === 'unavailable'" class="warn-box">
            {{ state.message || '当前为开发模式，自动更新仅在安装打包版本后生效。' }}
          </div>

          <div v-else-if="state.status === 'error'" class="warn-box">
            {{ state.message }}
          </div>

          <template v-else>
            <div class="update-status">
              <span class="update-dot" :class="state.status"></span>
              <span>{{ state.message || '尚未检查更新' }}</span>
            </div>

            <div v-if="state.status === 'downloading'" class="update-progress">
              <div class="update-progress-fill" :style="{ width: `${state.percent ?? 0}%` }"></div>
            </div>

            <div v-if="state.status === 'downloaded'" class="update-ready">
              新版本已下载完成。点击「立即重启安装」后应用会关闭并完成更新，当前未完成的发布任务会中断。
            </div>

            <div v-else class="hint" style="margin-top: 8px">
              应用启动后会检查一次更新，之后每 4 小时自动检查；发现新版本会在后台下载。
            </div>
          </template>
        </template>
      </div>

      <div class="modal-foot">
        <button
          v-if="state?.enabled && !installing"
          class="btn"
          :disabled="busy"
          @click="store.check()"
        >
          {{ busy ? '处理中...' : '检查更新' }}
        </button>
        <span class="spacer"></span>
        <button class="btn" @click="close">{{ installing ? '稍后' : '关闭' }}</button>
        <button v-if="installing" class="btn primary" @click="store.install()">
          立即重启安装
        </button>
      </div>
    </div>
  </div>
</template>
