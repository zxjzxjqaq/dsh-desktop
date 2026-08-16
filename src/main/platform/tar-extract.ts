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
    }
    return entries
  } catch (error) {
    if (error instanceof Error && error.message.includes('unexpected end of file')) {
      throw new Error('Truncated tar archive')
    }
    throw error
  }
}
