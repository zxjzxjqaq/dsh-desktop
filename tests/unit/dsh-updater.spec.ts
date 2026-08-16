import { describe, expect, it } from 'vitest'
import { DshUpdater, type DshUpdateStore } from '../../src/main/dsh-updater.js'
import type { DshSelection } from '../../src/main/dsh-package-manager.js'
import type { NodeEnvironment } from '../../src/main/node-environment.js'
import type { ProcessRunner } from '../../src/main/platform/process-runner.js'
import { UpdateLock } from '../../src/main/update-lock.js'

const oldSelection: DshSelection = {
  version: '0.1.0-rc.5',
  directory: 'C:\\dsh\\0.1.0-rc.5',
  installedAt: '2026-08-01T00:00:00.000Z'
}
const newSelection: DshSelection = {
  version: '0.1.0-rc.6',
  directory: 'C:\\dsh\\0.1.0-rc.6',
  installedAt: '2026-08-14T00:00:00.000Z'
}
const environment: NodeEnvironment = {
  ok: true,
  source: 'system',
  nodePath: 'C:\\Node\\node.exe',
  npmPath: 'C:\\Node\\npm.cmd',
  npmCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
  nodeVersion: '24.15.0',
  npmVersion: '11.12.1'
}

function createStore(): DshUpdateStore & { selected: DshSelection[]; restored: number } {
  return {
    selected: [],
    restored: 0,
    async current() {
      return oldSelection
    },
    async install() {
      return { selection: newSelection, binaryPath: 'C:\\dsh\\bin.js' }
    },
    async select(selection) {
      this.selected.push(selection)
    },
    async restorePrevious() {
      this.restored += 1
      return oldSelection
    }
  }
}

const runner: ProcessRunner = async () => ({
  exitCode: 0,
  stdout: JSON.stringify({ latest: '0.1.0-rc.6' }),
  stderr: '',
  timedOut: false
})
const detector = async (): Promise<NodeEnvironment> => environment
const logger = { async write(): Promise<void> {} }

describe('DSH updater', () => {
  it('reports the latest registry release', async () => {
    const updater = new DshUpdater(
      createStore(),
      { async restart() { return true } },
      new UpdateLock(),
      logger,
      runner,
      detector
    )
    await expect(updater.check()).resolves.toEqual({
      currentVersion: '0.1.0-rc.5',
      latestVersion: '0.1.0-rc.6',
      updateAvailable: true
    })
  })

  it('keeps a healthy new release', async () => {
    const store = createStore()
    const updater = new DshUpdater(
      store,
      { async restart() { return true } },
      new UpdateLock(),
      logger,
      runner,
      detector
    )
    await expect(updater.install('0.1.0-rc.6')).resolves.toEqual({
      version: '0.1.0-rc.6',
      rolledBack: false
    })
    expect(store.selected).toEqual([newSelection])
    expect(store.restored).toBe(0)
  })

  it('restores the previous release after failed health validation', async () => {
    const store = createStore()
    const restarts = [false, true]
    const updater = new DshUpdater(
      store,
      { async restart() { return restarts.shift() ?? false } },
      new UpdateLock(),
      logger,
      runner,
      detector
    )
    await expect(updater.install('0.1.0-rc.6')).resolves.toEqual({
      version: '0.1.0-rc.5',
      rolledBack: true
    })
    expect(store.restored).toBe(1)
  })
})
