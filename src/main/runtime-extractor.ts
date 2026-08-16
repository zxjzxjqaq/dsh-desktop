import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RUNTIME_ARCHIVE_SCHEMA } from '../shared/config.js'
import type { AppPaths } from './platform/app-paths.js'
import { readJson, writeJsonAtomic } from './platform/atomic-json.js'
import { extractTarGz } from './platform/tar-extract.js'

export interface BundledArchivesManifest {
  readonly schema: number
  readonly version: string
  readonly archives: {
    readonly node: { readonly name: string; readonly sha256: string }
    readonly dsh: { readonly name: string; readonly sha256: string }
  }
}

export interface ExtractedRuntimeManifest {
  readonly schema: number
  readonly version: string
  readonly archiveSha256: string
  readonly extractedAt: string
}

export interface RuntimeExtractorOptions {
  readonly resourcesDirectory: string
  readonly logger?: { write(channel: 'desktop', message: string): Promise<void> }
  readonly extractor?: typeof extractTarGz
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

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export class RuntimeExtractor {
  private readonly extractor: typeof extractTarGz
  private cachedManifest: BundledArchivesManifest | null | undefined

  public constructor(
    private readonly paths: AppPaths,
    private readonly options: RuntimeExtractorOptions
  ) {
    this.extractor = options.extractor ?? extractTarGz
  }

  public async archivesManifest(): Promise<BundledArchivesManifest | null> {
    if (this.cachedManifest !== undefined) return this.cachedManifest
    const value = await readJson<BundledArchivesManifest>(
      join(this.options.resourcesDirectory, 'runtime-manifest.json')
    )
    this.cachedManifest = value !== null && value.schema === RUNTIME_ARCHIVE_SCHEMA ? value : null
    return this.cachedManifest
  }

  public async nodeRuntimeDirectory(): Promise<string | null> {
    return await this.runtimeDirectory('node')
  }

  public async dshRuntimeDirectory(): Promise<string | null> {
    return await this.runtimeDirectory('dsh')
  }

  private async runtimeDirectory(kind: 'node' | 'dsh'): Promise<string | null> {
    const manifest = await this.archivesManifest()
    if (!manifest) return null
    const target =
      kind === 'node'
        ? join(this.paths.nodeRuntimes, manifest.version)
        : join(this.paths.versions, manifest.version)
    const keyFile = kind === 'node' ? 'node.exe' : 'node_modules/@deepseek-ai/dsh/package.json'
    if (await this.isValidExtraction(target, manifest.version, manifest.archives[kind].sha256, keyFile)) {
      return target
    }
    const archive = join(this.options.resourcesDirectory, manifest.archives[kind].name)
    if (!(await exists(archive))) return null
    await this.extractArchive(archive, target, manifest.version, manifest.archives[kind].sha256)
    return target
  }

  private async isValidExtraction(
    target: string,
    version: string,
    archiveSha256: string,
    keyFile: string
  ): Promise<boolean> {
    const recorded = await readJson<ExtractedRuntimeManifest>(join(target, 'runtime-manifest.json'))
    if (!recorded || recorded.schema !== RUNTIME_ARCHIVE_SCHEMA || recorded.version !== version) return false
    if (recorded.archiveSha256 !== archiveSha256) return false
    return await exists(join(target, keyFile))
  }

  private async extractArchive(
    archive: string,
    target: string,
    version: string,
    expectedSha256: string
  ): Promise<void> {
    const actualSha256 = await sha256File(archive)
    if (actualSha256 !== expectedSha256) throw new Error(`Bundled runtime archive checksum mismatch: ${archive}`)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    const entries = await this.extractor(archive, target, { stripComponents: 1 })
    await writeJsonAtomic(join(target, 'runtime-manifest.json'), {
      schema: RUNTIME_ARCHIVE_SCHEMA,
      version,
      archiveSha256: actualSha256,
      extractedAt: new Date().toISOString()
    } satisfies ExtractedRuntimeManifest)
    await this.options.logger?.write('desktop', `Extracted bundled runtime ${version} (${entries} entries)`)
  }
}
