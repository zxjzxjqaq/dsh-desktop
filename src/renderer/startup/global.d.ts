import type { StartupBridge } from '../../shared/contracts.js'

declare global {
  interface Window {
    readonly dshDesktop: StartupBridge
  }
}

export {}
