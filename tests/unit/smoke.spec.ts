import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_CHAT_URL,
  DEFAULT_WORKSPACE_TAB,
  DSH_URL,
  PRODUCT_NAME
} from '../../src/shared/config.js'

describe('project scaffold', () => {
  it('exposes the fixed product identity and loopback URL', () => {
    expect(PRODUCT_NAME).toBe('DSH Desktop')
    expect(DSH_URL).toBe('http://127.0.0.1:3080')
    expect(DEEPSEEK_CHAT_URL).toBe('https://chat.deepseek.com/')
    expect(DEFAULT_WORKSPACE_TAB).toBe('deepseek')
  })
})
