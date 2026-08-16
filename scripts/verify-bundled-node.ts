import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { INITIAL_DSH_VERSION } from '../src/shared/config.js'
import { DshPackageManager } from '../src/main/dsh-package-manager.js'
import { DshServiceManager } from '../src/main/dsh-service-manager.js'
import { FileLogger } from '../src/main/logging.js'
import { detectNodeEnvironment } from '../src/main/node-environment.js'
import { createAppPaths } from '../src/main/platform/app-paths.js'
import { runProcess, type ProcessRunner } from '../src/main/platform/process-runner.js'
import { inspectPort } from '../src/main/platform/port-inspector.js'
import { RuntimeExtractor } from '../src/main/runtime-extractor.js'

const root = resolve('.artifacts/bundled-node-verify')
const workspace = resolve('.artifacts/bundled-node-workspace')
await mkdir(workspace, { recursive: true })
const paths = createAppPaths(root)
const logger = new FileLogger(paths.logs)
const extractor = new RuntimeExtractor(paths, {
  resourcesDirectory: resolve('.artifacts/archives'),
  logger
})

const nodeDirectory = await extractor.nodeRuntimeDirectory()
if (!nodeDirectory) throw new Error('Bundled Node runtime is not prepared; run prepare:node-runtime first')

// Simulate a machine without Node.js on PATH: keep only Windows system directories.
const systemOnlyPath =
  process.env.PATH?.split(';')
    .filter((entry) => entry.trim().toLowerCase().startsWith('c:\\windows'))
    .join(';') ?? ''
const restrictedRunner: ProcessRunner = (executable, args, options = {}) =>
  runProcess(executable, args, { ...options, env: { ...process.env, PATH: systemOnlyPath } })

const systemCheck = await detectNodeEnvironment(restrictedRunner)
if (systemCheck.ok) throw new Error('System Node.js unexpectedly detected in restricted PATH')

const environment = await detectNodeEnvironment(restrictedRunner, nodeDirectory)
if (!environment.ok) throw new Error(environment.detail)
if (environment.source !== 'bundled') throw new Error('Expected the bundled Node runtime to be selected')

const packages = new DshPackageManager(paths, { extractor })
const install = await packages.restoreBundled(INITIAL_DSH_VERSION)
if (!install) throw new Error('Bundled DSH runtime could not be restored')
await packages.select(install.selection)

const verificationPort = 39832
const before = await inspectPort('127.0.0.1', verificationPort)
if (!before.free) {
  throw new Error(`Port ${verificationPort} is occupied before verification by PID ${String(before.ownerPid)}`)
}

const service = new DshServiceManager({
  nodePath: environment.nodePath,
  binaryPath: install.binaryPath,
  cwd: workspace,
  port: verificationPort,
  logger
})

let responseTitle = ''
try {
  await service.start()
  const response = await fetch(`http://127.0.0.1:${verificationPort}`)
  const body = await response.text()
  responseTitle = body.match(/<title>([^<]+)<\/title>/)?.[1] ?? ''
} finally {
  await service.stop()
}

const after = await inspectPort('127.0.0.1', verificationPort)
const result = {
  nodeSource: environment.source,
  nodeVersion: environment.nodeVersion,
  dshVersion: install.selection.version,
  responseTitle,
  portFreeBefore: before.free,
  portFreeAfter: after.free,
  current: await packages.current()
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (responseTitle !== 'DeepSeek Harness' || !after.free) process.exitCode = 1
