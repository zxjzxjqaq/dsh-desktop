# DSH Desktop for Windows Implementation Plan

> Implementation note (2026-08-14): on the verified Windows/Node 24 runtime,
> direct `child_process.spawn()` of `npm.cmd` returned `EINVAL`. The completed
> implementation still discovers npm with `where.exe npm.cmd`, then invokes the
> adjacent `node_modules/npm/bin/npm-cli.js` through the validated `node.exe`.
> This note supersedes the direct-`npm.cmd` runtime calls described below; shell
> verification commands continue to use `npm.cmd`.

## Objective

Implement the approved DSH Desktop design as a Windows x64 Electron application
that uses the system Node.js installation, manages versioned DSH packages,
starts and embeds the unchanged DSH Web UI, closes the full DSH process tree,
and verifies both desktop and DSH update workflows.

The approved design is:

`docs/superpowers/specs/2026-08-14-dsh-desktop-design.md`

## Locked Initial Toolchain

Use npm with a committed `package-lock.json`. Lock these direct dependencies at
the versions inspected on 2026-08-14:

| Package | Version | Role |
| --- | ---: | --- |
| `electron` | `43.4.0` | Desktop runtime |
| `electron-vite` | `5.0.0` | Main, preload, and renderer builds |
| `electron-builder` | `26.15.3` | Windows NSIS packaging |
| `electron-updater` | `6.8.9` | Desktop update client |
| `typescript` | `7.0.2` | Type checking |
| `vite` | `7.3.6` | Startup renderer build; latest release accepted by electron-vite 5 |
| `vitest` | `4.1.10` | Unit and integration tests |
| `@playwright/test` | `1.62.1` | Packaged UI smoke tests |
| `semver` | `7.8.5` | Node, application, and DSH version rules |
| `@types/semver` | `7.8.0` | SemVer type declarations |
| `@types/node` | `26.2.0` | Node.js type declarations |
| `sharp` | `0.35.3` | Render the icon SVG at required ICO sizes |
| `png-to-ico` | `3.0.2` | Assemble the Windows ICO artifact |

Pin the initial managed DSH version to `0.1.0-rc.6` and the accepted system
Node.js range to `^22.19.0 || >=24.0.0`.

## Implementation Rules

- Complete tasks in order; later tasks depend on interfaces introduced earlier.
- Write the failing focused test before each behavior implementation.
- Run the focused test after every behavior change.
- Run `npm.cmd run typecheck` and `npm.cmd test` before each task commit.
- Use `npm.cmd`, never the PowerShell `npm` alias.
- Spawn all executables with an argument array and `shell: false`.
- Keep privileged logic in the Electron main process.
- Never expose Electron APIs to the DSH renderer.
- Do not add a custom DSH interface or modify upstream DSH assets.
- Record packaged verification commands, literal outputs, and exit statuses.

## Task 1: Scaffold the Electron TypeScript Application

### Files

- Create `package.json`.
- Create `package-lock.json` through npm.
- Create `electron.vite.config.ts`.
- Create `tsconfig.json`.
- Create `tsconfig.node.json`.
- Create `tsconfig.web.json`.
- Create `src/main/app.ts`.
- Create `src/preload/startup.ts`.
- Create `src/renderer/startup/index.html`.
- Create `src/renderer/startup/startup.ts`.
- Create `src/renderer/startup/startup.css`.
- Create `tests/unit/smoke.spec.ts`.
- Create `.gitignore`.

### Steps

1. Initialize npm metadata with product name `DSH Desktop`, package name
   `dsh-desktop`, version `0.1.0`, ESM modules, and main entry
   `out/main/app.js`.
2. Install the locked runtime and development dependencies.
3. Configure electron-vite with separate main, preload, and startup renderer
   entries.
4. Configure strict TypeScript with `noImplicitAny`, `noUncheckedIndexedAccess`,
   separate DOM and Node compilation faces, and root project references.
5. Add scripts:
   - `dev`: start electron-vite development mode;
   - `build`: build all Electron faces;
   - `typecheck`: run `tsc --noEmit` separately across both TypeScript faces;
   - `test`: run Vitest once;
   - `test:watch`: run Vitest in watch mode;
   - `test:e2e`: run Playwright tests;
   - `dist:win`: build and package Windows x64; and
   - `update:serve`: run the local update server built later.
