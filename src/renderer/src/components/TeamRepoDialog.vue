<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TeamProjectInfo, TeamRepoConfig } from '@shared/types'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const store = useProjectStore()
const jobStore = useJobStore()

const tab = ref<'fetch' | 'publish' | 'connection'>('fetch')
const connectionMode = ref<'target' | 'custom'>('target')
const serverOptions = computed(() =>
  store.projects.flatMap((project) =>
    project.targets.map((target) => ({
      value: target.id,
      label: `${project.name} / ${target.name}（${target.username}@${target.host || '未配置主机'}）`
    }))
  )
)
const form = ref<TeamRepoConfig>({
  host: '',
  port: 22,
  username: 'root',
  authType: 'key',
  privateKeyPath: '~/.ssh/id_rsa',
  baseDir: '~/.deploye-config',
  password: '',
  passphrase: ''
})
const busy = ref(false)
const message = ref('')
const messageOk = ref(false)
const projects = ref<TeamProjectInfo[]>([])
const repoDir = ref('')
const hasConnection = computed(() => Boolean(form.value.linkTargetId || form.value.host))
const selectedFile = ref('')
const fetchPassword = ref('')
const publishPassword = ref('')
const publishPassword2 = ref('')

function close(): void {
  emit('update:open', false)
}

function formatTime(iso?: string): string {
  if (!iso) return '时间未知'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

async function loadRepo(): Promise<void> {
  const repo = await window.api.getTeamRepo()
  if (repo) {
    form.value = { ...repo, password: '', passphrase: '' }
    connectionMode.value = repo.linkTargetId || !repo.host ? 'target' : 'custom'
  } else {
    connectionMode.value = serverOptions.value.length > 0 ? 'target' : 'custom'
  }
  if (connectionMode.value === 'target' && !form.value.linkTargetId) {
    form.value.linkTargetId = serverOptions.value[0]?.value
  }
  await refreshList(true)
}

async function refreshList(quiet = false): Promise<void> {
  if (!hasConnection.value) return
  const result = await window.api.listTeamProjects()
  projects.value = result.projects
  repoDir.value = result.dir || ''
  if (!quiet || !result.ok || result.projects.length === 0) {
    messageOk.value = result.ok
    message.value = result.message || (result.ok ? `共 ${result.projects.length} 个项目` : '')
  }
}

async function pickKey(): Promise<void> {
  const file = await window.api.pickKeyFile()
  if (file) form.value.privateKeyPath = file
}

async function saveAndTest(): Promise<void> {
  message.value = ''
  if (connectionMode.value === 'target' && !form.value.linkTargetId) {
    messageOk.value = false
    message.value = '请选择用于连接的服务器'
    return
  }
  busy.value = true
  try {
    const saved = await window.api.saveTeamRepo({
      ...form.value,
      linkTargetId: connectionMode.value === 'target' ? form.value.linkTargetId : undefined
    })
    form.value = { ...saved, password: '', passphrase: '' }
    connectionMode.value = saved.linkTargetId ? 'target' : 'custom'
    const result = await window.api.testTeamRepo()
    messageOk.value = result.ok
    message.value = result.message
    if (result.ok) await refreshList(true)
  } catch (err) {
    messageOk.value = false
    message.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function fetchProject(): Promise<void> {
  if (!selectedFile.value) {
    messageOk.value = false
    message.value = '请先选择要获取的项目'
    return
  }
  if (!fetchPassword.value) {
    messageOk.value = false
    message.value = '请输入团队配置密码'
    return
  }
  busy.value = true
  try {
    const result = await window.api.fetchTeamProject(selectedFile.value, fetchPassword.value)
    messageOk.value = result.ok
    message.value = result.message || (result.ok ? '已导入' : '导入失败')
    if (result.ok && result.project) {
      store.projects.push(result.project)
      store.selectProject(result.project.id)
      for (const warning of result.warnings || []) jobStore.pushLocal('WARN', warning)
      jobStore.pushLocal('OK', `已从团队仓库导入：${result.project.name}`)
      fetchPassword.value = ''
      close()
    }
  } finally {
    busy.value = false
  }
}

async function publishProject(): Promise<void> {
  const project = store.current
  if (!project) {
    messageOk.value = false
    message.value = '请先选择项目'
    return
  }
  if (publishPassword.value.length < 6) {
    messageOk.value = false
    message.value = '团队配置密码至少 6 位'
    return
  }
  if (publishPassword.value !== publishPassword2.value) {
    messageOk.value = false
    message.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  try {
    const result = await window.api.publishTeamProject(project.id, publishPassword.value)
    messageOk.value = result.ok
    message.value = result.message || (result.ok ? '发布成功' : '发布失败')
    if (result.ok) {
      publishPassword.value = ''
      publishPassword2.value = ''
      await refreshList(true)
    }
  } finally {
    busy.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    void loadRepo()
    tab.value = 'fetch'
    message.value = ''
    selectedFile.value = ''
    fetchPassword.value = ''
    publishPassword.value = ''
    publishPassword2.value = ''
  }
)
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="close">
    <div class="modal" style="width: 640px">
      <div class="modal-head">
        团队配置仓库
        <span class="x" @click="close">×</span>
      </div>
      <div class="modal-body">
        <div class="right-tabs" style="margin: 0 0 12px">
          <div class="rtab" :class="{ on: tab === 'fetch' }" @click="tab = 'fetch'">获取配置</div>
          <div class="rtab" :class="{ on: tab === 'publish' }" @click="tab = 'publish'">发布配置</div>
          <div class="rtab" :class="{ on: tab === 'connection' }" @click="tab = 'connection'">
            连接设置
          </div>
        </div>

        <template v-if="tab === 'connection'">
          <div class="hint">
            仓库通过 SSH 访问。可以直接复用已配置的服务器连接，无需再填写或验证密钥；连接信息仅保存在本机，不会随项目配置共享。
          </div>
          <div class="field-row" style="margin-top: 12px">
            <div class="field" style="max-width: 300px">
              <label>连接方式</label>
              <select v-model="connectionMode">
                <option value="target">使用已配置的服务器（推荐）</option>
                <option value="custom">自定义连接信息</option>
              </select>
            </div>
          </div>

          <template v-if="connectionMode === 'target'">
            <div v-if="serverOptions.length === 0" class="empty">
              暂无已配置的服务器<br /><b>请先添加服务器，或改用自定义连接</b>
            </div>
            <template v-else>
              <div class="field-row">
                <div class="field">
                  <label>选择服务器</label>
                  <select v-model="form.linkTargetId">
                    <option value="" disabled>请选择</option>
                    <option v-for="option in serverOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </div>
              </div>
              <div class="field-row">
                <div class="field">
                  <label>仓库目录（相对主目录或绝对路径）</label>
                  <input v-model="form.baseDir" class="mono" type="text" placeholder="~/.deploye-config" />
                </div>
              </div>
              <div class="hint">
                复用该目标的 SSH 账号与密钥/密码；保存一次后，获取和发布都会直接使用它。
              </div>
            </template>
          </template>

          <template v-else>
          <div class="field-row">
            <div class="field">
              <label>主机</label>
              <input v-model="form.host" class="mono" type="text" placeholder="config.example.com" />
            </div>
            <div class="field" style="max-width: 100px">
              <label>端口</label>
              <input v-model.number="form.port" class="mono" type="number" min="1" max="65535" />
            </div>
            <div class="field" style="max-width: 150px">
              <label>用户名</label>
              <input v-model="form.username" class="mono" type="text" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>认证方式</label>
              <select v-model="form.authType">
                <option value="key">密钥文件</option>
                <option value="password">密码</option>
              </select>
            </div>
            <div class="field">
              <label>仓库目录（相对主目录或绝对路径）</label>
              <input v-model="form.baseDir" class="mono" type="text" placeholder="~/.deploye-config" />
            </div>
          </div>
          <template v-if="form.authType === 'key'">
            <div class="field-row">
              <div class="field">
                <label>密钥路径</label>
                <div class="path-box mono">
                  <template v-if="form.privateKeyPath">{{ form.privateKeyPath }}</template>
                  <span v-else class="path-placeholder">未选择密钥文件</span>
                </div>
              </div>
              <div class="field path-actions" style="max-width: 120px">
                <button class="btn sm" @click="pickKey">选择密钥</button>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label>密钥口令（可选）</label>
                <input
                  v-model="form.passphrase"
                  type="password"
                  :placeholder="form.hasPassphrase ? '已保存，留空不修改' : '私钥无口令可留空'"
                />
              </div>
            </div>
          </template>
          <div v-else class="field-row">
            <div class="field">
              <label>登录密码</label>
              <input
                v-model="form.password"
                type="password"
                :placeholder="form.hasPassword ? '已保存，留空不修改' : '请输入密码'"
              />
            </div>
          </div>
          </template>

          <div class="hint" style="margin-bottom: 8px">
            团队共享时建议把仓库目录设为绝对路径（例如
            <span class="mono">/srv/deploye-config</span>），避免不同 SSH 账号的主目录不同，导致看到不同目录。
          </div>

          <div class="row-actions">
            <button class="btn primary" :disabled="busy" @click="saveAndTest">
              {{ busy ? '连接中...' : '保存并测试连接' }}
            </button>
            <span class="hint">保存一次即可，后续获取 / 发布自动复用该连接</span>
          </div>
        </template>

        <template v-if="tab === 'fetch'">
          <div class="hint">
            连接仓库后选择项目，输入团队配置密码即可导入。列表只显示项目名、发布人和更新时间，配置内容均加密保存。
          </div>
          <div class="field-row" style="margin-top: 12px">
            <div class="field">
              <label>团队配置密码</label>
              <input v-model="fetchPassword" type="password" placeholder="需要密码才能解密项目配置" />
            </div>
            <div class="field" style="max-width: 120px; display: flex; align-items: flex-end">
              <button class="btn sm" @click="refreshList()">刷新列表</button>
            </div>
          </div>

          <div v-if="repoDir" class="hint" style="margin-bottom: 8px">
            仓库目录：<span class="mono">{{ repoDir }}</span>
          </div>
          <div v-if="!hasConnection" class="empty">
            尚未配置仓库连接<br /><b>请先到「连接设置」选择服务器或填写连接信息</b>
          </div>
          <div v-else-if="projects.length === 0" class="empty">仓库中暂无项目</div>
          <div
            v-for="item in projects"
            :key="item.fileName"
            class="target-card"
            :class="{ active: selectedFile === item.fileName }"
            @click="selectedFile = item.fileName"
          >
            <div class="tc-line">
              <span class="tc-name">{{ item.name }}</span>
              <span class="tag">{{ item.targets ?? 0 }} 个环境</span>
            </div>
            <div class="tc-host">
              {{ item.publisher || '未知发布人' }} · {{ formatTime(item.publishedAt) }}
            </div>
          </div>

          <div class="row-actions">
            <button class="btn primary" :disabled="busy" @click="fetchProject">
              {{ busy ? '获取中...' : '获取并导入选中项目' }}
            </button>
          </div>
        </template>

        <template v-if="tab === 'publish'">
          <div class="hint">
            将当前项目配置发布到团队仓库。<b>不包含任何密码、密钥口令或密钥文件</b>，同事使用各自的 SSH 密钥和团队密码导入。
          </div>
          <div class="field-row" style="margin-top: 12px">
            <div class="field">
              <label>当前项目</label>
              <input
                class="mono readonly"
                type="text"
                readonly
                :value="store.current?.name || '未选择项目'"
              />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>团队配置密码（至少 6 位）</label>
              <input v-model="publishPassword" type="password" />
            </div>
            <div class="field">
              <label>确认密码</label>
              <input v-model="publishPassword2" type="password" />
            </div>
          </div>
          <div class="row-actions">
            <button class="btn primary" :disabled="busy" @click="publishProject">
              {{ busy ? '发布中...' : '发布当前项目' }}
            </button>
            <span class="hint">重名项目会覆盖仓库中的同名配置</span>
          </div>
        </template>

        <div
          v-if="message"
          class="hint"
          :style="{ color: messageOk ? 'var(--accent)' : 'var(--danger)', marginTop: '10px' }"
        >
          {{ message }}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>
