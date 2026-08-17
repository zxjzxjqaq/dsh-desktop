import { join } from 'node:path'
import { app, ipcMain, Notification, shell } from 'electron'
import { DSH_HOST, DSH_PORT, INITIAL_DSH_VERSION, PRODUCT_NAME } from '../shared/config.js'
import type {
  DshServiceStatus,
  DshUpdateState,
  ShellSnapshot,
  StartupAction,
  WorkspaceTab
} from '../shared/contracts.js'
import type { DshUpdateResult } from './dsh-updater.js'
import { installAppMenu } from './app-menu.js'
import { DesktopUpdater } from './app-updater.js'
import { probeOnce } from './dsh-health.js'
import type { DshSelection } from './dsh-package-manager.js'
import { DshPackageManager } from './dsh-package-manager.js'
import { DshUpdater } from './dsh-updater.js'
import { FileLogger } from './logging.js'
import { createAppPaths } from './platform/app-paths.js'
import { RuntimeExtractor } from './runtime-extractor.js'
import { DEFAULT_SETTINGS, SettingsStore, type AppSettings } from './settings.js'
import { StartupOrchestrator } from './startup-orchestrator.js'
import { DshSupervisor } from './supervisor.js'
import { isTrayModeEnabled, TrayController } from './tray-controller.js'
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
let supervisor: DshSupervisor | null = null
let quitting = false
let currentSettings: AppSettings | null = null
let lastUpdateState: DshUpdateState = { phase: 'idle' }

const settingsSnapshot = (): AppSettings => currentSettings ?? DEFAULT_SETTINGS

function verifyStartupSender(senderId: number): void {
  if (!windows.isStartupSender(senderId)) throw new Error('Rejected startup IPC sender')
}

function verifyShellSender(senderId: number): void {
  if (!windows.isShellSender(senderId)) throw new Error('Rejected shell IPC sender')
}

function setUpdateState(state: DshUpdateState): void {
  lastUpdateState = state
  windows.sendUpdateState(state)
}

function sendServiceStatus(status: DshServiceStatus): void {
  windows.sendServiceStatus(status)
}

function registerIpc(paths: ReturnType<typeof createAppPaths>): void {
  ipcMain.handle('startup:get-versions', (event) => {
    verifyStartupSender(event.sender.id)
    const versions = orchestrator?.versions
    return {
      app: app.getVersion(),
      dsh: versions?.dsh ?? null,
      node: versions?.node ?? null,
      nodeSource: versions?.nodeSource ?? null,
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
  ipcMain.handle('shell:restart-dsh', async (event) => {
    verifyShellSender(event.sender.id)
    const active = supervisor
    if (!active) return false
    return await active.restartNow('manual')
  })
  ipcMain.handle('shell:get-snapshot', (event) => {
    verifyShellSender(event.sender.id)
    const snapshot: ShellSnapshot = {
      service: supervisor?.status ?? { phase: 'stopped', failures: 0 },
      update: lastUpdateState
    }
    return snapshot
  })
}

function notify(message: string, detail?: string): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title: PRODUCT_NAME, body: detail ? `${message}\n${detail}` : message })
    notification.show()
  }
}

function installUpdateScheduler(
  updateLock: UpdateLock,
  settings: () => AppSettings,
  dshUpdater: DshUpdater
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const reschedule = (): void => {
    if (cancelled) return
    const hours = Math.max(1, settings().updateCheckHours)
    timer = setTimeout(() => void runOnce(), hours * 3_600_000)
  }

  const runOnce = async (): Promise<void> => {
    if (cancelled) return
    if (!settings().autoUpdateDsh) {
      reschedule()
      return
    }
    if (updateLock.activeOperation) {
      reschedule()
      return
    }
    try {
      setUpdateState({ phase: 'checking' })
      const check = await dshUpdater.check()
      if (!check.updateAvailable) {
        setUpdateState({ phase: 'idle' })
        reschedule()
        return
      }
      setUpdateState({ phase: 'update-available', version: check.latestVersion })
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'DSH 更新可用',
          body: `发现 DSH ${check.latestVersion}（当前 ${check.currentVersion ?? '未安装'}）。`
        })
        notification.on('click', () => void runScheduledFlow(check.latestVersion))
        notification.show()
      }
    } catch {
      // Silent: background checks must never interrupt the user.
    }
    reschedule()
  }

  const runScheduledFlow = async (version: string): Promise<void> => {
    try {
      const prepared = await prepareDshUpdate(dshUpdater, version)
      if (!settings().autoApplyDsh) {
        if (Notification.isSupported()) {
          const ready = new Notification({
            title: 'DSH 更新已就绪',
            body: `DSH ${version} 已下载完成，点击“立即重启生效”。`
          })
          ready.on('click', () => {
            void applyDshUpdate(dshUpdater, prepared).then((result) => {
              notify(
                result.rolledBack ? 'DSH 更新验证失败，已回滚' : 'DSH 更新完成',
                result.rolledBack ? `已恢复 DSH ${result.version}。` : `当前运行 DSH ${result.version}。`
              )
            })
          })
          ready.show()
        }
        return
      }
      const result = await applyDshUpdate(dshUpdater, prepared)
      notify(
        result.rolledBack ? 'DSH 更新验证失败，已回滚' : 'DSH 更新完成',
        result.rolledBack ? `已恢复 DSH ${result.version}。` : `当前运行 DSH ${result.version}。`
      )
    } catch (error) {
      setUpdateState({ phase: 'failed', version, detail: String(error) })
      notify('DSH 更新失败', String(error))
    }
  }

  // First check shortly after startup so a stale release is surfaced quickly.
  timer = setTimeout(() => void runOnce(), 10 * 60_000)
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
  }
}

