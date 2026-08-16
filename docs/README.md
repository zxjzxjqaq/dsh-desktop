# DSH Desktop 文档索引

按时间线组织的设计、实施计划与验证记录。新成员从 **v0.2 设计** 开始读，
再对照 **v0.2 实施计划** 了解代码结构。

## 设计（specs）

| 文档 | 说明 |
| --- | --- |
| [`2026-08-14-dsh-desktop-design.md`](superpowers/specs/2026-08-14-dsh-desktop-design.md) | v0.1 原始设计：Windows 桌面壳、系统 Node.js 检测、DSH 版本管理与回滚、更新源 |
| [`2026-08-16-dsh-desktop-v0.2-design.md`](superpowers/specs/2026-08-16-dsh-desktop-v0.2-design.md) | **当前主线设计**：捆绑 Node.js、归档化运行时首启解压、向导式安装、托盘常驻、安装提速 |
| [`2026-08-16-dsh-desktop-android-feasibility.md`](superpowers/specs/2026-08-16-dsh-desktop-android-feasibility.md) | Android APK 迁移可行性评估（独立话题，未实施） |

## 实施计划（plans）

| 文档 | 说明 |
| --- | --- |
| [`2026-08-14-dsh-desktop-implementation.md`](superpowers/plans/2026-08-14-dsh-desktop-implementation.md) | v0.1 实施计划（已交付） |
| [`2026-08-16-dsh-desktop-v0.2.md`](superpowers/plans/2026-08-16-dsh-desktop-v0.2.md) | v0.2 实施计划：13 个任务，每任务含完整代码与 TDD 步骤（已交付） |

## 验证记录（verification）

| 文档 | 说明 |
| --- | --- |
| [`2026-08-14-windows-x64.md`](verification/2026-08-14-windows-x64.md) | Windows x64 实测记录（v0.1） |
| `dsh-desktop-implementation.patch.gz` | v0.1 实施补丁存档 |

## 代码地图（快速定位）

- `src/main/` — Electron 主进程：`app.ts`（装配）、`startup-orchestrator.ts`（启动流程）、
  `dsh-package-manager.ts`（版本存储）、`runtime-extractor.ts`（归档解压缓存）、
  `tray-controller.ts`（托盘）、`window-controller.ts`（窗口）
- `src/main/platform/` — 平台原语：`tar-extract.ts`（解包器）、`process-tree.ts`、
  `port-inspector.ts`、`atomic-json.ts`
- `src/shared/` — 主进程/渲染进程共享：`config.ts`（版本常量单源）、`contracts.ts`、`startup-state.ts`
- `scripts/` — 构建与验证：`prepare-node-runtime.ts`、`prepare-bundled-dsh.ts`、
  `after-pack.cjs`、`verify-bundled-node.ts`
- `tests/unit/` — Vitest 单测（18 个文件）
