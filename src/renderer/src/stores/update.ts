import { defineStore } from 'pinia'
import type { UpdateState } from '@shared/types'

let bound = false
let subscription = 0

export const useUpdateStore = defineStore('update', {
  state: () => ({
    state: null as UpdateState | null,
    open: false,
    busy: false
  }),
  getters: {
    version(state): string {
      return state.state?.currentVersion ?? ''
    },
    /** 顶栏快捷标识：下载进度或“可更新” */
    badge(state): string {
      const current = state.state
      if (!current) return ''
      if (current.status === 'downloaded') return '重启更新'
      if (current.status === 'downloading') return `${current.percent ?? 0}%`
      return ''
    },
    tone(state): 'idle' | 'active' | 'ready' | 'error' {
      const current = state.state
      if (!current) return 'idle'
      if (current.status === 'downloaded') return 'ready'
      if (current.status === 'downloading' || current.status === 'checking') return 'active'
      if (current.status === 'error') return 'error'
      return 'idle'
    }
  },
  actions: {
    async bind() {
      if (bound) return
      bound = true
      subscription = window.api.onUpdateState((state) => {
        this.state = state
      })
      this.state = await window.api.getUpdateState()
    },
    unbind() {
      if (!bound) return
      window.api.off(subscription)
      bound = false
    },
    async check() {
      if (this.busy) return
      this.busy = true
      try {
        this.state = await window.api.checkForUpdates()
      } finally {
        this.busy = false
      }
    },
    async install() {
      await window.api.installUpdate()
    }
  }
})
