import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/settings.js'

const roots: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-settings-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

describe('settings store', () => {
  it('returns defaults when no file exists', async () => {
    const store = new SettingsStore(join(await root(), 'settings.json'))
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('persists partial updates and survives a reload', async () => {
    const file = join(await root(), 'settings.json')
    const store = new SettingsStore(file)
    await store.update({ autoUpdateDsh: true, registryUrl: 'https://registry.npmmirror.com' })
    const reloaded = await new SettingsStore(file).load()
    expect(reloaded).toMatchObject({
      autoUpdateDsh: true,
      autoApplyDsh: false,
      registryUrl: 'https://registry.npmmirror.com'
    })
    expect(reloaded.updateCheckHours).toBe(6)
  })

  it('clamps invalid numeric values and normalises empty strings', async () => {
    const file = join(await root(), 'settings.json')
    const store = new SettingsStore(file)
    await store.update({
      updateCheckHours: 9_999,
      keepVersions: 1,
      registryUrl: '   ',
      proxyUrl: ''
    })
    const loaded = await store.load()
    expect(loaded.updateCheckHours).toBe(168)
    expect(loaded.keepVersions).toBe(2)
    expect(loaded.registryUrl).toBeNull()
    expect(loaded.proxyUrl).toBeNull()
  })

  it('rounds fractional settings and keeps booleans strict', async () => {
    const file = join(await root(), 'settings.json')
    const store = new SettingsStore(file)
    await store.update({ updateCheckHours: 2.6, autoUpdateDsh: 1 as unknown as boolean })
    const loaded = await store.load()
    expect(loaded.updateCheckHours).toBe(3)
    expect(loaded.autoUpdateDsh).toBe(true)
  })

  it('tolerates a corrupt file by falling back to defaults', async () => {
    const file = join(await root(), 'settings.json')
    await writeFile(file, 'not json')
    await expect(new SettingsStore(file).load()).resolves.toEqual(DEFAULT_SETTINGS)
  })
})
