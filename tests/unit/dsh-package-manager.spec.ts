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

async function createDsh(directory: string): Promise<void> {
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
})