6. Create the smallest startup page showing `Starting DSH Desktop`.
7. Create a main process that opens only the local startup renderer.
8. Add a smoke test importing one shared constant so the test pipeline proves
   TypeScript path resolution.

### Verification

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Expected result: all commands exit 0 and `out/main`, `out/preload`, and
`out/renderer` exist.

### Commit

```text
chore: scaffold Electron desktop application
```

## Task 2: Define Shared Contracts, Configuration, and Startup States

### Files

- Create `src/shared/config.ts`.
- Create `src/shared/contracts.ts`.
- Create `src/shared/startup-state.ts`.
- Create `tests/unit/startup-state.spec.ts`.
- Create `tests/unit/config.spec.ts`.

### Steps

1. Define constants for:
   - product name `DSH Desktop`;
   - loopback host `127.0.0.1`;
   - DSH port `3080`;
   - initial DSH version `0.1.0-rc.6`;
   - Node.js compatibility range;
   - startup and shutdown deadlines; and
   - log retention of 14 days.
2. Define discriminated startup states for checking the environment, preparing
   DSH, starting DSH, waiting for health, showing DSH, restarting once, and the
   three error categories.
3. Define serializable renderer status events and narrow startup actions.
4. Implement an exhaustive state transition reducer with `assertNever`.
5. Test every permitted transition and reject invalid state transitions.
6. Test that the DSH URL is constructed only from the fixed loopback host and
   fixed port.

### Verification

```powershell
npm.cmd test -- tests/unit/startup-state.spec.ts tests/unit/config.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: define desktop startup contracts
```

## Task 3: Add Application Paths and Redacting Logs

### Files

- Create `src/main/platform/app-paths.ts`.
- Create `src/main/logging.ts`.
- Create `tests/unit/app-paths.spec.ts`.
- Create `tests/unit/logging.spec.ts`.

### Steps

1. Derive DSH versions, staging, pointer, and log paths from Electron's
   `app.getPath('userData')` through a pure path factory.
2. Reject any version path component that is not valid SemVer.
3. Implement daily desktop, DSH, and updater logs.
4. Redact case-insensitive credential assignments for `api_key`, `apikey`,
   `authorization`, `token`, and `secret`, plus bearer values.
5. Never log the inherited environment or full process objects.
6. Delete log files older than 14 days at startup without failing application
   startup when an individual stale file cannot be removed.
7. Test paths containing spaces and Chinese characters.
8. Test redaction with values in JSON, environment-style assignments, headers,
   and free-form DSH stderr.

### Verification

```powershell
npm.cmd test -- tests/unit/app-paths.spec.ts tests/unit/logging.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: add app storage and redacted logging
```

## Task 4: Implement the Process Runner and Node Environment Detector

### Files

- Create `src/main/platform/process-runner.ts`.
- Create `src/main/node-environment.ts`.
- Create `tests/unit/process-runner.spec.ts`.
- Create `tests/unit/node-environment.spec.ts`.
- Create `tests/fixtures/bin/fake-node.cmd`.
- Create `tests/fixtures/bin/fake-npm.cmd`.

### Steps

1. Implement an injectable process runner that captures stdout, stderr, exit
   status, timeout, and spawn errors without using a shell.
2. Implement executable discovery with `where.exe node` and
   `where.exe npm.cmd`.
3. Select the first discovered executable that can be executed successfully.
4. Parse `node --version` with SemVer and enforce the configured compatibility
   range.
5. Call `npm.cmd --version` to distinguish a missing or unusable npm install.
6. Return typed results for missing Node, missing npm, incompatible Node, failed
   execution, and a valid environment.
7. Test multiple `where.exe` results, paths containing spaces, malformed output,
   timeouts, nonzero statuses, and the exact accepted version boundaries.
8. Add an integration assertion using this workstation's actual `node.exe` and
   `npm.cmd`; allow the test to skip only when the machine genuinely lacks them.

### Verification

```powershell
npm.cmd test -- tests/unit/process-runner.spec.ts tests/unit/node-environment.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: detect compatible system Node and npm
```

## Task 5: Implement Atomic DSH Version Storage

### Files

