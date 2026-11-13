/// <reference types="vite/client" />

import type { DeployeApi } from '@shared/types'

declare global {
  interface Window {
    api: DeployeApi
  }
}

export {}
