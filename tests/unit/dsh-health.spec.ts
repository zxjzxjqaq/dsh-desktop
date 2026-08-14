import { describe, expect, it } from 'vitest'
import { isDshHtml, waitForDshHealth } from '../../src/main/dsh-health.js'

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
