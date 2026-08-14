import semver from 'semver'
import type { DshInstall, DshSelection } from './dsh-package-manager.js'
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
    version: string
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
    private readonly detector: (runner: ProcessRunner) => Promise<NodeEnvironment> = detectNodeEnvironment
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

  public async install(version: string): Promise<DshUpdateResult> {
    return await this.lock.run('dsh-update', async () => {
      const environment = await this.environment()
      const previous = await this.packages.current()
      const install = await this.packages.install(environment, version)
      await this.packages.select(install.selection)
      await this.logger.write('updater', `Selected DSH ${version}; validating service health`)
      if (await this.orchestrator.restart()) return { version, rolledBack: false }
      if (!previous) throw new Error(`DSH ${version} failed health validation and no rollback exists`)
      await this.packages.restorePrevious()
      const recovered = await this.orchestrator.restart()
      await this.logger.write('updater', `DSH ${version} failed; rollback ${recovered ? 'succeeded' : 'failed'}`)
      if (!recovered) throw new Error(`DSH ${version} and rollback ${previous.version} both failed`)
      return { version: previous.version, rolledBack: true }
    })
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
