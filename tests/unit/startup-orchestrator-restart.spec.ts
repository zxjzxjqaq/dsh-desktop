import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshPackageManager, type DshInstall } from '../../src/main/dsh-package-manager.js'
import type { ValidNodeEnvironment } from '../../src/main/node-environment.js'
import type { FileLogger } from '../../src/main/logging.js'
import { createAppPaths, versionDirectory, type AppPaths } from '../../src/main/platform/app-paths.js'
import { WindowController } from '../../src/main/window-controller.js'
import { StartupOrchestrator } from '../../src/main/startup-orchestrator.js'

/**
 * Regression tests for restart(): after the update pipeline rewrites
 * current.json (apply / rollback), restart() must adopt the NEWLY selected
 * release instead of silently relaunching the version cached at boot.
 */
describe('StartupOrchestrator.restart adopts the selected release', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
  })

  function seedPrivate(orchestrator: StartupOrchestrator, key: string, value: unknown): void {
    ;(orchestrator as unknown as Record<string, unknown>)[key] = value
  }

  function silentLogger(): FileLogger {
    return { write: async (): Promise<void> => undefined } as unknown as FileLogger
  }

  /** Materialize a valid managed DSH release the way restoreBundled/npm would. */
  async function writeDshStore(paths: AppPaths, version: string): Promise<string> {
    const directory = versionDirectory(paths, version)
    const packageRoot = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'bin/dsh.js' } })
    )
    await writeFile(join(packageRoot, 'bin', 'dsh.js'), '// dsh entrypoint')
    return directory
  }

  const environment: ValidNodeEnvironment = {
    ok: true,
    source: 'bundled',
    nodePath: 'C:\\Runtime\\node.exe',
    npmPath: '',
    npmCliPath: 'C:\\Runtime\\node_modules\\npm\\bin\\npm-cli.js',
    nodeVersion: '24.15.0',
    npmVersion: '11.12.1'
  }

  interface ServiceSpy {
    readonly startedBinaries: string[]
    stopCount: number
  }

  function spyService(orchestrator: StartupOrchestrator): ServiceSpy {
    const spy: ServiceSpy = { startedBinaries: [], stopCount: 0 }
    ;(orchestrator as unknown as Record<string, unknown>).createService = (
      _environment: unknown,
      install: DshInstall
    ) => ({
      start: async (): Promise<void> => {
        spy.startedBinaries.push(resolve(install.binaryPath))
      },
      stop: async (): Promise<void> => {
        spy.stopCount += 1
      }
    })
    return spy
  }

  it('starts the newly applied release instead of the one cached at boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const paths = createAppPaths(join(root, 'user-data'))
    const packages = new DshPackageManager(paths)

    const oldDirectory = await writeDshStore(paths, '0.1.0-rc.5')
    const oldInstall = await packages.validate(oldDirectory, '0.1.0-rc.5')
    await packages.select(oldInstall.selection)

    const orchestrator = new StartupOrchestrator(
      new WindowController('http://127.0.0.1:3080'),
      packages,
      silentLogger(),
      'http://127.0.0.1:3080',
      null,
      { restartAttemptDelayMs: 1, restartMaxAttempts: 2 }
    )
    seedPrivate(orchestrator, 'environment', environment)
    seedPrivate(orchestrator, 'install', oldInstall)
    const spy = spyService(orchestrator)

    // Emulate DshUpdater.apply(): stage a release into the managed store, flip
    // the selection pointer, then ask the orchestrator to restart.
    const stagedDirectory = await writeDshStore(paths, '0.1.0-rc.7')
    const prepared = await packages.validate(stagedDirectory, '0.1.0-rc.7')
    await packages.select(prepared.selection)

    expect(await orchestrator.restart()).toBe(true)
    expect(spy.startedBinaries).toHaveLength(1)
    expect(spy.startedBinaries[0]).toContain('0.1.0-rc.7')
    expect(orchestrator.versions.dsh).toBe('0.1.0-rc.7')

    // Emulate rollback via "restore previous": restart must run the restored
    // version too.
    await packages.restorePrevious()
    expect(await orchestrator.restart()).toBe(true)
    expect(spy.startedBinaries).toHaveLength(2)
    expect(spy.startedBinaries[1]).toContain('0.1.0-rc.5')
    expect(orchestrator.versions.dsh).toBe('0.1.0-rc.5')
  })

  it('stops the running service while restarting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const paths = createAppPaths(join(root, 'user-data'))
    const packages = new DshPackageManager(paths)
    const directory = await writeDshStore(paths, '0.1.0-rc.5')
    const install = await packages.validate(directory, '0.1.0-rc.5')
    await packages.select(install.selection)

    const orchestrator = new StartupOrchestrator(
      new WindowController('http://127.0.0.1:3080'),
      packages,
      silentLogger(),
      'http://127.0.0.1:3080',
      null,
      { restartAttemptDelayMs: 1 }
    )
    seedPrivate(orchestrator, 'environment', environment)
    seedPrivate(orchestrator, 'install', install)
    // Simulate a live session: one service instance is already running.
    const spy = spyService(orchestrator)
    const liveStopSpy = spy
    seedPrivate(orchestrator, 'service', {
      stop: async (): Promise<void> => {
        liveStopSpy.stopCount += 1
      }
    })
    await orchestrator.restart()
    expect(spy.stopCount).toBe(1)
    expect(spy.startedBinaries).toHaveLength(1)
  })

  it('refuses to restart before boot completed and never spawns a service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const paths = createAppPaths(join(root, 'user-data'))

    const orchestrator = new StartupOrchestrator(
      new WindowController('http://127.0.0.1:3080'),
      new DshPackageManager(paths),
      silentLogger(),
      'http://127.0.0.1:3080'
    )
    const spy = spyService(orchestrator)
    expect(await orchestrator.restart()).toBe(false)
    expect(spy.startedBinaries).toHaveLength(0)
  })
})
