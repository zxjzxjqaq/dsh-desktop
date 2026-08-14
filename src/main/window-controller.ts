import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, shell, WebContentsView } from 'electron'
import {
  DEEPSEEK_CHAT_URL,
  DEFAULT_WORKSPACE_TAB,
  DSH_URL,
  PRODUCT_NAME
} from '../shared/config.js'
import type { StartupStatus, WorkspaceTab, WorkspaceTabState } from '../shared/contracts.js'
import {
  isAllowedDeepSeekNavigation,
  isAllowedDshNavigation,
  isAllowedExternalUrl
} from './navigation-policy.js'

const TOOLBAR_HEIGHT = 54

export class WindowController {
  private startupWindow: BrowserWindow | null = null
  private workspaceWindow: BrowserWindow | null = null
  private shellView: WebContentsView | null = null
  private dshView: WebContentsView | null = null
  private deepseekView: WebContentsView | null = null
  private activeTab: WorkspaceTab = DEFAULT_WORKSPACE_TAB
  private deepseekStarted = false
  private deepseekLoadTimer: NodeJS.Timeout | null = null

  public constructor(
    private readonly dshUrl = DSH_URL,
    private readonly deepseekUrl = DEEPSEEK_CHAT_URL
  ) {}

  public get activeWindow(): BrowserWindow | null {
    return this.workspaceWindow ?? this.startupWindow
  }

  public isStartupSender(senderId: number): boolean {
    return this.startupWindow?.webContents.id === senderId
  }

  public isShellSender(senderId: number): boolean {
    return this.shellView?.webContents.id === senderId
  }

