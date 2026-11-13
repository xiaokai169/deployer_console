<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import TopBar from './components/TopBar.vue'
import ProjectList from './components/ProjectList.vue'
import EnvironmentList from './components/EnvironmentList.vue'
import PublishBar from './components/PublishBar.vue'
import FlowList from './components/FlowList.vue'
import LogPanel from './components/LogPanel.vue'
import ProjectSettingsDialog from './components/ProjectSettingsDialog.vue'
import EnvironmentSettingsDialog from './components/EnvironmentSettingsDialog.vue'
import SnapshotDialog from './components/SnapshotDialog.vue'
import PublishConfirmDialog from './components/PublishConfirmDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import TeamRepoDialog from './components/TeamRepoDialog.vue'
import { useProjectStore } from './stores/project'
import { useJobStore } from './stores/job'
import { useUpdateStore } from './stores/update'

const projectStore = useProjectStore()
const jobStore = useJobStore()
const updateStore = useUpdateStore()
const teamOpen = ref(false)
const logsOpen = ref(true)

let saveTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => projectStore.current,
  () => {
    if (!projectStore.loaded) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void projectStore.save()
    }, 600)
  },
  { deep: true }
)

onMounted(async () => {
  jobStore.bind()
  void updateStore.bind()
  await projectStore.load()
})

onUnmounted(() => {
  jobStore.unbind()
  updateStore.unbind()
  if (saveTimer) clearTimeout(saveTimer)
})
</script>

<template>
  <div class="shell">
    <TopBar />

    <div class="main2">
      <aside class="sidebar">
        <ProjectList />
        <EnvironmentList />
        <div class="sidebar-foot">
          <button class="btn sm" @click="projectStore.openProjectSettings()">项目设置</button>
          <button class="btn sm" @click="teamOpen = true">团队配置</button>
        </div>
      </aside>

      <section class="workspace">
        <PublishBar />
        <FlowList />
        <div class="log-dock" :class="{ collapsed: !logsOpen }">
          <div v-if="!logsOpen" class="log-toggle" @click="logsOpen = true">
            展开发布日志（{{ jobStore.logs.length }}）
          </div>
          <LogPanel v-else @collapse="logsOpen = false" />
        </div>
      </section>
    </div>

    <ProjectSettingsDialog />
    <EnvironmentSettingsDialog />
    <SnapshotDialog v-if="projectStore.snapshotDialogOpen" />
    <PublishConfirmDialog />
    <UpdateDialog />
    <TeamRepoDialog v-model:open="teamOpen" />
  </div>
</template>