- Create `src/main/platform/atomic-json.ts`.
- Create `src/main/dsh-package-manager.ts`.
- Create `tests/unit/atomic-json.spec.ts`.
- Create `tests/unit/dsh-package-manager.spec.ts`.
- Create `tests/fixtures/dsh-package/package.json`.
- Create `tests/fixtures/dsh-package/lib/bin.js`.

### Steps

1. Implement atomic JSON replacement through a sibling temporary file, flush,
   close, and rename.
2. Define validated `current.json` and `previous.json` records containing DSH
   version, installation path, install time, and last successful health time.
3. Implement staging directory creation with a random suffix inside the fixed
   staging root.
4. Invoke the resolved `npm.cmd` with argument arrays to install an exact DSH
   release using the approved flags.
5. Validate npm exit status, package manifest name, exact version, declared
   `dsh` binary, and resolved binary containment inside the package directory.
6. Move a validated staging installation into the immutable version directory.
7. If the target version already exists, validate and reuse it rather than
   mutating it.
8. Clean abandoned staging directories older than one day.
9. Implement current/previous selection and explicit manual rollback selection.
10. Test interrupted pointer writes, malformed JSON, traversal attempts,
    mismatched package versions, missing binaries, failed npm installs, and
    reuse of an existing valid release.

### Verification

```powershell
npm.cmd test -- tests/unit/atomic-json.spec.ts tests/unit/dsh-package-manager.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: manage versioned DSH installations
```

## Task 6: Implement Port Inspection and DSH Health Checks

### Files

- Create `src/main/platform/port-inspector.ts`.
- Create `src/main/dsh-health.ts`.
- Create `tests/unit/port-inspector.spec.ts`.
- Create `tests/unit/dsh-health.spec.ts`.
- Create `tests/integration/dsh-health.integration.spec.ts`.

### Steps

1. Check loopback port availability by attempting an exclusive listener bind and
   immediately closing it.
2. When occupied, query Windows TCP ownership and return a PID when the operating
   system exposes one; ownership lookup failure must not hide the conflict.
3. Poll the fixed DSH URL with a bounded request timeout and overall startup
   deadline.
4. Require HTTP success, an HTML content type, and pinned-release DSH markers.
5. During implementation, run the pinned `0.1.0-rc.6` package once, capture the
   literal root response, and commit the minimal stable marker fixture used by
   the checker.
6. Reject unrelated HTTP 200 pages, redirects away from the loopback origin,
   non-HTML responses, and late responses.
7. Test a real temporary loopback server for healthy, unhealthy, timeout, and
   occupied-port behavior.

### Verification

```powershell
npm.cmd test -- tests/unit/port-inspector.spec.ts tests/unit/dsh-health.spec.ts
npm.cmd test -- tests/integration/dsh-health.integration.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: verify the local DSH web service
```

## Task 7: Implement DSH Process Lifecycle Management

### Files

- Create `src/main/platform/process-tree.ts`.
- Create `src/main/dsh-service-manager.ts`.
- Create `tests/unit/process-tree.spec.ts`.
- Create `tests/unit/dsh-service-manager.spec.ts`.
- Create `tests/fixtures/services/healthy-dsh.mjs`.
- Create `tests/fixtures/services/crashing-dsh.mjs`.
- Create `tests/fixtures/services/hanging-dsh.mjs`.
- Create `tests/integration/dsh-service-manager.integration.spec.ts`.

### Steps

1. Spawn the validated DSH binary with system Node.js, `web`, and
   `%USERPROFILE%` as the working directory.
2. Capture stdout and stderr into the redacting DSH logger.
3. Couple process survival with the HTTP health deadline.
4. Emit typed lifecycle events for starting, ready, early exit, timeout, crash,
   stopping, and stopped.
5. Implement one automatic restart for an unexpected runtime exit.
6. Stop gracefully first, then use Windows `taskkill.exe /PID`, `/T`, and `/F`
   after the deadline. Pass each token as a separate process argument.
7. Verify child exit and loopback port release before resolving shutdown.
8. Prevent two simultaneous DSH processes from being started by one application
   instance.
9. Test healthy startup, early crash, one-restart limit, hung shutdown, child
   descendants, and port release with fixture services.

