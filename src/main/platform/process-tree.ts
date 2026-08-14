import type { ChildProcess } from 'node:child_process'
import { DSH_SHUTDOWN_TIMEOUT_MS } from '../../shared/config.js'
import { runProcess, type ProcessRunner } from './process-runner.js'

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function stopProcessTree(
  child: ChildProcess,
  runner: ProcessRunner = runProcess,
  timeoutMs = DSH_SHUTDOWN_TIMEOUT_MS
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) throw new Error('DSH process has no PID')
  if (process.platform !== 'win32') {
    child.kill()
    if (await waitForExit(child, timeoutMs)) return
  } else {
    await runner('taskkill.exe', ['/PID', String(child.pid), '/T'], { timeoutMs })
    if (await waitForExit(child, timeoutMs)) return
  }
  const result = await runner(
    'taskkill.exe',
    ['/PID', String(child.pid), '/T', '/F'],
    { timeoutMs }
  )
  if (result.exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
    throw new Error(result.stderr.trim() || 'Failed to terminate the DSH process tree')
  }
  if (!(await waitForExit(child, timeoutMs))) throw new Error('DSH process tree did not exit')
}
