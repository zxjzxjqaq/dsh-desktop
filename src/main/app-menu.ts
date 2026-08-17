import { app, dialog, Menu, type BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import type { DesktopUpdater } from './app-updater.js'
import type { DshUpdateResult } from './dsh-updater.js'
import { DshUpdater } from './dsh-updater.js'
import type { DshPackageManager, DshSelection } from './dsh-package-manager.js'
import type { AppSettings } from './settings.js'
import type { WorkspaceTab } from '../shared/contracts.js'

export interface AppMenuOptions {
  readonly getWindow: () => BrowserWindow | null
  readonly desktopUpdater: DesktopUpdater
  readonly dshUpdater: DshUpdater
  readonly packages: DshPackageManager
  readonly logsDirectory: string
  readonly selectWorkspace: (tab: WorkspaceTab) => Promise<void>
  readonly restartDsh: () => Promise<boolean>
  readonly prepareDshUpdate: (version: string) => Promise<DshSelection>
  readonly applyDshUpdate: (prepared: DshSelection) => Promise<DshUpdateResult>
  readonly getSettings: () => AppSettings
  readonly updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
}

async function message(window: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return result.response
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
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
        },
        { type: 'separator' },
        {
          label: '重新启动 DSH 服务',
          click: async () => {
            const ok = await options.restartDsh()
            await message(options.getWindow(), {
              type: ok ? 'info' : 'warning',
              message: ok ? 'DSH 服务已原地重启。' : 'DSH 服务重启失败，请查看日志。'
            })
          }
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
        { type: 'separator' },
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
                buttons: ['下载并安装', '取消'],
                defaultId: 0,
                cancelId: 1,
                message: `发现 DSH ${check.latestVersion}`,
                detail: `当前版本：${check.currentVersion ?? '未安装'}。下载在后台进行，完成后需要重启生效。`
              })
              if (answer !== 0) return
              const prepared = await options.prepareDshUpdate(check.latestVersion)
              const apply = await message(options.getWindow(), {
                type: 'info',
                buttons: ['立即重启生效', '稍后'],
                defaultId: 0,
                cancelId: 1,
                message: `DSH ${prepared.version} 已下载完成。`,
                detail: '重启生效时会自动执行健康检查，失败将自动回滚。'
              })
              if (apply !== 0) return
              const result = await options.applyDshUpdate(prepared)
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
        {
          label: '管理 DSH 版本…',
          click: async () => {
            try {
              const versions = await options.packages.installedVersions()
              const lines = versions.length === 0
                ? '（没有已安装的 DSH 版本）'
                : versions
                    .map((version) =>
                      `${version.selected ? '* ' : '  '}${version.version}` +
                      `  ${formatBytes(version.sizeBytes)}` +
                      (version.installedAt ? `  安装于 ${version.installedAt.slice(0, 10)}` : '') +
                      (version.lastHealthyAt ? `  最近健康 ${version.lastHealthyAt.slice(0, 10)}` : '')
                    )
                    .join('\n')
              const keep = options.getSettings().keepVersions
              const answer = await message(options.getWindow(), {
                type: 'info',
                buttons: ['清理旧版本', '关闭'],
                defaultId: 1,
                cancelId: 1,
                message: '已安装的 DSH 版本（* 为当前选中）',
                detail: `${lines}\n\n将保留最近 ${keep} 个版本（当前版本与回滚目标始终保留）。`
              })
              if (answer !== 0) return
              const confirm = await message(options.getWindow(), {
                type: 'warning',
                buttons: ['清理', '取消'],
                defaultId: 1,
                cancelId: 1,
                message: `清理旧版本（保留 ${keep} 个）？`,
                detail: '被清理的版本将无法再回滚到。'
              })
              if (confirm !== 0) return
              const removed = await options.packages.pruneVersions(keep)
              await message(options.getWindow(), {
                type: 'info',
                message: removed.length === 0
                  ? '没有需要清理的旧版本。'
                  : `已清理 ${removed.length} 个旧版本：${removed.map((item) => item.version).join('、')}`
              })
            } catch (error) {
              await message(options.getWindow(), { type: 'error', message: '管理版本失败', detail: String(error) })
            }
          }
        },
        {
          label: 'DSH 更新设置…',
          click: async () => {
            const settings = options.getSettings()
            const window = options.getWindow()
            const opts: Electron.MessageBoxOptions = {
              type: 'info',
              message: 'DSH 更新设置',
              detail:
                `自动检查：${settings.autoUpdateDsh ? '开' : '关'}\n` +
                `自动应用：${settings.autoApplyDsh ? '开' : '关'}\n` +
                `检查间隔：每 ${settings.updateCheckHours} 小时\n` +
                `保留版本数：${settings.keepVersions}\n` +
                `registry：${settings.registryUrl ?? 'npm 官方'}`,
              checkboxLabel: '自动检查 DSH 更新',
              checkboxChecked: settings.autoUpdateDsh,
              buttons: ['保存', '打开设置文件', '取消'],
              defaultId: 2,
              cancelId: 2,
              noLink: true
            }
            const result = window
              ? await dialog.showMessageBox(window, opts)
              : await dialog.showMessageBox(opts)
            if (result.response === 0) {
              await options.updateSettings({ autoUpdateDsh: result.checkboxChecked })
              await message(options.getWindow(), { type: 'info', message: '设置已保存。' })
            } else if (result.response === 1) {
              await shell.openPath(join(dirname(options.logsDirectory), 'settings.json'))
            }
          }
        },
        {
          label: '切换自动应用 DSH 更新',
          click: async () => {
            const settings = options.getSettings()
            const next = !settings.autoApplyDsh
            const answer = await message(options.getWindow(), {
              type: 'warning',
              buttons: [next ? '开启自动应用' : '关闭自动应用', '取消'],
              defaultId: 1,
              cancelId: 1,
              message: next ? '自动应用已下载的 DSH 更新？' : '关闭自动应用？',
              detail: next
                ? '更新下载完成后将自动重启 DSH 服务并验证，失败会自动回滚。'
                : '更新下载完成后仍需手动确认重启。'
            })
            if (answer !== 0) return
            await options.updateSettings({ autoApplyDsh: next })
            await message(options.getWindow(), { type: 'info', message: next ? '已开启自动应用。' : '已关闭自动应用。' })
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