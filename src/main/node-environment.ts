import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import semver from 'semver'
import { NODE_VERSION_RANGE } from '../shared/config.js'
import { runProcess, type ProcessRunner } from './platform/process-runner.js'

export interface ValidNodeEnvironment {
  readonly ok: true
  readonly source: 'bundled' | 'system'
  readonly nodePath: string
  readonly npmPath: string
  readonly npmCliPath: string
  readonly nodeVersion: string
  readonly npmVersion: string
}

export interface InvalidNodeEnvironment {
  readonly ok: false
  readonly reason: 'node-missing' | 'npm-missing' | 'node-incompatible' | 'execution-failed'
  readonly detail: string
  readonly detectedVersion?: string
}

export type NodeEnvironment = ValidNodeEnvironment | InvalidNodeEnvironment

function candidates(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function locate(name: string, runner: ProcessRunner): Promise<string[]> {
  const result = await runner('where.exe', [name], { timeoutMs: 5_000 })
  return result.exitCode === 0 ? candidates(result.stdout) : []
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

async function detectBundledNode(
  runner: ProcessRunner,
  directory: string
): Promise<ValidNodeEnvironment | null> {
  const nodePath = join(directory, 'node.exe')
  const npmCliPath = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!(await exists(nodePath)) || !(await exists(npmCliPath))) return null
  const nodeResult = await runner(nodePath, ['--version'], { timeoutMs: 5_000 })
  const nodeVersion = semver.clean(nodeResult.stdout.trim())
  if (nodeResult.exitCode !== 0 || !nodeVersion || !semver.satisfies(nodeVersion, NODE_VERSION_RANGE)) {
    return null
  }
  const npmResult = await runner(nodePath, [npmCliPath, '--version'], { timeoutMs: 5_000 })
  const npmVersion = semver.clean(npmResult.stdout.trim())
  if (npmResult.exitCode !== 0 || !npmVersion) return null
  return { ok: true, source: 'bundled', nodePath, npmPath: '', npmCliPath, nodeVersion, npmVersion }
}

export async function detectNodeEnvironment(
  runner: ProcessRunner = runProcess,
  bundledNodeDirectory?: string | null
): Promise<NodeEnvironment> {
  if (bundledNodeDirectory) {
    const bundled = await detectBundledNode(runner, bundledNodeDirectory)
    if (bundled) return bundled
  }

  const nodePaths = await locate('node', runner)
  if (nodePaths.length === 0) {
    return { ok: false, reason: 'node-missing', detail: '未找到系统 Node.js。' }
  }

  let nodeFailure = ''
  let detectedVersion: string | undefined
  for (const nodePath of nodePaths) {
    const result = await runner(nodePath, ['--version'], { timeoutMs: 5_000 })
    const version = semver.clean(result.stdout.trim()) ?? undefined
    if (result.exitCode !== 0 || !version) {
      nodeFailure = result.error?.message ?? (result.stderr.trim() || 'Node.js 版本输出无效。')
      continue
    }
    detectedVersion = version
    if (!semver.satisfies(version, NODE_VERSION_RANGE)) {
      continue
    }

    const npmPaths = await locate('npm.cmd', runner)
    for (const npmPath of npmPaths) {
      const npmCliPath = join(dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      const npmResult = await runner(nodePath, [npmCliPath, '--version'], { timeoutMs: 5_000 })
      const npmVersion = semver.clean(npmResult.stdout.trim())
      if (npmResult.exitCode === 0 && npmVersion) {
        return {
          ok: true,
          source: 'system',
          nodePath,
          npmPath,
          npmCliPath,
          nodeVersion: version,
          npmVersion
        }
      }
    }
    return { ok: false, reason: 'npm-missing', detail: 'Node.js 可用，但未找到可执行的 npm.cmd。' }
  }

  if (detectedVersion) {
    return {
      ok: false,
      reason: 'node-incompatible',
      detail: `Node.js ${detectedVersion} 不符合 ${NODE_VERSION_RANGE}。`,
      detectedVersion
    }
  }
  return { ok: false, reason: 'execution-failed', detail: nodeFailure || 'Node.js 启动失败。' }
}
