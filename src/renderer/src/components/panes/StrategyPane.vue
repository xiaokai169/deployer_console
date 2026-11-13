<script setup lang="ts">
import { computed } from 'vue'
import type { Project } from '@shared/types'
import { useProjectStore } from '../../stores/project'

const store = useProjectStore()
const project = computed(() => store.current as Project)
</script>

<template>
  <div v-if="store.current">
    <div class="group">
      <div class="group-title">发布策略 <span class="badge proj">项目级</span></div>
      <div class="group-desc">控制多目标发布时的失败处理、并发与超时。</div>
      <div class="field-row">
        <div class="field">
          <label>失败策略</label>
          <select v-model="project.strategy.failPolicy">
            <option value="stop">任一失败即停止</option>
            <option value="continue">失败继续其他目标</option>
            <option value="rollback">失败自动回滚</option>
          </select>
        </div>
        <div class="field" style="max-width: 150px">
          <label>并发数</label>
          <input v-model.number="project.strategy.concurrency" type="number" min="1" />
        </div>
        <div class="field" style="max-width: 150px">
          <label>超时 (秒)</label>
          <input v-model.number="project.strategy.timeoutSec" type="number" min="10" />
        </div>
        <div class="field" style="max-width: 150px">
          <label>重试次数</label>
          <input v-model.number="project.strategy.retries" type="number" min="0" />
        </div>
      </div>
      <div class="field-row">
        <div class="field" style="max-width: 260px">
          <label>操作员（自动读取 git user.name）</label>
          <input
            class="mono readonly"
            type="text"
            readonly
            :value="store.operator || '未获取到'"
          />
        </div>
      </div>
      <div class="hint">
        发布记录、部署锁与团队配置的发布人都会使用该名称；未设置 git 用户名时回退到系统用户名。
        「失败自动回滚」仅在 current 软链已切换到新版本后失败时触发；切换前失败会保留原版本不动。
      </div>
    </div>
  </div>
</template>
