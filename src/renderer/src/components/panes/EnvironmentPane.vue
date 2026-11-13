<script setup lang="ts">
import { computed } from 'vue'
import type { EnvironmentConfig, Project } from '@shared/types'
import { uid } from '@shared/defaults'
import { useProjectStore } from '../../stores/project'
import ToggleSwitch from '../ToggleSwitch.vue'

const store = useProjectStore()
const environment = computed(() => store.activeEnvironment as EnvironmentConfig)
const project = computed(() => store.current as Project)
const activeServer = computed(
  () => project.value?.targets.find((s) => s.id === environment.value.serverId) ?? null
)

function addProtectPath(): void {
  environment.value.protectPaths.push({ id: uid(), path: '', mode: 'skip' })
}

function removeProtectPath(id: string): void {
  environment.value.protectPaths = environment.value.protectPaths.filter((p) => p.id !== id)
}
</script>

<template>
  <div v-if="store.activeEnvironment">
    <div class="group">
      <div class="group-title">环境 <span class="badge tgt">环境级</span></div>
      <div class="group-desc">
        环境（测试 / 生产）选择一台服务器，并配置自己的部署目录、构建命令与发布分支。
      </div>
      <div class="field-row">
        <div class="field">
          <label>环境名称</label>
          <input v-model="environment.name" type="text" placeholder="测试环境" />
        </div>
        <div class="field">
          <label>服务器</label>
          <select v-model="environment.serverId">
            <option value="">— 未选择服务器 —</option>
            <option v-for="server in project.targets" :key="server.id" :value="server.id">
              {{ server.name }}（{{ server.username }}@{{ server.host || '未配置主机' }}）
            </option>
          </select>
        </div>
      </div>
      <div class="row-actions" style="margin-top: -4px">
        <span v-if="activeServer" class="hint mono">
          {{ activeServer.username }}@{{ activeServer.host || '未配置主机' }}:{{ activeServer.port }} ·
          {{ activeServer.authType === 'key' ? '密钥认证' : '密码认证' }}
        </span>
        <span v-else class="hint" style="color: var(--warn)">
          尚未选择服务器，无法发布。请先在「服务器管理」里添加连接。
        </span>
        <span class="spacer"></span>
        <button class="btn sm" @click="store.openServerDialog()">服务器管理</button>
      </div>
    </div>

    <div class="group">
      <div class="group-title">目录结构</div>
      <div class="group-desc">服务器上的部署根目录与相对路径。</div>
      <div class="field-row">
        <div class="field">
          <label>根目录</label>
          <input v-model="environment.rootDir" class="mono" type="text" placeholder="/var/www/app" />
        </div>
        <div class="field">
          <label>上传目录</label>
          <input v-model="environment.uploadDir" class="mono" type="text" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>releases 目录</label>
          <input v-model="environment.releasesDir" class="mono" type="text" />
        </div>
        <div class="field">
          <label>current 软链名</label>
          <input v-model="environment.currentLink" class="mono" type="text" />
        </div>
      </div>
      <div class="field-row">
        <div class="field" style="max-width: 150px">
          <label>保留版本数</label>
          <input v-model.number="environment.keepVersions" type="number" min="1" />
        </div>
      </div>
    </div>

    <div class="group">
      <div class="group-title">环境构建 <span class="badge tgt">环境级</span></div>
      <div class="group-desc">
        测试/生产可使用不同的构建命令和监听分支；留空继承项目默认构建配置。
      </div>
      <div class="field-row">
        <div class="field">
          <label>构建命令（留空继承项目）</label>
          <input
            v-model="environment.build.buildCommand"
            class="mono"
            type="text"
            :placeholder="project.build.buildCommand || '（跳过构建）'"
          />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>产物目录（留空继承项目）</label>
          <input
            v-model="environment.build.distDir"
            class="mono"
            type="text"
            :placeholder="project.build.distDir"
          />
        </div>
        <div class="field">
          <label>自动发布分支（留空使用全局分支）</label>
          <input v-model="environment.gitBranch" class="mono" type="text" placeholder="develop" />
        </div>
      </div>
      <div class="switch-row">
        <div class="sw-text">
          <b>参与 Git 自动发布</b><span>关闭后该环境只允许手动发布</span>
        </div>
        <ToggleSwitch v-model="environment.autoDeploy" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>构建环境变量（每行 KEY=VALUE，支持 # 注释）</label>
          <textarea v-model="environment.build.envVars" class="mono" rows="3"></textarea>
        </div>
      </div>
    </div>

    <div class="group">
      <div class="group-title">保护路径</div>
      <div class="group-desc">
        发布时不被覆盖的路径：跳过打包、软链到根目录同名位置，或在切换前从上一版本复制。
      </div>
      <div v-for="item in environment.protectPaths" :key="item.id" class="protect-row">
        <input v-model="item.path" class="mono" type="text" placeholder="shared/.env" />
        <select v-model="item.mode">
          <option value="skip">跳过</option>
          <option value="symlink">软链共享</option>
          <option value="copy">从上一版本复制</option>
        </select>
        <button class="del" @click="removeProtectPath(item.id)">×</button>
      </div>
      <div class="add-line" @click="addProtectPath">+ 添加保护路径</div>
    </div>

    <div class="group">
      <div class="group-title">钩子命令</div>
      <div class="group-desc">在发布各阶段于服务器根目录执行（bash -lc）。</div>
      <div class="field-row">
        <div class="field">
          <label>发布前</label>
          <textarea v-model="environment.hooks.pre" class="mono" rows="2"></textarea>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>发布后</label>
          <textarea v-model="environment.hooks.post" class="mono" rows="2"></textarea>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>回滚后</label>
          <textarea v-model="environment.hooks.rollback" class="mono" rows="2"></textarea>
        </div>
      </div>
    </div>

    <div class="hint" style="margin-top: 4px">以上修改会自动保存</div>
  </div>
  <div v-else class="empty">
    暂无环境<br /><b>请在右侧「+ 添加环境」创建测试/生产环境</b>
  </div>
</template>
