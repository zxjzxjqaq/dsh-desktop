import {
  DSH_HEALTH_MARKERS,
  DSH_STARTUP_TIMEOUT_MS,
  DSH_URL
} from '../shared/config.js'

export interface HealthOptions {
  readonly url?: string
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly fetcher?: typeof fetch
  readonly signal?: AbortSignal
}

export interface DshHealth {
  readonly ok: true
  readonly url: string
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('Health check aborted'))
      },
      { once: true }
    )
  })
}

export function isDshHtml(contentType: string | null, body: string): boolean {
  return Boolean(contentType?.toLowerCase().includes('text/html')) &&
    DSH_HEALTH_MARKERS.every((marker) => body.includes(marker))
}

export async function waitForDshHealth(options: HealthOptions = {}): Promise<DshHealth> {
  const url = options.url ?? DSH_URL
  const fetcher = options.fetcher ?? fetch
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + (options.timeoutMs ?? DSH_STARTUP_TIMEOUT_MS)
  let lastError = 'DSH Web 尚未响应。'

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Health check aborted')
    const controller = new AbortController()
    const requestTimer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetcher(url, {
        redirect: 'error',
        signal: controller.signal
      })
      const body = await response.text()
      if (response.ok && isDshHtml(response.headers.get('content-type'), body)) {
        return { ok: true, url }
      }
      lastError = `DSH Web 返回了不匹配的响应（HTTP ${response.status}）。`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(requestTimer)
    }
    await delay(intervalMs, options.signal)
  }
  throw new Error(`DSH Web 启动超时：${lastError}`)
}
