<script setup lang="ts">
import { computed } from 'vue'
import type { Project } from '@shared/types'
import { useProjectStore } from '../../stores/project'
import ToggleSwitch from '../ToggleSwitch.vue'

const store = useProjectStore()
const project = computed(() => store.current as Project)
</script>

<template>
  <div v-if="store.current">
    <div class="group">
      <div class="group-title">构建命令 <span class="badge proj">项目级</span></div>
      <div class="group-desc">在本地项目目录执行，留空表示跳过构建。</div>
      <div class="field-row">
        <div class="field">
          <label>构建命令</label>
          <input v-model="project.build.buildCommand" class="mono" type="text" placeholder="npm run build" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>构建产物目录（相对项目根目录）</label>
          <input v-model="project.build.distDir" class="mono" type="text" placeholder="dist" />
        </div>
      </div>
    </div>

    <div class="group">
      <div class="group-title">打包与传输</div>
      <div class="switch-row">
        <div class="sw-text">
          <b>打包压缩</b><span>将产物打包为单个压缩包后传输（关闭时逐文件上传）</span>
        </div>
        <ToggleSwitch v-model="project.build.package" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>压缩包命名规则</label>
          <input v-model="project.build.archiveName" class="mono" type="text" />
        </div>
      </div>
      <div class="hint">
        命名支持 {name}（项目名）与 {timestamp}（时间戳）两个占位符；压缩包在远端解压成功后立即删除。
      </div>
      <div class="field-row" style="margin-top: 14px">
        <div class="field">
          <label>传输方式</label>
          <select v-model="project.build.transfer">
            <option value="sftp">SFTP 上传</option>
            <option value="rsync">rsync 同步</option>
          </select>
        </div>
        <div class="field">
          <label>未压缩时临时目录</label>
          <input v-model="project.build.stagingDir" class="mono" type="text" />
        </div>
      </div>
      <div v-if="project.build.transfer === 'rsync'" class="hint">
        rsync 仅支持密钥认证；本机需安装 rsync 并加入 PATH。Windows 下若使用 cwRsync，请注意本地路径格式限制。
      </div>
    </div>
  </div>
</template>
