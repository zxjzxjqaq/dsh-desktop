import { app, dialog, Menu, type BrowserWindow, shell } from 'electron'
import type { DesktopUpdater } from './app-updater.js'
import type { DshUpdater } from './dsh-updater.js'
import type { DshPackageManager } from './dsh-package-manager.js'
import type { WorkspaceTab } from '../shared/contracts.js'

export interface AppMenuOptions {
  readonly getWindow: () => BrowserWindow | null
  readonly desktopUpdater: DesktopUpdater
  readonly dshUpdater: DshUpdater
  readonly packages: DshPackageManager
  readonly logsDirectory: string
  readonly selectWorkspace: (tab: WorkspaceTab) => Promise<void>
}

async function message(window: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response
}

export function installAppMenu(options: AppMenuOptions): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }]
    },
    {
      label: '导航',
      submenu: [
        {
          label: 'DeepSeek 网页对话',
          accelerator: 'CmdOrCtrl+1',
          click: () => void options.selectWorkspace('deepseek')
        },
        {
          label: 'DSH 工作区',
          accelerator: 'CmdOrCtrl+2',
          click: () => void options.selectWorkspace('dsh')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查桌面程序更新',
          click: async () => {
            try {
              const update = await options.desktopUpdater.check()
              if (!update) {
                await message(options.getWindow(), { type: 'info', message: '当前开发版本未连接桌面更新源。' })
                return
              }
              if (!update.isUpdateAvailable) {
                await message(options.getWindow(), { type: 'info', message: 'DSH Desktop 已是最新版本。' })
                return
              }
              const answer = await message(options.getWindow(), {
                type: 'info',
                buttons: ['下载更新', '稍后'],
                defaultId: 0,
                cancelId: 1,
                message: `发现桌面版本 ${update.updateInfo.version}`,
                detail: String(update.updateInfo.releaseNotes ?? '')
              })
              if (answer !== 0) return
              await options.desktopUpdater.download()
              const install = await message(options.getWindow(), {
                type: 'info',
                buttons: ['立即重启安装', '稍后'],
                defaultId: 0,
                cancelId: 1,
                message: '桌面更新已下载完成。'
              })
              if (install === 0) await options.desktopUpdater.install()
            } catch (error) {
              await message(options.getWindow(), { type: 'error', message: '桌面更新失败', detail: String(error) })
            }
          }
        },
        {
          label: '检查 DSH 更新',
          click: async () => {
            try {
              const check = await options.dshUpdater.check()
              if (!check.updateAvailable) {
                await message(options.getWindow(), {
                  type: 'info',
                  message: `DSH ${check.currentVersion ?? check.latestVersion} 已是最新版本。`
                })
                return
              }
              const answer = await message(options.getWindow(), {
                type: 'question',
                buttons: ['安装并验证', '取消'],
                defaultId: 0,
                cancelId: 1,
                message: `发现 DSH ${check.latestVersion}`,
                detail: `当前版本：${check.currentVersion ?? '未安装'}。安装后将自动执行健康检查。`
              })
              if (answer !== 0) return
              const result = await options.dshUpdater.install(check.latestVersion)
              await message(options.getWindow(), {
                type: result.rolledBack ? 'warning' : 'info',
                message: result.rolledBack
                  ? `新版本验证失败，已恢复 DSH ${result.version}。`
                  : `DSH ${result.version} 更新成功。`
              })
            } catch (error) {
              await message(options.getWindow(), { type: 'error', message: 'DSH 更新失败', detail: String(error) })
            }
          }
        },
        {
          label: '回滚到上一个 DSH 版本',
          click: async () => {
            try {
              const previous = await options.packages.previous()
              if (!previous) {
                await message(options.getWindow(), { type: 'info', message: '没有可回滚的 DSH 版本。' })
                return
              }
              const answer = await message(options.getWindow(), {
                type: 'warning',
                buttons: ['回滚并验证', '取消'],
                defaultId: 1,
                cancelId: 1,
                message: `回滚到 DSH ${previous.version}？`
              })
              if (answer === 0) await options.dshUpdater.rollback()
            } catch (error) {
              await message(options.getWindow(), { type: 'error', message: 'DSH 回滚失败', detail: String(error) })
            }
          }
        },
        { type: 'separator' },
        { label: '打开日志目录', click: async () => void (await shell.openPath(options.logsDirectory)) },
        {
          label: '关于 DSH Desktop',
          click: async () => {
            const current = await options.packages.current()
            await message(options.getWindow(), {
              type: 'info',
              message: `DSH Desktop ${app.getVersion()}`,
              detail: `DSH：${current?.version ?? '未安装'}\nElectron：${process.versions.electron}`
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
