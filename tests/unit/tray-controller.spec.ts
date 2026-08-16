import { describe, expect, it } from 'vitest'
import { buildTrayMenuTemplate, TrayController } from '../../src/main/tray-controller.js'
import type { WorkspaceTab } from '../../src/shared/contracts.js'

const baseOptions = {
  iconPath: 'build/icon.ico',
  getWindow: () => null,
  selectWorkspace: async (_tab: WorkspaceTab) => undefined,
  openLogsDirectory: async () => undefined,
  onQuit: () => undefined
}

describe('tray menu template', () => {
  it('offers workspace shortcuts, logs, and a quit action', () => {
    const template = buildTrayMenuTemplate(baseOptions)
    const labels = template.map((item) => item.label)
    expect(labels).toContain('显示 DSH 工作区')
    expect(labels).toContain('显示 DeepSeek 对话')
    expect(labels).toContain('打开日志目录')
    expect(labels).toContain('退出')
  })

  it('routes actions to the injected callbacks', async () => {
    const calls: string[] = []
    const options = {
      ...baseOptions,
      selectWorkspace: async (tab: WorkspaceTab) => {
        calls.push(`select:${tab}`)
      },
      openLogsDirectory: async () => {
        calls.push('logs')
      },
      onQuit: () => {
        calls.push('quit')
      }
    }
    const template = buildTrayMenuTemplate(options)
    const byLabel = new Map(template.map((item) => [item.label, item]))
    await byLabel.get('显示 DSH 工作区')!.click!({} as never, {} as never, {} as never)
    await byLabel.get('打开日志目录')!.click!({} as never, {} as never, {} as never)
    byLabel.get('退出')!.click!({} as never, {} as never, {} as never)
    expect(calls).toEqual(['select:dsh', 'logs', 'quit'])
  })

  it('notifies only once per process', () => {
    const notifications: Array<[string, string]> = []
    const controller = new TrayController({
      ...baseOptions,
      notify: (title: string, body: string) => {
        notifications.push([title, body])
      }
    })
    controller.onWindowHidden()
    controller.onWindowHidden()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]![0]).toContain('DSH Desktop')
  })
})
