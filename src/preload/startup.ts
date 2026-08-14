import { contextBridge } from 'electron'
import { PRODUCT_NAME } from '../shared/config.js'

export interface StartupBridge {
  readonly productName: string
  readonly platform: NodeJS.Platform
}

contextBridge.exposeInMainWorld('dshDesktop', {
  productName: PRODUCT_NAME,
  platform: process.platform
} satisfies StartupBridge)
