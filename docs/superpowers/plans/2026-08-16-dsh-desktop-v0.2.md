# DSH Desktop v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DSH Desktop v0.2: bundled Node.js runtime (no system Node required), fast installer via archived runtimes with first-launch extraction, assisted install with user-chosen directory, and tray-resident mode where closing the window hides to tray and only the tray "Exit" fully quits.

**Architecture:** Two single-file `tar.gz` archives (Node LTS + DSH runtime) ship inside `resources/`; on first launch a new `RuntimeExtractor` extracts them into the per-user data directory (cached via manifest, reused on later launches). Node detection prefers the extracted bundled runtime, falling back to the system. A new `TrayController` owns the tray icon, close-to-hide policy, and the quit path. `electron-builder.yml` switches NSIS to assisted mode with a changeable install directory.

**Tech Stack:** Electron 43, TypeScript 7 (strict, NodeNext ESM), Vitest 4, electron-builder 26, Windows `tar.exe` (bsdtar) for archive creation, Node built-in `node:zlib` for extraction.

**Spec:** `docs/superpowers/specs/2026-08-16-dsh-desktop-v0.2-design.md`

---

## File Map

**New files:**
- `src/main/platform/tar-extract.ts` — dependency-free tar.gz extractor (gzip via `node:zlib`, tar header parsing, path-traversal protection)
- `src/main/runtime-extractor.ts` — extracts bundled Node/DSH archives into the per-user data directory with manifest caching
- `src/main/tray-controller.ts` — tray icon, context menu (pure `buildTrayMenuTemplate`), close-to-hide notification
- `scripts/prepare-node-runtime.ts` — downloads Node LTS zip, verifies SHA256, repackages as single tar.gz, writes `.artifacts/archives/manifest.json`
- `scripts/verify-bundled-node.ts` — end-to-end check of bundled Node + bundled DSH on a simulated Node-less machine
- `tests/unit/tar-extract.spec.ts`, `tests/unit/runtime-extractor.spec.ts`, `tests/unit/tray-controller.spec.ts`

**Modified files:**
- `src/shared/config.ts` — add `BUNDLED_NODE_VERSION`
- `src/shared/contracts.ts` — add `preparing-runtime` startup phase
- `src/shared/startup-state.ts` — phase transition for `preparing-runtime`
- `src/main/platform/app-paths.ts` — add `nodeRuntimes` path
- `src/main/node-environment.ts` — bundled-first detection, `source` field
- `src/main/dsh-package-manager.ts` — replace `bundledDirectory` with `RuntimeExtractor`; add `restoreBundled()`
- `src/main/startup-orchestrator.ts` — runtime extraction phase, new fallback order, log Node source
- `src/main/window-controller.ts` — close-to-hide hook, DeepSeek tab background preload
- `src/main/app.ts` — assemble TrayController, tray-gated `window-all-closed` and close policy
- `src/main/app-menu.ts` — About dialog shows Node source
- `src/preload/startup.ts`, `src/renderer/startup/startup.ts` — pass through new phase (no logic change)
- `scripts/prepare-bundled-dsh.ts` — also emit `dsh-runtime-<version>.tar.gz` + merged manifest
- `scripts/after-pack.cjs` — copy the two archives + write `resources/runtime-manifest.json` (no hardcoded version)
- `electron-builder.yml` — assisted NSIS with changeable directory
- `package.json` — v0.2.0, `prepare:node-runtime`, `verify:bundled-node`, updated `dist:win`/`release:github`
- `tests/unit/startup-state.spec.ts`, `tests/unit/node-environment.spec.ts`, `tests/unit/dsh-package-manager.spec.ts`, `tests/unit/builder-config.spec.ts`, `tests/unit/app-paths.spec.ts`
- `README.md` — document new behavior

---

## Task 1: Version constants, phase, paths

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/startup-state.ts`
- Modify: `src/main/platform/app-paths.ts`
- Test: `tests/unit/startup-state.spec.ts`, `tests/unit/app-paths.spec.ts`

- [ ] **Step 1: Add failing tests for the new phase transition and node-runtime path**

In `tests/unit/startup-state.spec.ts`, replace the first `it` block body's opening lines with:

```ts
  it('allows the normal startup path', () => {
    expect(canTransition('preparing-runtime', 'checking-node')).toBe(true)
    expect(canTransition('checking-node', 'preparing-dsh')).toBe(true)
    expect(canTransition('preparing-dsh', 'starting-dsh')).toBe(true)
    expect(canTransition('waiting-for-health', 'ready')).toBe(true)
  })
```

In `tests/unit/app-paths.spec.ts`, add inside the first `it`:

```ts
    expect(paths.nodeRuntimes).toBe('C:\\用户目录\\DSH Desktop Data\\dsh\\node')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/startup-state.spec.ts tests/unit/app-paths.spec.ts`
Expected: `canTransition('preparing-runtime', ...)` fails (`TRANSITIONS['preparing-runtime']` undefined), `paths.nodeRuntimes` undefined.

- [ ] **Step 3: Add the constant, phase, transition, and path**

In `src/shared/config.ts`, append:

```ts
export const BUNDLED_NODE_VERSION = '24.15.0'
```

In `src/shared/contracts.ts`, change the `StartupPhase` union to start with:

```ts
export type StartupPhase =
  | 'preparing-runtime'
  | 'checking-node'
```

In `src/shared/startup-state.ts`, change `TRANSITIONS` to:

```ts
const TRANSITIONS: Readonly<Record<StartupPhase, readonly StartupPhase[]>> = {
  'preparing-runtime': ['checking-node', 'environment-error'],
  'checking-node': ['preparing-dsh', 'environment-error'],
  'preparing-dsh': ['starting-dsh', 'package-error'],
  'starting-dsh': ['waiting-for-health', 'service-error'],
  'waiting-for-health': ['ready', 'service-error'],
  ready: ['starting-dsh', 'service-error'],
  'environment-error': ['checking-node'],
  'package-error': ['preparing-dsh'],
  'service-error': ['starting-dsh']
}
```

In `src/main/platform/app-paths.ts`, add `nodeRuntimes` to the interface and to `createAppPaths`:

```ts
export interface AppPaths {
  readonly root: string
  readonly versions: string
  readonly nodeRuntimes: string
  readonly staging: string
  readonly currentPointer: string
  readonly previousPointer: string
  readonly failedReleases: string
  readonly logs: string
}

export function createAppPaths(userData: string): AppPaths {
  const root = resolve(userData)
  const dsh = join(root, 'dsh')
  return {
    root,
    versions: join(dsh, 'versions'),
    nodeRuntimes: join(dsh, 'node'),
    staging: join(dsh, 'staging'),
    currentPointer: join(dsh, 'current.json'),
    previousPointer: join(dsh, 'previous.json'),
    failedReleases: join(dsh, 'failed-releases.json'),
    logs: join(root, 'logs')
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/startup-state.spec.ts tests/unit/app-paths.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/shared/config.ts src/shared/contracts.ts src/shared/startup-state.ts src/main/platform/app-paths.ts tests/unit/startup-state.spec.ts tests/unit/app-paths.spec.ts
git commit -m "feat: add bundled node version constant, preparing-runtime phase, node runtime path"
```

---

## Task 2: tar.gz extractor

**Files:**
- Create: `src/main/platform/tar-extract.ts`
- Test: `tests/unit/tar-extract.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tar-extract.spec.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractTarGz,
  resolveEntryPath
} from '../../src/main/platform/tar-extract.js'

const roots: string[] = []
async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tar-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (d) => await rm(d, { recursive: true, force: true })))
})

