import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installDshRuntime, missingPeers } from '../../src/main/dsh-runtime-installer.js'
import type { ProcessRunner, ProcessResult } from '../../src/main/platform/process-runner.js'

const roots: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-installer-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

const okResult: ProcessResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }
const environment = { nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }

describe('missingPeers', () => {
  it('collects peer dependencies that are not installed and ignores satisfied ones', async () => {
    const workspace = await root()
    const nodeModules = join(workspace, 'node_modules')
    await mkdir(join(nodeModules, '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    await mkdir(join(nodeModules, '@deepseek-ai', 'dsh-invariants'), { recursive: true })
    await writeFile(
      join(nodeModules, '@deepseek-ai', 'dsh-app-boot', 'package.json'),
      JSON.stringify({
        peerDependencies: {
          '@deepseek-ai/cordis-plugin-group': '^1.0.1',
          '@deepseek-ai/dsh-invariants': '^0.1.0-rc.6'
        }
      })
    )
    await writeFile(join(nodeModules, '@deepseek-ai', 'dsh-invariants', 'package.json'), JSON.stringify({}))

    await expect(missingPeers(nodeModules)).resolves.toEqual([
      { name: '@deepseek-ai/cordis-plugin-group', range: '^1.0.1' }
    ])
  })

  it('returns an empty list for a tree without peers', async () => {
    const workspace = await root()
    const nodeModules = join(workspace, 'node_modules')
    await mkdir(join(nodeModules, '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(nodeModules, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({}))

    await expect(missingPeers(nodeModules)).resolves.toEqual([])
  })
})

describe('installDshRuntime', () => {
  it('installs the release and then repairs missing peers', async () => {
    const workspace = await root()
    const prefix = join(workspace, 'prefix')
    await mkdir(prefix, { recursive: true })
    const nodeModules = join(prefix, 'node_modules')
    await mkdir(join(nodeModules, '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    await writeFile(
      join(nodeModules, '@deepseek-ai', 'dsh-app-boot', 'package.json'),
      JSON.stringify({ peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^1.0.1' } })
    )

    const calls: Array<{ executable: string; args: string[] }> = []
    const runner: ProcessRunner = async (executable, args) => {
      calls.push({ executable, args: [...args] })
      if (args.includes('--no-save')) {
        // Simulate the peer actually becoming installed so the post-check passes.
        await mkdir(join(nodeModules, '@deepseek-ai', 'cordis-plugin-group'), { recursive: true })
        await writeFile(
          join(nodeModules, '@deepseek-ai', 'cordis-plugin-group', 'package.json'),
          JSON.stringify({})
        )
      }
      return okResult
    }

    const result = await installDshRuntime(environment, prefix, '0.1.0-rc.6', {
      runner,
      registryUrl: 'https://registry.npmmirror.com'
    })

    expect(result.installedPeers).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toContain('--legacy-peer-deps')
    expect(calls[0]?.args).toContain('--registry=https://registry.npmmirror.com')
    expect(calls[0]?.args).toContain('@deepseek-ai/dsh@0.1.0-rc.6')
    expect(calls[1]?.args).toContain('--no-save')
    expect(calls[1]?.args).toContain('@deepseek-ai/cordis-plugin-group@^1.0.1')
  })

  it('skips the peer repair when nothing is missing', async () => {
    const workspace = await root()
    const prefix = join(workspace, 'prefix')
    await mkdir(prefix, { recursive: true })
    await mkdir(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({}))

    const calls: string[][] = []
    const runner: ProcessRunner = async (_executable, args) => {
      calls.push([...args])
      return okResult
    }

    await installDshRuntime(environment, prefix, '0.1.0-rc.6', { runner })
    expect(calls).toHaveLength(1)
  })

  it('throws when the main npm install fails', async () => {
    const workspace = await root()
    const prefix = join(workspace, 'prefix')
    await mkdir(prefix, { recursive: true })
    const runner: ProcessRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ECONNREFUSED registry unreachable',
      timedOut: false
    })

    await expect(installDshRuntime(environment, prefix, '0.1.0-rc.6', { runner })).rejects.toThrow(
      'ECONNREFUSED registry unreachable'
    )
  })
})