import { contextBridge, ipcRenderer } from 'electron'
import type {
  DshServiceStatus,
  DshUpdateState,
  ShellBridge,
  ShellSnapshot,
  WorkspaceTab,
  WorkspaceTabState
} from '../shared/contracts.js'

contextBridge.exposeInMainWorld('dshShell', {
  selectTab: async (tab) => await ipcRenderer.invoke('shell:select-tab', tab),
  restartDsh: async () => await ipcRenderer.invoke('shell:restart-dsh'),
  getSnapshot: async () => await ipcRenderer.invoke('shell:get-snapshot') as ShellSnapshot,
  onTabChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: WorkspaceTab): void => listener(tab)
    ipcRenderer.on('shell:tab-changed', handler)
    return () => ipcRenderer.removeListener('shell:tab-changed', handler)
  },
  onTabState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceTabState): void => listener(state)
    ipcRenderer.on('shell:tab-state', handler)
    return () => ipcRenderer.removeListener('shell:tab-state', handler)
  },
  onServiceStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DshServiceStatus): void => listener(status)
    ipcRenderer.on('shell:service-status', handler)
    return () => ipcRenderer.removeListener('shell:service-status', handler)
  },
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DshUpdateState): void => listener(state)
    ipcRenderer.on('shell:update-state', handler)
    return () => ipcRenderer.removeListener('shell:update-state', handler)
  }
} satisfies ShellBridge)