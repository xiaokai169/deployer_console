<script setup lang="ts">
import { computed, watch } from 'vue'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'
import EnvironmentPane from './panes/EnvironmentPane.vue'
import HistoryPanel from './HistoryPanel.vue'
import ServerManagerDialog from './ServerManagerDialog.vue'

const store = useProjectStore()
const jobStore = useJobStore()
const environment = computed(() => store.activeEnvironment)

watch(
  () => store.environmentSettingsOpen,
  (open) => {
    if (open) void store.loadReleases()
  }
)

async function removeEnvironment(): Promise<void> {
  if (!environment.value) return
  if (jobStore.running) {
    jobStore.pushLocal('WARN', '任务执行中，暂不能删除环境')
    return
  }
  if (
    !window.confirm(
      `确定删除环境「${environment.value.name}」？\n\n只删除本机配置，不会影响服务器上已发布的文件。`
    )
  ) {
    return
  }
  await store.removeEnvironment(environment.value.id)
  store.closeEnvironmentSettings()
}
</script>

<template>
  <div
    v-if="store.environmentSettingsOpen"
    class="overlay"
    @click.self="store.closeEnvironmentSettings()"
  >
    <div class="modal settings-modal" style="width: 800px">
      <div class="modal-head">
        环境设置{{ environment ? ` · ${environment.name}` : '' }}
        <span class="x" @click="store.closeEnvironmentSettings()">×</span>
      </div>

      <div class="modal-body settings-single">
        <EnvironmentPane />
        <div class="group" v-if="environment">
          <div class="group-title">远端版本历史</div>
          <div class="group-desc">服务器上已发布的版本，可回滚到任意一个历史版本。</div>
          <HistoryPanel />
        </div>
      </div>

      <div class="modal-foot">
        <button v-if="environment" class="btn warn" @click="removeEnvironment">删除环境</button>
        <span class="spacer"></span>
        <span class="hint">修改会自动保存</span>
        <button class="btn primary" @click="store.closeEnvironmentSettings()">完成</button>
      </div>
    </div>

    <ServerManagerDialog v-if="store.serverDialog.open" />
  </div>
</template>
