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

  it('surfaces the DSH service state and restart control in the toolbar', async () => {
    const html = await readFile('src/renderer/shell/index.html', 'utf8')
    expect(html).toContain('id="dsh-status"')
    expect(html).toContain('id="restart-dsh"')
    expect(html).toContain('id="update-status"')
    const shell = await readFile('src/renderer/shell/shell.ts', 'utf8')
    expect(shell).toContain('onServiceStatus(renderServiceStatus)')
    expect(shell).toContain('onUpdateState(renderUpdateState)')
    expect(shell).toContain('getSnapshot()')
  })

  it('keeps the DSH restart and update menu entries wired', async () => {
    const menu = await readFile('src/main/app-menu.ts', 'utf8')
    expect(menu).toContain('重新启动 DSH 服务')
    expect(menu).toContain('管理 DSH 版本')
    expect(menu).toContain('DSH 更新设置')
  })
})
