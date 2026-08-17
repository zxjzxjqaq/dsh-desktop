import { describe, expect, it } from 'vitest'
import { isDshHtml, probeOnce, waitForDshHealth } from '../../src/main/dsh-health.js'

const DSH_HTML = '<!doctype html><title>DeepSeek Harness</title><div id="root"></div>'

describe('DSH health checks', () => {
  it('accepts the pinned DSH root document markers', () => {
    expect(isDshHtml('text/html; charset=utf-8', DSH_HTML)).toBe(true)
  })

  it('rejects an unrelated HTML page', () => {
    expect(isDshHtml('text/html', '<title>Other app</title>')).toBe(false)
  })

  it('returns after a healthy response', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(DSH_HTML, { headers: { 'content-type': 'text/html' } })
    await expect(waitForDshHealth({ fetcher, timeoutMs: 100, intervalMs: 1 })).resolves.toMatchObject({
      ok: true
    })
  })
})

describe('single-shot probeOnce', () => {
  it('reports healthy pages as ok', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(DSH_HTML, { headers: { 'content-type': 'text/html' } })
    await expect(probeOnce({ fetcher })).resolves.toEqual({ ok: true, url: 'http://127.0.0.1:3080' })
  })

  it('reports unmatched content with a reason', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response('<title>Other</title>', { headers: { 'content-type': 'text/html' } })
    const result = await probeOnce({ fetcher })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('不是 DSH')
  })

  it('reports error statuses with the HTTP code', async () => {
    const fetcher = async (): Promise<Response> => new Response('oops', { status: 503 })
    const result = await probeOnce({ fetcher })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('HTTP 503')
  })

  it('reports network failures without throwing', async () => {
    const fetcher = async (): Promise<Response> => {
      throw new Error('ECONNREFUSED')
    }
    const result = await probeOnce({ fetcher })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('ECONNREFUSED')
  })
})