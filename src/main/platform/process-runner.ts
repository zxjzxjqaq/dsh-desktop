import { spawn } from 'node:child_process'

export interface ProcessResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error?: Error
}

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /** 流式接收 stdout 增量（例如 tar -v 的逐文件输出），与完整 stdout 同时保留 */
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: RunProcessOptions
) => Promise<ProcessResult>

export const runProcess: ProcessRunner = async (executable, args, options = {}) => {
  return await new Promise<ProcessResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      options.onStderr?.(chunk)
    })

    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : undefined

    child.on('error', (error) => finish({ exitCode: null, stdout, stderr, timedOut, error }))
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut }))
  })
}