### Verification

```powershell
npm.cmd test -- tests/unit/process-tree.spec.ts tests/unit/dsh-service-manager.spec.ts
npm.cmd test -- tests/integration/dsh-service-manager.integration.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: manage the DSH process lifecycle
```

## Task 8: Build Secure Startup and DSH Windows

### Files

- Create `src/main/window-controller.ts`.
- Create `src/main/navigation-policy.ts`.
- Update `src/preload/startup.ts`.
- Update `src/shared/contracts.ts`.
- Create `tests/unit/navigation-policy.spec.ts`.
- Create `tests/unit/window-controller.spec.ts`.

### Steps

1. Create the startup window with context isolation, sandboxing, Node integration
   disabled, a restrictive preload, and a packaged local renderer.
2. Expose only typed `retry`, `openNodeDownload`, `openLogs`, status subscription,
   and version query functions through `contextBridge`.
3. Validate the sender frame URL in every startup IPC handler.
4. Create the DSH window only after health succeeds, with no preload and no IPC
   bridge.
5. Copy startup window bounds to the DSH window, show it after readiness, and
   destroy the startup window.
6. Allow in-window navigation only to the exact loopback DSH origin.
7. Deny new Electron windows. Parse user-initiated links and send only `https:`
   URLs to the system browser.
8. Deny renderer permission requests by default.
9. Test renderer preferences, sender validation, navigation edge cases,
   deceptive URLs, non-HTTPS external URLs, and the absence of a DSH preload.

### Verification

```powershell
npm.cmd test -- tests/unit/navigation-policy.spec.ts tests/unit/window-controller.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: isolate startup and DSH renderer windows
```

## Task 9: Implement the Startup Orchestrator and Interface

### Files

- Create `src/main/startup-orchestrator.ts`.
- Update `src/main/app.ts`.
- Update `src/renderer/startup/index.html`.
- Update `src/renderer/startup/startup.ts`.
- Update `src/renderer/startup/startup.css`.
- Create `tests/unit/startup-orchestrator.spec.ts`.
- Create `tests/unit/startup-renderer.spec.ts`.

### Steps

1. Orchestrate environment validation, installed-version selection, first-run DSH
   installation, service startup, health checking, and window replacement.
2. Emit every transition through the shared startup state contract.
3. Render a compact startup card with the current step, elapsed time, latest
   redacted diagnostic, and progress indicator.
4. Render targeted error actions rather than a generic retry for every failure.
5. Implement `Install Node.js` as an external link to the official Node.js
   download page, followed by an explicit `Check again` action.
6. Add `Open logs`, `Retry`, and `Exit` actions where applicable.
7. Keep the startup UI keyboard accessible and usable at 125% and 150% Windows
   display scaling.
8. Test successful orchestration, every error mapping, retry behavior, repeated
   click suppression, and renderer output for each state.

### Verification

```powershell
npm.cmd test -- tests/unit/startup-orchestrator.spec.ts tests/unit/startup-renderer.spec.ts
npm.cmd run typecheck
npm.cmd run build
```

### Commit

```text
feat: add the DSH Desktop startup experience
```

## Task 10: Add the Shared Update Lock

### Files

- Create `src/main/update-lock.ts`.
- Create `tests/unit/update-lock.spec.ts`.

### Steps

1. Implement a non-reentrant, process-local mutex shared by desktop and DSH
   updates.
2. Return the active operation name when a second update is requested.
3. Always release the lock after synchronous errors, rejected promises, and user
   cancellation.
4. Expose whether shutdown is allowed, needs confirmation, or must wait for a
   version-pointer/install critical section.
5. Test every release path and verify that crash-restart requests wait while an
   update holds the lock.

### Verification

```powershell
npm.cmd test -- tests/unit/update-lock.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: serialize desktop and DSH updates
```

## Task 11: Implement DSH Update, Health Validation, and Rollback

### Files

- Create `src/main/dsh-updater.ts`.
- Create `src/main/dsh-failed-releases.ts`.
- Create `tests/unit/dsh-updater.spec.ts`.
- Create `tests/integration/dsh-update.integration.spec.ts`.

### Steps

1. Query npm dist-tags through the validated `npm.cmd` executable.
2. Parse and validate JSON output and compare the selected release with current
   DSH using SemVer.
