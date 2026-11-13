<script setup lang="ts">
import { computed } from 'vue'
import type { EnvironmentConfig } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'

const store = useProjectStore()
const jobStore = useJobStore()
const project = computed(() => store.current)

function serverLabel(environment: EnvironmentConfig): string {
  const server = project.value?.targets.find((item) => item.id === environment.serverId)
  if (!server) return '未选择服务器'
  return `${server.username}@${server.host || '未配置主机'}`
}

function selected(environment: EnvironmentConfig): boolean {
  return store.selectedEnvironmentIds.includes(environment.id)
}

async function removeEnvironment(environment: EnvironmentConfig): Promise<void> {
  if (jobStore.running) {
    jobStore.pushLocal('WARN', '任务执行中，暂不能删除环境')
    return
  }
  if (
    !window.confirm(
      `确定删除环境「${environment.name}」？\n\n只删除本机配置，不会影响服务器上已发布的文件。`
    )
  ) {
    return
  }
  await store.removeEnvironment(environment.id)
  if (store.environmentSettingsId === environment.id) store.closeEnvironmentSettings()
}
</script>

<template>
  <div v-if="project" class="env-section">
    <div class="section-head">
      <span>环境</span>
      <span class="spacer"></span>
      <span class="head-btn" title="管理服务器连接" @click="store.openProjectSettings('servers')">
        服务器
      </span>
    </div>

    <div class="env-list">
      <div
        v-for="environment in project.environments"
        :key="environment.id"
        class="env-card"
        :class="{
          active: environment.id === store.activeEnvironmentId,
          on: selected(environment)
        }"
        @click="store.selectEnvironment(environment.id)"
      >
        <span
          class="target-check"
          :class="{ on: selected(environment) }"
          :title="selected(environment) ? '取消勾选本次发布' : '勾选参与本次发布'"
          @click.stop="store.toggleEnvironmentSelected(environment.id)"
        ></span>
        <div class="env-main">
          <div class="env-name">{{ environment.name }}</div>
          <div
            class="env-host mono"
            :title="`${serverLabel(environment)} · ${environment.rootDir}`"
          >
            {{ serverLabel(environment) }} · {{ environment.rootDir || '未配置目录' }}
          </div>
        </div>
        <button
          class="env-gear"
          title="环境设置"
          @click.stop="store.openEnvironmentSettings(environment.id)"
        >
          ⚙
        </button>
        <button
          class="env-del"
          title="删除环境"
          @click.stop="removeEnvironment(environment)"
        >
          ×
        </button>
      </div>
    </div>

    <div class="add-line" @click="store.addEnvironment()">+ 添加环境</div>

    <div v-if="project.environments.length === 0" class="hint" style="padding: 0 10px 10px">
      还没有环境，先添加测试 / 生产环境。
    </div>
    <div v-if="project.targets.length === 0" class="hint" style="padding: 0 10px 10px">
      还没有服务器连接，点击右上角「服务器」添加。
    </div>
  </div>
</template>
