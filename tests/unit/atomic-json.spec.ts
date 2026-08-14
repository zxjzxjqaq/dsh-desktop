import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readJson, writeJsonAtomic } from '../../src/main/platform/atomic-json.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('atomic JSON files', () => {
  it('writes complete newline-terminated JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
    directories.push(directory)
    const path = join(directory, 'pointer.json')
    await writeJsonAtomic(path, { version: '0.1.0' })
    expect(await readJson(path)).toEqual({ version: '0.1.0' })
    expect(await readFile(path, 'utf8')).toMatch(/\n$/)
  })
})
