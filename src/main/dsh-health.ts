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

export interface ProbeOptions {
  readonly url?: string
  readonly fetcher?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type ProbeResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly url: string; readonly reason: string }

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

/**
 * A single non-throwing health probe. Used by `waitForDshHealth` (startup),
 * the service supervisor (periodic watchdog) and any other caller that needs
 * "is DSH healthy right now" without a loop around it.
 */
export async function probeOnce(options: ProbeOptions = {}): Promise<ProbeResult> {
  const url = options.url ?? DSH_URL
  const fetcher = options.fetcher ?? fetch
  if (options.signal?.aborted) {
    return { ok: false, url, reason: 'Health probe aborted' }
  }
  const controller = new AbortController()
  const requestTimer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000)
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      return { ok: false, url, reason: `DSH Web 返回了不匹配的响应（HTTP ${response.status}）。` }
    }
    const body = await response.text()
    if (!isDshHtml(response.headers.get('content-type'), body)) {
      return { ok: false, url, reason: '响应内容不是 DSH Web 页面。' }
    }
    return { ok: true, url }
  } catch (error) {
    return { ok: false, url, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(requestTimer)
  }
}

export async function waitForDshHealth(options: HealthOptions = {}): Promise<DshHealth> {
  const url = options.url ?? DSH_URL
  const fetcher = options.fetcher ?? fetch
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + (options.timeoutMs ?? DSH_STARTUP_TIMEOUT_MS)
  let lastReason = 'DSH Web 尚未响应。'

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Health check aborted')
    const result = await probeOnce({ url, fetcher, timeoutMs: 2_000, signal: options.signal })
    if (result.ok) return { ok: true, url }
    lastReason = result.reason
    await delay(intervalMs, options.signal)
  }
  throw new Error(`DSH Web 启动超时：${lastReason}`)
}