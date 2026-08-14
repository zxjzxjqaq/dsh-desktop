import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { INITIAL_DSH_VERSION } from '../src/shared/config.js'
import { DshPackageManager } from '../src/main/dsh-package-manager.js'
import { DshServiceManager } from '../src/main/dsh-service-manager.js'
import { FileLogger } from '../src/main/logging.js'
import { detectNodeEnvironment } from '../src/main/node-environment.js'
import { createAppPaths } from '../src/main/platform/app-paths.js'
import { inspectPort } from '../src/main/platform/port-inspector.js'

const root = resolve('.artifacts/real-dsh')
const workspace = resolve('.artifacts/real-dsh-workspace')
await mkdir(workspace, { recursive: true })
const paths = createAppPaths(root)
const logger = new FileLogger(paths.logs)
const environment = await detectNodeEnvironment()
if (!environment.ok) throw new Error(environment.detail)

const verificationPort = 39831
const before = await inspectPort('127.0.0.1', verificationPort)
if (!before.free) {
  throw new Error(`Port ${verificationPort} is occupied before verification by PID ${String(before.ownerPid)}`)
}

const packages = new DshPackageManager(paths)
const install = await packages.install(environment, INITIAL_DSH_VERSION)
await packages.select(install.selection)
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
  nodeVersion: environment.nodeVersion,
  npmVersion: environment.npmVersion,
  dshVersion: install.selection.version,
  dshBinary: install.binaryPath,
  responseTitle,
  portFreeBefore: before.free,
  portFreeAfter: after.free,
  current: await packages.current()
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (responseTitle !== 'DeepSeek Harness' || !after.free) process.exitCode = 1
