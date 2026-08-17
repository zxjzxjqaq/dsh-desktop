import semver from 'semver'
import type { DshInstall, DshInstallOptions, DshSelection } from './dsh-package-manager.js'
import { detectNodeEnvironment, type NodeEnvironment, type ValidNodeEnvironment } from './node-environment.js'
import { runProcess, type ProcessRunner } from './platform/process-runner.js'
import type { UpdateLock } from './update-lock.js'

interface DistTags {
  readonly latest?: string
  readonly next?: string
}

export interface DshUpdateCheck {
  readonly currentVersion: string | null
  readonly latestVersion: string
  readonly updateAvailable: boolean
}

export interface DshUpdateResult {
  readonly version: string
  readonly rolledBack: boolean
}

export interface DshUpdateStore {
  current(): Promise<DshSelection | null>
  install(
    environment: Pick<ValidNodeEnvironment, 'nodePath' | 'npmCliPath'>,
    version: string,
    options?: DshInstallOptions
  ): Promise<DshInstall>
  select(selection: DshSelection): Promise<void>
  restorePrevious(): Promise<DshSelection>
}

export interface DshRestarter {
  restart(): Promise<boolean>
}

export interface UpdateLogger {
  write(channel: 'updater', message: string): Promise<void>
}

export class DshUpdater {
  public constructor(
    private readonly packages: DshUpdateStore,
    private readonly orchestrator: DshRestarter,
    private readonly lock: UpdateLock,
    private readonly logger: UpdateLogger,
    private readonly runner: ProcessRunner = runProcess,
    private readonly detector: (runner: ProcessRunner) => Promise<NodeEnvironment> = detectNodeEnvironment,
    private readonly installOptions: DshInstallOptions = {}
  ) {}

  private async environment() {
    const environment = await this.detector(this.runner)
    if (!environment.ok) throw new Error(environment.detail)
    return environment
  }

  public async check(): Promise<DshUpdateCheck> {
    const environment = await this.environment()
    const result = await this.runner(
      environment.nodePath,
      [environment.npmCliPath, 'view', '@deepseek-ai/dsh', 'dist-tags', '--json'],
      { timeoutMs: 30_000 }
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'npm registry query failed')
    const tags = JSON.parse(result.stdout) as DistTags
    const latestVersion = semver.valid(tags.latest ?? '')
    if (!latestVersion) throw new Error('npm returned an invalid DSH latest tag')
    const currentVersion = (await this.packages.current())?.version ?? null
    return {
      currentVersion,
      latestVersion,
      updateAvailable: !currentVersion || semver.gt(latestVersion, currentVersion)
    }
  }

  /**
   * Phase one of a two-phase update: download and install the release into the
   * managed version store WITHOUT touching the active selection or the running
   * service. Safe to run in the background while the user keeps working.
   */
  public async prepare(version: string): Promise<DshSelection> {
    return await this.lock.run('dsh-update', async () => {
      const environment = await this.environment()
      const install = await this.packages.install(environment, version, this.installOptions)
      await this.logger.write('updater', `Prepared DSH ${version} at ${install.selection.directory}`)
      return install.selection
    })
  }

  /**
   * Phase two: switch the active selection to the prepared release and restart
   * the service in place. If the new version fails health validation, restart
   * again on the previous release and report the rollback.
   */
  public async apply(prepared: DshSelection): Promise<DshUpdateResult> {
    return await this.lock.run('dsh-update', async () => {
      const previous = await this.packages.current()
      await this.packages.select(prepared)
      await this.logger.write('updater', `Selected DSH ${prepared.version}; validating service health`)
      if (await this.orchestrator.restart()) return { version: prepared.version, rolledBack: false }
      if (!previous) throw new Error(`DSH ${prepared.version} failed health validation and no rollback exists`)
      await this.packages.restorePrevious()
      const recovered = await this.orchestrator.restart()
      await this.logger.write('updater', `DSH ${prepared.version} failed; rollback ${recovered ? 'succeeded' : 'failed'}`)
      if (!recovered) throw new Error(`DSH ${prepared.version} and rollback ${previous.version} both failed`)
      return { version: previous.version, rolledBack: true }
    })
  }

  /** Combined convenience flow: prepare (background-safe) then apply. */
  public async install(version: string): Promise<DshUpdateResult> {
    const prepared = await this.prepare(version)
    return await this.apply(prepared)
  }

  public async rollback(): Promise<DshUpdateResult> {
    return await this.lock.run('dsh-rollback', async () => {
      const restored = await this.packages.restorePrevious()
      if (!(await this.orchestrator.restart())) throw new Error(`Rollback ${restored.version} failed health validation`)
      await this.logger.write('updater', `Manual DSH rollback succeeded: ${restored.version}`)
      return { version: restored.version, rolledBack: true }
    })
  }
}