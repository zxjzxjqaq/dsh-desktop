import { INITIAL_DSH_VERSION, NODE_VERSION_RANGE } from '../shared/config.js'
import type { StartupStatus } from '../shared/contracts.js'
import type { DshPackageManager, DshInstall } from './dsh-package-manager.js'
import { DshServiceManager } from './dsh-service-manager.js'
import type { FileLogger } from './logging.js'
import { detectNodeEnvironment, type ValidNodeEnvironment } from './node-environment.js'
import type { RuntimeExtractionProgress, RuntimeExtractor } from './runtime-extractor.js'
import type { WindowController } from './window-controller.js'

function status(
  phase: StartupStatus['phase'],
  title: string,
  detail: string,
  actions: StartupStatus['actions'] = [],
  diagnostic?: string,
  progress?: StartupStatus['progress']
): StartupStatus {
  return {
    phase,
    title,
    detail,
    actions,
    ...(diagnostic ? { diagnostic } : {}),
    ...(progress ? { progress } : {})
  }
}

export interface StartupOrchestratorOptions {
  readonly onUnexpectedExit?: () => void
  readonly onServiceStarted?: () => void
  readonly restartAttemptDelayMs?: number
  readonly restartMaxAttempts?: number
}

export class StartupOrchestrator {
  private running: Promise<boolean> | null = null
  private service: DshServiceManager | null = null
  private environment: ValidNodeEnvironment | null = null
  private install: DshInstall | null = null
  /** 两个内置运行环境各自的最新解压进度，合并成单一进度条展示 */
  private runtimeProgress: Record<'node' | 'dsh', { done: number; total: number | null }> = {
    node: { done: 0, total: null },
    dsh: { done: 0, total: null }
  }

  public constructor(
    private readonly windows: WindowController,
    private readonly packages: DshPackageManager,
    private readonly logger: FileLogger,
    private readonly dshUrl = 'http://127.0.0.1:3080',
    private readonly extractor: RuntimeExtractor | null = null,
    private readonly options: StartupOrchestratorOptions = {}
  ) {}

  public get versions(): {
    readonly dsh: string | null
    readonly node: string | null
    readonly nodeSource: 'bundled' | 'system' | null
    readonly npm: string | null
  } {
    return {
      dsh: this.install?.selection.version ?? null,
      node: this.environment?.nodeVersion ?? null,
      nodeSource: this.environment?.source ?? null,
      npm: this.environment?.npmVersion ?? null
    }
  }

  public get serviceRunning(): boolean {
    return this.service !== null
  }

  /** 由 RuntimeExtractor 上报单归档解压进度，合并后推送启动界面（节流已在解压层完成） */
  public reportRuntimeProgress(progress: RuntimeExtractionProgress): void {
    const current = this.runtimeProgress[progress.kind]
    current.done = Math.max(current.done, progress.done)
    if (progress.total !== null) current.total = progress.total
    const done = this.runtimeProgress.node.done + this.runtimeProgress.dsh.done
    const total =
      this.runtimeProgress.node.total !== null && this.runtimeProgress.dsh.total !== null
        ? this.runtimeProgress.node.total + this.runtimeProgress.dsh.total
        : null
    const detail =
      total === null
        ? `正在解压内置运行环境…（已处理 ${done.toLocaleString()} 个文件）`
        : `正在解压内置运行环境…（${done.toLocaleString()} / ${total.toLocaleString()} 个文件）`
    this.windows.sendStatus(
      status('preparing-runtime', '正在准备运行环境', detail, [], undefined, { done, total })
    )
  }

  public async run(): Promise<boolean> {
    if (this.running) return await this.running
    this.running = this.runOnce().finally(() => {
      this.running = null
    })
    return await this.running
  }

