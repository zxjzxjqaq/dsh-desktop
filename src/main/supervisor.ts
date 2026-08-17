/**
 * DshSupervisor — the in-session watchdog for the DSH Web service.
 *
 * Owns the "is DSH alive right now" question. It periodically probes the DSH
 * URL, tracks consecutive failures, and restarts the service *in place*
 * (without touching any window) when the service crashes or goes unresponsive.
 *
 * Design invariants:
 * - Single-flight: at most one restart task at a time.
 * - Backoff: automatic restarts are limited to a sliding time window so a
 *   crash loop degrades to a `failed` state instead of restarting forever.
 * - Cooperative: when an update operation is active (`isUpdateActive`), the
 *   supervisor never restarts on its own — the update flow owns the service
 *   lifecycle and will restart it.
 * - The supervisor never asks the app to tear down windows.
 */
import type { ProbeResult } from './dsh-health.js'

export type SupervisorPhase =
  | 'stopped' // no service tracked (initial / shutdown)
  | 'watching' // healthy; periodic probing armed
  | 'degraded' // probes failing, below the restart threshold
  | 'restarting' // a restart task is in flight
  | 'failed' // automatic restart budget exhausted; manual action needed

export type RestartReason = 'crash' | 'probe' | 'manual' | 'update'

export interface SupervisorStatus {
  readonly phase: SupervisorPhase
  readonly failures: number
  readonly detail?: string
  readonly lastRestartAt?: number
  readonly autoRestartsInWindow: number
}

export interface SupervisorOptions {
  readonly url: string
  readonly probe: (url: string) => Promise<ProbeResult>
  readonly restart: (reason: RestartReason) => Promise<boolean>
  readonly isUpdateActive: () => boolean
  readonly log: (message: string) => Promise<void> | void
  readonly probeIntervalMs?: number
  readonly degradedThreshold?: number
  readonly maxAutoRestarts?: number
  readonly backoffWindowMs?: number
}

export type SupervisorListener = (status: SupervisorStatus) => void

const DEFAULT_PROBE_INTERVAL_MS = 5_000
const DEFAULT_DEGRADED_THRESHOLD = 3
const DEFAULT_MAX_AUTO_RESTARTS = 3
const DEFAULT_BACKOFF_WINDOW_MS = 60_000

export class DshSupervisor {
  private phase: SupervisorPhase = 'stopped'
  private failures = 0
  private restarting = false
  private lastRestartAt: number | null = null
  private autoRestartTimestamps: number[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private detail: string | undefined
  private readonly listeners = new Set<SupervisorListener>()

  public constructor(private readonly options: SupervisorOptions) {}

  public get status(): SupervisorStatus {
    return {
      phase: this.phase,
      failures: this.failures,
      detail: this.detail,
      lastRestartAt: this.lastRestartAt ?? undefined,
      autoRestartsInWindow: this.autoRestartTimestamps.length
    }
  }

  public onStatusChange(listener: SupervisorListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  /** Arm the watchdog. Safe to call from `stopped` or `failed`. */
  public start(): void {
    if (this.phase === 'restarting') return
    this.phase = 'watching'
    this.failures = 0
    this.detail = undefined
    this.emit()
    this.scheduleNextProbe(0)
  }

  /** Disarm the watchdog (app shutdown or explicit service stop). */
  public stop(): void {
    this.clearTimer()
    this.phase = 'stopped'
    this.failures = 0
    this.restarting = false
    this.detail = undefined
    this.emit()
  }

  /** Called by the service manager when the DSH child process exits on its own. */
  public onServiceExited(): void {
    if (this.phase === 'stopped' || this.phase === 'restarting') return
    void this.attemptRestart('crash')
  }

  /** Force a restart (manual toolbar/menu action or update apply). */
  public async restartNow(reason: 'manual' | 'update'): Promise<boolean> {
    return await this.attemptRestart(reason)
  }

  private scheduleNextProbe(delayMs = this.options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS): void {
    this.clearTimer()
    this.timer = setTimeout(() => void this.tick(), delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (this.phase !== 'watching' && this.phase !== 'degraded') return
    const result = await this.options.probe(this.options.url)
    if (result.ok) {
      this.failures = 0
      this.detail = undefined
      if (this.phase === 'degraded') this.phase = 'watching'
      this.emit()
      this.scheduleNextProbe()
      return
    }
    this.failures += 1
    this.detail = result.reason
    const threshold = this.options.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD
    if (this.failures >= threshold) {
      this.phase = 'degraded'
      this.emit()
      await this.attemptRestart('probe')
      if ((this.phase as SupervisorPhase) !== 'failed') this.scheduleNextProbe()
    } else {
      this.phase = 'degraded'
      this.emit()
      this.scheduleNextProbe()
    }
  }

  private async attemptRestart(reason: RestartReason): Promise<boolean> {
    if (this.phase === 'stopped' || this.restarting) return false
    if ((reason === 'crash' || reason === 'probe') && this.options.isUpdateActive()) {
      // An update owns the service lifecycle right now; stay out of the way.
      this.phase = 'degraded'
      this.detail = '更新进行中，等待更新流程完成重启。'
      this.emit()
      return false
    }
    if (reason === 'crash' || reason === 'probe') {
      const now = Date.now()
      const windowMs = this.options.backoffWindowMs ?? DEFAULT_BACKOFF_WINDOW_MS
      const max = this.options.maxAutoRestarts ?? DEFAULT_MAX_AUTO_RESTARTS
      this.autoRestartTimestamps = this.autoRestartTimestamps.filter((t) => now - t < windowMs)
      if (this.autoRestartTimestamps.length >= max) {
        this.phase = 'failed'
        this.detail = `自动重启次数已达上限（${max} 次 / ${Math.round(windowMs / 1000)} 秒）。`
        this.emit()
        void this.options.log(`Supervisor: auto-restart budget exhausted (${reason})`)
        return false
      }
    }

    this.restarting = true
    this.phase = 'restarting'
    this.detail = reason === 'crash' ? '检测到 DSH 进程退出，正在恢复…' : '正在重启 DSH 服务…'
    this.emit()

    let ok = false
    try {
      ok = await this.options.restart(reason)
    } catch (error) {
      void this.options.log(`Supervisor: restart threw: ${String(error)}`)
      ok = false
    } finally {
      this.restarting = false
    }

    if (ok) {
      if (reason === 'crash' || reason === 'probe') {
        this.autoRestartTimestamps.push(Date.now())
      }
      this.lastRestartAt = Date.now()
      this.failures = 0
      this.detail = undefined
      this.phase = 'watching'
      await this.options.log(`Supervisor: restart succeeded (${reason})`)
      this.emit()
      this.scheduleNextProbe()
      return true
    }

    if (reason === 'crash' || reason === 'probe') {
      this.autoRestartTimestamps.push(Date.now())
    }
    this.phase = 'failed'
    this.detail = 'DSH 重启失败，请点击“重启 DSH”或查看日志后重试。'
    await this.options.log(`Supervisor: restart failed (${reason})`)
    this.emit()
    return false
  }

  private emit(): void {
    const status = this.status
    for (const listener of this.listeners) listener(status)
  }
}