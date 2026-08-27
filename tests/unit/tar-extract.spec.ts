import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractTarGz,
  resolveEntryPath,
  resolveTarExecutable
} from '../../src/main/platform/tar-extract.js'
import type { ProcessRunner } from '../../src/main/platform/process-runner.js'

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
  execFileSync(resolveTarExecutable(), ['-czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' })
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

    const entries = await extractTarGz(archive, dest, { native: false })
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
    await expect(
      extractTarGz(truncated, join(workspace, 'dest'), { native: false })
    ).rejects.toThrow('Truncated')
  })

  it('reports progress as files are written (pure JS)', async () => {
    const workspace = await root()
    const source = join(workspace, 'source')
    await mkdir(join(source, 'd'), { recursive: true })
    await writeFile(join(source, 'a.txt'), 'a\n')
    await writeFile(join(source, 'b.txt'), 'b\n')
    await writeFile(join(source, 'd', 'c.txt'), 'c\n')
    const archive = join(workspace, 'bundle.tar.gz')
    createTarGz(source, archive)
    const values: number[] = []
    const entries = await extractTarGz(archive, join(workspace, 'dest'), {
      native: false,
      stripComponents: 1,
      onProgress: (files) => values.push(files)
    })
    expect(entries).toBe(3)
    expect(values.length).toBeGreaterThan(0)
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    }
    expect(values[values.length - 1]).toBe(3)
  })

  it('normalizes entry paths safely', () => {
    expect(resolveEntryPath('./a/b.txt', 'C:\\dest', 1)).toBe('C:\\dest\\a\\b.txt')
    expect(resolveEntryPath('./a.txt', 'C:\\dest', 1)).toBe('C:\\dest\\a.txt')
    expect(resolveEntryPath('a/../../b', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('/abs/path', 'C:\\dest', 0)).toBeNull()
    expect(resolveEntryPath('C:/abs/path', 'C:\\dest', 0)).toBeNull()
  })

  describe('native system tar fast path (Windows)', () => {
    it.skipIf(process.platform !== 'win32')(
      'streams verbose output into progress counts',
      async () => {
        const workspace = await root()
        const archive = join(workspace, 'bundle.tar.gz')
        const dest = join(workspace, 'dest')
        const values: number[] = []
        const calls: string[][] = []
        const runner: ProcessRunner = async (_executable, args, options) => {
          calls.push([...args])
          if (args.includes('-xvzf')) {
            // bsdtar -v emits `x <name>` lines; directories end with '/'
            options?.onStderr?.('x a.txt\nx sub/\nx b.txt\nx c.txt\nx d.txt\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        }
        const previousOverride = process.env.DSH_TAR_EXTRACTOR
        delete process.env.DSH_TAR_EXTRACTOR
        try {
          const entries = await extractTarGz(archive, dest, {
            stripComponents: 1,
            runner,
            onProgress: (files) => values.push(files)
          })
          expect(entries).toBe(0) // the fake runner writes no files
        } finally {
          if (previousOverride === undefined) delete process.env.DSH_TAR_EXTRACTOR
          else process.env.DSH_TAR_EXTRACTOR = previousOverride
        }
        expect(calls.some((call) => call.includes('-xvzf'))).toBe(true)
        // 4 plain files counted; the directory line (`x sub/`) is excluded
        expect(values.some((value) => value === 4)).toBe(true)
      }
    )

    it.skipIf(process.platform !== 'win32')(
      'delegates to the system tar with strip flags when it is usable',
      async () => {
        const workspace = await root()
        const archive = join(workspace, 'bundle.tar.gz')
        const dest = join(workspace, 'dest')
        const calls: string[][] = []
        const runner: ProcessRunner = async (executable, args) => {
          calls.push([executable, ...args])
          return { exitCode: 0, stdout: 'bsdtar 3.5.2\n', stderr: '', timedOut: false }
        }
        const previousOverride = process.env.DSH_TAR_EXTRACTOR
        delete process.env.DSH_TAR_EXTRACTOR
        try {
          const entries = await extractTarGz(archive, dest, { stripComponents: 1, runner })
          expect(entries).toBe(0) // the fake runner writes nothing, so no files exist yet
        } finally {
          if (previousOverride === undefined) delete process.env.DSH_TAR_EXTRACTOR
          else process.env.DSH_TAR_EXTRACTOR = previousOverride
        }
        const tarCall = calls.find((call) => call.includes('-xvzf'))
        expect(tarCall).toBeDefined()
        expect(tarCall!).toEqual(
          expect.arrayContaining(['-xvzf', archive, '-C', dest, '--strip-components', '1'])
        )
      }
    )

    it('rejects a missing archive instead of hanging', async () => {
      const workspace = await root()
      await expect(
        extractTarGz(join(workspace, 'does-not-exist.tar.gz'), join(workspace, 'dest'), {
          native: false
        })
      ).rejects.toThrow('ENOENT')
    })

    it.skipIf(process.platform !== 'win32')(
      'falls back to the pure-JS extractor when the system tar is missing or broken',
      async () => {
        const workspace = await root()
        const source = join(workspace, 'source')
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'a.txt'), 'hello\n')
        const archive = join(workspace, 'bundle.tar.gz')
        createTarGz(source, archive)
        const previousOverride = process.env.DSH_TAR_EXTRACTOR
        delete process.env.DSH_TAR_EXTRACTOR
        try {
          const dest = join(workspace, 'dest')
          const runner: ProcessRunner = async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'tar: not found',
            timedOut: false
          })
          const entries = await extractTarGz(archive, dest, { runner })
          expect(entries).toBe(1)
          expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('hello\n')
        } finally {
          if (previousOverride === undefined) delete process.env.DSH_TAR_EXTRACTOR
          else process.env.DSH_TAR_EXTRACTOR = previousOverride
        }
      }
    )

    it.skipIf(process.platform !== 'win32')(
      'surfaces native extraction failures when forced',
      async () => {
        const workspace = await root()
        const runner: ProcessRunner = async () => ({
          exitCode: 2,
          stdout: '',
          stderr: 'tar: corrupt archive',
          timedOut: false
        })
        await expect(
          extractTarGz(join(workspace, 'bundle.tar.gz'), join(workspace, 'dest'), {
            native: true,
            runner
          })
        ).rejects.toThrow(/system tar|tar/i)
      }
    )
  })
})
