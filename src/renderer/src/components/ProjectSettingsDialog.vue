<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore, type SettingsTab } from '../stores/project'
import BasicPane from './panes/BasicPane.vue'
import BuildPane from './panes/BuildPane.vue'
import StrategyPane from './panes/StrategyPane.vue'
import AutoDeployPane from './panes/AutoDeployPane.vue'
import ServerManagerDialog from './ServerManagerDialog.vue'

const store = useProjectStore()
const project = computed(() => store.current)

const tabs: Array<{ key: SettingsTab; label: string; desc: string }> = [
  { key: 'basic', label: '基本信息', desc: '名称、类型、本地路径、产物校验' },
  { key: 'build', label: '构建与打包', desc: '构建命令、产物目录、传输方式' },
  { key: 'strategy', label: '发布策略', desc: '失败策略、并发、超时、重试' },
  { key: 'autodeploy', label: 'Git 自动发布', desc: '监听分支、工作区、依赖安装' },
  { key: 'servers', label: '服务器', desc: 'SSH 连接池，可被多个环境复用' }
]
</script>

<template>
  <div
    v-if="store.projectSettingsOpen"
    class="overlay"
    @click.self="store.closeProjectSettings()"
  >
    <div class="modal settings-modal" style="width: 900px">
      <div class="modal-head">
        项目设置{{ project ? ` · ${project.name}` : '' }}
        <span class="x" @click="store.closeProjectSettings()">×</span>
      </div>

      <div class="settings-body">
        <div class="settings-nav">
          <div
            v-for="tab in tabs"
            :key="tab.key"
            class="settings-nav-item"
            :class="{ active: store.projectSettingsTab === tab.key }"
            @click="store.projectSettingsTab = tab.key"
          >
            <b>{{ tab.label }}</b>
            <span>{{ tab.desc }}</span>
          </div>
        </div>

        <div class="settings-content">
          <div v-if="!project" class="empty">暂无项目</div>
          <template v-else>
            <div v-show="store.projectSettingsTab === 'basic'"><BasicPane /></div>
            <div v-show="store.projectSettingsTab === 'build'"><BuildPane /></div>
            <div v-show="store.projectSettingsTab === 'strategy'"><StrategyPane /></div>
            <div v-show="store.projectSettingsTab === 'autodeploy'"><AutoDeployPane /></div>

            <div v-show="store.projectSettingsTab === 'servers'">
              <div class="group">
                <div class="group-title">服务器连接</div>
                <div class="group-desc">
                  只保存 SSH 连接信息，可在多个环境里复用；部署目录与构建配置在环境设置里。
                </div>
                <div v-if="project.targets.length === 0" class="empty">暂无服务器</div>
                <div
                  v-for="server in project.targets"
                  :key="server.id"
                  class="target-card"
                  style="cursor: default"
                >
                  <div class="tc-line">
                    <span class="status-dot" :class="store.serverStatus[server.id]?.ok ? 'ok' : store.serverStatus[server.id] ? 'err' : 'unk'"></span>
                    <span class="tc-name">{{ server.name }}</span>
                    <button class="rb-btn" @click="store.openServerDialog('edit', server.id)">修改</button>
                  </div>
                  <div class="tc-host mono">
                    {{ server.username }}@{{ server.host || '未配置主机' }}:{{ server.port }} ·
                    {{ server.authType === 'key' ? '密钥' : '密码' }}
                  </div>
                </div>
                <div class="add-line" @click="store.openServerDialog()">+ 添加服务器</div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="modal-foot">
        <span class="hint">修改会自动保存</span>
        <span class="spacer"></span>
        <button class="btn primary" @click="store.closeProjectSettings()">完成</button>
      </div>
    </div>

    <ServerManagerDialog v-if="store.serverDialog.open" />
  </div>
</template>
