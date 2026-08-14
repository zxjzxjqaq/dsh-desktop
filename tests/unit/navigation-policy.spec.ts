import { describe, expect, it } from 'vitest'
import { isAllowedDshNavigation, isAllowedExternalUrl } from '../../src/main/navigation-policy.js'

describe('navigation policy', () => {
  it('allows only the exact DSH loopback origin', () => {
    expect(isAllowedDshNavigation('http://127.0.0.1:3080/settings')).toBe(true)
    expect(isAllowedDshNavigation('http://127.0.0.1:3080.attacker.test/')).toBe(false)
    expect(isAllowedDshNavigation('http://localhost:3080/')).toBe(false)
  })

  it('opens only HTTPS links externally', () => {
    expect(isAllowedExternalUrl('https://github.com/deepseek-ai/deepseek-harness')).toBe(true)
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
