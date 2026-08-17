import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createGunzip } from 'node:zlib'
import { runProcess, type ProcessRunner } from './process-runner.js'

const BLOCK_SIZE = 512

/**
 * Windows 10 1803+ ships bsdtar at %SystemRoot%\System32\tar.exe. Extracting the
 * bundled runtimes through it is an order of magnitude faster than the pure-JS
 * fallback below (native C, buffered I/O, no per-512-byte-block syscalls).
 * The archive is always SHA-256 verified by the caller against the shipped
 * manifest before extraction, and bsdtar also sanitises absolute / `..` paths,
 * so the native path retains the same guarantees as the JS one.
 */
function systemTarPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

export interface ExtractTarGzOptions {
  readonly stripComponents?: number
  /**
   * `true` — always use the system tar and fail if it is unavailable.
   * `false` — always use the pure-JS extractor.
   * `undefined` (default) — use the system tar on Windows when present, and
   * fall back to pure JS if it is missing or fails.
   */
  readonly native?: boolean
  readonly runner?: ProcessRunner
  /** 解压进度回调：已完成（写入）的文件数，内部节流；total 由调用方结合归档清单提供 */
  readonly onProgress?: (files: number) => void
}

const PROGRESS_INTERVAL_MS = 150

interface ProgressSink {
  report(files: number): void
  flush(files: number): void
}

function createProgressSink(report: ((files: number) => void) | undefined): ProgressSink {
  let lastReportAt = 0
  return {
    report(files: number): void {
      if (!report) return
      const now = Date.now()
      if (now - lastReportAt >= PROGRESS_INTERVAL_MS) {
        lastReportAt = now
        report(files)
      }
    },
    flush(files: number): void {
      if (report) report(files)
    }
  }
}

/**
 * Counts `x <name>` lines emitted by `tar -v`. bsdtar prints directory entries
 * with a trailing '/', so counting only non-slash lines yields the plain-file
 * count, which matches the entry totals recorded in the runtime manifest.
 */
class VerboseTarProgress {
  private pending = ''
  private files = 0

  public push(chunk: string): void {
    const text = `${this.pending}${chunk}`
    const lines = text.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('x ') && !trimmed.endsWith('/')) this.files += 1
    }
  }

  public get count(): number {
    return this.files
  }
}

async function systemTarUsable(runner: ProcessRunner): Promise<boolean> {
  if (process.platform !== 'win32') return false
  // `DSH_TAR_EXTRACTOR=js` forces the pure-JS path (hermetic tests, debugging).
  if (process.env.DSH_TAR_EXTRACTOR === 'js') return false
  try {
    await stat(systemTarPath())
  } catch {
    return false
  }
  const probe = await runner(systemTarPath(), ['--version'], { timeoutMs: 5_000 })
  return probe.exitCode === 0
}

async function extractWithSystemTar(
  runner: ProcessRunner,
  archivePath: string,
  destination: string,
  stripComponents: number,
  progress: ProgressSink
): Promise<void> {
  await mkdir(destination, { recursive: true })
  const args = ['-xvzf', archivePath, '-C', destination]
  if (stripComponents > 0) args.push('--strip-components', String(stripComponents))
  const parser = new VerboseTarProgress()
  const onChunk = (chunk: string): void => {
    parser.push(chunk)
    progress.report(parser.count)
  }
  const result = await runner(systemTarPath(), args, {
    timeoutMs: 15 * 60_000,
    onStdout: onChunk,
    onStderr: onChunk
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `System tar extraction failed: ${result.stderr.trim() || `exit code ${String(result.exitCode)}`}`
    )
  }
}

async function countExtractedFiles(root: string): Promise<number> {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop() as string
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // A missing or partially removed destination counts as zero files.
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(directory, entry.name))
      else count += 1
    }
  }
  return count
}

export function resolveEntryPath(
  entryName: string,
  destination: string,
  stripComponents: number
): string | null {
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return null
  const rawParts = entryName.split('/').filter((part) => part !== '')
  if (rawParts.some((part) => part === '..')) return null
  const stripped = rawParts.slice(stripComponents)
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

async function extractTarGzPure(
  archivePath: string,
  destination: string,
  stripComponents: number,
  progress: ProgressSink
): Promise<number> {
  const root = resolve(destination)
  await mkdir(root, { recursive: true })
  // `pipe` does not forward source errors, so a missing or unreadable archive
  // would otherwise leave the extraction looping forever; race the loop against
  // stream failures so callers get a rejection instead of a hang.
  let fail: ((error: Error) => void) | null = null
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  const source = createReadStream(archivePath)
  const gunzip = createGunzip()
  const failWith = (error: Error): void => {
    if (error.message.includes('unexpected end of file')) {
      fail?.(new Error('Truncated tar archive'))
    } else {
      fail?.(error)
    }
  }
  source.on('error', failWith)
  gunzip.on('error', failWith)
  const reader = new TarStreamReader(source.pipe(gunzip))
  let entries = 0
  let paxPath: string | null = null
  let paxSize: number | null = null

  const extract = async (): Promise<number> => {
    try {
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
        progress.report(entries)
      }
      return entries
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpected end of file')) {
        throw new Error('Truncated tar archive')
      }
      throw error
    }
  }

  return await Promise.race([extract(), failure])
}

export async function extractTarGz(
  archivePath: string,
  destination: string,
  options: ExtractTarGzOptions = {}
): Promise<number> {
  const stripComponents = options.stripComponents ?? 0
  const runner = options.runner ?? runProcess
  const progress = createProgressSink(options.onProgress)

  if (options.native !== false && (options.native === true || (await systemTarUsable(runner)))) {
    try {
      await extractWithSystemTar(runner, archivePath, destination, stripComponents, progress)
      const files = await countExtractedFiles(destination)
      progress.flush(files)
      return files
    } catch (error) {
      if (options.native === true) throw error
      // Auto mode: a failed (possibly partial) native extraction must not
      // poison the pure-JS fallback with `wx` conflicts, so start it clean.
      await rm(destination, { recursive: true, force: true })
    }
  }

  const files = await extractTarGzPure(archivePath, destination, stripComponents, progress)
  progress.flush(files)
  return files
}