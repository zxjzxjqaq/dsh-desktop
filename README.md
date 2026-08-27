# DSH Desktop

[![Release](https://img.shields.io/github/v/release/zxjzxjqaq/dsh-desktop)](https://github.com/zxjzxjqaq/dsh-desktop/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue)](#快速开始)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**DSH Desktop** 是 DeepSeek Harness（DSH）Web UI 的 Windows 桌面外壳。它把
`@deepseek-ai/dsh web` 服务连同官方 Node.js 运行时一并打包成单个安装程序：
双击安装即可使用，无需自行安装 Node.js，也无需打开命令行。桌面端在本地启动
并管理 DSH 服务，保留原始 Web UI 的全部能力，同时提供看门狗守护、双版本
更新闭环、版本回滚和系统托盘常驻。

> 仅支持 Windows 10/11 x64；macOS / Linux 暂不支持。

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [界面一览](#界面一览)
- [DSH 更新与回滚](#dsh-更新与回滚)
- [看门狗无感重启](#看门狗无感重启)
- [数据与日志](#数据与日志)
- [面向开发者](#面向开发者)
- [文档索引](#文档索引)
- [License](#license)

## 核心特性

- **开箱即用** —— 安装包捆绑 Node.js v24.15.0 与固定版本的 DSH 运行时，
  系统中没有任何 Node.js 也能直接运行；系统 Node 仅作为捆绑环境损坏时的
  回退。
- **向导式安装** —— NSIS 安装向导支持自定义安装目录，按当前用户权限安装，
  全程不需要管理员授权（UAC）。
- **首次启动自动就绪** —— 首次启动一次性解压内置运行环境（带真实进度条），
  之后每次启动都在数秒内完成冷启动。
- **原始 Web UI** —— 受限 Electron 窗口加载 `http://127.0.0.1:3080`，不篡改
  页面内容；附带标签页可直接进入 DeepSeek 官方对话页。
- **看门狗守护** —— 每 5 秒探测一次服务健康，崩溃或失联自动原地重启，
  带频控与手动恢复兜底；窗口中的会话全程不受影响。
- **DSH 更新闭环** —— 后台下载新版（不中断当前服务）→ 切换 → 原地重启 →
  健康验证，验证失败自动回滚上一个可用版本；支持定时检查、Windows 通知
  与“立即生效 / 稍后生效”。
- **版本管理与磁盘治理** —— 按版本隔离保存历史发行版，一键回滚到任意已装
  版本或清理旧版本（当前版本与回滚目标始终受保护）。
- **网络设置即时生效** —— 支持配置 npm registry 镜像与 HTTP(S) 代理，
  安装、更新检查与更新全部携带对应参数，保存后无需重启应用。
- **桌面自更新** —— 通过 electron-updater 支持增量更新（blockmap），窗口
  内可见下载进度。
- **安全约束** —— 渲染进程全沙箱 + 上下文隔离，导航白名单锁定本机 DSH 与
  deepseek.com 域，外部链接交给系统浏览器；日志对令牌/密钥做脱敏处理。

## 快速开始

1. 从 [Releases](https://github.com/zxjzxjqaq/dsh-desktop/releases) 下载最新的
   `DSH-Desktop-x.y.z-Setup.exe`；
2. 双击运行安装向导，选择安装目录；
3. 启动后等待首次解压与 DSH 服务就绪（仅第一次），之后即常驻托盘；
4. 关闭窗口只是最小化到托盘，DSH 继续在后台运行；右键托盘图标选择
   “退出”才完全退出。

## 界面一览

工作区采用双标签布局：

| 标签 | 内容 |
| --- | --- |
| DSH 工作区 | 本机运行的 DeepSeek Harness Web UI（默认） |
| DeepSeek 对话 | chat.deepseek.com 官方页面 |

顶部工具栏实时显示：

- DSH 服务状态：`运行中` / `响应异常` / `正在恢复…` / `需要重启`（失败时出现
  “重启 DSH”按钮）；
- 更新状态：新版本发现、后台准备与应用进度。

## DSH 更新与回滚

菜单 **帮助 → 检查 DSH 更新** 读取 npm `latest` dist-tag（使用设置中的镜像
与代理），将新版本安装到独立版本目录——整个过程不触碰正在运行的服务。
切换采用两段式：

```text
prepare：后台下载并校验新版本        （随时可做，不影响当前会话）
apply  ：写入选中指针 → 原地重启 → 健康检查
         └─ 验证失败 ⇒ 自动回滚上一版本并再次原地重启
```

- 新版本就绪后会弹出通知，可“立即重启生效”或稍后在菜单里应用；
- 开启“自动应用”后下载完成即自动切换生效；
- 默认每 6 小时定时检查（可配置间隔或关闭），仅在发现新版本时通知；
- 菜单 **帮助 → 回滚到上一个 DSH 版本** 可随时手动回退；
- **帮助 → 管理 DSH 版本…** 列出所有已装版本与磁盘占用，可一键清理
  （默认保留最近 3 个，当前版本与回滚目标永不删除）。

## 看门狗无感重启

运行中的 DSH 由 `DshSupervisor`（src/main/supervisor.ts）持续守护：

- 每 5 秒单次探测 Web 健康（无抛错，附带失败原因）；
- 连续 3 次探测失败或进程意外退出时**原地重启**：停掉进程树 → 重新拉起当前
  选中版本 → 等待健康 → 自动重载 DSH 视图。窗口、工具栏与 DeepSeek 会话
  全程不受影响；
- 60 秒滑动窗口内最多自动重启 3 次，超过后进入“需要重启”状态，由工具栏
  按钮或菜单手动恢复；
- 更新流程进行中看门狗自动让位，绝不与服务生命周期争抢。

## 数据与日志

所有数据保存在 `%LOCALAPPDATA%\DSH-Desktop`（无空格路径，规避 npm
`--prefix` 的已知问题）：

```text
DSH-Desktop/
├─ dsh/
│  ├─ versions/<version>/    # 每个 DSH 版本一个独立目录
│  ├─ node/<version>/        # 捆绑 Node.js 运行时
│  ├─ current.json           # 当前选中的版本指针
│  ├─ previous.json          # 上一个健康版本（回滚目标）
│  └─ staging/               # 下载/更新的临时暂存区
├─ settings.json             # 更新开关、镜像与代理等
└─ logs/                     # desktop / dsh / updater 三类日志，保留 14 天
```

应用菜单可直接打开日志目录。删除用户数据前请先从托盘完全退出程序。

## 面向开发者

### 运行要求

与最终用户不同，构建本仓库需要本地具备开发工具链：

- Windows 10/11 x64；
- Node.js `^22.19.0` 或 `>=24.0.0`（含 npm）；
- 国内网络建议先配置镜像：`npm config set registry https://registry.npmmirror.com`。

### 常用命令

```powershell
npm.cmd ci                    # 安装依赖
npm.cmd run dev               # 开发模式（ELECTRON_RENDERER_URL 热更新）
npm.cmd run typecheck         # 主/预加载/渲染三层 TS 类型检查
npm.cmd test                  # vitest 单元测试（含少量端到端集成用例）
npm.cmd run build             # 仅产出 out/ 打包产物

# 构建 Windows 安装包（首次会下载 Node 运行时并安装 DSH 运行时，需数分钟）
npm.cmd run dist:win
```

构建脚本内部统一使用 `%SystemRoot%\System32\tar.exe`（bsdtar）处理归档，
因此在 Git Bash 终端下也能正常执行。

### 项目结构

```text
src/
├─ main/                      # Electron 主进程
│  ├─ app.ts                  # 入口：IPC、生命周期、调度器装配
│  ├─ startup-orchestrator.ts # 启动/重启编排（restart 动态解析当前选择）
│  ├─ supervisor.ts           # 看门狗（退避、让位、状态推送）
│  ├─ dsh-package-manager.ts  # 版本存储/选择指针/回滚链/磁盘清理
│  ├─ dsh-updater.ts          # DSH 两段式更新（prepare/apply/rollback）
│  ├─ dsh-runtime-installer.ts# npm 安装 + legacy-peer-deps 缺失依赖修复
│  ├─ runtime-extractor.ts    # 内置运行时解压（SHA-256 校验 + 进度上报）
│  └─ platform/               # 进程执行树、端口探测、tar 解压、原子 JSON 等
├─ preload/                   # contextBridge IPC 桥（shell / startup）
└─ renderer/                  # startup 引导屏与 shell 工具栏 UI
scripts/                      # 构建期：准备内置运行时、发布校验脚本
tests/unit/                   # vitest 单元测试
docs/                         # 设计稿、计划与验证记录（按时间线归档）
```

### 架构要点

- **服务生命周期单一所有权**：DshServiceManager 负责进程树的拉起与停止；
  orchestrator 编排启动/重启；supervisor 只负责“是否需要重启”的判定并在
  更新期间让位，避免多方争抢同一进程。
- **每次重启都重新解析选择**：restart 从 current.json 出发重新校验出可运行
  实例，保证 apply/rollback 之后的服务重启拿到的是刚切换的版本（这也是
  v0.2.5 修复的核心问题）。
- **防篡改的版本存储**：所有选择必须位于受管版本目录内并通过包名/版本/
  二进制存在性校验；tar 解压拒绝绝对路径与 `..` 穿越；JSON 一律原子写盘，
  损坏的指针文件会被降级为“未选择”而不是卡死启动。
- **可靠 npm 安装**：npm 11 在该依赖图上的 peer 解析会挂起，安装器先用
  `--legacy-peer-deps` 快速落地再扫描补齐缺失 peer，最多三轮兜底。

### 测试与环境变量

完整校验链路：

```powershell
npm.cmd run verify:real-dsh        # 隔离端口 39831 实测安装+启动+探活
npm.cmd run verify:bundled-node    # 模拟无系统 Node 的 PATH 验证捆绑链路
npm.cmd run verify:update-feed     # 校验更新源元数据
```

测试专用环境变量（打包版不受影响）：

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_TRAY=1` | 开发模式下启用托盘常驻 |
| `DSH_DESKTOP_UPDATE_URL` | 覆盖桌面更新源地址 |
| `DSH_DESKTOP_TEST_MODE=1` | 允许自定义端口/数据目录/自动退出 |
| `DSH_DESKTOP_DATA_ROOT` | 测试模式下的用户数据目录 |
| `DSH_DESKTOP_PORT` | 测试模式下的 DSH 端口（默认 3080） |
| `DSH_DESKTOP_AUTO_EXIT_MS` | 测试模式下自动退出毫秒数 |
| `DSH_DESKTOP_SCREENSHOT` | 测试模式下保存启动截图的路径 |

### 发布流程

推送 `v*` 格式的 tag 即可，GitHub Actions 会自动完成类型检查、测试、构建
NSIS 安装包并创建 Release（附 `latest.yml` 与 blockmap）。发布说明读取
`docs/release-notes/<tag>.md`（如不存在则回退到 v0.2 设计文档）。正式分发前
应在 CI 中配置 Windows 代码签名证书（当前构建未签名）。

## 文档索引

设计与实施记录按时间线存放在 `docs/`，入口见
[`docs/README.md`](docs/README.md)：v0.1 原始设计、v0.2（捆绑 Node /
归档运行时 / 托盘 / 向导安装）设计与实施计划、各阶段实测验证记录、以及
v0.2.5 更新修复说明（`docs/release-notes/`、`docs/verification/`）。

## License

[MIT](LICENSE)
