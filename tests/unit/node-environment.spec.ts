import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectNodeEnvironment } from '../../src/main/node-environment.js'
import type { ProcessRunner } from '../../src/main/platform/process-runner.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (d) => await rm(d, { recursive: true, force: true })))
})

async function bundledNodeFixture(options: { npmManifest?: boolean } = {}): Promise<string> {
  const { npmManifest = true } = options
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-'))
  roots.push(directory)
  await mkdir(join(directory, 'node_modules', 'npm', 'bin'), { recursive: true })
  await writeFile(join(directory, 'node.exe'), 'node')
  await writeFile(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm')
  if (npmManifest) {
    await writeFile(
      join(directory, 'node_modules', 'npm', 'package.json'),
      JSON.stringify({ name: 'npm', version: '11.14.1' })
    )
  }
  return directory
}

function fakeRunner(outputs: Readonly<Record<string, { code: number; stdout?: string }>>): ProcessRunner {
  return async (executable, args) => {
    const key = `${executable} ${args.join(' ')}`
    const output =
      outputs[key] ??
      (executable.toLowerCase().endsWith('node.exe') && args[0] === '--version'
        ? { code: 0, stdout: 'v24.15.0\n' }
        : executable.toLowerCase().endsWith('node.exe') && args.some((a) => a.endsWith('npm-cli.js'))
          ? { code: 0, stdout: '11.14.1\n' }
          : undefined)
    return {
      exitCode: output?.code ?? 1,
      stdout: output?.stdout ?? '',
      stderr: '',
      timedOut: false
    }
  }
}

describe('Node environment detection', () => {
  it('detects compatible node and npm executables', async () => {
    const runner = fakeRunner({
      'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'where.exe npm.cmd': { code: 0, stdout: 'C:\\Node\\npm.cmd\r\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })
    await expect(detectNodeEnvironment(runner)).resolves.toMatchObject({
      ok: true,
      nodeVersion: '24.15.0',
      npmVersion: '11.14.1'
    })
  })

  it('reports incompatible node', async () => {
    const runner = fakeRunner({
      'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v20.0.0\n' }
    })
    await expect(detectNodeEnvironment(runner)).resolves.toMatchObject({
      ok: false,
      reason: 'node-incompatible'
    })
  })

  it('prefers a valid bundled runtime over the system', async () => {
    const bundled = await bundledNodeFixture()
    // The bundled npm version must come from the shipped manifest, so any
    // npm-cli execution attempt should be impossible: fail any spawn that is
    // not the trivial `node.exe --version` probe.
    const runner: ProcessRunner = async (executable, args) => {
      if (executable.toLowerCase().endsWith('node.exe') && args[0] === '--version') {
        return { exitCode: 0, stdout: 'v24.15.0\n', stderr: '', timedOut: false }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected npm-cli spawn', timedOut: false }
    }
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'bundled',
      nodeVersion: '24.15.0',
      npmVersion: '11.14.1',
      nodePath: join(bundled, 'node.exe')
    })
  })

  it('probes npm-cli when a bundled npm manifest is missing', async () => {
    const bundled = await bundledNodeFixture({ npmManifest: false })
    const runner = fakeRunner({})
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'bundled',
      npmVersion: '11.14.1',
      npmCliPath: join(bundled, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    })
  })

  it('falls back to the system when the bundled runtime is broken', async () => {
    const bundled = await bundledNodeFixture()
    const runner = fakeRunner({
      'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'where.exe npm.cmd': { code: 0, stdout: 'C:\\Node\\npm.cmd\r\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })

    await rm(join(bundled, 'node.exe'))
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'system'
    })
  })
})
