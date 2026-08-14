import { DSH_URL } from '../shared/config.js'

export function isAllowedDshNavigation(value: string, expectedUrl = DSH_URL): boolean {
  try {
    const url = new URL(value)
    return url.origin === new URL(expectedUrl).origin && (url.protocol === 'http:' || url.protocol === 'ws:')
  } catch {
    return false
  }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
