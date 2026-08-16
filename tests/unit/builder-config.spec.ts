import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Windows builder configuration', () => {
  it('uses a per-user x64 NSIS target and updater feed', async () => {
    const config = await readFile('electron-builder.yml', 'utf8')
    expect(config).toContain('appId: com.dsh.desktop')
    expect(config).toContain('target: nsis')
    expect(config).toContain('- x64')
    expect(config).toContain('perMachine: false')
    expect(config).toContain('oneClick: false')
    expect(config).toContain('allowToChangeInstallationDirectory: true')
    expect(config).toContain('allowElevation: false')
    expect(config).toContain('provider: github')
    expect(config).toContain('owner: zxjzxjqaq')
    expect(config).toContain('repo: dsh-desktop')
    expect(config).toContain('afterPack: ./scripts/after-pack.cjs')
  })
})
