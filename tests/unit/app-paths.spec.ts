import { describe, expect, it } from 'vitest'
import { createAppPaths, versionDirectory } from '../../src/main/platform/app-paths.js'

describe('application paths', () => {
  it('supports spaces and Chinese user directories', () => {
    const paths = createAppPaths('C:\\用户目录\\DSH Desktop Data')
    expect(paths.logs).toContain('用户目录')
    expect(versionDirectory(paths, '0.1.0-rc.6')).toContain('0.1.0-rc.6')
  })

  it('rejects unsafe version values', () => {
    const paths = createAppPaths('C:\\data')
    expect(() => versionDirectory(paths, '..\\escape')).toThrow('Invalid DSH version')
  })
})