function createTarGz(sourceDir: string, archivePath: string): void {
  execFileSync('tar', ['-czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' })
}

describe('tar.gz extraction', () => {
  it('extracts nested files, empty dirs, and pax long names', async () => {
    const workspace = await root()
    const source = join(workspace, 'source')
    const longName = `deep/${'n'.repeat(120)}.txt`
    await mkdir(join(source, 'deep', 'empty'), { recursive: true })
    await writeFile(join(source, 'a.txt'), 'hello\n')
    await writeFile(join(source, longName), 'long\n')
    const archive = join(workspace, 'bundle.tar.gz')
    createTarGz(source, archive)
    const dest = join(workspace, 'dest')
    const entries = await extractTarGz(archive, dest, { stripComponents: 1 })
    expect(entries).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(await readFile(join(dest, longName), 'utf8')).toBe('long\n')
    await expect(stat(join(dest, 'deep', 'empty'))).resolves.toBeDefined()
  })

  it('rejects path traversal entries instead of writing them', async () => {
    const workspace = await root()
    const dest = join(workspace, 'dest')
    const name = '../../escape.txt'
    const header = Buffer.alloc(512)
    header.write(name.padEnd(100, '\0'), 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write('00000000005\0', 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    const data = Buffer.alloc(512)
    data.write('evil!', 0, 5, 'utf8')
    const tar = Buffer.concat([header, data, Buffer.alloc(1024)])
    const archive = join(workspace, 'malicious.tar.gz')
    await writeFile(archive, gzipSync(tar))

    const entries = await extractTarGz(archive, dest)
    expect(entries).toBe(0)
    await expect(stat(join(workspace, 'escape.txt'))).rejects.toThrow('ENOENT')
  })

  it('rejects truncated archives', async () => {
    const workspace = await root()
    const source = join(workspace, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'a.txt'), 'x')
    const archive = join(workspace, 'bundle.tar.gz')
    createTarGz(source, archive)
    const content = await readFile(archive)
    const truncated = join(workspace, 'truncated.tar.gz')
    await writeFile(truncated, content.subarray(0, Math.floor(content.length / 2)))
    await expect(extractTarGz(truncated, join(workspace, 'dest'))).rejects.toThrow('Truncated')
  })

  it('normalizes entry paths safely', () => {
    expect(resolveEntryPath('./a/b.txt', 'C:\\dest', 1)).toBe('C:\\dest\\b.txt')
    expect(resolveEntryPath('a/../../b', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('/abs/path', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('C:/abs/path', 'C:\\dest', 0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/tar-extract.spec.ts`
Expected: FAIL — module `../../src/main/platform/tar-extract.js` not found.

- [ ] **Step 3: Implement the extractor**

Create `src/main/platform/tar-extract.ts`:

```ts
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { createGunzip } from 'node:zlib'

const BLOCK_SIZE = 512

export interface ExtractTarGzOptions {
  readonly stripComponents?: number
}

export function resolveEntryPath(
  entryName: string,
  destination: string,
  stripComponents: number
): string | null {
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return null
  const parts = entryName.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return null
  const stripped = parts.slice(stripComponents)
  if (stripped.length === 0) return null
  const root = resolve(destination)
  const target = resolve(root, ...stripped)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null
  return target
}

function parseOctalOrBase256(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + (field[index] ?? 0)
    }
    return value
  }
  const text = field.toString('utf8').replace(/\0.*$/, '').trim()
  return text.length === 0 ? 0 : Number.parseInt(text, 8)
}

interface TarHeader {
  readonly name: string
  readonly size: number
  readonly type: string
}

function parseTarHeader(block: Buffer): TarHeader {
  const nameField = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  const prefixField = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
  return {
    name: prefixField ? `${prefixField}/${nameField}` : nameField,
    size: parseOctalOrBase256(block.subarray(124, 136)),
    type: String.fromCharCode(block[156] ?? 0)
  }
}

function parsePaxRecords(data: Buffer): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {}
  const text = data.toString('utf8')
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break
    const record = text.slice(space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals !== -1) {
      const key = record.slice(0, equals)
      const value = record.slice(equals + 1)
      if (key === 'path') result.path = value
      if (key === 'size') result.size = Number(value)
    }
    offset += length
  }
  return result
}

class TarStreamReader {
  private pending = Buffer.alloc(0)
  private readonly iterator: AsyncIterator<Buffer>
  private eof = false

  public constructor(source: NodeJS.ReadableStream) {
    this.iterator = (source as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  }

  public async readBlock(): Promise<Buffer | null> {
    while (this.pending.length < BLOCK_SIZE) {
      if (this.eof) break
      const next = await this.iterator.next()
      if (next.done) {
        this.eof = true
        break
      }
      this.pending = Buffer.concat([this.pending, next.value])
    }
    if (this.pending.length === 0) return null
    if (this.pending.length < BLOCK_SIZE) throw new Error('Truncated tar archive')
    const block = this.pending.subarray(0, BLOCK_SIZE)
    this.pending = this.pending.subarray(BLOCK_SIZE)
    return block
  }
}

async function readData(reader: TarStreamReader, size: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = size
  while (remaining > 0) {
    const block = await reader.readBlock()
    if (block === null) throw new Error('Truncated tar archive')
    const take = Math.min(remaining, block.length)
    chunks.push(block.subarray(0, take))
    remaining -= take
  }
  return Buffer.concat(chunks)
}

async function skipData(reader: TarStreamReader, size: number): Promise<void> {
  let remaining = size
  while (remaining > 0) {
    const block = await reader.readBlock()
    if (block === null) throw new Error('Truncated tar archive')
    remaining -= Math.min(remaining, block.length)
  }
}

async function writeData(reader: TarStreamReader, target: string, size: number): Promise<void> {
  const handle = await open(target, 'wx')
  try {
    let remaining = size
    while (remaining > 0) {
      const block = await reader.readBlock()
      if (block === null) throw new Error('Truncated tar archive')
      const take = Math.min(remaining, block.length)
      await handle.write(block.subarray(0, take))
      remaining -= take
    }
  } finally {
    await handle.close()
  }
}

export async function extractTarGz(
  archivePath: string,
  destination: string,
  options: ExtractTarGzOptions = {}
): Promise<number> {
  const stripComponents = options.stripComponents ?? 0
  const root = resolve(destination)
  await mkdir(root, { recursive: true })
  const reader = new TarStreamReader(createReadStream(archivePath).pipe(createGunzip()))
  let entries = 0
  let paxPath: string | null = null
  let paxSize: number | null = null

  for (;;) {
    const block = await reader.readBlock()
    if (block === null) break
    if (block.every((byte) => byte === 0)) {
      await reader.readBlock()
      break
    }
    const header = parseTarHeader(block)
    if (header.type === 'x' || header.type === 'g') {
      const pax = parsePaxRecords(await readData(reader, header.size))
      if (pax.path !== undefined) paxPath = pax.path
      if (pax.size !== undefined) paxSize = pax.size
      continue
    }
    const entryName = paxPath ?? header.name
    paxPath = null
    const entrySize = paxSize ?? header.size
    paxSize = null
    const target = resolveEntryPath(entryName, root, stripComponents)
    if (target === null) {
      await skipData(reader, entrySize)
      continue
    }
    if (header.type === '5') {
      await mkdir(target, { recursive: true })
      continue
    }
    if (header.type === '2' || header.type === '3' || header.type === '1') {
      await skipData(reader, entrySize)
      continue
    }
    if (header.type !== '0' && header.type !== '\u0000' && header.type !== '7') {
      await skipData(reader, entrySize)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeData(reader, target, entrySize)
    entries += 1
  }
  return entries
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/tar-extract.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/main/platform/tar-extract.ts tests/unit/tar-extract.spec.ts
git commit -m "feat: add dependency-free tar.gz extractor with path traversal protection"
```

---

## Task 3: Runtime extractor with manifest cache

**Files:**
- Create: `src/main/runtime-extractor.ts`
- Test: `tests/unit/runtime-extractor.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/runtime-extractor.spec.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeExtractor } from '../../src/main/runtime-extractor.js'
import { createAppPaths } from '../../src/main/platform/app-paths.js'

const roots: string[] = []
async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (d) => await rm(d, { recursive: true, force: true })))
})

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

interface Fixture {
  readonly resources: string
  readonly paths: ReturnType<typeof createAppPaths>
  readonly nodeArchive: string
  readonly dshArchive: string
  readonly manifest: {
    schema: number
    version: string
    archives: { node: { name: string; sha256: string }; dsh: { name: string; sha256: string } }
  }
}

async function fixture(): Promise<Fixture> {
  const workspace = await root()
  const resources = resolve(workspace, 'resources')
  await mkdir(resources, { recursive: true })
  const version = '24.15.0'

  const nodeSource = resolve(workspace, 'node-source')
  await mkdir(join(nodeSource, 'node_modules', 'npm', 'bin'), { recursive: true })
  await writeFile(join(nodeSource, 'node.exe'), 'node-binary')
  await writeFile(join(nodeSource, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm-cli')

  const dshSource = resolve(workspace, 'dsh-source')
  await mkdir(join(dshSource, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(
    join(dshSource, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6', bin: { dsh: 'lib/bin.js' } })
  )
  await writeFile(join(dshSource, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'dsh-bin')

  const nodeArchive = join(resources, 'node-runtime-24.15.0.tar.gz')
  const dshArchive = join(resources, 'dsh-runtime-0.1.0-rc.6.tar.gz')
  execFileSync('tar', ['-czf', nodeArchive, '-C', nodeSource, '.'], { stdio: 'pipe' })
  execFileSync('tar', ['-czf', dshArchive, '-C', dshSource, '.'], { stdio: 'pipe' })

  const manifest = {
    schema: 1,
    version,
    archives: {
      node: { name: 'node-runtime-24.15.0.tar.gz', sha256: await sha256(nodeArchive) },
      dsh: { name: 'dsh-runtime-0.1.0-rc.6.tar.gz', sha256: await sha256(dshArchive) }
    }
  }
  await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify(manifest))
  return { resources, paths: createAppPaths(join(workspace, 'user-data')), nodeArchive, dshArchive, manifest }
}

describe('runtime extractor', () => {
  it('extracts bundled archives into the user data directory', async () => {
    const { resources, paths, nodeArchive, dshArchive } = await fixture()
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    expect(await extractor.nodeRuntimeDirectory()).toBe(join(paths.nodeRuntimes, '24.15.0'))
    expect(await extractor.dshRuntimeDirectory()).toBe(join(paths.versions, '24.15.0'))
    await expect(stat(join(paths.nodeRuntimes, '24.15.0', 'node.exe'))).resolves.toBeDefined()
    await expect(
      stat(join(paths.versions, '24.15.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    ).resolves.toBeDefined()
    expect(nodeArchive).toContain('node-runtime')
    expect(dshArchive).toContain('dsh-runtime')
  })

  it('reuses a valid extraction without re-extracting', async () => {
    const { resources, paths } = await fixture()
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    const first = await extractor.nodeRuntimeDirectory()
    expect(first).not.toBeNull()
    const marker = join(paths.nodeRuntimes, '24.15.0', 'runtime-manifest.json')
    const before = await readFile(marker, 'utf8')
    const second = await extractor.nodeRuntimeDirectory()
    expect(second).toBe(first)
    expect(await readFile(marker, 'utf8')).toBe(before)
  })

  it('returns null when archives are absent and rejects on checksum mismatch', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: join(workspace, 'no-resources') })
    expect(await extractor.nodeRuntimeDirectory()).toBeNull()

    const { resources, paths: freshPaths } = await fixture()
    const tampered = new RuntimeExtractor(freshPaths, { resourcesDirectory: resources })
    const manifest = JSON.parse(await readFile(join(resources, 'runtime-manifest.json'), 'utf8')) as {
      archives: { node: { sha256: string } }
    }
    manifest.archives.node.sha256 = '0'.repeat(64)
    await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify(manifest))
    await expect(tampered.nodeRuntimeDirectory()).rejects.toThrow('checksum mismatch')
  })
})
```

Note: the fixture `version` is `24.15.0` for both node and dsh entries; the dsh package.json inside says `0.1.0-rc.6` — extraction is directory-based and does not validate package identity (that is `DshPackageManager.validate`'s job in Task 5). If you prefer distinct versions, use `0.1.0-rc.6` for the dsh archive name and a two-field manifest; keep it simple per above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/runtime-extractor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extractor**

Create `src/main/runtime-extractor.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RUNTIME_ARCHIVE_SCHEMA } from '../shared/config.js'
import type { AppPaths } from './platform/app-paths.js'
import { readJson, writeJsonAtomic } from './platform/atomic-json.js'
import { extractTarGz } from './platform/tar-extract.js'

export interface BundledArchivesManifest {
  readonly schema: number
  readonly version: string
  readonly archives: {
    readonly node: { readonly name: string; readonly sha256: string }
    readonly dsh: { readonly name: string; readonly sha256: string }
  }
}

export interface ExtractedRuntimeManifest {
  readonly schema: number
  readonly version: string
  readonly archiveSha256: string
  readonly extractedAt: string
}

export interface RuntimeExtractorOptions {
  readonly resourcesDirectory: string
  readonly logger?: { write(channel: 'desktop', message: string): Promise<void> }
  readonly extractor?: typeof extractTarGz
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export class RuntimeExtractor {
  private readonly extractor: typeof extractTarGz
  private cachedManifest: BundledArchivesManifest | null | undefined

  public constructor(
    private readonly paths: AppPaths,
    private readonly options: RuntimeExtractorOptions
  ) {
    this.extractor = options.extractor ?? extractTarGz
  }

  public async archivesManifest(): Promise<BundledArchivesManifest | null> {
    if (this.cachedManifest !== undefined) return this.cachedManifest
    const value = await readJson<BundledArchivesManifest>(
      join(this.options.resourcesDirectory, 'runtime-manifest.json')
    )
    this.cachedManifest = value !== null && value.schema === RUNTIME_ARCHIVE_SCHEMA ? value : null
    return this.cachedManifest
  }

  public async nodeRuntimeDirectory(): Promise<string | null> {
    return await this.runtimeDirectory('node')
  }

  public async dshRuntimeDirectory(): Promise<string | null> {
    return await this.runtimeDirectory('dsh')
  }

  private async runtimeDirectory(kind: 'node' | 'dsh'): Promise<string | null> {
    const manifest = await this.archivesManifest()
    if (!manifest) return null
    const target =
      kind === 'node'
        ? join(this.paths.nodeRuntimes, manifest.version)
        : join(this.paths.versions, manifest.version)
    const keyFile = kind === 'node' ? 'node.exe' : 'node_modules/@deepseek-ai/dsh/package.json'
    if (await this.isValidExtraction(target, manifest.version, manifest.archives[kind].sha256, keyFile)) {
      return target
    }
    const archive = join(this.options.resourcesDirectory, manifest.archives[kind].name)
    if (!(await exists(archive))) return null
    await this.extractArchive(archive, target, manifest.version, manifest.archives[kind].sha256)
    return target
  }

  private async isValidExtraction(
    target: string,
    version: string,
    archiveSha256: string,
    keyFile: string
  ): Promise<boolean> {
    const recorded = await readJson<ExtractedRuntimeManifest>(join(target, 'runtime-manifest.json'))
    if (!recorded || recorded.schema !== RUNTIME_ARCHIVE_SCHEMA || recorded.version !== version) return false
    if (recorded.archiveSha256 !== archiveSha256) return false
    return await exists(join(target, keyFile))
  }

  private async extractArchive(
    archive: string,
    target: string,
    version: string,
    expectedSha256: string
  ): Promise<void> {
    const actualSha256 = await sha256File(archive)
    if (actualSha256 !== expectedSha256) throw new Error(`Bundled runtime archive checksum mismatch: ${archive}`)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    const entries = await this.extractor(archive, target, { stripComponents: 1 })
    await writeJsonAtomic(join(target, 'runtime-manifest.json'), {
      schema: RUNTIME_ARCHIVE_SCHEMA,
      version,
      archiveSha256,
      extractedAt: new Date().toISOString()
    } satisfies ExtractedRuntimeManifest)
    await this.options.logger?.write('desktop', `Extracted bundled runtime ${version} (${entries} entries)`)
  }
}
```

- [ ] **Step 4: Add the schema constant**

In `src/shared/config.ts`, append:

```ts
export const RUNTIME_ARCHIVE_SCHEMA = 1
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/runtime-extractor.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/shared/config.ts src/main/runtime-extractor.ts tests/unit/runtime-extractor.spec.ts
git commit -m "feat: extract bundled runtimes with manifest caching"
```

---

## Task 4: Bundled-first Node environment detection

**Files:**
- Modify: `src/main/node-environment.ts`
- Test: `tests/unit/node-environment.spec.ts`

- [ ] **Step 1: Add failing tests**

In `tests/unit/node-environment.spec.ts`, add a fake-filesystem helper and two tests:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
```

Add at module level:

```ts
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (d) => await rm(d, { recursive: true, force: true })))
})

async function bundledNodeFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-'))
  roots.push(directory)
  await mkdir(join(directory, 'node_modules', 'npm', 'bin'), { recursive: true })
  await writeFile(join(directory, 'node.exe'), 'node')
  await writeFile(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm')
  return directory
}
```

Add inside the `describe` block:

```ts
  it('prefers a valid bundled runtime over the system', async () => {
    const bundled = await bundledNodeFixture()
    const runner = fakeRunner({
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'bundled',
      nodeVersion: '24.15.0',
      nodePath: join(bundled, 'node.exe')
    })
  })

  it('falls back to the system when the bundled runtime is broken', async () => {
    const bundled = await bundledNodeFixture()
    await rm(join(bundled, 'node.exe'))
    const runner = fakeRunner({
      'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
      'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
      'where.exe npm.cmd': { code: 0, stdout: 'C:\\Node\\npm.cmd\r\n' },
      'C:\\Node\\node.exe C:\\Node\\node_modules\\npm\\bin\\npm-cli.js --version': {
        code: 0,
        stdout: '11.14.1\n'
      }
    })
    await expect(detectNodeEnvironment(runner, bundled)).resolves.toMatchObject({
      ok: true,
      source: 'system'
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/node-environment.spec.ts`
Expected: FAIL — `detectNodeEnvironment` ignores the second argument; `source` is undefined.

- [ ] **Step 3: Implement bundled-first detection**

Modify `src/main/node-environment.ts`:

- add `exists` helper (same pattern as Task 3), import `stat` from `node:fs/promises`:
- add `source: 'bundled' | 'system'` to `ValidNodeEnvironment`:
- change the signature and add the bundled probe:

```ts
export interface ValidNodeEnvironment {
  readonly ok: true
  readonly source: 'bundled' | 'system'
  readonly nodePath: string
  readonly npmPath: string
  readonly npmCliPath: string
  readonly nodeVersion: string
  readonly npmVersion: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function detectBundledNode(
  runner: ProcessRunner,
  directory: string
): Promise<ValidNodeEnvironment | null> {
  const nodePath = join(directory, 'node.exe')
  const npmCliPath = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!(await exists(nodePath)) || !(await exists(npmCliPath))) return null
  const nodeResult = await runner(nodePath, ['--version'], { timeoutMs: 5_000 })
  const nodeVersion = semver.clean(nodeResult.stdout.trim())
  if (nodeResult.exitCode !== 0 || !nodeVersion || !semver.satisfies(nodeVersion, NODE_VERSION_RANGE)) {
    return null
  }
  const npmResult = await runner(nodePath, [npmCliPath, '--version'], { timeoutMs: 5_000 })
  const npmVersion = semver.clean(npmResult.stdout.trim())
  if (npmResult.exitCode !== 0 || !npmVersion) return null
  return { ok: true, source: 'bundled', nodePath, npmPath: '', npmCliPath, nodeVersion, npmVersion }
}

export async function detectNodeEnvironment(
  runner: ProcessRunner = runProcess,
  bundledNodeDirectory?: string | null
): Promise<NodeEnvironment> {
  if (bundledNodeDirectory) {
    const bundled = await detectBundledNode(runner, bundledNodeDirectory)
    if (bundled) return bundled
  }
  // ... existing system detection unchanged, except every `return { ok: true, ... }` gains `source: 'system'`
}
```

The system success path becomes:

```ts
      const npmVersion = semver.clean(npmResult.stdout.trim())
      if (npmResult.exitCode === 0 && npmVersion) {
        return {
          ok: true,
          source: 'system',
          nodePath,
          npmPath,
          npmCliPath,
          nodeVersion: version,
          npmVersion
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/node-environment.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/main/node-environment.ts tests/unit/node-environment.spec.ts
git commit -m "feat: prefer bundled Node runtime with system fallback"
```

---

## Task 5: DSH package manager restores the bundled archive

**Files:**
- Modify: `src/main/dsh-package-manager.ts`
- Test: `tests/unit/dsh-package-manager.spec.ts`

- [ ] **Step 1: Rewrite the bundled tests**

In `tests/unit/dsh-package-manager.spec.ts`:
- replace the `createDsh(directory, bundled)` second parameter usage; the `bundled` branch and `BundledRuntimeManifest` fixture are removed.
- replace the two `bundled runtime` tests with a `restoreBundled` test, and add imports `execFileSync` from `node:child_process` and `RuntimeExtractor`:

```ts
import { execFileSync } from 'node:child_process'
```

Replace the first two `it` blocks with:

```ts
  it('restores the bundled DSH runtime from its archive', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const source = resolve(workspace, 'runtime-source')
    await createDsh(source)
    const resources = resolve(workspace, 'resources')
    await mkdir(resources, { recursive: true })
    const archiveName = `dsh-runtime-${version}.tar.gz`
    const archivePath = join(resources, archiveName)
    execFileSync('tar', ['-czf', archivePath, '-C', source, '.'], { stdio: 'pipe' })
    await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify({
      schema: 1,
      version,
      archives: {
        node: { name: 'node-runtime.tar.gz', sha256: '0'.repeat(64) },
        dsh: { name: archiveName, sha256: sha256(await readFile(archivePath)) }
      }
    }))
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    const packages = new DshPackageManager(paths, { extractor })

    const install = await packages.restoreBundled(version)
    expect(install?.selection.directory).toBe(versionDirectory(paths, version))
    await packages.select(install!.selection)
    expect((await packages.current())?.directory).toBe(versionDirectory(paths, version))
  })

  it('returns null when no bundled archive exists', async () => {
    const workspace = await root()
    const paths = createAppPaths(join(workspace, 'user-data'))
    const packages = new DshPackageManager(paths, { extractor: null })
    expect(await packages.restoreBundled(version)).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/dsh-package-manager.spec.ts`
Expected: FAIL — `restoreBundled` does not exist; `bundledDirectory` option gone.

- [ ] **Step 3: Rework the package manager**

Modify `src/main/dsh-package-manager.ts`:

- remove `BundledRuntimeManifest` interface and the `bundledDirectory` option/field;
- add `extractor` option; change constructor:

```ts
export interface DshPackageManagerOptions {
  readonly runner?: ProcessRunner
  readonly extractor?: RuntimeExtractor | null
}

export class DshPackageManager {
  private readonly runner: ProcessRunner
  private readonly extractor: RuntimeExtractor | null

  public constructor(
    private readonly paths: AppPaths,
    options: DshPackageManagerOptions = {}
  ) {
    this.runner = options.runner ?? runProcess
    this.extractor = options.extractor ?? null
  }
```

- delete the `bundled()` method and the `isBundled` branch in `validate()`; delete the `if (this.bundledDirectory && ...)` block inside `validateAt()`;
- add:

```ts
  public async restoreBundled(version: string): Promise<DshInstall | null> {
    if (!this.extractor) return null
    const directory = await this.extractor.dshRuntimeDirectory()
    if (!directory) return null
    return await this.validate(directory, version)
  }
```

Add the import:

```ts
import type { RuntimeExtractor } from './runtime-extractor.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dsh-package-manager.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/main/dsh-package-manager.ts tests/unit/dsh-package-manager.spec.ts
git commit -m "feat: restore bundled DSH runtime from archive in package manager"
```

---

## Task 6: Build scripts produce runtime archives

**Files:**
- Create: `scripts/prepare-node-runtime.ts`
- Modify: `scripts/prepare-bundled-dsh.ts`
- Modify: `scripts/after-pack.cjs`
- Modify: `package.json` (scripts only — version bump comes in Task 12)

- [ ] **Step 1: Create the Node runtime prepare script**

Create `scripts/prepare-node-runtime.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { BUNDLED_NODE_VERSION, RUNTIME_ARCHIVE_SCHEMA } from '../src/shared/config.js'

interface ArchivesManifest {
  readonly schema: number
  readonly version: string
  readonly archives: {
    readonly node?: { readonly name: string; readonly sha256: string }
    readonly dsh?: { readonly name: string; readonly sha256: string }
  }
}

const nodeVersion = BUNDLED_NODE_VERSION
const base = `https://nodejs.org/dist/v${nodeVersion}`
const zipName = `node-v${nodeVersion}-win-x64.zip`
const extractRoot = resolve('.artifacts', 'node-runtime')
const extractedDirectory = resolve(extractRoot, `node-v${nodeVersion}-win-x64`)
const archivesRoot = resolve('.artifacts', 'archives')
const manifestPath = join(archivesRoot, 'manifest.json')

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readManifest(): Promise<ArchivesManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as ArchivesManifest
  } catch {
    return null
  }
}

async function writeManifest(next: ArchivesManifest): Promise<void> {
  const previous = (await readManifest()) ?? { schema: RUNTIME_ARCHIVE_SCHEMA, version: nodeVersion, archives: {} }
  const merged: ArchivesManifest = {
    schema: RUNTIME_ARCHIVE_SCHEMA,
    version: nodeVersion,
    archives: { ...previous.archives, ...next.archives }
  }
  await mkdir(archivesRoot, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}

const archiveName = `node-runtime-${nodeVersion}.tar.gz`
const archivePath = join(archivesRoot, archiveName)

async function isPrepared(): Promise<boolean> {
  const manifest = await readManifest()
  if (manifest?.archives.node?.name !== archiveName) return false
  if (!(await exists(archivePath))) return false
  return (await sha256(archivePath)) === manifest.archives.node.sha256
}

if (!(await isPrepared())) {
  await mkdir(extractRoot, { recursive: true })
  const zipPath = join(extractRoot, zipName)

  const [zipResponse, sumsResponse] = await Promise.all([
    fetch(`${base}/${zipName}`),
    fetch(`${base}/SHASUMS256.txt`)
  ])
  if (!zipResponse.ok || !sumsResponse.ok) {
    throw new Error(`Failed to download Node.js v${nodeVersion} from ${base}`)
  }
  const sums = await sumsResponse.text()
  const expected = sums
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${zipName}`) || line.endsWith(` *${zipName}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`SHA256 for ${zipName} not found in SHASUMS256.txt`)

  await writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()))
  const actual = await sha256(zipPath)
  if (actual !== expected) {
    await rm(zipPath, { force: true })
    throw new Error(`Node.js zip checksum mismatch: expected ${expected}, got ${actual}`)
  }

  await rm(extractedDirectory, { recursive: true, force: true })
  execFileSync('tar', ['-xf', zipPath, '-C', extractRoot], { stdio: 'pipe' })
  await rm(zipPath, { force: true })
  execFileSync('tar', ['-czf', archivePath, '-C', extractRoot, `node-v${nodeVersion}-win-x64`], {
    stdio: 'pipe'
  })
  await writeManifest({
    schema: RUNTIME_ARCHIVE_SCHEMA,
    version: nodeVersion,
    archives: { node: { name: archiveName, sha256: await sha256(archivePath) } }
  })
}

const manifest = await readManifest()
process.stdout.write(
  `${JSON.stringify({
    archive: archivePath,
    version: nodeVersion,
    sha256: manifest?.archives.node?.sha256 ?? null
  }, null, 2)}\n`
)
```

- [ ] **Step 2: Extend the DSH prepare script to emit its archive**

In `scripts/prepare-bundled-dsh.ts`, after the existing `runtime-manifest.json` write and before the final `process.stdout.write`, add archive creation and manifest merge:

```ts
import { execFileSync } from 'node:child_process'
```

```ts
const archivesRoot = resolve('.artifacts', 'archives')
const archiveName = `dsh-runtime-${INITIAL_DSH_VERSION}.tar.gz`
const archivePath = join(archivesRoot, archiveName)
const archivesManifestPath = join(archivesRoot, 'manifest.json')
const sha256File = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

interface ArchivesManifest {
  readonly schema: number
  readonly version: string
  readonly archives: {
    readonly node?: { readonly name: string; readonly sha256: string }
    readonly dsh?: { readonly name: string; readonly sha256: string }
  }
}

async function mergeArchivesManifest(partial: Partial<ArchivesManifest['archives']>): Promise<void> {
  let previous: ArchivesManifest | null = null
  try {
    previous = JSON.parse(await readFile(archivesManifestPath, 'utf8')) as ArchivesManifest
  } catch {
    previous = null
  }
  const merged: ArchivesManifest = {
    schema: 1,
    version: INITIAL_DSH_VERSION,
    archives: { ...(previous?.archives ?? {}), ...partial }
  }
  await mkdir(archivesRoot, { recursive: true })
  await writeFile(archivesManifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}

execFileSync('tar', ['-czf', archivePath, '-C', resolve('.artifacts', 'bundled-dsh'), INITIAL_DSH_VERSION], {
  stdio: 'pipe'
})
await mergeArchivesManifest({ dsh: { name: archiveName, sha256: await sha256File(archivePath) } })
```

Update the final output line to include the archive path:

```ts
process.stdout.write(`${JSON.stringify({ target, version: INITIAL_DSH_VERSION, archive: archivePath, ...inspected }, null, 2)}\n`)
```

Note: `createHash` and `readFile` are already imported in this file; add `execFileSync`, `mkdir`, `writeFile` imports as needed (check existing imports; `mkdir`, `writeFile` are already imported).

- [ ] **Step 3: Rewrite after-pack to copy archives only**

Replace `scripts/after-pack.cjs` entirely:

```js
const { cp, readFile, stat, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const archivesRoot = resolve('.artifacts', 'archives')
  const archivesManifest = JSON.parse(await readFile(join(archivesRoot, 'manifest.json'), 'utf8'))
  if (archivesManifest.schema !== 1 || !archivesManifest.version) {
    throw new Error('Bundled runtime archives manifest is missing or invalid')
  }
  const resources = resolve(context.appOutDir, 'resources')
  const copied = []
  for (const key of ['node', 'dsh']) {
    const entry = archivesManifest.archives?.[key]
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`Bundled runtime archive ${key} is missing from the manifest`)
    }
    const source = resolve(archivesRoot, entry.name)
    await stat(source)
    await cp(source, join(resources, entry.name), { force: true })
    copied.push(entry.name)
  }
  await writeFile(
    join(resources, 'runtime-manifest.json'),
    `${JSON.stringify(archivesManifest, null, 2)}\n`,
    'utf8'
  )
  process.stdout.write(`Bundled runtime archives copied: ${copied.join(', ')}\n`)
}
```

- [ ] **Step 4: Update package.json scripts**

In `package.json`, add `prepare:node-runtime` and wire it into `dist:win` / `release:github`:

```json
"prepare:node-runtime": "tsx scripts/prepare-node-runtime.ts",
"dist:win": "npm run prepare:node-runtime && npm run prepare:dsh-runtime && npm run build:icon && npm run build && electron-builder --win nsis --x64",
"release:github": "npm run prepare:node-runtime && npm run prepare:dsh-runtime && npm run build:icon && npm run build && electron-builder --win nsis --x64 --publish always",
```

- [ ] **Step 5: Verify the prepare pipeline end to end**

Run: `npm.cmd run prepare:node-runtime`
Expected: downloads Node v24.15.0, verifies SHA256, prints `{ archive: .../node-runtime-24.15.0.tar.gz, ... }`.

Run: `npm.cmd run prepare:dsh-runtime`
Expected: existing behavior plus archive line; `.artifacts/archives/manifest.json` contains both `node` and `dsh` entries.

Run: `npx vitest run tests/unit/tar-extract.spec.ts tests/unit/runtime-extractor.spec.ts`
Expected: still PASS (archives are valid inputs for the extractor).

- [ ] **Step 6: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add scripts/prepare-node-runtime.ts scripts/prepare-bundled-dsh.ts scripts/after-pack.cjs package.json
git commit -m "feat: prepare node and dsh runtime archives for the installer"
```

---

## Task 7: Orchestrator extracts runtimes and reports progress

**Files:**
- Modify: `src/main/startup-orchestrator.ts`
- Modify: `src/main/app.ts` (extractor construction only)
- Modify: `src/main/app-menu.ts` (About shows Node source)

- [ ] **Step 1: Update the orchestrator**

Modify `src/main/startup-orchestrator.ts`:

- constructor gains `extractor: RuntimeExtractor | null`:

```ts
  public constructor(
    private readonly windows: WindowController,
    private readonly packages: DshPackageManager,
    private readonly logger: FileLogger,
    private readonly dshUrl = 'http://127.0.0.1:3080',
    private readonly extractor: RuntimeExtractor | null = null
  ) {}
```

- `versions` getter gains `nodeSource`:

```ts
  public get versions(): {
    readonly dsh: string | null
    readonly node: string | null
    readonly nodeSource: 'bundled' | 'system' | null
    readonly npm: string | null
  } {
    return {
      dsh: this.activeDshVersion,
      node: this.environment?.nodeVersion ?? null,
      nodeSource: this.environment?.source ?? null,
      npm: this.environment?.npmVersion ?? null
    }
  }
```

- in `runOnce()`, replace the environment-detection block:

```ts
    const startupStartedAt = Date.now()
    this.windows.sendStatus(
      status('preparing-runtime', '正在准备运行环境', '正在准备 Node.js 运行环境…')
    )
    let bundledNodeDirectory: string | null = null
    if (this.extractor) {
      try {
        bundledNodeDirectory = await this.extractor.nodeRuntimeDirectory()
        if (bundledNodeDirectory) {
          await this.logger.write('desktop', `Bundled Node runtime ready at ${bundledNodeDirectory}`)
        }
      } catch (error) {
        await this.logger.write('desktop', `Bundled Node runtime unavailable: ${String(error)}`)
      }
    }
    this.windows.sendStatus(
      status('checking-node', '正在检测 Node.js', `需要 Node.js ${NODE_VERSION_RANGE}`)
    )
    const environment = await detectNodeEnvironment(undefined, bundledNodeDirectory)
    if (!environment.ok) {
      await this.logger.write('desktop', `Node environment error: ${environment.reason} ${environment.detail}`)
      this.windows.sendStatus(
        status(
          'environment-error',
          'Node.js 环境需要处理',
          environment.detail,
          ['open-node-download', 'retry', 'open-logs', 'exit']
        )
      )
      return false
    }
    this.environment = environment
    await this.logger.write(
      'desktop',
      `Node environment ready in ${Date.now() - startupStartedAt}ms (source: ${environment.source}, ${environment.nodeVersion})`
    )
```

- in the DSH preparation block, replace the bundled fallback:

```ts
      if (!install) {
        try {
          install = await this.packages.restoreBundled(INITIAL_DSH_VERSION)
        } catch (error) {
          await this.logger.write('desktop', `Bundled DSH is unavailable; using network fallback: ${String(error)}`)
        }
        if (install) {
          await this.logger.write('desktop', `Using bundled DSH ${install.selection.version}`)
        } else {
          this.windows.sendStatus(
            status(
              'preparing-dsh',
              '正在下载 DSH 运行环境',
              `内置运行环境不可用，正在获取 DSH ${INITIAL_DSH_VERSION}`
            )
          )
          install = await this.packages.install(environment, INITIAL_DSH_VERSION)
        }
        await this.packages.select(install.selection)
      }
```

- add imports `RuntimeExtractor` (type-only) and `detectNodeEnvironment` already imported.

- [ ] **Step 2: Wire the extractor and Node source into app.ts and contracts**

In `src/shared/contracts.ts`, add `nodeSource` to `DesktopVersions`:

```ts
export interface DesktopVersions {
  readonly app: string
  readonly dsh: string | null
  readonly node: string | null
  readonly nodeSource: 'bundled' | 'system' | null
  readonly npm: string | null
}
```

In `src/main/app.ts`, inside `whenReady`, replace the `DshPackageManager` and orchestrator construction with a single extractor instance:

```ts
    const extractor = app.isPackaged
      ? new RuntimeExtractor(paths, { resourcesDirectory: process.resourcesPath, logger })
      : null
    const packages = new DshPackageManager(paths, { extractor })
    orchestrator = new StartupOrchestrator(windows, packages, logger, dshUrl, extractor)
```

Add the import:

```ts
import { RuntimeExtractor } from './runtime-extractor.js'
```

In the `startup:get-versions` handler in `app.ts`, add the node source:

```ts
    return {
      app: app.getVersion(),
      dsh: versions?.dsh ?? null,
      node: versions?.node ?? null,
      nodeSource: versions?.nodeSource ?? null,
      npm: versions?.npm ?? null
    }
```

- [ ] **Step 3: Run the full unit suite and typecheck**

Run: `npm.cmd test`
Expected: all PASS.

Run: `npm.cmd run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/startup-orchestrator.ts src/main/app.ts src/main/app-menu.ts
git commit -m "feat: orchestrate bundled runtime extraction during startup"
```

---

## Task 8: Window controller — close-to-tray hook and DeepSeek preload

**Files:**
- Modify: `src/main/window-controller.ts`

- [ ] **Step 1: Add the close policy and preload**

In `src/main/window-controller.ts`:

- add fields and a setter:

```ts
  private closePolicy: (() => boolean) | null = null
  private onWindowHidden: () => void = () => undefined

  public setCloseBehavior(policy: () => boolean, onHidden: () => void): void {
    this.closePolicy = policy
    this.onWindowHidden = onHidden
  }
```

- in `createStartupWindow()`, right after `window.on('closed', ...)`, add:

```ts
    window.on('close', (event) => {
      if (this.closePolicy?.()) {
        event.preventDefault()
        window.hide()
        this.onWindowHidden()
      }
    })
```

- in `showDsh()`, right after `window.on('closed', ...)`, add the same close handler (window variable is in scope):

```ts
    window.on('close', (event) => {
      if (this.closePolicy?.()) {
        event.preventDefault()
        window.hide()
        this.onWindowHidden()
      }
    })
```

- in `showDsh()`, after `await this.selectTab(DEFAULT_WORKSPACE_TAB)` and before `window.show()`, add the background preload:

```ts
    if (DEFAULT_WORKSPACE_TAB === 'dsh') this.startDeepSeek()
```

- [ ] **Step 2: Typecheck**

Run: `npm.cmd run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/window-controller.ts
git commit -m "feat: add close-to-tray hook and background DeepSeek preload"
```

---

## Task 9: Tray controller

**Files:**
- Create: `src/main/tray-controller.ts`
- Test: `tests/unit/tray-controller.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tray-controller.spec.ts`:

```ts
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
    await byLabel.get('显示 DSH 工作区')!.click!({} as never, {} as never)
    await byLabel.get('打开日志目录')!.click!({} as never, {} as never)
    byLabel.get('退出')!.click!({} as never, {} as never)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/tray-controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tray controller**

Create `src/main/tray-controller.ts`:

```ts
import { Menu, Tray, nativeImage, Notification, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { WorkspaceTab } from '../shared/contracts.js'

export interface TrayControllerOptions {
  readonly iconPath: string
  readonly getWindow: () => BrowserWindow | null
  readonly selectWorkspace: (tab: WorkspaceTab) => Promise<void>
  readonly openLogsDirectory: () => Promise<void>
  readonly onQuit: () => void
  readonly notify?: (title: string, body: string) => void
  readonly enabled?: boolean
}

export function isTrayModeEnabled(): boolean {
  return app.isPackaged || process.env.DSH_DESKTOP_TRAY === '1'
}

export function buildTrayMenuTemplate(options: TrayControllerOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: '显示 DSH 工作区',
      click: () => void options.selectWorkspace('dsh')
    },
    {
      label: '显示 DeepSeek 对话',
      click: () => void options.selectWorkspace('deepseek')
    },
    { type: 'separator' },
    {
      label: '打开日志目录',
      click: () => void options.openLogsDirectory()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => options.onQuit()
    }
  ]
}

export class TrayController {
  private tray: Tray | null = null
  private hiddenNotificationShown = false

  public constructor(private readonly options: TrayControllerOptions) {}

  public get enabled(): boolean {
    if (this.options.enabled !== undefined) return this.options.enabled
    return isTrayModeEnabled()
  }

  public create(): void {
    if (!this.enabled || this.tray) return
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath)
      this.tray = new Tray(icon)
      this.tray.setToolTip('DSH Desktop')
      this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(this.options)))
      this.tray.on('click', () => this.toggleWindow())
    } catch (error) {
      this.options.notify?.('DSH Desktop', `托盘创建失败：${String(error)}`)
    }
  }

  public destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  public onWindowHidden(): void {
    if (this.hiddenNotificationShown) return
    this.hiddenNotificationShown = true
    this.notify('DSH Desktop 仍在运行', '窗口已隐藏到托盘。右键点击托盘图标，选择“退出”可完全退出。')
  }

  private notify(title: string, body: string): void {
    if (this.options.notify) {
      this.options.notify(title, body)
      return
    }
    new Notification({ title, body }).show()
  }

  private toggleWindow(): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isVisible() && window.isFocused()) {
      window.hide()
      this.onWindowHidden()
    } else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/tray-controller.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm.cmd run typecheck`
Expected: no errors.

```bash
git add src/main/tray-controller.ts tests/unit/tray-controller.spec.ts
git commit -m "feat: add tray controller with close-to-hide notification"
```

---

## Task 10: Assemble tray mode in the app entry

**Files:**
- Modify: `src/main/app.ts`

- [ ] **Step 1: Wire the tray into app.ts**

In `src/main/app.ts`:

- import `isTrayModeEnabled` and `TrayController`:

```ts
import { isTrayModeEnabled, TrayController } from './tray-controller.js'
```

- inside `whenReady`, after `windows.createStartupWindow()` and before `orchestrator.run()`, create the tray:

```ts
    const tray = new TrayController({
      iconPath: app.isPackaged
        ? join(process.resourcesPath, 'icon.ico')
        : join(app.getAppPath(), 'build', 'icon.ico'),
      getWindow: () => windows.activeWindow,
      selectWorkspace: async (tab) => {
        windows.focus()
        await windows.selectTab(tab)
      },
      openLogsDirectory: async () => {
        await shell.openPath(paths.logs)
      },
      onQuit: () => app.quit()
    })
    tray.create()
    windows.setCloseBehavior(() => tray.enabled, () => tray.onWindowHidden())
