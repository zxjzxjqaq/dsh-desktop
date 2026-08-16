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

async function bundledNodeFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-'))
  roots.push(directory)
  await mkdir(join(directory, 'node_modules', 'npm', 'bin'), { recursive: true })
  await writeFile(join(directory, 'node.exe'), 'node')
  await writeFile(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm')
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
    const runner = fakeRunner({
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'bundled',
      nodeVersion: '24.15.0',
      nodePath: join(bundled, 'node.exe')
    })
  })

  it('falls back to the system when the bundled runtime is broken', async () => {
    const bundled = await bundledNodeFixture()
    await rm(join(bundled, 'node.exe'))
    const runner = fakeRunner({
      'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'where.exe npm.cmd': { code: 0, stdout: 'C:\\Node\\npm.cmd\r\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'system'
    })
  })
})
