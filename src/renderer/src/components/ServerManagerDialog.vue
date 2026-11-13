<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ServerConfig } from '@shared/types'
import { createDefaultServer } from '@shared/defaults'
import { useProjectStore } from '../stores/project'
import { useJobStore } from '../stores/job'

const store = useProjectStore()
const jobStore = useJobStore()

const view = ref<'list' | 'form'>('list')
const editingId = ref('')
const form = ref<ServerConfig>(createDefaultServer())
const busy = ref(false)
const error = ref('')
const testingId = ref('')
const testingDraft = ref(false)
const draftTest = ref<{ ok: boolean; message: string } | null>(null)

onMounted(() => {
  if (store.serverDialog.mode === 'edit' && store.serverDialog.serverId) {
    openEdit(store.serverDialog.serverId)
  }
})

function openAdd(): void {
  form.value = createDefaultServer()
  editingId.value = ''
  error.value = ''
  draftTest.value = null
  view.value = 'form'
}

function openEdit(serverId: string): void {
  const server = store.current?.targets.find((s) => s.id === serverId)
  if (!server) return
  form.value = {
    ...server,
    password: '',
    passphrase: '',
    hasPassword: server.hasPassword,
    hasPassphrase: server.hasPassphrase
  }
  editingId.value = serverId
  error.value = ''
  draftTest.value = null
  view.value = 'form'
}

/** 不保存直接测试表单里的连接信息；密码留空时使用已保存的密钥 */
async function testDraft(): Promise<void> {
  if (!store.current) return
  error.value = ''
  draftTest.value = null
  testingDraft.value = true
  try {
    const result = await window.api.testServerDraft(store.current.id, {
      ...form.value,
      host: form.value.host.trim(),
      username: form.value.username.trim(),
      port: Number(form.value.port) || 22,
      privateKeyPath: (form.value.privateKeyPath || '').trim() || undefined
    })
    draftTest.value = result
    if (result.ok && editingId.value) {
      store.serverStatus[editingId.value] = { ok: true, message: result.message }
    }
    jobStore.pushLocal(
      result.ok ? 'OK' : 'ERROR',
      `[${form.value.name || '服务器'}] ${result.message}`
    )
  } catch (err) {
    draftTest.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    testingDraft.value = false
  }
}

async function pickKey(): Promise<void> {
  const file = await window.api.pickKeyFile()
  if (file) form.value.privateKeyPath = file
}

async function save(): Promise<void> {
  error.value = ''
  if (!form.value.name.trim()) {
    error.value = '请输入服务器名称'
    return
  }
  if (!form.value.host.trim()) {
    error.value = '请输入主机地址'
    return
  }
  if (!form.value.username.trim()) {
    error.value = '请输入登录用户名'
    return
  }
  if (form.value.authType === 'key' && !(form.value.privateKeyPath || '').trim()) {
    error.value = '请选择密钥文件'
    return
  }
  const patch: Partial<ServerConfig> = {
    name: form.value.name.trim(),
    host: form.value.host.trim(),
    port: Number(form.value.port) || 22,
    username: form.value.username.trim(),
    authType: form.value.authType,
    privateKeyPath:
      form.value.authType === 'key' ? (form.value.privateKeyPath || '').trim() : undefined
  }
  if (form.value.password) patch.password = form.value.password
  if (form.value.passphrase) patch.passphrase = form.value.passphrase

  busy.value = true
  try {
    if (editingId.value) {
      await store.updateServerConnection(editingId.value, patch)
    } else {
      await store.addServerFrom(createDefaultServer({ ...patch, name: patch.name }))
    }
    view.value = 'list'
  } finally {
    busy.value = false
  }
}

async function testServer(serverId: string): Promise<void> {
  testingId.value = serverId
  try {
    const result = await store.testServer(serverId)
    const server = store.current?.targets.find((s) => s.id === serverId)
    jobStore.pushLocal(
      result.ok ? 'OK' : 'ERROR',
      `[${server?.name ?? '服务器'}] ${result.message}`
    )
  } finally {
    testingId.value = ''
  }
}

