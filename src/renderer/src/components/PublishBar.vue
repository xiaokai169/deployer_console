<script setup lang="ts">
import { computed } from 'vue'
import type { EnvironmentConfig } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'
import { profileKeyOf } from '../utils/profile'
import ProgressBar from './ProgressBar.vue'

const store = useProjectStore()
const jobStore = useJobStore()

const project = computed(() => store.current)
const busy = computed(() => jobStore.running)

const targets = computed<EnvironmentConfig[]>(() => {
  const current = project.value
  if (!current) return []
  return current.environments.filter((env) => store.publishEnvironmentIds.includes(env.id))
})

/** 目标环境的构建配置签名，相同签名会共用一份产物 */
const profileGroups = computed(() => {
  const current = project.value
  if (!current) return [] as string[][]
  const map = new Map<string, string[]>()
  for (const env of targets.value) {
    const key = profileKeyOf(current, env)
    map.set(key, [...(map.get(key) ?? []), env.name])
  }
  return Array.from(map.values())
})

const sharedCount = computed(
  () => profileGroups.value.filter((group) => group.length > 1).length
)

function runPreflight(): void {
  void jobStore.start('preflight', store.publishEnvironmentIds)
}

function runBuild(): void {
  const ids =
    store.publishEnvironmentIds.length > 0
      ? store.publishEnvironmentIds
      : store.activeEnvironmentId
        ? [store.activeEnvironmentId]
        : []
  void jobStore.start('build', ids)
}

function runSnapshot(): void {
  store.openSnapshotDialog()
}

function runPublish(): void {
  store.openPublishDialog('deploy')
}

function runRollback(): void {
  const environmentId = store.activeEnvironmentId
  if (!environmentId) {
    jobStore.pushLocal('WARN', '请先在左侧选择一个环境')
    return
  }
  if (!window.confirm('确定将当前环境回滚到上一个版本？')) return
  void jobStore.start('rollback', [environmentId])
}
</script>

<template>
  <div class="publish-bar">
    <div class="publish-targets">
      <span class="pb-label">本次发布</span>
      <template v-if="targets.length > 0">
        <span
          v-for="environment in targets"
          :key="environment.id"
          class="target-chip"
          :title="`${environment.name} · ${environment.rootDir || '未配置目录'}`"
          @click="store.selectEnvironment(environment.id)"
        >
          {{ environment.name }}
        </span>
      </template>
      <span v-else class="hint">未勾选环境，请在左侧勾选要发布的目标</span>
      <span class="spacer"></span>
      <span v-if="sharedCount > 0" class="pb-warn" title="这些环境构建配置相同，会共用一份产物">
        {{ sharedCount }} 组环境共用产物
      </span>
    </div>

    <div class="publish-actions">
      <button class="btn sm" :disabled="busy || !project" @click="runPreflight">预检</button>
      <button class="btn sm" :disabled="busy || !project" @click="runBuild">仅构建</button>
      <button
        class="btn sm"
        :disabled="busy || !project"
        title="从历史产物快照发布，不会读取本地 dist"
        @click="runSnapshot"
      >
        选快照发布
      </button>
      <button class="btn sm warn" :disabled="busy || !store.activeEnvironmentId" @click="runRollback">
        回滚
      </button>
      <span class="spacer"></span>
      <button v-if="busy" class="btn sm danger" @click="jobStore.cancel()">取消</button>
      <button class="btn primary" :disabled="busy || !project" @click="runPublish">
        构建并发布
      </button>
    </div>

    <ProgressBar />
  </div>
</template>
