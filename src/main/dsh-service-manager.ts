import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { DSH_HOST, DSH_PORT } from '../shared/config.js'
import type { FileLogger } from './logging.js'
import { waitForDshHealth } from './dsh-health.js'
import { inspectPort, type PortStatus } from './platform/port-inspector.js'
import { stopProcessTree } from './platform/process-tree.js'

export interface DshServiceOptions {
  readonly nodePath: string
  readonly binaryPath: string
  readonly cwd?: string
  readonly host?: string
  readonly port?: number
  readonly logger: FileLogger
  readonly healthCheck?: typeof waitForDshHealth
  readonly inspectPort?: (host: string, port: number) => Promise<PortStatus>
  readonly onUnexpectedExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void
}

export class DshServiceManager {
  private child: ChildProcess | null = null
  private stopping = false

  public constructor(private readonly options: DshServiceOptions) {}

  public get pid(): number | null {
    return this.child?.pid ?? null
  }

  public async start(): Promise<void> {
    if (this.child) throw new Error('DSH service is already running')
    const host = this.options.host ?? DSH_HOST
    const portNumber = this.options.port ?? DSH_PORT
    const port = await (this.options.inspectPort ?? inspectPort)(host, portNumber)
    if (!port.free) {
      const suffix = port.ownerPid ? `，占用 PID：${port.ownerPid}` : ''
      throw new Error(`端口 ${portNumber} 已被占用${suffix}`)
    }

    this.stopping = false
    const child = spawn(
      this.options.nodePath,
      [this.options.binaryPath, 'web', '--host', host, '--port', String(portNumber)],
      {
      cwd: this.options.cwd ?? homedir(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => void this.options.logger.write('dsh', chunk.trimEnd()))
    child.stderr?.on('data', (chunk: string) => void this.options.logger.write('dsh', chunk.trimEnd()))

    const exited = new Promise<never>((_resolve, reject) => {
      child.once('exit', (exitCode, signal) => {
        if (this.child === child) this.child = null
        if (!this.stopping) {
          this.options.onUnexpectedExit?.(exitCode, signal)
          reject(new Error(`DSH exited before becoming healthy (${String(exitCode)}, ${String(signal)})`))
        }
      })
    })

    try {
      await Promise.race([
        (this.options.healthCheck ?? waitForDshHealth)({ url: `http://${host}:${portNumber}` }),
        exited
      ])
    } catch (error) {
      if (this.child === child) await this.stop()
      throw error
    }
  }

  public async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    try {
      await stopProcessTree(child)
    } finally {
      if (this.child === child) this.child = null
      this.stopping = false
    }
  }
}
