import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import semver from 'semver'
import type { AppPaths } from './platform/app-paths.js'
import { versionDirectory } from './platform/app-paths.js'
import { readJson, writeJsonAtomic } from './platform/atomic-json.js'
import { runProcess, type ProcessRunner } from './platform/process-runner.js'
import type { ValidNodeEnvironment } from './node-environment.js'

export interface DshSelection {
  readonly version: string
  readonly directory: string
  readonly installedAt: string
  readonly lastHealthyAt?: string
}

export interface DshInstall {
  readonly selection: DshSelection
  readonly binaryPath: string
}

interface DshManifest {
  readonly name?: string
  readonly version?: string
  readonly bin?: string | Readonly<Record<string, string>>
}

interface BundledRuntimeManifest {
  readonly schema?: number
  readonly version?: string
  readonly packageJsonSha256?: string
  readonly binarySha256?: string
  readonly binary?: string
}

export interface DshPackageManagerOptions {
  readonly runner?: ProcessRunner
  readonly bundledDirectory?: string
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class DshPackageManager {
  private readonly runner: ProcessRunner
  private readonly bundledDirectory: string | null

  public constructor(
    private readonly paths: AppPaths,
    options: DshPackageManagerOptions = {}
  ) {
    this.runner = options.runner ?? runProcess
    this.bundledDirectory = options.bundledDirectory ? resolve(options.bundledDirectory) : null
  }

  public async current(): Promise<DshSelection | null> {
    return await readJson<DshSelection>(this.paths.currentPointer)
  }

  public async previous(): Promise<DshSelection | null> {
    return await readJson<DshSelection>(this.paths.previousPointer)
  }

  private async validateAt(directory: string, expectedVersion: string): Promise<DshInstall> {
    if (semver.valid(expectedVersion) !== expectedVersion) {
      throw new Error(`Invalid DSH version: ${expectedVersion}`)
    }
    const resolvedDirectory = resolve(directory)
    const packageRoot = resolve(resolvedDirectory, 'node_modules', '@deepseek-ai', 'dsh')
    const manifestPath = join(packageRoot, 'package.json')
    const manifestContent = await readFile(manifestPath)
    const manifest = JSON.parse(manifestContent.toString('utf8')) as DshManifest
    if (manifest.name !== '@deepseek-ai/dsh') throw new Error('Installed package name is not @deepseek-ai/dsh')
    if (manifest.version !== expectedVersion) throw new Error('Installed DSH version does not match request')
    const relativeBinary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (!relativeBinary) throw new Error('Installed DSH package has no dsh binary')
    const binaryPath = resolve(packageRoot, relativeBinary)
    if (!binaryPath.startsWith(`${packageRoot}${sep}`)) throw new Error('DSH binary escaped package root')
    if (!(await exists(binaryPath))) throw new Error('Installed DSH binary does not exist')

    if (this.bundledDirectory && resolvedDirectory === this.bundledDirectory) {
      const runtime = JSON.parse(
        await readFile(join(resolvedDirectory, 'runtime-manifest.json'), 'utf8')
      ) as BundledRuntimeManifest
      if (runtime.schema !== 1 || runtime.version !== expectedVersion) {
        throw new Error('Bundled DSH runtime manifest is invalid')
      }
      if (runtime.binary?.replaceAll('/', sep) !== binaryPath.slice(resolvedDirectory.length + 1)) {
        throw new Error('Bundled DSH runtime binary path does not match')
      }
      if (runtime.packageJsonSha256 !== sha256(manifestContent)) {
        throw new Error('Bundled DSH package manifest checksum does not match')
      }
      if (runtime.binarySha256 !== sha256(await readFile(binaryPath))) {
        throw new Error('Bundled DSH binary checksum does not match')
      }
    }

    return {
      selection: {
        version: expectedVersion,
        directory: resolvedDirectory,
        installedAt: new Date().toISOString()
      },
      binaryPath
    }
  }

  public async validate(directory: string, expectedVersion: string): Promise<DshInstall> {
    const resolvedDirectory = resolve(directory)
    const managedDirectory = versionDirectory(this.paths, expectedVersion)
    const isManaged = resolvedDirectory === managedDirectory
    const isBundled = this.bundledDirectory !== null && resolvedDirectory === this.bundledDirectory
    if (!isManaged && !isBundled) throw new Error('DSH selection is outside a trusted version store')
    return await this.validateAt(resolvedDirectory, expectedVersion)
  }

  public async bundled(expectedVersion: string): Promise<DshInstall | null> {
    if (!this.bundledDirectory) return null
    return await this.validate(this.bundledDirectory, expectedVersion)
  }

  public async install(
    environment: Pick<ValidNodeEnvironment, 'nodePath' | 'npmCliPath'>,
    version: string
  ): Promise<DshInstall> {
    const finalDirectory = versionDirectory(this.paths, version)
    if (await exists(finalDirectory)) {
      try {
        return await this.validate(finalDirectory, version)
      } catch {
        await rm(finalDirectory, { recursive: true, force: true })
      }
    }

    await mkdir(this.paths.staging, { recursive: true })
    const stagingDirectory = join(this.paths.staging, `${version}-${randomUUID()}`)
    await mkdir(stagingDirectory, { recursive: true })
    const result = await this.runner(
      environment.nodePath,
      [
        environment.npmCliPath,
        'install',
        '--prefix',
        stagingDirectory,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        `@deepseek-ai/dsh@${version}`
      ],
      { timeoutMs: 10 * 60_000 }
    )
    if (result.exitCode !== 0) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw new Error(result.stderr.trim() || `npm.cmd exited with ${String(result.exitCode)}`)
    }

    const resolvedStaging = resolve(stagingDirectory)
    if (!resolvedStaging.startsWith(`${resolve(this.paths.staging)}${sep}`)) {
      throw new Error('DSH staging directory escaped its root')
    }
    try {
      await this.validateAt(resolvedStaging, version)
      await mkdir(dirname(finalDirectory), { recursive: true })
      await rename(stagingDirectory, finalDirectory)
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw error
    }
    return await this.validate(finalDirectory, version)
  }

  public async select(selection: DshSelection): Promise<void> {
    const validated = await this.validate(selection.directory, selection.version)
    const current = await this.current()
    if (current) {
      try {
        const healthyCurrent = await this.validate(current.directory, current.version)
        if (healthyCurrent.selection.directory !== validated.selection.directory) {
          await writeJsonAtomic(this.paths.previousPointer, healthyCurrent.selection)
        }
      } catch {
        // Invalid pointers are replaced, not promoted to rollback state.
      }
    }
    await writeJsonAtomic(this.paths.currentPointer, validated.selection)
  }

  public async restorePrevious(): Promise<DshSelection> {
    const previous = await this.previous()
    if (!previous) throw new Error('No previous DSH release is available')
    const validated = await this.validate(previous.directory, previous.version)
    await writeJsonAtomic(this.paths.currentPointer, validated.selection)
    return validated.selection
  }
}
