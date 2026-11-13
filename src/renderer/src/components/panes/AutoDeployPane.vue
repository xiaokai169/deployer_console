<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { GitWatchStatus, Project, WorkspaceStatus } from '@shared/types'
import { useJobStore } from '../../stores/job'
import { useProjectStore } from '../../stores/project'
import ToggleSwitch from '../ToggleSwitch.vue'

const store = useProjectStore()
const jobStore = useJobStore()
const project = computed(() => store.current as Project)
const status = ref<GitWatchStatus | null>(null)
const workspace = ref<WorkspaceStatus | null>(null)
const checking = ref(false)
const cleaning = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

async function refresh(): Promise<void> {
  if (!store.currentId) return
  try {
    status.value = await window.api.getGitStatus(store.currentId)
  } catch {
    /* ignore */
  }
}

async function refreshWorkspace(): Promise<void> {
  if (!store.currentId) return
  try {
    workspace.value = await window.api.getWorkspaceStatus(store.currentId)
  } catch {
    /* ignore */
  }
}

async function cleanWorkspace(): Promise<void> {
  if (!store.currentId) return
  if (!window.confirm('确定清理部署工作区？下次发布将重新检出代码并安装依赖。')) return
  cleaning.value = true
  try {
    const result = await window.api.cleanWorkspace(store.currentId)
    jobStore.pushLocal(result.ok ? 'OK' : 'ERROR', result.message)
    await refreshWorkspace()
  } finally {
    cleaning.value = false
  }
}

