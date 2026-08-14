import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../src/main/logging.js'

describe('log redaction', () => {
  it('redacts assignments and bearer values', () => {
    const input = 'api_key=abc token: xyz Authorization: Bearer very.secret.value'
    const output = redactSecrets(input)
    expect(output).not.toContain('abc')
    expect(output).not.toContain('xyz')
    expect(output).not.toContain('very.secret.value')
    expect(output).toContain('[REDACTED]')
  })
})
