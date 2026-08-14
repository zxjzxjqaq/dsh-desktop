import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace shell', () => {
  it('presents the official web chat as the default workspace', async () => {
    const html = await readFile('src/renderer/shell/index.html', 'utf8')
    const deepseekIndex = html.indexOf('data-tab="deepseek"')
    const dshIndex = html.indexOf('data-tab="dsh"')

    expect(deepseekIndex).toBeGreaterThan(-1)
    expect(dshIndex).toBeGreaterThan(deepseekIndex)
    expect(html).toContain('DeepSeek 网页对话')
    expect(html).toContain('DSH 工作区')
    expect(html).toContain('data-tab="deepseek" aria-selected="true"')
  })

  it('keeps native navigation shortcuts as a fallback', async () => {
    const menu = await readFile('src/main/app-menu.ts', 'utf8')
    expect(menu).toContain("accelerator: 'CmdOrCtrl+1'")
    expect(menu).toContain("selectWorkspace('deepseek')")
    expect(menu).toContain("accelerator: 'CmdOrCtrl+2'")
    expect(menu).toContain("selectWorkspace('dsh')")
  })
})