3. Require explicit user confirmation before installing a discovered release.
4. Acquire the update lock and install into staging without changing the active
   release.
5. Stop DSH, atomically update previous/current pointers, and start the new
   release.
6. Commit the new selection only after the normal health check passes.
7. On failed health, stop the failed release, restore the previous pointer,
   restart the previous release, and report the literal rollback result.
8. Record failed release versions so automatic checks do not repeatedly prompt
   for the same unhealthy release. A manual check may retry it.
9. Implement manual rollback only when the previous installation revalidates.
10. Test no-update, malformed registry output, install failure, healthy update,
    unhealthy update with successful rollback, previous-release failure, and
    update-lock contention.

### Verification

```powershell
npm.cmd test -- tests/unit/dsh-updater.spec.ts
npm.cmd test -- tests/integration/dsh-update.integration.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: update and roll back DSH releases
```

## Task 12: Implement Desktop Updates and the Local Update Feed

### Files

- Create `src/main/app-updater.ts`.
- Create `src/main/update-window.ts`.
- Create `src/renderer/update/index.html`.
- Create `src/renderer/update/update.ts`.
- Create `src/renderer/update/update.css`.
- Create `scripts/local-update-server.ts`.
- Create `tests/unit/app-updater.spec.ts`.
- Create `tests/integration/local-update-server.integration.spec.ts`.
- Create `dev-app-update.yml`.

### Steps

1. Wrap `electron-updater` behind an injected update client interface so tests
   do not contact a real feed.
2. Disable automatic download; check after DSH reaches the ready state.
3. Show release version, notes, and size before download.
4. Report download progress through an isolated packaged update window.
5. Acquire the update lock before download and preserve it through the install
   decision.
6. On `Restart and install`, stop DSH, persist window state, and call
   `quitAndInstall`.
7. On `Later`, release the lock and retain the staged update.
8. Serve only the configured update artifact directory from a loopback-only
   development HTTP server. Reject traversal and directory listing.
9. Configure packaged development builds to use the local generic provider.
10. Ensure production configuration does not accept the insecure loopback feed.
11. Test event translation, confirmation, progress, errors, cancellation, lock
    behavior, shutdown ordering, static artifact serving, and traversal rejection.

### Verification

```powershell
npm.cmd test -- tests/unit/app-updater.spec.ts
npm.cmd test -- tests/integration/local-update-server.integration.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: add desktop updates with a local test feed
```

## Task 13: Add Menus, Single-instance Behavior, and Shutdown Coordination

### Files

- Create `src/main/app-menu.ts`.
- Create `src/main/shutdown-coordinator.ts`.
- Update `src/main/app.ts`.
- Create `tests/unit/app-menu.spec.ts`.
- Create `tests/unit/shutdown-coordinator.spec.ts`.

### Steps

1. Acquire the single-instance lock before creating windows or DSH processes.
2. Focus and restore the existing window on a second-instance event.
3. Add Help menu commands for desktop update, DSH update, DSH versions, manual
   rollback, logs, and About.
4. Disable menu commands when their preconditions are not satisfied.
5. Route all close and quit events through one shutdown coordinator.
6. Ask for confirmation only when an update download can be safely cancelled.
7. Delay close through update critical sections, stop DSH, verify port release,
   and then exit.
8. Prevent recursive close handling when Electron is already in the final exit
   phase.
9. Test second-instance focusing, menu enablement, download confirmation,
   critical-section waiting, DSH stop ordering, and repeated quit events.

### Verification

```powershell
npm.cmd test -- tests/unit/app-menu.spec.ts tests/unit/shutdown-coordinator.spec.ts
npm.cmd run typecheck
```

### Commit

```text
feat: complete Windows application lifecycle
```

## Task 14: Configure the Windows Installer and Application Identity

### Files

- Create `electron-builder.yml`.
- Create `build/icon.svg`.
- Create `build/icon.ico` from the committed SVG source.
- Create `scripts/build-icon.mjs`.
- Update `package.json`.
- Create `tests/unit/builder-config.spec.ts`.

### Steps

1. Use application ID `com.dsh.desktop` and product name `DSH Desktop`.
2. Create a neutral blue `DSH` monogram development icon that does not copy
   upstream trademarks; commit both its SVG source and generated ICO artifact.
