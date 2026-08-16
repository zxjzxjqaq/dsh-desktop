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
}

async function fixture(): Promise<Fixture> {
  const workspace = await root()
  const resources = resolve(workspace, 'resources')
  await mkdir(resources, { recursive: true })

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

  await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    version: '24.15.0',
    archives: {
      node: { name: 'node-runtime-24.15.0.tar.gz', sha256: await sha256(nodeArchive) },
      dsh: { name: 'dsh-runtime-0.1.0-rc.6.tar.gz', sha256: await sha256(dshArchive) }
    }
  }))
  return { resources, paths: createAppPaths(join(workspace, 'user-data')) }
}

describe('runtime extractor', () => {
  it('extracts bundled archives into the user data directory', async () => {
    const { resources, paths } = await fixture()
    const extractor = new RuntimeExtractor(paths, { resourcesDirectory: resources })
    expect(await extractor.nodeRuntimeDirectory()).toBe(join(paths.nodeRuntimes, '24.15.0'))
    expect(await extractor.dshRuntimeDirectory()).toBe(join(paths.versions, '24.15.0'))
    await expect(stat(join(paths.nodeRuntimes, '24.15.0', 'node.exe'))).resolves.toBeDefined()
    await expect(
      stat(join(paths.versions, '24.15.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    ).resolves.toBeDefined()
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
