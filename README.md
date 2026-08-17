# DSH Desktop

DSH Desktop 是面向 Windows x64 的 Electron 桌面端。它保留 DeepSeek Harness
原始 Web UI，在本机启动并管理 `@deepseek-ai/dsh web`，同时提供桌面程序更新、
DSH 独立更新、健康检查和 DSH 版本回滚。

## 功能

- 使用受限 Electron 窗口加载 `http://127.0.0.1:3080` 的原始 DSH Web UI；
- 安装包捆绑 Node.js v24.15.0 与 DSH 运行时，**无需自行安装 Node.js**；
- 安装向导支持自定义安装目录；
- 首次启动自动解压捆绑运行环境（一次性，显示进度），之后启动直接复用；
- 关闭窗口时最小化到系统托盘，DSH 继续运行；右键托盘图标选择“退出”才完全退出；
- 自动检测系统 `node.exe` 和 npm CLI（仅作为捆绑运行时的回退）；
- 首次启动安装固定版本 `@deepseek-ai/dsh@0.1.0-rc.6`（仅在捆绑运行时不可用时联网安装）；
- 按版本隔离保存 DSH，更新失败时恢复上一个健康版本；
- 通过 `electron-updater` 支持 NSIS 桌面更新；
- 提供仅监听回环地址的本地更新源，便于发布前验证；
- 日志写入用户数据目录，并对常见令牌、密钥和授权头进行脱敏。
- 看门狗守护 DSH 服务：运行中崩溃或失联时原地无感重启并自动重连，带退避与手动恢复。
- DSH 更新闭环：后台两段式下载/切换、定时检查、系统通知、版本历史回滚链与磁盘清理。
- 网络设置：npm registry 镜像与 HTTP(S) 代理配置。

## 运行要求

- Windows 10/11 x64；
- 无需安装 Node.js：安装包已捆绑 Node.js v24.15.0 与 DSH 运行时。
  系统 Node.js 仅在捆绑运行时不可用时作为回退。

应用使用捆绑 Node.js 启动 DSH。npm 的位置通过 `where.exe npm.cmd` 发现，
实际调用由已验证的 `node.exe` 执行相邻的 `node_modules/npm/bin/npm-cli.js`，
避免 PowerShell 执行策略和 `.cmd` 进程启动差异。

## 开发和构建

开发环境要求（与最终用户不同，**构建本仓库需要 Node.js**）：

- Windows 10/11 x64；
- Node.js `^22.19.0` 或 `>=24.0.0`（含 npm）；
- 国内网络建议先配置 npm 镜像（如 `npm config set registry https://registry.npmmirror.com`）。

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev
```

生成 Windows 安装包（首次构建会从 nodejs.org 下载捆绑的 Node.js，并从 npm
安装捆绑的 DSH 运行时，需要几分钟网络时间）：

```powershell
npm.cmd run dist:win
```

输出位于：

- `dist/DSH-Desktop-<version>-Setup.exe`
- `dist/DSH-Desktop-<version>-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/win-unpacked/DSH Desktop.exe`

当前测试构建未配置 Windows 代码签名证书；正式分发前应在 CI 中配置证书签名。

## 桌面版本更新

默认测试更新源为 `http://127.0.0.1:45873/`。启动本地更新源：

```powershell
npm.cmd run update:serve
```

发布一个更高版本进行本地验证：

```powershell
npm.cmd version 0.1.1 --no-git-tag-version
npm.cmd run dist:win
npm.cmd run update:serve
```

将新版本的 `latest.yml`、安装程序和 `.blockmap` 放在同一个更新目录中。在旧版
应用内选择“帮助 → 检查桌面程序更新”，即可执行发现、下载和确认安装。部署到
正式 HTTPS 文件源时，修改 `electron-builder.yml` 的 `publish.url`，或在运行环境
设置 `DSH_DESKTOP_UPDATE_URL`。

## DSH 更新与回滚

“帮助 → 检查 DSH 更新”读取 npm `latest` dist-tag，将新版本安装到独立目录，
切换后重新启动 DSH 并执行健康检查。验证失败会自动恢复上一个版本。也可选择
“帮助 → 回滚到上一个 DSH 版本”手动回滚。

