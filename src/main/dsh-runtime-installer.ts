/**
 * Reliable npm install for the @deepseek-ai/dsh dependency closure.
 *
 * npm 11 hangs in its peer-dependency resolution phase (placeDep) on this
 * package family's large dependency graph (400+ packages), stalling with no
 * output until the outer timeout kills the process. `--legacy-peer-deps`
 * installs the tree quickly but skips peer dependencies, which breaks the
 * runtime (e.g. dsh-app-boot imports @deepseek-ai/cordis-plugin-group).
 *
 * The fix is two-staged:
 *   1. install the release with `--legacy-peer-deps` (fast, no hang);
 *   2. scan the installed tree's package.json files for peerDependencies
 *      that are missing and explicitly install those (peers install fine as
 *      direct arguments even in legacy mode).
 *
 * Used by the desktop updater (DshPackageManager.install) and the CI runtime
 * bundler (scripts/prepare-bundled-dsh.ts).
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ValidNodeEnvironment } from './node-environment.js'
import { runProcess, type ProcessRunner, type ProcessResult } from './platform/process-runner.js'

export interface DshRuntimeInstallOptions {
  readonly registryUrl?: string | null
  readonly proxyUrl?: string | null
  readonly httpsProxyUrl?: string | null
  readonly runner?: ProcessRunner
  readonly timeoutMs?: number
  readonly maxPeerFixRounds?: number
}

interface PeerRequest {
  readonly name: string
  readonly range: string
}

function baseArgs(npmCliPath: string, prefix: string, options: DshRuntimeInstallOptions): string[] {
  const args = [
    npmCliPath,
    'install',
    '--prefix',
    prefix,
    '--legacy-peer-deps',
    '--omit=dev',
    '--no-audit',
    '--no-fund'
  ]
  if (options.registryUrl) args.push(`--registry=${options.registryUrl}`)
  if (options.proxyUrl) args.push(`--proxy=${options.proxyUrl}`)
  if (options.httpsProxyUrl) args.push(`--https-proxy=${options.httpsProxyUrl}`)
  return args
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Collect peerDependencies declared by top-level (and scoped) packages that are not installed. */
export async function missingPeers(nodeModulesDir: string): Promise<PeerRequest[]> {
  const missing = new Map<string, string>()
  const collect = async (packageRoot: string): Promise<void> => {
    const manifestPath = join(packageRoot, 'package.json')
    if (!(await exists(manifestPath))) return
    let manifest: { peerDependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
    } catch {
      return
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!(await exists(join(nodeModulesDir, name)))) {
        missing.set(name, range)
      }
    }
  }
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) continue
    const topLevel = join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      // Scoped namespace: peer declarations live on the scope's packages.
      let scoped
      try {
        scoped = await readdir(topLevel, { withFileTypes: true })
      } catch {
        continue
      }
      for (const scopedEntry of scoped) {
        if (scopedEntry.isDirectory() && !scopedEntry.name.startsWith('.')) {
          await collect(join(topLevel, scopedEntry.name))
        }
      }
    } else {
      await collect(topLevel)
    }
  }
  return [...missing].map(([name, range]) => ({ name, range }))
}

export interface DshRuntimeInstallResult {
  readonly result: ProcessResult
  readonly installedPeers: number
}

/**
 * Install `@deepseek-ai/dsh@version` into `prefix` and repair missing peer
 * dependencies. Throws when the main install fails or peers cannot be fully
 * repaired after `maxPeerFixRounds` rounds.
 */
export async function installDshRuntime(
  environment: Pick<ValidNodeEnvironment, 'nodePath' | 'npmCliPath'>,
  prefix: string,
  version: string,
  options: DshRuntimeInstallOptions = {}
): Promise<DshRuntimeInstallResult> {
  const runner = options.runner ?? runProcess
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const maxRounds = options.maxPeerFixRounds ?? 3

  const main = await runner(
    environment.nodePath,
    [...baseArgs(environment.npmCliPath, prefix, options), '--save-exact', `@deepseek-ai/dsh@${version}`],
    { timeoutMs }
  )
  if (main.exitCode !== 0) {
    throw new Error(main.stderr.trim() || `npm exited with ${String(main.exitCode)}`)
  }

  const nodeModulesDir = join(prefix, 'node_modules')
  let installedPeers = 0
  for (let round = 1; round <= maxRounds; round += 1) {
    const peers = await missingPeers(nodeModulesDir)
    if (peers.length === 0) return { result: main, installedPeers }
    const fix = await runner(
      environment.nodePath,
      [
        ...baseArgs(environment.npmCliPath, prefix, options),
        '--no-save',
        ...peers.map((peer) => `${peer.name}@${peer.range}`)
      ],
      { timeoutMs }
    )
    if (fix.exitCode !== 0) {
      throw new Error(fix.stderr.trim() || `npm peer install exited with ${String(fix.exitCode)}`)
    }
    installedPeers += peers.length
  }
  const remaining = await missingPeers(nodeModulesDir)
  if (remaining.length > 0) {
    throw new Error(`DSH peer dependencies could not be fully installed: ${remaining.map((p) => p.name).join(', ')}`)
  }
  return { result: main, installedPeers }
}