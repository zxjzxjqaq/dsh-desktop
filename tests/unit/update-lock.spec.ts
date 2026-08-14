import { describe, expect, it } from 'vitest'
import { UpdateLock } from '../../src/main/update-lock.js'

describe('update lock', () => {
  it('rejects concurrent updates and releases after errors', async () => {
    const lock = new UpdateLock()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const active = lock.run('dsh-update', async () => await waiting)
    await expect(lock.run('desktop-update', async () => undefined)).rejects.toThrow('dsh-update')
    release()
    await active
    await expect(lock.run('desktop-update', async () => 'ok')).resolves.toBe('ok')
  })
})
