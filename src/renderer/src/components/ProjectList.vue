<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '../stores/project'

const store = useProjectStore()
const project = computed(() => store.current)

function typeLabel(type?: string): string {
  return type === 'static' ? 'STATIC' : 'VUE'
}

async function removeProject(id: string, name: string): Promise<void> {
  if (!window.confirm(`确定删除项目「${name}」？\n\n只删除本机配置，不会影响服务器上已发布的文件。`)) {
    return
  }
  await store.removeProject(id)
}
</script>

<template>
  <div class="project-section">
    <div class="section-head">
      <span>项目</span>
      <span class="spacer"></span>
      <span class="head-btn" @click="store.addProject()">+ 新建</span>
    </div>

    <div class="project-scroll">
      <div
        v-for="item in store.projects"
        :key="item.id"
        class="proj"
        :class="{ active: item.id === store.currentId }"
        @click="store.selectProject(item.id)"
      >
        <div class="proj-name">
          <span class="dot vue"></span>{{ item.name }}
        </div>
        <div class="proj-sub">
          <span class="tag">{{ typeLabel(item.type) }}</span>
          <span>{{ item.environments.length }} 环境</span>
        </div>
        <button
          class="proj-del"
          title="删除项目"
          @click.stop="removeProject(item.id, item.name)"
        >
          ×
        </button>
      </div>

      <div v-if="store.projects.length === 0" class="empty" style="padding: 20px 12px">
        暂无项目<br /><b>点击「+ 新建」开始</b>
      </div>
    </div>

    <div v-if="project" class="hint project-path mono" :title="project.localPath || '未选择目录'">
      {{ project.localPath || '未选择本地目录' }}
    </div>
  </div>
</template>
