import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { DSH_HOST, DSH_PORT, INITIAL_DSH_VERSION, PRODUCT_NAME } from '../shared/config.js'
import type { StartupAction, WorkspaceTab } from '../shared/contracts.js'
import { installAppMenu } from './app-menu.js'
import { DesktopUpdater } from './app-updater.js'
import { DshPackageManager } from './dsh-package-manager.js'
import { DshUpdater } from './dsh-updater.js'
import { FileLogger } from './logging.js'
import { createAppPaths } from './platform/app-paths.js'
import { StartupOrchestrator } from './startup-orchestrator.js'
import { UpdateLock } from './update-lock.js'
import { WindowController } from './window-controller.js'

app.setName(PRODUCT_NAME)
const localAppData = process.env.LOCALAPPDATA ?? app.getPath('appData')
const testMode = process.env.DSH_DESKTOP_TEST_MODE === '1'
const configuredDataRoot = testMode ? process.env.DSH_DESKTOP_DATA_ROOT : undefined
app.setPath('userData', configuredDataRoot ? join(configuredDataRoot) : join(localAppData, PRODUCT_NAME))
const configuredPort = testMode ? Number(process.env.DSH_DESKTOP_PORT ?? DSH_PORT) : DSH_PORT
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error('Invalid DSH_DESKTOP_PORT')
}
const dshUrl = `http://${DSH_HOST}:${configuredPort}`

const windows = new WindowController(dshUrl)
let orchestrator: StartupOrchestrator | null = null
let quitting = false

function verifyStartupSender(senderId: number): void {
  if (!windows.isStartupSender(senderId)) throw new Error('Rejected IPC sender')
}

function verifyShellSender(senderId: number): void {
  if (!windows.isShellSender(senderId)) throw new Error('Rejected shell IPC sender')
}

function registerIpc(paths: ReturnType<typeof createAppPaths>): void {
  ipcMain.handle('startup:get-versions', (event) => {
    verifyStartupSender(event.sender.id)
    const versions = orchestrator?.versions
    return {
      app: app.getVersion(),
      dsh: versions?.dsh ?? null,
      node: versions?.node ?? null,
      npm: versions?.npm ?? null
    }
  })
  ipcMain.handle('startup:action', async (event, action: StartupAction) => {
    verifyStartupSender(event.sender.id)
    switch (action) {
      case 'retry':
        await orchestrator?.run()
        return
      case 'open-node-download':
        await shell.openExternal('https://nodejs.org/en/download')
        return
      case 'open-logs':
        await shell.openPath(paths.logs)
        return
      case 'exit':
        app.quit()
        return
      default:
        throw new Error('Unknown startup action')
    }
  })
  ipcMain.handle('shell:select-tab', async (event, tab: WorkspaceTab) => {
    verifyShellSender(event.sender.id)
    if (tab !== 'dsh' && tab !== 'deepseek') throw new Error('Unknown workspace tab')
    await windows.selectTab(tab)
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => windows.focus())

  void app.whenReady().then(async () => {
    const paths = createAppPaths(app.getPath('userData'))
    const logger = new FileLogger(paths.logs)
    await logger.prune()
    const packages = new DshPackageManager(paths, {
      extractor: null
    })
    orchestrator = new StartupOrchestrator(windows, packages, logger, dshUrl)
    const updateLock = new UpdateLock()
    const desktopUpdater = new DesktopUpdater(
      updateLock,
      logger,
      () => windows.activeWindow,
      async () => await orchestrator?.stop()
    )
    const dshUpdater = new DshUpdater(packages, orchestrator, updateLock, logger)
    installAppMenu({
      getWindow: () => windows.activeWindow,
      desktopUpdater,
      dshUpdater,
      packages,
      logsDirectory: paths.logs,
      selectWorkspace: async (tab) => await windows.selectTab(tab)
    })
    registerIpc(paths)
    windows.createStartupWindow()
    await logger.write('desktop', `Starting ${PRODUCT_NAME} ${app.getVersion()}, pinned DSH ${INITIAL_DSH_VERSION}`)
    const ready = await orchestrator.run()
    const autoExitMs = testMode ? Number(process.env.DSH_DESKTOP_AUTO_EXIT_MS ?? 0) : 0
    if (ready && testMode) {
      const testTab = process.env.DSH_DESKTOP_TEST_TAB
      if (testTab === 'deepseek') await windows.selectTab('deepseek')
      const screenshotPath = process.env.DSH_DESKTOP_SCREENSHOT
      const captureDelayMs = Number(process.env.DSH_DESKTOP_TEST_CAPTURE_DELAY_MS ?? 1_500)
      if (screenshotPath) await windows.captureActive(
        screenshotPath,
        Number.isFinite(captureDelayMs) && captureDelayMs >= 0 ? captureDelayMs : 1_500
      )
    }
    if (ready && Number.isFinite(autoExitMs) && autoExitMs > 0) {
      setTimeout(() => app.quit(), autoExitMs)
    }
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    const stop = orchestrator?.stop() ?? Promise.resolve()
    void stop
      .catch(() => undefined)
      .finally(() => {
        windows.destroyAll()
        app.quit()
      })
  })

  app.on('window-all-closed', () => app.quit())
}
