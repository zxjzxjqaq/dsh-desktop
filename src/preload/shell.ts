import { contextBridge, ipcRenderer } from 'electron'
import type { ShellBridge, WorkspaceTab, WorkspaceTabState } from '../shared/contracts.js'

contextBridge.exposeInMainWorld('dshShell', {
  selectTab: async (tab) => await ipcRenderer.invoke('shell:select-tab', tab),
  onTabChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: WorkspaceTab): void => listener(tab)
    ipcRenderer.on('shell:tab-changed', handler)
    return () => ipcRenderer.removeListener('shell:tab-changed', handler)
  },
  onTabState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceTabState): void => listener(state)
    ipcRenderer.on('shell:tab-state', handler)
    return () => ipcRenderer.removeListener('shell:tab-state', handler)
  }
} satisfies ShellBridge)