async function checkNow(): Promise<void> {
  if (!store.currentId) return
  checking.value = true
  try {
    status.value = await window.api.checkGitNow(store.currentId)
  } finally {
    checking.value = false
    void refresh()
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '尚未检查'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '尚未检查'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

onMounted(() => {
  void refresh()
  void refreshWorkspace()
  timer = setInterval(() => {
    void refresh()
    void refreshWorkspace()
  }, 5000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="store.current">
    <div class="group">
      <div class="group-title">Git 自动发布 <span class="badge proj">项目级</span></div>
      <div class="group-desc">
        监听本地仓库的主分支远程跟踪引用，检测到新提交后自动执行构建并发布到全部目标服务器。
      </div>
      <div class="switch-row">
        <div class="sw-text">
          <b>启用主分支自动发布</b><span>关闭后不再监听，也不会触发任何自动任务</span>
        </div>
        <ToggleSwitch v-model="project.gitWatch.enabled" />
      </div>

      <div class="field-row">
        <div class="field" style="max-width: 260px">
          <label>触发来源</label>
          <select v-model="project.gitWatch.triggerMode">
            <option value="own">仅本机推送（推荐）</option>
            <option value="any">任意人推送到主分支</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>监听分支（逗号分隔）</label>
          <input v-model="project.gitWatch.branches" class="mono" type="text" placeholder="main, master" />
        </div>
        <div class="field" style="max-width: 140px">
          <label>远程名</label>
          <input v-model="project.gitWatch.remote" class="mono" type="text" placeholder="origin" />
        </div>
        <div class="field" style="max-width: 150px">
          <label>检查间隔（秒）</label>
          <input v-model.number="project.gitWatch.intervalSec" type="number" min="5" />
        </div>
      </div>

      <template v-if="project.gitWatch.triggerMode === 'any'">
        <div class="switch-row">
          <div class="sw-text">
            <b>定期 git fetch</b><span>用于感知他人推送到主分支的提交（需要本机具备拉取凭据）</span>
          </div>
          <ToggleSwitch v-model="project.gitWatch.fetchRemote" />
        </div>
        <div v-if="project.gitWatch.fetchRemote" class="field-row">
          <div class="field" style="max-width: 160px">
            <label>fetch 间隔（秒）</label>
            <input v-model.number="project.gitWatch.fetchIntervalSec" type="number" min="30" />
          </div>
        </div>
      </template>

      <div class="hint" v-if="project.gitWatch.triggerMode === 'own'">
        只响应你在本仓库执行的 git push（依据本地 git reflog 中 "update by push" 记录），同事推送到主分支不会触发，也不需要定时 fetch。
        首次开启只记录基线，不会立即发布；自动发布使用项目全部目标服务器。
      </div>
      <div class="hint" v-else>
        定时 fetch 主分支，任何人推送都会触发。如果多台机器都开启了自动发布，同一次提交会被重复构建发布，建议只保留一台机器开启。
        首次开启只记录基线，不会立即发布。
      </div>
      <div class="hint">
        若环境配置了「自动发布分支」，会按分支独立触发（例如 develop → 测试环境、main → 生产环境）；
        未配置时使用上面的全局分支，并发布到所有参与自动发布的环境。
      </div>
    </div>

    <div class="group">
      <div class="group-title">部署工作区 <span class="badge proj">项目级</span></div>
      <div class="group-desc">
        开启后，自动发布会把目标提交检出到独立 worktree 中构建，不切换你的分支，也不改动当前工作区。
      </div>
      <div class="switch-row">
        <div class="sw-text">
          <b>使用独立工作区构建</b><span>从远程主分支提交检出，构建与发布不影响当前分支</span>
        </div>
        <ToggleSwitch v-model="project.gitWatch.isolatedWorkspace" />
      </div>

      <template v-if="project.gitWatch.isolatedWorkspace">
        <div class="switch-row">
          <div class="sw-text">
            <b>锁文件变化时自动安装依赖</b>
            <span>支持 npm / pnpm / yarn / bun；未变化时复用已有依赖</span>
          </div>
          <ToggleSwitch v-model="project.gitWatch.installDeps" />
        </div>
        <div class="switch-row">
          <div class="sw-text">
            <b>保留部署工作区</b>
            <span>复用 node_modules 加速后续发布；关闭则每次发布成功后清理</span>
          </div>
          <ToggleSwitch v-model="project.gitWatch.keepWorkspace" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>构建前复制文件（逗号分隔，从当前工作区复制）</label>
            <input
              v-model="project.gitWatch.copyPaths"
              class="mono"
              type="text"
              placeholder=".env, .env.production"
            />
          </div>
        </div>
        <div class="hint">
          被 git 忽略但构建需要的文件（如 .env）可在此复制；复制的是你当前工作区中的版本。
        </div>
        <div class="field-row" style="margin-top: 10px">
          <div class="field">
            <label>工作区状态</label>
            <input
              class="mono readonly"
              readonly
              :value="
                workspace
                  ? workspace.exists
                    ? workspace.path + (workspace.head ? ' @ ' + workspace.head.slice(0, 7) : '')
                    : '尚未创建'
                  : '读取中...'
              "
            />
          </div>
          <div class="field" style="max-width: 140px; display: flex; align-items: flex-end">
            <button class="btn sm" :disabled="cleaning" @click="cleanWorkspace">
              {{ cleaning ? '清理中...' : '清理工作区' }}
            </button>
          </div>
        </div>
        <div class="hint">
          首次发布需要检出代码并安装依赖，耗时会明显增加；工作区会占用额外磁盘空间。
        </div>
      </template>
    </div>

    <div class="group">
      <div class="group-title">监听状态</div>
      <div class="group-desc">每 {{ Math.max(5, project.gitWatch.intervalSec || 15) }} 秒检查一次，仅应用运行期间有效。</div>

      <div v-if="!status" class="empty">暂无状态</div>
      <template v-else>
        <div v-if="status.error" class="hint" style="color: var(--danger); margin-bottom: 8px">
          {{ status.error }}
        </div>
        <div class="field-row" style="margin-bottom: 8px">
          <div class="field" style="max-width: 280px">
            <label>最近检查</label>
            <input
              class="mono readonly"
              type="text"
              readonly
              :value="formatTime(status.lastChecked)"
            />
          </div>
          <div class="field" style="max-width: 200px">
            <label>监听开关</label>
            <input
              class="mono readonly"
              readonly
              :value="status.enabled ? '已开启' : '未开启'"
            />
          </div>
        </div>

        <div v-if="status.branches.length === 0" class="hint">尚未获取到分支信息</div>
        <div v-for="branch in status.branches" :key="branch.branch" class="file-item">
          <span class="fn mono">{{ project.gitWatch.remote || 'origin' }}/{{ branch.branch }}</span>
          <span class="fs mono">{{ branch.sha ? branch.sha.slice(0, 10) : '未找到' }}</span>
          <span class="badge-st" :class="branch.sha ? 'a' : 'd'">
            {{ branch.sha ? '正常' : '缺失' }}
          </span>
        </div>

        <div class="hint" style="margin-top: 10px">自动发布映射</div>
        <div v-for="environment in project.environments" :key="environment.id" class="file-item">
          <span class="fn">{{ environment.name }}</span>
          <span class="fs mono">
            {{
              environment.autoDeploy === false
                ? '不参与自动发布'
                : environment.gitBranch || '使用全局分支'
            }}
          </span>
        </div>
        <div v-if="project.environments.length === 0" class="hint">暂无环境</div>

        <div class="row-actions">
          <button class="btn sm" :disabled="checking || !project.gitWatch.enabled" @click="checkNow">
            {{ checking ? '检查中...' : '立即检查' }}
          </button>
          <span class="hint">
            {{
              project.gitWatch.isolatedWorkspace
                ? '发现新提交后会在独立工作区触发发布，无需切换当前分支'
                : '发现新提交且当前工作区位于该提交时，会立即触发发布'
            }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