  private async runOnce(): Promise<boolean> {
    const startupStartedAt = Date.now()
    this.windows.sendStatus(
      status('preparing-runtime', '正在准备运行环境', '正在准备 Node.js 运行环境…')
    )
    let bundledNodeDirectory: string | null = null
    if (this.extractor) {
      // Extract the Node and DSH runtimes concurrently: on a first launch they
      // are independent ~100 MB / ~250 MB archives, and doing them serially made
      // the built-in environment check take minutes.
      const [nodeResult, dshResult] = await Promise.allSettled([
        this.extractor.nodeRuntimeDirectory(),
        this.extractor.dshRuntimeDirectory()
      ])
      if (nodeResult.status === 'fulfilled' && nodeResult.value) {
        bundledNodeDirectory = nodeResult.value
        await this.logger.write('desktop', `Bundled Node runtime ready at ${bundledNodeDirectory}`)
      } else if (nodeResult.status === 'rejected') {
        await this.logger.write('desktop', `Bundled Node runtime unavailable: ${String(nodeResult.reason)}`)
      }
      if (dshResult.status === 'fulfilled' && dshResult.value) {
        await this.logger.write('desktop', `Bundled DSH runtime ready at ${dshResult.value}`)
      } else if (dshResult.status === 'rejected') {
        await this.logger.write('desktop', `Bundled DSH runtime unavailable: ${String(dshResult.reason)}`)
      }
    }
    this.windows.sendStatus(
      status('checking-node', '正在检测 Node.js', `需要 Node.js ${NODE_VERSION_RANGE}`)
    )
    const environment = await detectNodeEnvironment(undefined, bundledNodeDirectory)
    if (!environment.ok) {
      await this.logger.write('desktop', `Node environment error: ${environment.reason} ${environment.detail}`)
      this.windows.sendStatus(
        status(
          'environment-error',
          'Node.js 环境需要处理',
          environment.detail,
          ['open-node-download', 'retry', 'open-logs', 'exit']
        )
      )
      return false
    }
    this.environment = environment
    await this.logger.write(
      'desktop',
      `Node environment ready in ${Date.now() - startupStartedAt}ms (source: ${environment.source}, ${environment.nodeVersion})`
    )

    this.windows.sendStatus(
      status(
        'preparing-dsh',
        '正在验证内置 DSH',
        `DSH ${INITIAL_DSH_VERSION} · Node.js ${environment.nodeVersion}`
      )
    )
    let install: DshInstall | null = null
    try {
      install = await this.resolveInstall(environment)
      await this.logger.write('desktop', `DSH runtime ready in ${Date.now() - startupStartedAt}ms`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.logger.write('desktop', `DSH package error: ${detail}`)
      this.windows.sendStatus(
        status('package-error', 'DSH 安装失败', '当前版本未被切换，可以查看日志后重试。', [
          'retry',
          'open-logs',
          'exit'
        ], detail)
      )
      return false
    }
    this.install = install

    this.windows.sendStatus(
      status('starting-dsh', '正在启动 DSH 服务', `DSH ${install.selection.version}`)
    )
    const service = this.createService(environment, install)
    this.service = service
    this.windows.sendStatus(
      status('waiting-for-health', '正在连接 DSH Web', '正在等待 127.0.0.1:3080 就绪…')
    )
    try {
      const serviceStartedAt = Date.now()
      await service.start()
      this.options.onServiceStarted?.()
      await this.logger.write(
        'desktop',
        `DSH ${install.selection.version} is healthy in ${Date.now() - serviceStartedAt}ms; total startup ${Date.now() - startupStartedAt}ms`
      )
      await this.windows.showDsh()
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.logger.write('desktop', `DSH service error: ${detail}`)
      this.windows.sendStatus(
        status('service-error', 'DSH 服务启动失败', '服务已停止，可以查看日志后重试。', [
          'retry',
          'open-logs',
          'exit'
        ], detail)
      )
      return false
    }
  }

  private async resolveInstall(environment: ValidNodeEnvironment): Promise<DshInstall> {
    const current = await this.packages.current()
    if (current) {
      try {
        return await this.packages.validate(current.directory, current.version)
      } catch (error) {
        await this.logger.write('desktop', `Current DSH selection is invalid; using bundled fallback: ${String(error)}`)
      }
    }
    const bundled = await this.packages.restoreBundled(INITIAL_DSH_VERSION)
    if (bundled) {
      await this.logger.write('desktop', `Using bundled DSH ${bundled.selection.version}`)
      await this.packages.select(bundled.selection)
      return bundled
    }
    this.windows.sendStatus(
      status(
        'preparing-dsh',
        '正在下载 DSH 运行环境',
        `内置运行环境不可用，正在获取 DSH ${INITIAL_DSH_VERSION}`
      )
    )
    const install = await this.packages.install(environment, INITIAL_DSH_VERSION)
    await this.packages.select(install.selection)
    return install
  }

  private createService(environment: ValidNodeEnvironment, install: DshInstall): DshServiceManager {
    return new DshServiceManager({
      nodePath: environment.nodePath,
      binaryPath: install.binaryPath,
      host: new URL(this.dshUrl).hostname,
      port: Number(new URL(this.dshUrl).port),
      logger: this.logger,
      onUnexpectedExit: () => void this.options.onUnexpectedExit?.()
    })
  }

  /**
   * Restart the DSH service *in place*: stop the child process tree, spawn a
   * fresh one for the same selected version, wait for health and reconnect the
   * workspace view. Windows are never touched, so a DeepSeek chat session and
   * the toolbar keep working across the restart.
   *
   * Used by the supervisor (watchdog) and the update pipeline.
   */
  public async restart(): Promise<boolean> {
    const environment = this.environment
    const install = this.install
    if (!environment || !install) {
      await this.logger.write('desktop', 'Restart requested but the environment/install is not ready')
      return false
    }
    await this.stop()
    const delayMs = this.options.restartAttemptDelayMs ?? 500
    const maxAttempts = this.options.restartMaxAttempts ?? 3
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        const service = this.createService(environment, install)
        this.service = service
        await service.start()
        this.options.onServiceStarted?.()
        await this.logger.write('desktop', `DSH ${install.selection.version} restarted in place`)
        this.windows.reloadDsh()
        return true
      } catch (error) {
        lastError = error
        this.service = null
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    await this.logger.write('desktop', `DSH restart failed after ${maxAttempts} attempts: ${detail}`)
    return false
  }

  public async stop(): Promise<void> {
    await this.service?.stop()
    this.service = null
  }
}