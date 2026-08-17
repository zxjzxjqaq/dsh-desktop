import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshPackageManager } from '../../src/main/dsh-package-manager.js'
import { RuntimeExtractor } from '../../src/main/runtime-extractor.js'
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

async function createDsh(directory: string, v = version): Promise<void> {
  const packageRoot = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  const binaryPath = join(packageRoot, 'lib', 'bin.js')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  const packageJson = Buffer.from(JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: v,
    bin: { dsh: 'lib/bin.js' }
  }))
  const binary = Buffer.from('console.log("dsh")\n')
  await writeFile(join(packageRoot, 'package.json'), packageJson)
  await writeFile(binaryPath, binary)
}

const fakeNpmRunner: ProcessRunner = async (_executable, args) => {
  const prefixIndex = args.indexOf('--prefix')
  const staging = String(args[prefixIndex + 1])
  const spec = args.at(-1) ?? `@deepseek-ai/dsh@${version}`
  const requested = spec.startsWith('@') ? (spec.split('@').at(-1) ?? version) : version
  await createDsh(staging, requested)
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

describe('DSH package manager', () => {
  it('restores the bundled DSH runtime from its archive', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const source = resolve(workspace, 'runtime-source')
    await createDsh(source)
    const resources = resolve(workspace, 'resources')
    await mkdir(resources, { recursive: true })
    const archiveName = `dsh-runtime-${version}.tar.gz`
    const archivePath = join(resources, archiveName)
    execFileSync('tar', ['-czf', archivePath, '-C', source, '.'], { stdio: 'pipe' })
    await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify({
      schema: 1,
      version,
      archives: {
        node: { name: 'node-runtime.tar.gz', sha256: '0'.repeat(64) },
        dsh: { name: archiveName, sha256: sha256(await readFile(archivePath)) }
      }
    }))
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    const packages = new DshPackageManager(paths, { extractor })

    const install = await packages.restoreBundled(version)
    expect(install?.selection.directory).toBe(versionDirectory(paths, version))
    await packages.select(install!.selection)
    expect((await packages.current())?.directory).toBe(versionDirectory(paths, version))
  })

  it('returns null when no bundled archive exists', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { extractor: null })
    expect(await packages.restoreBundled(version)).toBeNull()
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

  it('passes registry and proxy flags to the npm install command', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const seenArgs: string[] = []
    const runner: ProcessRunner = async (_executable, args) => {
      seenArgs.push(...args)
      const prefixIndex = args.indexOf('--prefix')
      await createDsh(String(args[prefixIndex + 1]))
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    const packages = new DshPackageManager(paths, { runner })

    await packages.install(
      { nodePath: 'node.exe', npmCliPath: 'npm-cli.js' },
      version,
      { registryUrl: 'https://registry.npmmirror.com', proxyUrl: 'http://127.0.0.1:7890' }
    )
    expect(seenArgs).toContain('--registry=https://registry.npmmirror.com')
    expect(seenArgs).toContain('--proxy=http://127.0.0.1:7890')
  })

  it('records a rollback chain in history as selections change', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { runner: fakeNpmRunner })

    const v1 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.5')
    await packages.select(v1.selection)
    const v2 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.6')
    await packages.select(v2.selection)

    expect((await packages.previous())?.version).toBe('0.1.0-rc.5')
    const history = await packages.history()
    expect(history.map((entry) => entry.version)).toEqual(['0.1.0-rc.5'])
  })

  it('reports installed versions with sizes and selection state', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { runner: fakeNpmRunner })

    const v1 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.5')
    await packages.select(v1.selection)
    const v2 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.6')

    const versions = await packages.installedVersions()
    expect(versions).toHaveLength(2)
    const selected = versions.find((entry) => entry.selected)
    expect(selected?.version).toBe('0.1.0-rc.5')
    for (const entry of versions) {
      expect(entry.sizeBytes).toBeGreaterThan(0)
    }
  })

  it('prunes the oldest versions while always keeping current and previous', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { runner: fakeNpmRunner })

    const v1 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.4')
    const v2 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.5')
    await packages.select(v1.selection)
    await packages.select(v2.selection)
    const v3 = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.6')
    await packages.select(v3.selection)
    // v4 prepared but never selected: newest by install time, still removable at keep=3
    await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.7')

    // current=rc.6, previous=rc.5 are protected; keep=3 -> drop the oldest (rc.4)
    expect((await packages.previous())?.version).toBe('0.1.0-rc.5')
    const removed = await packages.pruneVersions(3)
    expect(removed.map((item) => item.version)).toEqual(['0.1.0-rc.4'])

    const remaining = await packages.installedVersions()
    expect(remaining.map((entry) => entry.version).sort()).toEqual([
      '0.1.0-rc.5',
      '0.1.0-rc.6',
      '0.1.0-rc.7'
    ])

    await expect(packages.pruneVersions(3)).resolves.toEqual([])
  })

  it('never removes the bundled runtime directory during pruning', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const source = resolve(workspace, 'runtime-source')
    await createDsh(source)
    const resources = resolve(workspace, 'resources')
    await mkdir(resources, { recursive: true })
    const archiveName = 'dsh-runtime.tar.gz'
    execFileSync('tar', ['-czf', join(resources, archiveName), '-C', source, '.'], { stdio: 'pipe' })
    await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify({
      schema: 1,
      version,
      archives: {
        node: { name: 'node-runtime.tar.gz', sha256: '0'.repeat(64) },
        dsh: { name: archiveName, sha256: sha256(await readFile(join(resources, archiveName))) }
      }
    }))
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    const packages = new DshPackageManager(paths, { extractor, runner: fakeNpmRunner })
    const bundled = await packages.restoreBundled(version)
    expect(bundled).not.toBeNull()
    const bundledDirectory = bundled!.selection.directory

    const older = await packages.install({ nodePath: 'node.exe', npmCliPath: 'npm-cli.js' }, '0.1.0-rc.4')
    await packages.select(older.selection)
    await packages.select(bundled!.selection)

    const removed = await packages.pruneVersions(3)
    expect(removed.some((item) => item.directory === bundledDirectory)).toBe(false)
    expect(await packages.restoreBundled(version)).not.toBeNull()
  })
})
