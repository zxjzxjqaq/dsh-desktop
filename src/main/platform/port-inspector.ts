import { createServer } from 'node:net'
import { DSH_HOST, DSH_PORT } from '../../shared/config.js'
import { runProcess, type ProcessRunner } from './process-runner.js'

export interface PortStatus {
  readonly free: boolean
  readonly ownerPid?: number
}

export function parseNetstatOwner(output: string, host: string, port: number): number | undefined {
  const endpoint = `${host}:${port}`
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    if (fields[0]?.toUpperCase() !== 'TCP') continue
    if (fields[1] !== endpoint || fields[3]?.toUpperCase() !== 'LISTENING') continue
    const pid = Number(fields[4])
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return undefined
}

async function canBind(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

export async function inspectPort(
  host: string,
  port: number,
  runner: ProcessRunner = runProcess
): Promise<PortStatus> {
  if (await canBind(host, port)) return { free: true }
  const result = await runner('netstat.exe', ['-ano', '-p', 'tcp'], { timeoutMs: 5_000 })
  const ownerPid = result.exitCode === 0 ? parseNetstatOwner(result.stdout, host, port) : undefined
  return ownerPid ? { free: false, ownerPid } : { free: false }
}

export async function inspectDshPort(runner: ProcessRunner = runProcess): Promise<PortStatus> {
  return await inspectPort(DSH_HOST, DSH_PORT, runner)
}
