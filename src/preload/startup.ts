import { contextBridge, ipcRenderer } from 'electron'
import { PRODUCT_NAME } from '../shared/config.js'
import type { StartupBridge, StartupStatus } from '../shared/contracts.js'

contextBridge.exposeInMainWorld('dshDesktop', {
  productName: PRODUCT_NAME,
  platform: process.platform,
  getVersions: async () => await ipcRenderer.invoke('startup:get-versions'),
  perform: async (action) => await ipcRenderer.invoke('startup:action', action),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: StartupStatus): void => listener(value)
    ipcRenderer.on('startup:status', handler)
    return () => ipcRenderer.removeListener('startup:status', handler)
  }
} satisfies StartupBridge)