async function prepareDshUpdate(dshUpdater: DshUpdater, version: string): Promise<DshSelection> {
  setUpdateState({ phase: 'preparing', version })
  try {
    const prepared = await dshUpdater.prepare(version)
    setUpdateState({ phase: 'update-available', version })
    return prepared
  } catch (error) {
    setUpdateState({ phase: 'failed', version, detail: String(error) })
    throw error
  }
}

async function applyDshUpdate(dshUpdater: DshUpdater, prepared: DshSelection): Promise<DshUpdateResult> {
  setUpdateState({ phase: 'applying', version: prepared.version })
  try {
    const result = await dshUpdater.apply(prepared)
    setUpdateState({
      phase: result.rolledBack ? 'rolled-back' : 'applied',
      version: result.version
    })
    return result
  } catch (error) {
    setUpdateState({ phase: 'failed', version: prepared.version, detail: String(error) })
    throw error
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

function wakeApp(): void {
  if (quitting) return
  const restarting = supervisor?.status.phase === 'restarting'
  if (orchestrator?.serviceRunning || restarting) {
    // DSH is healthy or a watchdog restart is already in flight: never start a
    // second instance that would race for the same port. Just show the window.
    void windows.showDsh()
  } else {
    windows.focus()
    if (orchestrator && !orchestrator.serviceRunning) void orchestrator.run()
  }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', wakeApp)

  void app.whenReady().then(async () => {
    const paths = createAppPaths(app.getPath('userData'))
    const logger = new FileLogger(paths.logs)
    await logger.prune()
    const extractor = app.isPackaged
      ? new RuntimeExtractor(paths, {
          resourcesDirectory: process.resourcesPath,
          logger,
          onProgress: (progress) => orchestrator?.reportRuntimeProgress(progress)
        })
      : null
    const packages = new DshPackageManager(paths, { extractor })
    const settingsStore = new SettingsStore(paths.settings)
    currentSettings = await settingsStore.load()
    orchestrator = new StartupOrchestrator(windows, packages, logger, dshUrl, extractor, {
      onUnexpectedExit: () => supervisor?.onServiceExited(),
      onServiceStarted: () => supervisor?.start()
    })
    const updateLock = new UpdateLock()
    supervisor = new DshSupervisor({
      url: dshUrl,
      probe: async (url) => await probeOnce({ url }),
      restart: async (reason) => {
        if (!orchestrator) return false
        void logger.write('desktop', `Supervisor restart triggered: ${reason}`)
        return await orchestrator.restart()
      },
      isUpdateActive: () => updateLock.activeOperation !== null,
      log: (message) => logger.write('desktop', message)
    })
    supervisor.onStatusChange(sendServiceStatus)
    const desktopUpdater = new DesktopUpdater(
      updateLock,
      logger,
      () => windows.activeWindow,
      async () => await orchestrator?.stop()
    )
    const dshUpdater = new DshUpdater(
      packages,
      {
        restart: async () => {
          const active = supervisor
          if (!active) return false
          return await active.restartNow('update')
        }
      },
      updateLock,
      logger,
      undefined,
      undefined,
      {
        registryUrl: currentSettings.registryUrl,
        proxyUrl: currentSettings.proxyUrl,
        httpsProxyUrl: currentSettings.httpsProxyUrl
      }
    )
    installAppMenu({
      getWindow: () => windows.activeWindow,
      desktopUpdater,
      dshUpdater,
      packages,
      logsDirectory: paths.logs,
      selectWorkspace: async (tab) => await windows.selectTab(tab),
      restartDsh: async () => {
        const active = supervisor
        if (!active) return false
        return await active.restartNow('manual')
      },
      prepareDshUpdate: async (version) => await prepareDshUpdate(dshUpdater, version),
      applyDshUpdate: async (prepared) => await applyDshUpdate(dshUpdater, prepared),
      getSettings: () => settingsSnapshot(),
      updateSettings: async (patch) => {
        currentSettings = await settingsStore.update(patch)
        return currentSettings
      }
    })
    registerIpc(paths)
    windows.createStartupWindow()
    const tray = new TrayController({
      iconPath: app.isPackaged
        ? join(process.resourcesPath, 'icon.ico')
        : join(app.getAppPath(), 'build', 'icon.ico'),
      getWindow: () => windows.activeWindow,
      selectWorkspace: async (tab) => {
        windows.focus()
        await windows.selectTab(tab)
      },
      openLogsDirectory: async () => {
        await shell.openPath(paths.logs)
      },
      onQuit: () => app.quit()
    })
    tray.create()
    windows.setCloseBehavior(() => tray.enabled, () => tray.onWindowHidden())
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

    const stopScheduler = installUpdateScheduler(updateLock, settingsSnapshot, dshUpdater)
    app.on('before-quit', () => stopScheduler())
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    supervisor?.stop()
    const stop = orchestrator?.stop() ?? Promise.resolve()
    void stop
      .catch(() => undefined)
      .finally(() => {
        windows.destroyAll()
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (!isTrayModeEnabled()) app.quit()
  })
}