import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BUNDLED_NODE_VERSION, RUNTIME_ARCHIVE_SCHEMA } from '../src/shared/config.js'

interface ArchivesManifest {
  readonly schema: number
  readonly version: string
  readonly archives: {
    readonly node?: { readonly name: string; readonly sha256: string; readonly entries?: number }
    readonly dsh?: { readonly name: string; readonly sha256: string; readonly entries?: number }
  }
}

const nodeVersion = BUNDLED_NODE_VERSION
const base = `https://nodejs.org/dist/v${nodeVersion}`
const zipName = `node-v${nodeVersion}-win-x64.zip`
const extractRoot = resolve('.artifacts', 'node-runtime')
const extractedDirectory = resolve(extractRoot, `node-v${nodeVersion}-win-x64`)
const archivesRoot = resolve('.artifacts', 'archives')
const manifestPath = join(archivesRoot, 'runtime-manifest.json')

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function fileCount(directory: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    count += entry.isDirectory() ? await fileCount(path) : 1
  }
  return count
}

async function readManifest(): Promise<ArchivesManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as ArchivesManifest
  } catch {
    return null
  }
}

async function writeManifest(next: ArchivesManifest): Promise<void> {
  const previous = (await readManifest()) ?? { schema: RUNTIME_ARCHIVE_SCHEMA, version: nodeVersion, archives: {} }
  const merged: ArchivesManifest = {
    schema: RUNTIME_ARCHIVE_SCHEMA,
    version: nodeVersion,
    archives: { ...previous.archives, ...next.archives }
  }
  await mkdir(archivesRoot, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}

const archiveName = `node-runtime-${nodeVersion}.tar.gz`
const archivePath = join(archivesRoot, archiveName)

async function isPrepared(): Promise<boolean> {
  const manifest = await readManifest()
  if (manifest?.archives.node?.name !== archiveName) return false
  if (!(await exists(archivePath))) return false
  return (await sha256(archivePath)) === manifest.archives.node.sha256
}

if (!(await isPrepared())) {
  await mkdir(extractRoot, { recursive: true })
  const zipPath = join(extractRoot, zipName)

  const [zipResponse, sumsResponse] = await Promise.all([
    fetch(`${base}/${zipName}`),
    fetch(`${base}/SHASUMS256.txt`)
  ])
  if (!zipResponse.ok || !sumsResponse.ok) {
    throw new Error(`Failed to download Node.js v${nodeVersion} from ${base}`)
  }
  const sums = await sumsResponse.text()
  const expected = sums
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${zipName}`) || line.endsWith(` *${zipName}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`SHA256 for ${zipName} not found in SHASUMS256.txt`)

  await writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()))
  const actual = await sha256(zipPath)
  if (actual !== expected) {
    await rm(zipPath, { force: true })
    throw new Error(`Node.js zip checksum mismatch: expected ${expected}, got ${actual}`)
  }

  await rm(extractedDirectory, { recursive: true, force: true })
  execFileSync('tar', ['-xf', zipPath, '-C', extractRoot], { stdio: 'pipe' })
  await rm(zipPath, { force: true })
  await mkdir(archivesRoot, { recursive: true })
  execFileSync('tar', ['-czf', archivePath, '-C', extractRoot, `node-v${nodeVersion}-win-x64`], {
    stdio: 'pipe'
  })
  await writeManifest({
    schema: RUNTIME_ARCHIVE_SCHEMA,
    version: nodeVersion,
    archives: {
      node: {
        name: archiveName,
        sha256: await sha256(archivePath),
        entries: await fileCount(extractedDirectory)
      }
    }
  })
}

const manifest = await readManifest()
process.stdout.write(
  `${JSON.stringify({
    archive: archivePath,
    version: nodeVersion,
    sha256: manifest?.archives.node?.sha256 ?? null
  }, null, 2)}\n`
)
