import type { ShellBridge } from '../../shared/contracts.js'

declare global {
  interface Window {
    readonly dshShell: ShellBridge
  }
}

export {}
