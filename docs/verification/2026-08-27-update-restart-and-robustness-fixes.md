# 2026-08-27 修复记录：DSH 更新重启生效与健壮性加固

针对 v0.2.4 代码评审发现的问题，本次提交包含以下修复。全部改动通过
`npm run typecheck`、`npm test`（22 个文件 / 85 个用例）与 `npm run build`。

## P0：更新“应用”后实际重启的仍是旧版本

**根因**：`StartupOrchestrator.restart()` 直接使用启动时缓存的
`this.install`（旧版本）。`DshUpdater.apply()` / `rollback()` 通过
`packages.select()` 或 `restorePrevious()` 重写 current.json 后调用的却是
这条缓存路径——表面报告更新/回滚成功，实际进程树里跑的仍是启动时那个
版本；“新版本健康验证失败自动回滚”也因此从未真正验证过新版本。

**修复**（src/main/startup-orchestrator.ts）：

- 从 `resolveInstall()` 拆出静默解析核心 `resolveInstalledSelection()`
  （优先 current.json 校验，其次捆绑运行时回退；不带任何启动界面消息，
  避免 restart 在工作区可见后误创建 startup 窗口）；
- `restart()` 每次先停掉现有服务树，再重新解析当前选择并刷新
  `this.install`，之后才按既有重试逻辑拉起新服务。

**回归测试**：tests/unit/startup-orchestrator-restart.spec.ts 以真实
DshPackageManager + 假服务桩复现 apply→restart 与 rollback→restart
两条链路，断言拉起的 binaryPath 来自最新 selection。

## P1：registry / 代理设置不即时生效；检查更新不走镜像

- `DshUpdater` 的 installOptions 现在接受 getter（app.ts 传入
  `() => settingsSnapshot()` 快照读取器），菜单保存设置后立即对后续
  prepare/check 生效，无需重启应用；
- `check()`（npm view dist-tags）现在同样携带
  `--registry` / `--proxy` / `--https-proxy` 参数；
- 三个参数拼装逻辑收敛到 dsh-runtime-installer.ts 导出的
  `npmNetworkArguments()`，安装与检查共用一份实现。

## P2：健壮性

- **损坏指针不再卡死启动**：atomic-json.ts `readJson` 对 JSON 解析失败
  返回 null（与 ENOENT 同等对待），current.json / previous.json /
  runtime-manifest.json 损坏时按“无选择/需重解压”降级处理而非永久报错；
- **启动失败的 serviceRunning 幽灵状态**：service.start() 失败路径上补
  `this.service = null`，第二次实例唤起（wakeApp）能正确触发重新尝试而
  不是只弹窗口；
- **通知点击“立即重启生效”缺 catch**：补 `.catch` 并以系统通知提示失败，
  消除 unhandled rejection 静默失败；
- **测试模式跳过 legacy 数据迁移**：migrateLegacyUserData 在
  DSH_DESKTOP_TEST_MODE=1 时直接返回，避免把真实用户数据搬进测试目录。

## P3：构建/测试对 PATH 上 tar 的依赖

Windows 上统一使用绝对路径 `%SystemRoot%\System32\tar.exe`（bsdtar），
从 tar-extract.ts 导出 `resolveTarExecutable()` 供复用：

- scripts/prepare-node-runtime.ts、scripts/prepare-bundled-dsh.ts
  （此前在 Git Bash 环境下 GNU tar 会把 `C:\...` 当远程主机、也无法读 zip）；
- tests/unit/tar-extract.spec.ts、runtime-extractor.spec.ts、
  dsh-package-manager.spec.ts 的夹具压缩助手（修复了 Git Bash 下
  npm test 失败 10 个用例的环境问题）。

生产代码运行时解压路径未变（其本就使用 System32 绝对路径探测 + 回退）。
