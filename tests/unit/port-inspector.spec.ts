import { describe, expect, it } from 'vitest'
import { parseNetstatOwner } from '../../src/main/platform/port-inspector.js'

describe('Windows port inspection', () => {
  it('parses the PID for the exact loopback listener', () => {
    const output = [
      '  TCP    127.0.0.1:3080       0.0.0.0:0       LISTENING       4321',
      '  TCP    127.0.0.1:3081       0.0.0.0:0       LISTENING       9000'
    ].join('\r\n')
    expect(parseNetstatOwner(output, '127.0.0.1', 3080)).toBe(4321)
  })
})
