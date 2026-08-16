import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(resolveEntryPath('./a/b.txt', 'C:\\dest', 1)).toBe('C:\\dest\\a\\b.txt')
    expect(resolveEntryPath('./a.txt', 'C:\\dest', 1)).toBe('C:\\dest\\a.txt')
    expect(resolveEntryPath('a/../../b', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('/abs/path', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('C:/abs/path', 'C:\\dest', 0)).toBeNull()
  })
})
