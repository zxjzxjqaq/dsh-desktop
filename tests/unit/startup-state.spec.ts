import { describe, expect, it } from 'vitest'
import { canTransition, transition } from '../../src/shared/startup-state.js'

describe('startup state machine', () => {
  it('allows the normal startup path', () => {
    expect(canTransition('preparing-runtime', 'checking-node')).toBe(true)
    expect(canTransition('checking-node', 'preparing-dsh')).toBe(true)
    expect(canTransition('preparing-dsh', 'starting-dsh')).toBe(true)
    expect(canTransition('waiting-for-health', 'ready')).toBe(true)
  })

  it('rejects a transition that skips preparation', () => {
    expect(() =>
      transition(
        { phase: 'checking-node', title: '', detail: '', actions: [] },
        { phase: 'ready', title: '', detail: '', actions: [] }
      )
    ).toThrow('Invalid startup transition')
  })
})
