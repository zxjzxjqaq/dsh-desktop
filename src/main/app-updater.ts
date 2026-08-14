import { app, type BrowserWindow } from 'electron'
import updaterPackage from 'electron-updater'
import type { ProgressInfo, UpdateCheckResult } from 'electron-updater'
import type { FileLogger } from './logging.js'
import type { UpdateLock } from './update-lock.js'

const { autoUpdater } = updaterPackage

export class DesktopUpdater {
  public constructor(
    private readonly lock: UpdateLock,
    private readonly logger: FileLogger,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly beforeInstall: () => Promise<void>
  ) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    const feedUrl = process.env.DSH_DESKTOP_UPDATE_URL
    if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    autoUpdater.on('error', (error) => void this.logger.write('updater', `Desktop update error: ${error.message}`))
  }

  public get supported(): boolean {
    return app.isPackaged || process.env.DSH_FORCE_UPDATE === '1'
  }

  public async check(): Promise<UpdateCheckResult | null> {
    if (!this.supported) return null
    return await autoUpdater.checkForUpdates()
  }

  public async download(): Promise<void> {
    await this.lock.run('desktop-update', async () => {
      const window = this.getWindow()
      const onProgress = (progress: ProgressInfo): void => {
        window?.setProgressBar(progress.percent / 100)
        window?.setTitle(`DSH Desktop · 更新 ${Math.round(progress.percent)}%`)
      }
      autoUpdater.on('download-progress', onProgress)
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', onProgress)
        window?.setProgressBar(-1)
        window?.setTitle('DSH Desktop')
      }
    })
  }

  public async install(): Promise<void> {
    await this.beforeInstall()
    autoUpdater.quitAndInstall(false, true)
  }
}
