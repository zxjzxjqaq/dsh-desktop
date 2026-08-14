import { INITIAL_DSH_VERSION, NODE_VERSION_RANGE } from '../shared/config.js'
import type { StartupStatus } from '../shared/contracts.js'
import type { DshPackageManager } from './dsh-package-manager.js'
import { DshServiceManager } from './dsh-service-manager.js'
import type { FileLogger } from './logging.js'
import { detectNodeEnvironment, type ValidNodeEnvironment } from './node-environment.js'
import type { WindowController } from './window-controller.js'

function status(
  phase: StartupStatus['phase'],
  title: string,
  detail: string,
  actions: StartupStatus['actions'] = [],
  diagnostic?: string
): StartupStatus {
  return { phase, title, detail, actions, ...(diagnostic ? { diagnostic } : {}) }
}

export class StartupOrchestrator {
  private running: Promise<boolean> | null = null
  private service: DshServiceManager | null = null
  private environment: ValidNodeEnvironment | null = null
  private activeDshVersion: string | null = null
  private crashRestarts = 0

  public constructor(
    private readonly windows: WindowController,
    private readonly packages: DshPackageManager,
    private readonly logger: FileLogger,
    private readonly dshUrl = 'http://127.0.0.1:3080'
  ) {}

  public get versions(): {
    readonly dsh: string | null
    readonly node: string | null
    readonly npm: string | null
  } {
    return {
      dsh: this.activeDshVersion,
      node: this.environment?.nodeVersion ?? null,
      npm: this.environment?.npmVersion ?? null
    }
  }

  public async run(): Promise<boolean> {
    if (this.running) return await this.running
    this.running = this.runOnce().finally(() => {
      this.running = null
    })
    return await this.running
  }

  private async runOnce(): Promise<boolean> {
    this.windows.sendStatus(
      status('checking-node', '正在检测 Node.js', `需要 Node.js ${NODE_VERSION_RANGE}`)
    )
    const environment = await detectNodeEnvironment()
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

    this.windows.sendStatus(
      status(
        'preparing-dsh',
        '正在准备 DSH',
        `Node.js ${environment.nodeVersion} · npm ${environment.npmVersion}`
      )
    )
    let install
    try {
      const current = await this.packages.current()
      install = current
        ? await this.packages.validate(current.directory, current.version)
        : await this.packages.install(environment, INITIAL_DSH_VERSION)
      if (!current) await this.packages.select(install.selection)
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
    this.activeDshVersion = install.selection.version

    this.windows.sendStatus(
      status('starting-dsh', '正在启动 DSH 服务', `DSH ${install.selection.version}`)
    )
    const service = new DshServiceManager({
      nodePath: environment.nodePath,
      binaryPath: install.binaryPath,
      host: new URL(this.dshUrl).hostname,
      port: Number(new URL(this.dshUrl).port),
      logger: this.logger,
      onUnexpectedExit: () => void this.handleUnexpectedExit()
    })
    this.service = service
    this.windows.sendStatus(
      status('waiting-for-health', '正在连接 DSH Web', '正在等待 127.0.0.1:3080 就绪…')
    )
    try {
      await service.start()
      this.crashRestarts = 0
      await this.logger.write('desktop', `DSH ${install.selection.version} is healthy`)
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

  private async handleUnexpectedExit(): Promise<void> {
    if (this.crashRestarts >= 1) {
      this.windows.sendStatus(
        status('service-error', 'DSH 服务已停止', '自动重启仍然失败，请查看日志。', [
          'retry',
          'open-logs',
          'exit'
        ])
      )
      return
    }
    this.crashRestarts += 1
    await this.logger.write('desktop', 'DSH exited unexpectedly; attempting one restart')
    this.windows.sendStatus(
      status('starting-dsh', '正在重新启动 DSH', '检测到服务意外退出，正在自动重试一次。')
    )
    this.service = null
    await this.restart()
  }

  public async restart(): Promise<boolean> {
    await this.stop()
    this.windows.showStartup()
    return await this.run()
  }

  public async stop(): Promise<void> {
    await this.service?.stop()
    this.service = null
  }
}
