import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { INITIAL_DSH_VERSION } from '../src/shared/config.js'
import { detectNodeEnvironment } from '../src/main/node-environment.js'
import { runProcess } from '../src/main/platform/process-runner.js'

interface DshManifest {
  readonly name?: string
  readonly version?: string
  readonly bin?: string | Readonly<Record<string, string>>
}

const artifactsRoot = resolve('.artifacts')
const runtimeRoot = resolve(artifactsRoot, 'bundled-dsh')
const target = resolve(runtimeRoot, INITIAL_DSH_VERSION)
if (!target.startsWith(`${runtimeRoot}${sep}`)) throw new Error('Bundled DSH target escaped artifact root')

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

async function fileCount(directory: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'runtime-manifest.json') continue
    const path = join(directory, entry.name)
    count += entry.isDirectory() ? await fileCount(path) : 1
  }
  return count
}

async function inspectRuntime(): Promise<{
  readonly packageJsonSha256: string
  readonly binarySha256: string
  readonly binary: string
  readonly files: number
}> {
  const packageRoot = join(target, 'node_modules', '@deepseek-ai', 'dsh')
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageJson = await readFile(packageJsonPath)
  const manifest = JSON.parse(packageJson.toString('utf8')) as DshManifest
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== INITIAL_DSH_VERSION) {
    throw new Error('Bundled DSH package identity does not match the pinned release')
  }
  const relativeBinary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (!relativeBinary) throw new Error('Bundled DSH package does not declare its CLI binary')
  const binaryPath = resolve(packageRoot, relativeBinary)
  if (!binaryPath.startsWith(`${resolve(packageRoot)}${sep}`)) throw new Error('Bundled DSH binary escaped package root')
  const binary = await readFile(binaryPath)
  return {
    packageJsonSha256: sha256(packageJson),
    binarySha256: sha256(binary),
    binary: relative(target, binaryPath).replaceAll('\\', '/'),
    files: await fileCount(target)
  }
}

async function isPrepared(): Promise<boolean> {
  try {
    const descriptor = JSON.parse(await readFile(join(target, 'runtime-manifest.json'), 'utf8')) as {
      readonly version?: string
      readonly packageJsonSha256?: string
      readonly binarySha256?: string
    }
    const inspected = await inspectRuntime()
    return descriptor.version === INITIAL_DSH_VERSION &&
      descriptor.packageJsonSha256 === inspected.packageJsonSha256 &&
      descriptor.binarySha256 === inspected.binarySha256
  } catch {
    return false
  }
}

if (!(await isPrepared())) {
  if (await stat(target).then(() => true, () => false)) await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  const environment = await detectNodeEnvironment()
  if (!environment.ok) throw new Error(environment.detail)
  const result = await runProcess(
    environment.nodePath,
    [
      environment.npmCliPath,
      'install',
      '--prefix',
      target,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--save-exact',
      `@deepseek-ai/dsh@${INITIAL_DSH_VERSION}`
    ],
    { timeoutMs: 15 * 60_000 }
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `npm exited with ${String(result.exitCode)}`)
}

const inspected = await inspectRuntime()
await writeFile(
  join(target, 'runtime-manifest.json'),
  `${JSON.stringify({
    schema: 1,
    version: INITIAL_DSH_VERSION,
    packageJsonSha256: inspected.packageJsonSha256,
    binarySha256: inspected.binarySha256,
    binary: inspected.binary,
    files: inspected.files
  }, null, 2)}\n`,
  'utf8'
)
process.stdout.write(`${JSON.stringify({ target, version: INITIAL_DSH_VERSION, ...inspected }, null, 2)}\n`)
