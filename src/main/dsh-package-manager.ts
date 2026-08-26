import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import semver from 'semver'
import type { AppPaths } from './platform/app-paths.js'
import { versionDirectory } from './platform/app-paths.js'
import { readJson, writeJsonAtomic } from './platform/atomic-json.js'
import { runProcess, type ProcessRunner } from './platform/process-runner.js'
import type { RuntimeExtractor } from './runtime-extractor.js'
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

export interface InstalledVersion {
  readonly version: string
  readonly directory: string
  readonly sizeBytes: number
  readonly selected: boolean
  readonly installedAt?: string
  readonly lastHealthyAt?: string
}

export interface PrunedVersion {
  readonly version: string
  readonly directory: string
}

export interface DshInstallOptions {
  readonly registryUrl?: string | null
  readonly proxyUrl?: string | null
  readonly httpsProxyUrl?: string | null
}

interface DshManifest {
  readonly name?: string
  readonly version?: string
  readonly bin?: string | Readonly<Record<string, string>>
}

export interface DshPackageManagerOptions {
  readonly runner?: ProcessRunner
  readonly extractor?: RuntimeExtractor | null
}

const HISTORY_CAP = 8

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
  private readonly extractor: RuntimeExtractor | null

  public constructor(
    private readonly paths: AppPaths,
    options: DshPackageManagerOptions = {}
  ) {
    this.runner = options.runner ?? runProcess
    this.extractor = options.extractor ?? null
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
    if (resolvedDirectory !== managedDirectory) {
      throw new Error('DSH selection is outside a trusted version store')
    }
    return await this.validateAt(resolvedDirectory, expectedVersion)
  }

  public async restoreBundled(version: string): Promise<DshInstall | null> {
    if (!this.extractor) return null
    const directory = await this.extractor.dshRuntimeDirectory()
    if (!directory) return null
    return await this.validate(directory, version)
  }

  public async install(
    environment: Pick<ValidNodeEnvironment, 'nodePath' | 'npmCliPath'>,
    version: string,
    options: DshInstallOptions = {}
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
    const args = [
      environment.npmCliPath,
      'install',
      '--prefix',
      stagingDirectory,
      '--legacy-peer-deps',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--save-exact'
    ]
    if (options.registryUrl) args.push(`--registry=${options.registryUrl}`)
    if (options.proxyUrl) args.push(`--proxy=${options.proxyUrl}`)
    if (options.httpsProxyUrl) args.push(`--https-proxy=${options.httpsProxyUrl}`)
    args.push(`@deepseek-ai/dsh@${version}`)
    const result = await this.runner(
      environment.nodePath,
      args,
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
          await this.recordHistory(healthyCurrent.selection)
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
    const current = await this.current()
    if (current && current.directory !== validated.selection.directory) {
      try {
        const install = await this.validate(current.directory, current.version)
        await this.recordHistory(install.selection)
      } catch {
        // Invalid current pointers are not carried into history.
      }
    }
    await writeJsonAtomic(this.paths.currentPointer, validated.selection)
    return validated.selection
  }

  /** Rollback chain (most recent first) for previously selected releases. */
  public async history(): Promise<DshSelection[]> {
    return await this.readHistory()
  }

  private async readHistory(): Promise<DshSelection[]> {
    try {
      const entries = await readJson<unknown>(this.paths.historyPointer)
      if (!Array.isArray(entries)) return []
      const validated: DshSelection[] = []
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue
        const candidate = entry as Partial<DshSelection>
        if (
          typeof candidate.version !== 'string' ||
          typeof candidate.directory !== 'string' ||
          typeof candidate.installedAt !== 'string'
        ) continue
        try {
          const install = await this.validate(candidate.directory, candidate.version)
          validated.push({
            ...install.selection,
            ...(candidate.lastHealthyAt ? { lastHealthyAt: candidate.lastHealthyAt } : {})
          })
        } catch {
          // Broken history entries are dropped on the next write.
        }
      }
      return validated
    } catch {
      return []
    }
  }

  private async writeHistory(entries: DshSelection[]): Promise<void> {
    await writeJsonAtomic(this.paths.historyPointer, entries.slice(0, HISTORY_CAP))
  }

  private async recordHistory(selection: DshSelection): Promise<void> {
    const entries = await this.readHistory()
    const filtered = entries.filter((entry) => entry.directory !== selection.directory)
    await this.writeHistory([selection, ...filtered])
  }

  /** Enumerate every managed DSH release directory with its on-disk size. */
  public async installedVersions(): Promise<InstalledVersion[]> {
    const current = await this.current()
    const previous = await this.previous()
    const history = await this.readHistory()
    const knownByDirectory = new Map<string, DshSelection>()
    for (const entry of history) knownByDirectory.set(entry.directory, entry)
    if (current) knownByDirectory.set(current.directory, current)
    if (previous) knownByDirectory.set(previous.directory, previous)
    const entries = await readdir(this.paths.versions, { withFileTypes: true })
    const versions: InstalledVersion[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (semver.valid(entry.name) !== entry.name) continue
      const directory = resolve(this.paths.versions, entry.name)
      const known = knownByDirectory.get(directory)
      versions.push({
        version: entry.name,
        directory,
        sizeBytes: await directorySize(directory),
        selected: current?.directory === directory,
        installedAt: known?.installedAt,
        lastHealthyAt: known?.lastHealthyAt
      })
    }
    return versions
  }

  /**
   * Remove the oldest managed DSH releases so that only `keep` recent versions
   * remain. The currently selected release, the rollback target and the
   * bundled runtime are never removed.
   */
  public async pruneVersions(keep: number): Promise<PrunedVersion[]> {
    const safeKeep = Math.max(2, Math.floor(keep))
    const current = await this.current()
    const previous = await this.previous()
    const protectedDirectories = new Set<string>()
    if (current) protectedDirectories.add(current.directory)
    if (previous) protectedDirectories.add(previous.directory)
    if (this.extractor) {
      const bundledDirectory = await this.extractor.dshRuntimeDirectory().catch(() => null)
      if (bundledDirectory) protectedDirectories.add(bundledDirectory)
    }

    const versions = await this.installedVersions()
    const knownTime = (version: InstalledVersion): string =>
      version.installedAt ?? '9999-12-31T23:59:59.999Z' // unknown install date counts as newest
    const removable = versions
      .filter((version) => !protectedDirectories.has(version.directory))
      .sort((a, b) => {
        const byTime = knownTime(a).localeCompare(knownTime(b))
        return byTime !== 0 ? byTime : a.directory.localeCompare(b.directory)
      })

    const excess = Math.max(0, removable.length - Math.max(0, safeKeep - protectedDirectories.size))
    const victims = removable.slice(0, excess)
    const removed: PrunedVersion[] = []
    for (const victim of victims) {
      await rm(victim.directory, { recursive: true, force: true })
      removed.push({ version: victim.version, directory: victim.directory })
    }
    if (removed.length > 0) {
      const history = await this.readHistory()
      const victimsSet = new Set(removed.map((victim) => victim.directory))
      await this.writeHistory(history.filter((entry) => !victimsSet.has(entry.directory)))
    }
    return removed
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path)
    } else {
      try {
        total += (await stat(path)).size
      } catch {
        // Race with concurrent cleanup: skip unreadable entries.
      }
    }
  }
  return total
}
