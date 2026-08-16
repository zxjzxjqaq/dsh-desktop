import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { WorkspaceTab } from '../shared/contracts.js'

export interface TrayControllerOptions {
  readonly iconPath: string
  readonly getWindow: () => BrowserWindow | null
  readonly selectWorkspace: (tab: WorkspaceTab) => Promise<void>
  readonly openLogsDirectory: () => Promise<void>
  readonly onQuit: () => void
  readonly notify?: (title: string, body: string) => void
  readonly enabled?: boolean
}

export function isTrayModeEnabled(): boolean {
  return app.isPackaged || process.env.DSH_DESKTOP_TRAY === '1'
}

export function buildTrayMenuTemplate(options: TrayControllerOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: '显示 DSH 工作区',
      click: () => void options.selectWorkspace('dsh')
    },
    {
      label: '显示 DeepSeek 对话',
      click: () => void options.selectWorkspace('deepseek')
    },
    { type: 'separator' },
    {
      label: '打开日志目录',
      click: () => void options.openLogsDirectory()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => options.onQuit()
    }
  ]
}

export class TrayController {
  private tray: Tray | null = null
  private hiddenNotificationShown = false

  public constructor(private readonly options: TrayControllerOptions) {}

  public get enabled(): boolean {
    if (this.options.enabled !== undefined) return this.options.enabled
    return isTrayModeEnabled()
  }

  public create(): void {
    if (!this.enabled || this.tray) return
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath)
      this.tray = new Tray(icon)
      this.tray.setToolTip('DSH Desktop')
      this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(this.options)))
      this.tray.on('click', () => this.toggleWindow())
    } catch (error) {
      this.options.notify?.('DSH Desktop', `托盘创建失败：${String(error)}`)
    }
  }

  public destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  public onWindowHidden(): void {
    if (this.hiddenNotificationShown) return
    this.hiddenNotificationShown = true
    this.notify('DSH Desktop 仍在运行', '窗口已隐藏到托盘。右键点击托盘图标，选择“退出”可完全退出。')
  }

  private notify(title: string, body: string): void {
    if (this.options.notify) {
      this.options.notify(title, body)
      return
    }
    new Notification({ title, body }).show()
  }

  private toggleWindow(): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isVisible() && window.isFocused()) {
      window.hide()
      this.onWindowHidden()
    } else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }
}