  private async loadRenderer(window: BrowserWindow, page: 'startup'): Promise<void> {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.endsWith('/')
        ? process.env.ELECTRON_RENDERER_URL
        : `${process.env.ELECTRON_RENDERER_URL}/`
      await window.loadURL(new URL(`${page}/index.html`, base).toString())
    } else {
      await window.loadFile(join(__dirname, `../renderer/${page}/index.html`))
    }
  }

  private async loadShellRenderer(view: WebContentsView): Promise<void> {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.endsWith('/')
        ? process.env.ELECTRON_RENDERER_URL
        : `${process.env.ELECTRON_RENDERER_URL}/`
      await view.webContents.loadURL(new URL('shell/index.html', base).toString())
      return
    }
    await view.webContents.loadFile(join(__dirname, '../renderer/shell/index.html'))
  }

  public createStartupWindow(): BrowserWindow {
    if (this.startupWindow && !this.startupWindow.isDestroyed()) return this.startupWindow
    const bounds = this.workspaceWindow?.getBounds()
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
    void this.loadRenderer(window, 'startup')
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

  private sendTabState(state: WorkspaceTabState): void {
    const window = this.workspaceWindow
    if (!window || window.isDestroyed()) return
    this.shellView?.webContents.send('shell:tab-state', state)
  }

  private layoutViews(): void {
    const window = this.workspaceWindow
    if (!window || window.isDestroyed()) return
    const size = window.getContentSize()
    const width = size[0] ?? 0
    const height = size[1] ?? 0
    this.shellView?.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT })
    const workspaceBounds = {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT)
    }
    this.dshView?.setBounds(workspaceBounds)
    this.deepseekView?.setBounds(workspaceBounds)
  }

  private createShellView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/shell.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return view
  }

  private createDshView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedDshNavigation(url, this.dshUrl)) event.preventDefault()
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    return view
  }

  private createDeepSeekView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:deepseek-chat',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const chromeVersion = process.versions.chrome
    view.webContents.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
    )
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedDeepSeekNavigation(url)) event.preventDefault()
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedDeepSeekNavigation(url)) void view.webContents.loadURL(url)
      else if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    view.webContents.on('did-start-loading', () => {
      this.sendTabState({ tab: 'deepseek', loading: true })
      if (this.deepseekLoadTimer) clearTimeout(this.deepseekLoadTimer)
      this.deepseekLoadTimer = setTimeout(() => {
        this.sendTabState({
          tab: 'deepseek',
          loading: false,
          detail: 'DeepSeek 加载时间较长，请检查网络或代理设置'
        })
      }, 20_000)
    })
    view.webContents.on('did-stop-loading', () => {
      if (this.deepseekLoadTimer) clearTimeout(this.deepseekLoadTimer)
      this.deepseekLoadTimer = null
      this.sendTabState({ tab: 'deepseek', loading: false })
    })
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.sendTabState({
        tab: 'deepseek',
        loading: false,
        detail: `DeepSeek 加载失败：${description} (${code})`
      })
    })
    return view
  }

  private startDeepSeek(): void {
    if (this.deepseekStarted || !this.deepseekView) return
    this.deepseekStarted = true
    void this.deepseekView.webContents.loadURL(this.deepseekUrl).catch((error: unknown) => {
      this.sendTabState({
        tab: 'deepseek',
        loading: false,
        detail: `DeepSeek 加载失败：${error instanceof Error ? error.message : String(error)}`
      })
    })
  }

  public async selectTab(tab: WorkspaceTab): Promise<void> {
    const window = this.workspaceWindow
    if (!window || window.isDestroyed() || !this.dshView || !this.deepseekView) return
    this.activeTab = tab
    this.dshView.setVisible(tab === 'dsh')
    this.deepseekView.setVisible(tab === 'deepseek')
    window.setTitle(tab === 'deepseek' ? `${PRODUCT_NAME} — DeepSeek 对话` : PRODUCT_NAME)
    this.shellView?.webContents.send('shell:tab-changed', tab)
    if (tab === 'deepseek') {
      this.startDeepSeek()
      this.deepseekView.webContents.focus()
    } else {
      this.sendTabState({ tab: 'dsh', loading: false })
      this.dshView.webContents.focus()
    }
  }

  public async showDsh(): Promise<BrowserWindow> {
    const existing = this.workspaceWindow
    if (existing && !existing.isDestroyed()) {
      existing.show()
      return existing
    }

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
      backgroundColor: '#111722',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.workspaceWindow = window
    this.shellView = this.createShellView()
    this.dshView = this.createDshView()
    this.deepseekView = this.createDeepSeekView()
    this.dshView.setVisible(DEFAULT_WORKSPACE_TAB === 'dsh')
    this.deepseekView.setVisible(DEFAULT_WORKSPACE_TAB === 'deepseek')
    window.contentView.addChildView(this.dshView)
    window.contentView.addChildView(this.deepseekView)
    window.contentView.addChildView(this.shellView)
    window.on('resize', () => this.layoutViews())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.on('closed', () => {
      if (this.workspaceWindow !== window) return
      this.workspaceWindow = null
      this.closeViews()
    })
    this.layoutViews()

    await Promise.all([
      this.loadShellRenderer(this.shellView),
      this.dshView.webContents.loadURL(this.dshUrl)
    ])
    this.layoutViews()
    await this.selectTab(DEFAULT_WORKSPACE_TAB)
    window.show()
    startup?.destroy()
    this.startupWindow = null

    return window
  }

  public async captureActive(path: string, delayMs = 1_500): Promise<void> {
    const view = this.activeTab === 'deepseek' ? this.deepseekView : this.dshView
    if (!view || view.webContents.isDestroyed()) throw new Error('Active workspace view is unavailable')
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    const image = await view.webContents.capturePage()
    await writeFile(path, image.toPNG())
  }

  private closeViews(): void {
    for (const view of [this.shellView, this.dshView, this.deepseekView]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    }
    this.shellView = null
    this.dshView = null
    this.deepseekView = null
    if (this.deepseekLoadTimer) clearTimeout(this.deepseekLoadTimer)
    this.deepseekLoadTimer = null
    this.deepseekStarted = false
    this.activeTab = DEFAULT_WORKSPACE_TAB
  }

  public showStartup(): BrowserWindow {
    const startup = this.createStartupWindow()
    const workspace = this.workspaceWindow
    if (workspace && !workspace.isDestroyed()) {
      startup.setBounds(workspace.getBounds())
      workspace.destroy()
    }
    this.workspaceWindow = null
    this.closeViews()
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
    this.workspaceWindow?.destroy()
    this.startupWindow?.destroy()
    this.workspaceWindow = null
    this.startupWindow = null
    this.closeViews()
  }
}