```

- change `window-all-closed` to respect tray mode:

```ts
  app.on('window-all-closed', () => {
    if (!isTrayModeEnabled()) app.quit()
  })
```

- `shell` is already imported in app.ts. The icon for packaged builds: `resources/icon.ico` must be copied by after-pack — add it to this task's after-pack change: in `scripts/after-pack.cjs`, after the archive loop:

```js
  await cp(resolve('build', 'icon.ico'), join(resources, 'icon.ico'), { force: true })
```

- [ ] **Step 2: Typecheck**

Run: `npm.cmd run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/app.ts scripts/after-pack.cjs
git commit -m "feat: enable tray resident mode in the app entry"
```

---

## Task 11: Assisted installer with changeable directory

**Files:**
- Modify: `electron-builder.yml`
- Test: `tests/unit/builder-config.spec.ts`

- [ ] **Step 1: Update the failing test**

In `tests/unit/builder-config.spec.ts`, replace the `nsis` assertions:

```ts
    expect(config).toContain('perMachine: false')
    expect(config).toContain('oneClick: false')
    expect(config).toContain('allowToChangeInstallationDirectory: true')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/builder-config.spec.ts`
Expected: FAIL — `oneClick: false` not present.

- [ ] **Step 3: Update electron-builder.yml**

Change the `nsis` block to:

```yaml
nsis:
  oneClick: false
  perMachine: false
  allowElevation: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: DSH Desktop
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/builder-config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron-builder.yml tests/unit/builder-config.spec.ts
git commit -m "feat: assisted NSIS installer with user-chosen directory"
```

---

## Task 12: Version bump, verify script, package scripts

**Files:**
- Modify: `package.json`
- Create: `scripts/verify-bundled-node.ts`

- [ ] **Step 1: Create the bundled-node verification script**

Create `scripts/verify-bundled-node.ts`:

```ts
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { INITIAL_DSH_VERSION } from '../src/shared/config.js'
import { DshPackageManager } from '../src/main/dsh-package-manager.js'
import { DshServiceManager } from '../src/main/dsh-service-manager.js'
import { FileLogger } from '../src/main/logging.js'
import { detectNodeEnvironment } from '../src/main/node-environment.js'
import { createAppPaths } from '../src/main/platform/app-paths.js'
import { runProcess, type ProcessRunner } from '../src/main/platform/process-runner.js'
import { inspectPort } from '../src/main/platform/port-inspector.js'
import { RuntimeExtractor } from '../src/main/runtime-extractor.js'

