import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, shell } from 'electron'
import { DSH_URL, PRODUCT_NAME } from '../shared/config.js'
import type { StartupStatus } from '../shared/contracts.js'
import { isAllowedDshNavigation, isAllowedExternalUrl } from './navigation-policy.js'

export class WindowController {
  private startupWindow: BrowserWindow | null = null
  private dshWindow: BrowserWindow | null = null

  public constructor(private readonly dshUrl = DSH_URL) {}

  public get activeWindow(): BrowserWindow | null {
    return this.dshWindow ?? this.startupWindow
  }

  public isStartupSender(senderId: number): boolean {
    return this.startupWindow?.webContents.id === senderId
  }

  public createStartupWindow(): BrowserWindow {
    if (this.startupWindow && !this.startupWindow.isDestroyed()) return this.startupWindow
    const bounds = this.dshWindow?.getBounds()
    const window = new BrowserWindow({
      title: PRODUCT_NAME,
      width: bounds?.width ?? 1180,
      height: bounds?.height ?? 780,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 760,
      minHeight: 560,
      show: false,
      backgroundColor: '#0b0d10',
      webPreferences: {
        preload: join(__dirname, '../preload/startup.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.startupWindow = window
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      if (this.startupWindow === window) this.startupWindow = null
    })
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return window
  }

  public sendStatus(status: StartupStatus): void {
    const window = this.createStartupWindow()
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => window.webContents.send('startup:status', status))
    } else {
      window.webContents.send('startup:status', status)
    }
  }

  public async showDsh(): Promise<BrowserWindow> {
    const startup = this.startupWindow
    const bounds = startup?.getBounds()
    const window = new BrowserWindow({
      title: PRODUCT_NAME,
      width: bounds?.width ?? 1180,
      height: bounds?.height ?? 780,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 760,
      minHeight: 560,
      show: false,
      backgroundColor: '#0b0d10',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.dshWindow = window
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedDshNavigation(url, this.dshUrl)) event.preventDefault()
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    window.on('closed', () => {
      if (this.dshWindow === window) this.dshWindow = null
    })
    await window.loadURL(this.dshUrl)
    window.show()
    startup?.destroy()
    this.startupWindow = null
    const screenshotPath = process.env.DSH_DESKTOP_TEST_MODE === '1'
      ? process.env.DSH_DESKTOP_SCREENSHOT
      : undefined
    if (screenshotPath) {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const image = await window.webContents.capturePage()
      await writeFile(screenshotPath, image.toPNG())
    }
    return window
  }

  public showStartup(): BrowserWindow {
    const startup = this.createStartupWindow()
    const dsh = this.dshWindow
    if (dsh && !dsh.isDestroyed()) {
      startup.setBounds(dsh.getBounds())
      dsh.destroy()
    }
    this.dshWindow = null
    startup.show()
    return startup
  }

  public focus(): void {
    const window = this.activeWindow
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  public destroyAll(): void {
    this.dshWindow?.destroy()
    this.startupWindow?.destroy()
    this.dshWindow = null
    this.startupWindow = null
  }
}
