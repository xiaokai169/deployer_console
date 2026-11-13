<script setup lang="ts">
import { computed } from 'vue'
import type { Project } from '@shared/types'
import { useProjectStore } from '../../stores/project'
import ToggleSwitch from '../ToggleSwitch.vue'

const store = useProjectStore()
const project = computed(() => store.current as Project)

async function pickDirectory(): Promise<void> {
  const dir = await window.api.pickDirectory()
  if (dir && store.current) store.current.localPath = dir
}
</script>

<template>
  <div v-if="store.current">
    <div class="group">
      <div class="group-title">基本信息 <span class="badge proj">项目级</span></div>
      <div class="group-desc">项目的名称、类型与本地代码位置。</div>
      <div class="field-row">
        <div class="field">
          <label>项目名称</label>
          <input v-model="project.name" type="text" />
        </div>
        <div class="field" style="max-width: 200px">
          <label>项目类型</label>
          <select v-model="project.type">
            <option value="vue">Vue 前端</option>
            <option value="static">静态 HTML</option>
          </select>
        </div>
      </div>
    </div>

    <div class="group">
      <div class="group-title">本地路径</div>
      <div class="group-desc">通过系统文件选择器选取本地项目目录。</div>
      <div class="field-row">
        <div class="field">
          <label>本地项目目录</label>
          <div class="path-box mono">
            <template v-if="project.localPath">{{ project.localPath }}</template>
            <span v-else class="path-placeholder">未选择目录</span>
          </div>
        </div>
        <div class="field path-actions" style="max-width: 120px">
          <button class="btn primary" @click="pickDirectory">选择目录</button>
        </div>
      </div>
    </div>

    <div class="group">
      <div class="group-title">产物校验</div>
      <div class="group-desc">发布前自动校验产物完整性，不达标则中止发布。</div>
      <div class="switch-row">
        <div class="sw-text">
          <b>启用产物校验</b><span>检查空目录、缺入口文件、体积异常</span>
        </div>
        <ToggleSwitch v-model="project.validation.enabled" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>入口文件（必须存在）</label>
          <input v-model="project.validation.entryFile" class="mono" type="text" />
        </div>
        <div class="field" style="max-width: 150px">
          <label>体积下限 (MB)</label>
          <input v-model.number="project.validation.minMB" type="number" min="0" />
        </div>
        <div class="field" style="max-width: 150px">
          <label>体积上限 (MB)</label>
          <input v-model.number="project.validation.maxMB" type="number" min="0" />
        </div>
      </div>
    </div>
  </div>
</template>