const root = resolve('.artifacts/bundled-node-verify')
const workspace = resolve('.artifacts/bundled-node-workspace')
await mkdir(workspace, { recursive: true })
const paths = createAppPaths(root)
const logger = new FileLogger(paths.logs)
const extractor = new RuntimeExtractor(paths, {
  resourcesDirectory: resolve('.artifacts/archives'),
  logger
})

const nodeDirectory = await extractor.nodeRuntimeDirectory()
if (!nodeDirectory) throw new Error('Bundled Node runtime is not prepared; run prepare:node-runtime first')

// Simulate a machine without Node.js on PATH: keep only Windows system directories.
const systemOnlyPath =
  process.env.PATH?.split(';')
    .filter((entry) => entry.trim().toLowerCase().startsWith('c:\\windows'))
    .join(';') ?? ''
const restrictedRunner: ProcessRunner = (executable, args, options = {}) =>
  runProcess(executable, args, { ...options, env: { ...process.env, PATH: systemOnlyPath } })

const systemCheck = await detectNodeEnvironment(restrictedRunner)
if (systemCheck.ok) throw new Error('System Node.js unexpectedly detected in restricted PATH')

const environment = await detectNodeEnvironment(restrictedRunner, nodeDirectory)
if (!environment.ok) throw new Error(environment.detail)
if (environment.source !== 'bundled') throw new Error('Expected the bundled Node runtime to be selected')

