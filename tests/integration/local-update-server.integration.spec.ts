import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUpdateServer } from '../../scripts/local-update-server.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local update server', () => {
  it('serves explicit artifacts and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-feed-'))
    directories.push(root)
    await writeFile(join(root, 'latest.yml'), 'version: 0.1.1\n', 'utf8')
    const server = createUpdateServer(root)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/latest.yml`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('version: 0.1.1\n')
      const traversal = await fetch(`http://127.0.0.1:${address.port}/..%2Fpackage.json`)
      expect(traversal.status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
