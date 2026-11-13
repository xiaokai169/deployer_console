<script setup lang="ts">
import { computed } from 'vue'
import type { ArtifactSnapshot } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { profileKeyOf } from '../utils/profile'

const store = useProjectStore()
const project = computed(() => store.current)

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 目标环境当前构建配置与快照不一致的环境名 */
function mismatchEnvironments(snapshot: ArtifactSnapshot): string[] {
  const current = project.value
  if (!current) return []
  const ids =
    store.publishEnvironmentIds.length > 0
      ? store.publishEnvironmentIds
      : store.activeEnvironmentId
        ? [store.activeEnvironmentId]
        : []
  return current.environments
    .filter((env) => ids.includes(env.id) && profileKeyOf(current, env) !== snapshot.profileKey)
    .map((env) => env.name)
}

function pick(snapshot: ArtifactSnapshot): void {
  if (!snapshot.available) return
  store.activeSnapshotId = snapshot.id
  store.closeSnapshotDialog()
  store.openPublishDialog('deploy-only')
}

async function remove(snapshot: ArtifactSnapshot): Promise<void> {
  if (!window.confirm(`确定删除快照「${snapshot.id}」？已发布的版本不受影响。`)) return
  await store.removeSnapshot(snapshot.id)
}
</script>

<template>
  <div class="overlay" @click.self="store.closeSnapshotDialog()">
    <div class="modal" style="width: 720px">
      <div class="modal-head">
        选择产物快照
        <span class="x" @click="store.closeSnapshotDialog()">×</span>
      </div>
      <div class="modal-body">
        <div class="hint" style="margin-bottom: 12px">
          发布只读取快照目录，不会再读取本地 dist。想发到哪个环境，就选为该环境构建的那份快照。
        </div>

        <div v-if="store.snapshotLoading" class="empty">正在读取快照...</div>
        <div v-else-if="store.snapshots.length === 0" class="empty">
          暂无可用快照<br /><b>执行一次「仅构建」或「构建并发布」后生成</b>
        </div>

        <div
          v-for="snapshot in store.snapshots"
          :key="snapshot.id"
          class="snap-item"
          :class="{ picked: store.activeSnapshotId === snapshot.id, disabled: !snapshot.available }"
        >
          <div class="snap-line">
            <span class="mono snap-id">{{ snapshot.id }}</span>
            <span class="snap-time">{{ formatTime(snapshot.createdAt) }}</span>
            <span class="spacer"></span>
            <span v-if="!snapshot.available" class="snap-badge err">文件缺失</span>
            <span
              v-else-if="mismatchEnvironments(snapshot).length > 0"
              class="snap-badge warn"
              :title="`与 ${mismatchEnvironments(snapshot).join('、')} 的当前构建配置不一致`"
            >
              配置不一致
            </span>
            <span v-else class="snap-badge ok">配置匹配</span>
          </div>
          <div class="snap-line snap-sub">
            <span class="mono">{{ snapshot.buildCommand || '（跳过构建）' }}</span>
            <span>·</span>
            <span class="mono">{{ snapshot.distDir }}</span>
            <span v-if="snapshot.commit">· {{ snapshot.commit.slice(0, 8) }}</span>
            <span v-else-if="snapshot.branch">· {{ snapshot.branch }}</span>
          </div>
          <div class="snap-line snap-sub">
            <span>{{ snapshot.fileCount }} 个文件 · {{ formatSize(snapshot.totalBytes) }}</span>
            <span>·</span>
            <span>为 {{ snapshot.environmentNames.join('、') || '项目默认' }} 构建</span>
            <span>· 指纹 {{ snapshot.manifestHash.slice(0, 8) }}</span>
          </div>
          <div class="snap-actions">
            <button class="rb-btn" @click="remove(snapshot)">删除</button>
            <button class="btn primary sm" :disabled="!snapshot.available" @click="pick(snapshot)">
              使用该快照发布
            </button>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="store.closeSnapshotDialog()">取消</button>
      </div>
    </div>
  </div>
</template>
