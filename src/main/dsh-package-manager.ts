import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import semver from 'semver'
import type { AppPaths } from './platform/app-paths.js'
import { versionDirectory } from './platform/app-paths.js'
import { readJson, writeJsonAtomic } from './platform/atomic-json.js'
import { runProcess, type ProcessRunner } from './platform/process-runner.js'

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
  public constructor(
    private readonly paths: AppPaths,
    private readonly runner: ProcessRunner = runProcess
  ) {}

  public async current(): Promise<DshSelection | null> {
    return await readJson<DshSelection>(this.paths.currentPointer)
  }

  public async previous(): Promise<DshSelection | null> {
    return await readJson<DshSelection>(this.paths.previousPointer)
  }

  public async validate(directory: string, expectedVersion: string): Promise<DshInstall> {
    if (semver.valid(expectedVersion) !== expectedVersion) {
      throw new Error(`Invalid DSH version: ${expectedVersion}`)
    }
    const packageRoot = resolve(directory, 'node_modules', '@deepseek-ai', 'dsh')
    const manifestPath = join(packageRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DshManifest
    if (manifest.name !== '@deepseek-ai/dsh') throw new Error('Installed package name is not @deepseek-ai/dsh')
    if (manifest.version !== expectedVersion) throw new Error('Installed DSH version does not match request')
    const relativeBinary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (!relativeBinary) throw new Error('Installed DSH package has no dsh binary')
    const binaryPath = resolve(packageRoot, relativeBinary)
    if (!binaryPath.startsWith(`${packageRoot}\\`)) throw new Error('DSH binary escaped package root')
    if (!(await exists(binaryPath))) throw new Error('Installed DSH binary does not exist')
    return {
      selection: {
        version: expectedVersion,
        directory: resolve(directory),
        installedAt: new Date().toISOString()
      },
      binaryPath
    }
  }

  public async install(npmPath: string, version: string): Promise<DshInstall> {
    const finalDirectory = versionDirectory(this.paths, version)
    if (await exists(finalDirectory)) return await this.validate(finalDirectory, version)

    await mkdir(this.paths.staging, { recursive: true })
    const stagingDirectory = join(this.paths.staging, `${version}-${randomUUID()}`)
    await mkdir(stagingDirectory, { recursive: true })
    const result = await this.runner(
      npmPath,
      [
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

    await this.validate(stagingDirectory, version)
    await mkdir(dirname(finalDirectory), { recursive: true })
    await rename(stagingDirectory, finalDirectory)
    return await this.validate(finalDirectory, version)
  }

  public async select(selection: DshSelection): Promise<void> {
    const validated = await this.validate(selection.directory, selection.version)
    const current = await this.current()
    if (current) await writeJsonAtomic(this.paths.previousPointer, current)
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
