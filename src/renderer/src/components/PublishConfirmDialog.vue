<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EnvironmentConfig } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'
import { profileKeyOf } from '../utils/profile'

const store = useProjectStore()
const jobStore = useJobStore()

const confirmed = ref(false)
const busy = ref(false)

const kind = computed(() => store.publishDialog.kind)
const isSnapshotMode = computed(() => kind.value === 'deploy-only')
const project = computed(() => store.current)
const snapshot = computed(
  () => store.snapshots.find((item) => item.id === store.activeSnapshotId) ?? null
)

const allEnvironments = computed<EnvironmentConfig[]>(() => project.value?.environments ?? [])

const targets = computed<EnvironmentConfig[]>(() => {
  const current = project.value
  if (!current) return []
  return current.environments.filter((env) => store.publishEnvironmentIds.includes(env.id))
})

function isSelected(environment: EnvironmentConfig): boolean {
  return store.selectedEnvironmentIds.includes(environment.id)
}

function toggle(environment: EnvironmentConfig): void {
  store.toggleEnvironmentSelected(environment.id)
}

const needsProductionConfirm = computed(() =>
  targets.value.some((env) => /生产|prod|production/i.test(env.name))
)

/** 构建配置相同的环境会共用同一份产物，必须明确提示 */
const sharedProfiles = computed(() => {
  const current = project.value
  if (!current) return [] as string[][]
  const map = new Map<string, string[]>()
  for (const env of targets.value) {
    const key = profileKeyOf(current, env)
    const list = map.get(key) ?? []
    list.push(env.name)
    map.set(key, list)
  }
  return Array.from(map.values()).filter((names) => names.length > 1)
})

const canPublish = computed(() => {
  if (!project.value) return false
  if (targets.value.length === 0) return false
  if (isSnapshotMode.value && !snapshot.value) return false
  if (needsProductionConfirm.value && !confirmed.value) return false
  return !busy.value
})

watch(
  () => store.publishDialog.open,
  (open) => {
    if (!open) return
    confirmed.value = false
    void store.loadSnapshots()
  }
)

function serverOf(env: EnvironmentConfig): string {
  const server = project.value?.targets.find((item) => item.id === env.serverId)
  if (!server) return '未选择服务器'
  return `${server.username}@${server.host || '未配置主机'}:${server.port}`
}

function envMatch(env: EnvironmentConfig): 'ok' | 'warn' | 'idle' {
  if (!isSnapshotMode.value) return 'idle'
  if (!snapshot.value) return 'warn'
  return profileKeyOf(project.value!, env) === snapshot.value.profileKey ? 'ok' : 'warn'
}

function diffText(envId: string): string {
  const diff = jobStore.diffByTarget[envId]
  if (!diff) return '—'
  return `+${diff.added} / ~${diff.modified} / -${diff.deleted}`
}

async function confirm(): Promise<void> {
  if (!project.value || !canPublish.value) return
  busy.value = true
  try {
    const result = await jobStore.start(
      kind.value,
      store.publishEnvironmentIds,
      undefined,
      isSnapshotMode.value ? snapshot.value?.id : undefined
    )
    if (result.started) store.closePublishDialog()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="store.publishDialog.open" class="overlay" @click.self="store.closePublishDialog()">
    <div class="modal" style="width: 840px">
      <div class="modal-head">
        {{ isSnapshotMode ? '确认发布产物快照' : '确认构建并发布' }}
        <span class="x" @click="store.closePublishDialog()">×</span>
      </div>

      <div class="modal-body">
        <div v-if="!project" class="empty">暂无项目</div>
        <template v-else>
          <div v-if="isSnapshotMode && !snapshot" class="warn-box">
            尚未选择产物快照，请先「选择快照」再发布。
          </div>

          <div v-if="isSnapshotMode && snapshot" class="snap-summary">
            <div class="mono snap-title">{{ snapshot.id }}</div>
            <div class="hint">
              {{ snapshot.buildCommand || '（跳过构建）' }} · {{ snapshot.distDir }} ·
              {{ snapshot.fileCount }} 个文件 · 为
              {{ snapshot.environmentNames.join('、') || '项目默认' }} 构建
            </div>
          </div>

          <div class="hint" style="margin-bottom: 8px">
            勾选本次要发布的环境（默认不勾选）；未勾选的环境不会被部署。
          </div>

          <div v-if="allEnvironments.length === 0" class="empty">
            项目还没有环境<br /><b>请先在左侧添加测试 / 生产环境</b>
          </div>

          <table v-else class="confirm-table">
            <thead>
              <tr>
                <th class="check-cell"></th>
                <th>环境</th>
                <th>服务器</th>
                <th>部署目录</th>
                <th>快照 / 配置</th>
                <th>变更</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="env in allEnvironments"
                :key="env.id"
                :class="{ unselected: !isSelected(env) }"
              >
                <td class="check-cell">
                  <input
                    type="checkbox"
                    :checked="isSelected(env)"
                    :aria-label="`选择 ${env.name}`"
                    @change="toggle(env)"
                  />
                </td>
                <td>
                  <b>{{ env.name }}</b>
                </td>
                <td class="mono">{{ serverOf(env) }}</td>
                <td class="mono">{{ env.rootDir || '未配置根目录' }}</td>
                <td>
                  <template v-if="isSnapshotMode && isSelected(env)">
                    <span class="snap-badge" :class="envMatch(env) === 'ok' ? 'ok' : 'warn'">
                      {{ envMatch(env) === 'ok' ? '配置匹配' : '配置不一致' }}
                    </span>
                  </template>
                  <span v-else-if="!isSnapshotMode && isSelected(env)" class="snap-badge idle">
                    重新构建
                  </span>
                  <span v-else class="hint">不参与</span>
                </td>
                <td class="mono">{{ isSelected(env) ? diffText(env.id) : '—' }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="targets.length === 0" class="warn-box">
            尚未勾选任何环境，勾选后才能发布。
          </div>

          <div v-if="sharedProfiles.length > 0" class="warn-box">
            {{ sharedProfiles.map((names) => names.join('、')).join('；') }}
            的构建配置完全相同，将共用同一份产物。如果测试/生产需要使用不同的 env，请在环境设置里区分构建命令或环境变量。
          </div>

          <div v-if="needsProductionConfirm" class="prod-confirm">
            <label>
              <input v-model="confirmed" type="checkbox" />
              我确认将发布到以下生产环境：{{
                targets
                  .filter((env) => /生产|prod|production/i.test(env.name))
                  .map((env) => env.name)
                  .join('、')
              }}
            </label>
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <template v-if="isSnapshotMode && !snapshot">
          <button class="btn" @click="store.closePublishDialog()">取消</button>
          <button class="btn primary" @click="store.closePublishDialog(); store.openSnapshotDialog()">
            去选择快照
          </button>
        </template>
        <template v-else>
          <button class="btn" @click="store.closePublishDialog()">取消</button>
          <button class="btn primary" :disabled="!canPublish" @click="confirm">
            {{ busy ? '启动中...' : isSnapshotMode ? '确认发布' : '构建并发布' }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