async function removeServer(server: ServerConfig): Promise<void> {
  if (
    !window.confirm(
      `确定删除服务器「${server.name}」？引用它的环境会变成「未选择服务器」。`
    )
  ) {
    return
  }
  await store.removeServer(server.id)
}

function statusClass(serverId: string): string {
  const status = store.serverStatus[serverId]
  if (!status) return 'unk'
  return status.ok ? 'ok' : 'err'
}
</script>

<template>
  <div class="overlay" @click.self="store.closeServerDialog()">
    <div class="modal" style="width: 640px">
      <div class="modal-head">
        {{ view === 'form' ? (editingId ? '修改服务器' : '添加服务器') : '服务器管理' }}
        <span class="x" @click="store.closeServerDialog()">×</span>
      </div>

      <div class="modal-body">
        <template v-if="view === 'list'">
          <div class="hint">
            这里只保存 SSH 连接信息，可在多个项目/环境里复用。部署根目录、构建命令、保护路径等在「环境」中配置。
          </div>
          <div v-if="!store.current || store.current.targets.length === 0" class="empty">
            暂无服务器
          </div>
          <div
            v-for="server in store.current?.targets || []"
            :key="server.id"
            class="target-card"
            style="cursor: default"
          >
            <div class="tc-line">
              <span class="status-dot" :class="statusClass(server.id)"></span>
              <span class="tc-name">{{ server.name }}</span>
              <button
                class="rb-btn"
                :disabled="testingId === server.id"
                @click="testServer(server.id)"
              >
                {{ testingId === server.id ? '测试中...' : '测试' }}
              </button>
              <button class="rb-btn" @click="openEdit(server.id)">修改</button>
              <button class="rb-btn" @click="removeServer(server)">删除</button>
            </div>
            <div class="tc-host mono">
              {{ server.username }}@{{ server.host || '未配置主机' }}:{{ server.port }} ·
              {{ server.authType === 'key' ? '密钥' : '密码' }}
            </div>
          </div>
          <div class="add-line" @click="openAdd">+ 添加服务器</div>
        </template>

        <template v-else>
          <div class="field-row">
            <div class="field">
              <label>名称</label>
              <input v-model="form.name" type="text" placeholder="测试服务器" />
            </div>
            <div class="field" style="max-width: 190px">
              <label>主机</label>
              <input v-model="form.host" class="mono" type="text" placeholder="1.2.3.4" />
            </div>
            <div class="field" style="max-width: 100px">
              <label>端口</label>
              <input v-model.number="form.port" class="mono" type="number" min="1" max="65535" />
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>用户名</label>
              <input v-model="form.username" class="mono" type="text" />
            </div>
            <div class="field">
              <label>认证方式</label>
              <select v-model="form.authType">
                <option value="key">密钥文件</option>
                <option value="password">密码</option>
              </select>
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

          <div class="hint">部署目录、构建命令与自动发布分支请在对应「环境」里配置。</div>
          <div v-if="error" class="hint" style="color: var(--danger); margin-top: 8px">
            {{ error }}
          </div>
          <div
            v-if="draftTest"
            class="hint"
            :style="{ color: draftTest.ok ? 'var(--success)' : 'var(--danger)', marginTop: '8px' }"
          >
            {{ draftTest.ok ? '✓ ' : '✗ ' }}{{ draftTest.message }}
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <template v-if="view === 'form'">
          <button class="btn" :disabled="testingDraft || busy" @click="testDraft">
            {{ testingDraft ? '测试中...' : '测试连接' }}
          </button>
          <span class="spacer"></span>
          <button class="btn" @click="view = 'list'">取消</button>
          <button class="btn primary" :disabled="busy || testingDraft" @click="save">
            {{ busy ? '保存中...' : '保存' }}
          </button>
        </template>
        <button v-else class="btn" @click="store.closeServerDialog()">关闭</button>
      </div>
    </div>
  </div>
</template>
