import { readJson, writeJsonAtomic } from './platform/atomic-json.js'

export interface AppSettings {
  readonly autoUpdateDsh: boolean
  readonly autoApplyDsh: boolean
  readonly updateCheckHours: number
  readonly registryUrl: string | null
  readonly proxyUrl: string | null
  readonly httpsProxyUrl: string | null
  readonly keepVersions: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoUpdateDsh: false,
  autoApplyDsh: false,
  updateCheckHours: 6,
  registryUrl: null,
  proxyUrl: null,
  httpsProxyUrl: null,
  keepVersions: 3
}

function coerce(value: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...value }
  return {
    autoUpdateDsh: Boolean(merged.autoUpdateDsh),
    autoApplyDsh: Boolean(merged.autoApplyDsh),
    updateCheckHours: clamp(merged.updateCheckHours, 1, 168),
    registryUrl: emptyToNull(merged.registryUrl),
    proxyUrl: emptyToNull(merged.proxyUrl),
    httpsProxyUrl: emptyToNull(merged.httpsProxyUrl),
    keepVersions: clamp(merged.keepVersions, 2, 20)
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function emptyToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() === '' ? null : (value ?? null)
}

export class SettingsStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<AppSettings> {
    try {
      const stored = await readJson<Partial<AppSettings>>(this.filePath)
      return coerce(stored ?? {})
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  public async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load()
    const next = coerce({ ...current, ...patch })
    await writeJsonAtomic(this.filePath, next)
    return next
  }
}