3. Configure an x64, per-user, one-click NSIS installer with desktop and Start
   Menu shortcuts.
4. Generate updater metadata and blockmap artifacts.
5. Package only runtime output and required dependencies; exclude tests, source
   maps from production, local logs, and update feed artifacts.
6. Ensure application data remains under the user's profile during upgrades and
   uninstall does not delete DSH data without an explicit future option.
7. Add a configuration test asserting product identity, per-user installation,
   x64 target, artifact naming, and updater metadata generation.

### Verification

```powershell
npm.cmd test -- tests/unit/builder-config.spec.ts
npm.cmd run build
npm.cmd run dist:win
```

Expected artifacts include the NSIS setup executable, blockmap, and
`latest.yml` under `dist`.

### Commit

```text
build: package the Windows desktop installer
```

## Task 15: Add Packaged Smoke and Update Tests

### Files

- Create `tests/e2e/desktop-startup.spec.ts`.
- Create `tests/e2e/desktop-shutdown.spec.ts`.
- Create `tests/e2e/desktop-update.spec.ts`.
- Create `tests/e2e/dsh-update-rollback.spec.ts`.
- Create `tests/e2e/helpers/packaged-app.ts`.
- Create `tests/e2e/helpers/process-audit.ts`.
- Create `scripts/create-update-fixture.ts`.

### Steps

1. Launch the packaged application with isolated temporary user data.
2. Inject fixture Node/npm and DSH services through a test-only packaged
   configuration that is rejected outside test builds.
3. Verify every startup state and the transition to a healthy DSH page.
4. Close the app and assert that fixture DSH descendants exit and port 3080 is
   free.
5. Build version `0.1.0`, install it, serve a generated `0.1.1` update feed, and
   verify download, restart, and the reported application version.
6. Exercise a healthy fixture DSH update.
7. Exercise an unhealthy fixture DSH update and assert that the previous fixture
   release is running afterward.
8. Save literal command lines, exit statuses, process lists, port checks, and
   application version outputs into a timestamped verification record.

### Verification

```powershell
npm.cmd run dist:win
npm.cmd run test:e2e
```

### Commit

```text
test: verify packaged startup updates and rollback
```

## Task 16: Produce Release Documentation and Final Verification

### Files

- Create `README.md`.
- Create `docs/development.md`.
- Create `docs/release.md`.
- Create `docs/verification/windows-x64.md`.
- Create `scripts/verify-release.ps1`.

### Steps

1. Document prerequisites, Node.js compatibility, installation, first launch,
   update commands, log locations, data locations, and uninstall behavior.
2. Document development commands and the reason Windows automation uses
   `npm.cmd`.
3. Document how to build two local versions and exercise the desktop update feed.
4. Document the later GitHub Releases and Windows signing transition without
   enabling it in the first release.
5. Implement a non-destructive release verification script that runs typecheck,
   unit/integration tests, build, package inspection, and packaged smoke tests.
6. Record the exact baseline and packaged verification commands, inputs, literal
   outputs, exit statuses, artifact hashes, observed DSH version, update result,
   rollback result, process audit, and port audit.
7. Reopen the installer, update metadata, verification record, and rollback logs
   to confirm every referenced artifact exists and is readable.

### Verification

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify-release.ps1
git diff --check
git status --short
```

Expected result: the verification script and `git diff --check` exit 0, and the
only uncommitted files before the final commit are the intended documentation
and verification record.

### Commit

```text
docs: document and verify the Windows release
```

## Final Deliverables

The implementation is complete only when these verified roles exist:

1. Windows x64 NSIS installer and installed application.
2. Desktop update metadata, update artifact, and local update server command.
3. Versioned DSH store with a verified current release and previous-release
   rollback.
4. A single Windows verification record containing exact commands, inputs,
   literal outputs, exit statuses, SHA-256 hashes, both update behaviors, DSH
   process-tree shutdown evidence, and port-release evidence.

The final implementation report must name the absolute paths of all four roles,
the desktop versions exercised, the DSH versions exercised, the successful
desktop update result, the successful DSH update result, the failed-update
rollback result, and the final process/port audit.
