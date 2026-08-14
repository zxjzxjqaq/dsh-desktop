import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Windows builder configuration', () => {
  it('uses a per-user x64 NSIS target and updater feed', async () => {
    const config = await readFile('electron-builder.yml', 'utf8')
    expect(config).toContain('appId: com.dsh.desktop')
    expect(config).toContain('target: nsis')
    expect(config).toContain('- x64')
    expect(config).toContain('perMachine: false')
    expect(config).toContain('allowElevation: false')
    expect(config).toContain('http://127.0.0.1:45873/')
  })
})
