import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshPackageManager } from '../../src/main/dsh-package-manager.js'
import { createAppPaths, versionDirectory } from '../../src/main/platform/app-paths.js'
import type { ProcessRunner } from '../../src/main/platform/process-runner.js'

const roots: string[] = []
const version = '0.1.0-rc.6'

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-packages-'))
  roots.push(directory)
  return directory
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

async function createDsh(directory: string, bundled = false): Promise<void> {
  const packageRoot = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  const binaryPath = join(packageRoot, 'lib', 'bin.js')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  const packageJson = Buffer.from(JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    bin: { dsh: 'lib/bin.js' }
  }))
  const binary = Buffer.from('console.log("dsh")\n')
  await writeFile(join(packageRoot, 'package.json'), packageJson)
  await writeFile(binaryPath, binary)
  if (bundled) {
    await writeFile(join(directory, 'runtime-manifest.json'), JSON.stringify({
      schema: 1,
      version,
      packageJsonSha256: sha256(packageJson),
      binarySha256: sha256(binary),
      binary: 'node_modules/@deepseek-ai/dsh/lib/bin.js'
    }))
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

describe('DSH package manager', () => {
  it('validates and selects the complete bundled runtime', async () => {
    const workspace = await root()
    const bundled = resolve(workspace, 'resources', 'dsh-runtime', version)
    await createDsh(bundled, true)
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { bundledDirectory: bundled })

    const install = await packages.bundled(version)
    expect(install?.selection.directory).toBe(bundled)
    await packages.select(install!.selection)
    expect((await packages.current())?.directory).toBe(bundled)
  })

  it('rejects a bundled runtime whose binary checksum changed', async () => {
    const workspace = await root()
    const bundled = resolve(workspace, 'resources', 'dsh-runtime', version)
    await createDsh(bundled, true)
    await writeFile(join(bundled, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'tampered')
    const packages = new DshPackageManager(createAppPaths(join(workspace, 'user-data')), {
      bundledDirectory: bundled
    })

    await expect(packages.bundled(version)).rejects.toThrow('binary checksum')
  })

  it('validates a staged npm install before moving it into the managed store', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const runner: ProcessRunner = async (_executable, args) => {
      const prefixIndex = args.indexOf('--prefix')
      const staging = String(args[prefixIndex + 1])
      await createDsh(staging)
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    const packages = new DshPackageManager(paths, { runner })

    const install = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, version)
    expect(install.selection.directory).toBe(versionDirectory(paths, version))
    expect(JSON.parse(await readFile(join(install.selection.directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))).toMatchObject({ version })
  })
})