const packages = new DshPackageManager(paths, { extractor })
const install = await packages.restoreBundled(INITIAL_DSH_VERSION)
if (!install) throw new Error('Bundled DSH runtime could not be restored')
await packages.select(install.selection)

const verificationPort = 39832
const before = await inspectPort('127.0.0.1', verificationPort)
if (!before.free) {
  throw new Error(`Port ${verificationPort} is occupied before verification by PID ${String(before.ownerPid)}`)
}

const service = new DshServiceManager({
  nodePath: environment.nodePath,
  binaryPath: install.binaryPath,
  cwd: workspace,
  port: verificationPort,
  logger
})

let responseTitle = ''
try {
  await service.start()
  const response = await fetch(`http://127.0.0.1:${verificationPort}`)
  const body = await response.text()
  responseTitle = body.match(/<title>([^<]+)<\/title>/)?.[1] ?? ''
} finally {
  await service.stop()
}

const after = await inspectPort('127.0.0.1', verificationPort)
const result = {
  nodeSource: environment.source,
  nodeVersion: environment.nodeVersion,
  dshVersion: install.selection.version,
  responseTitle,
  portFreeBefore: before.free,
  portFreeAfter: after.free,
  current: await packages.current()
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (responseTitle !== 'DeepSeek Harness' || !after.free) process.exitCode = 1
```

- [ ] **Step 2: Update package.json**

- bump `"version": "0.2.0"` (top of file);
- add scripts:

```json
"verify:bundled-node": "npm run prepare:node-runtime && npm run prepare:dsh-runtime && tsx scripts/verify-bundled-node.ts",
```

- [ ] **Step 3: Run the verify script**

Run: `npm.cmd run verify:bundled-node`
Expected: downloads/prepares archives if needed, then prints a JSON result with `nodeSource: "bundled"`, `responseTitle: "DeepSeek Harness"`, `portFreeAfter: true`, exit code 0.

- [ ] **Step 4: Run the full suite**

Run: `npm.cmd test && npm.cmd run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/verify-bundled-node.ts
git commit -m "feat: verify bundled Node and DSH on a simulated Node-less machine"
```

---

## Task 13: Documentation and final validation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-16-dsh-desktop-v0.2-design.md` (only if gaps found)

- [ ] **Step 1: Update README**

Update README.md:

- 运行要求 section: replace the Node.js requirement with:

```markdown
- Windows 10/11 x64。
- 无需自行安装 Node.js：安装包已捆绑 Node.js v24.15.0 与 DSH 运行时。
  系统 Node.js 仅在捆绑运行时不可用时作为回退。
```

- 功能 section: add bullets:

```markdown
- 安装向导支持自定义安装目录；
- 关闭窗口时最小化到系统托盘，DSH 继续运行；右键托盘图标选择“退出”才完全退出；
- 首次启动自动解压捆绑运行环境（一次性），之后启动直接复用。
```

- 数据与日志 section: add `dsh/node/<version>/` to the tree.
- 验证命令 section: add `npm.cmd run verify:bundled-node`.
- 开发和构建 section: note that `prepare:node-runtime` downloads Node from nodejs.org during `dist:win`.

- [ ] **Step 2: Full validation**

Run: `npm.cmd test`
Expected: all PASS.

Run: `npm.cmd run typecheck`
Expected: no errors.

Run: `npm.cmd run verify:bundled-node`
Expected: PASS (idempotent, uses prepared archives).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document v0.2 features (bundled Node, assisted install, tray)"
```

---

## Self-Review Notes

- **Spec coverage:** §5.1 (archives + extraction) → Tasks 2/3/6; §5.2 (orchestration, cache, preload) → Tasks 7/8; §5.3 (assisted install) → Task 11; §5.4 (tray) → Tasks 9/10; §5.5 (version single-source) → Tasks 1/6 (after-pack reads the archives manifest); §5.6 (install speed) → Task 6; §6 (error handling) → Tasks 3/4/7; §7 (testing) → Tasks 2-12; §8 (versioning) → Task 12.
- **Placeholder scan:** no TBD/TODO; every code step shows the full code.
- **Type consistency:** `RuntimeExtractor` methods are `nodeRuntimeDirectory()`/`dshRuntimeDirectory()`/`archivesManifest()` everywhere; `detectNodeEnvironment(runner?, bundledNodeDirectory?)`; `DshPackageManager.restoreBundled(version)`; `TrayController.onWindowHidden()`; `resolveEntryPath(entryName, destination, stripComponents)`.