## 数据与日志

默认目录：`%LOCALAPPDATA%\DSH Desktop`

```text
DSH Desktop/
├─ dsh/versions/<version>/
├─ dsh/node/<version>/
├─ dsh/current.json
├─ dsh/previous.json
├─ dsh/staging/
└─ logs/
```

应用菜单可直接打开日志目录。删除用户数据前，请先退出 DSH Desktop。

## 验证命令

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run verify:real-dsh
npm.cmd run verify:bundled-node
npm.cmd run verify:update-feed
npm.cmd run verify:desktop-update
```

`verify:real-dsh` 使用隔离端口 39831，不会占用或停止正在运行的 3080 服务。
`verify:bundled-node` 使用隔离端口 39832，在模拟无系统 Node.js 的 PATH 下
验证捆绑 Node 与捆绑 DSH 运行时的完整链路。桌面更新验证需要
`.artifacts/update-feed` 中存在更高版本测试包；测试脚本禁用
“退出即安装”，只验证发现、下载和更新包校验。

## 开发环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_TRAY=1` | 开发模式下启用托盘常驻（打包版默认启用） |
| `DSH_DESKTOP_UPDATE_URL` | 覆盖桌面更新源地址 |
| `DSH_DESKTOP_TEST_MODE=1` | 测试模式：允许自定义端口/数据目录/自动退出 |
| `DSH_DESKTOP_DATA_ROOT` | 测试模式下的用户数据目录 |
| `DSH_DESKTOP_PORT` | 测试模式下的 DSH 端口（默认 3080） |
| `DSH_DESKTOP_AUTO_EXIT_MS` | 测试模式下自动退出毫秒数 |
| `DSH_DESKTOP_SCREENSHOT` | 测试模式下启动后截图保存路径 |


## 看门狗无感重启（Watchdog）

运行中的 DSH 服务由 `DshSupervisor`（src/main/supervisor.ts）持续守护：

- 每 5 秒探测一次 DSH Web（`probeOnce`：单次、不抛错、附带原因）；
- 连续 3 次探测失败或进程意外退出时**原地重启**：停掉进程树 → 重新拉起当前选中
  版本 → 健康等待 → 自动重载 DSH 视图。窗口、工具栏与 DeepSeek 会话全程不受影响；
- 自动重启带退避：60 秒滑动窗口内最多 3 次，超过后进入"需要重启"状态，由工具栏
  按钮或菜单手动恢复；
- 更新流程进行中看门狗自动让位，绝不与更新流程争抢服务生命周期。

工具栏会实时显示服务状态（运行中/响应异常/正在恢复/需要重启），失败时出现
"重启 DSH"按钮（IPC：`shell:restart-dsh`，状态推送：`shell:service-status`）。

## DSH 更新闭环

更新拆成两段，下载与切换解耦：

- `prepare`：后台将新版安装到版本目录，不触碰当前运行版本与正在运行的进程；
- `apply`：切换指针 → 原地重启 → 健康验证 → 失败自动回滚到上一版本。

配套能力：

- 定时检查（默认每 6 小时、可配置、可关闭），发现新版本通过 Windows 通知提醒；
  开启"自动应用"后下载完成即自动重启生效；
- 版本历史链：select/回滚都会把旧选中记入 history.json，回滚菜单与后续版本切换
  都能回到历史版本；
- 版本磁盘管理：列出已安装版本与占用大小，一键清理旧版本（当前版本与回滚目标
  始终保留，保留数量在设置中配置，默认 3）；
- 网络设置：`settings.json` 中可配置 npm registry 镜像（如 npmmirror）与
  HTTP(S) 代理，安装与更新自动携带 `--registry` / `--proxy` / `--https-proxy` 参数。

## 文档索引

设计、实施计划与验证记录按时间线存放在 `docs/`，入口见
[`docs/README.md`](docs/README.md)：v0.1 原始设计、v0.2（捆绑 Node / 归档
运行时 / 托盘 / 向导安装）设计与实施计划、Android 可行性评估、Windows x64
实测记录。
