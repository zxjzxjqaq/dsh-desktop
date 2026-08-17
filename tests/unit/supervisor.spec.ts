import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProbeResult } from '../../src/main/dsh-health.js'
import { DshSupervisor, type RestartReason, type SupervisorStatus } from '../../src/main/supervisor.js'

const URL = 'http://127.0.0.1:3080'
const okResult: ProbeResult = { ok: true, url: URL }
const failResult: ProbeResult = { ok: false, url: URL, reason: 'connection refused' }

interface Harness {
  supervisor: DshSupervisor
  statuses: SupervisorStatus[]
  restartReasons: RestartReason[]
  restartResults: boolean[]
  probeResults: ProbeResult[]
  updateActive: boolean
}

function createHarness(overrides: {
  probeResults?: ProbeResult[]
  restartResults?: boolean[]
  updateActive?: boolean
  maxAutoRestarts?: number
  degradedThreshold?: number
  probeIntervalMs?: number
  backoffWindowMs?: number
} = {}): Harness {
  const harness = {
    statuses: [] as SupervisorStatus[],
    restartReasons: [] as RestartReason[],
    restartResults: overrides.restartResults ?? [true],
    probeResults: overrides.probeResults ?? [okResult],
    updateActive: overrides.updateActive ?? false
  } satisfies Omit<Harness, 'supervisor'>
  const probe = vi.fn(async (): Promise<ProbeResult> => {
    const result = harness.probeResults.shift()
    return result ?? okResult
  })
  const restart = vi.fn(async (reason: RestartReason): Promise<boolean> => {
    harness.restartReasons.push(reason)
    const result = harness.restartResults.shift()
    return result ?? false
  })
  const supervisor = new DshSupervisor({
    url: URL,
    probe,
    restart: restart as (reason: RestartReason) => Promise<boolean>,
    isUpdateActive: () => harness.updateActive,
    log: () => undefined,
    probeIntervalMs: overrides.probeIntervalMs ?? 5_000,
    degradedThreshold: overrides.degradedThreshold ?? 3,
    maxAutoRestarts: overrides.maxAutoRestarts ?? 3,
    backoffWindowMs: overrides.backoffWindowMs ?? 60_000
  })
  const completed: Harness = { ...harness, supervisor }
  supervisor.onStatusChange((status) => completed.statuses.push(status))
  return completed
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DSH service supervisor', () => {
  it('starts watching and stays watching while probes pass', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.supervisor.start()
    expect(harness.statuses.at(-1)?.phase).toBe('watching')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(harness.statuses.at(-1)?.phase).toBe('watching')
    expect(harness.restartReasons).toEqual([])
  })

  it('goes degraded below the threshold and never restarts', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      degradedThreshold: 3,
      probeResults: [failResult, failResult, okResult]
    })
    harness.supervisor.start()
    // start() probes immediately at t=0
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 2 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'watching', failures: 0 })
    expect(harness.restartReasons).toEqual([])
  })

  it('auto-restarts in place once the failure threshold is reached', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      degradedThreshold: 2,
      probeResults: [failResult, failResult],
      restartResults: [true]
    })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.restartReasons).toEqual(['probe'])
    expect(harness.statuses.some((s) => s.phase === 'restarting')).toBe(true)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'watching', failures: 0 })
  })

  it('restarts immediately with reason crash when the child exits', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ restartResults: [true] })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    harness.supervisor.onServiceExited()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.restartReasons).toEqual(['crash'])
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'watching' })
  })

  it('backs off after the auto-restart budget is exhausted', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      degradedThreshold: 1,
      maxAutoRestarts: 2,
      probeResults: [failResult, failResult, failResult],
      restartResults: [true, true]
    })
    harness.supervisor.start()
    // t=0: fail -> restart #1 (ok)  |  t=5: fail -> restart #2 (ok)  |  t=10: fail -> budget exhausted
    await vi.advanceTimersByTimeAsync(15_000)
    expect(harness.restartReasons).toEqual(['probe', 'probe'])
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'failed' })
    // failed stops probing; nothing changes later
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.statuses.at(-1)?.phase).toBe('failed')
  })

  it('never auto-restarts while an update operation is active', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      updateActive: true,
      degradedThreshold: 2,
      probeResults: [failResult, failResult, failResult]
    })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    // threshold reached but the update owns the lifecycle: no restart, stays degraded
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 2 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'degraded', failures: 3 })
    expect(harness.restartReasons).toEqual([])
  })

  it('manual restart recovers from the failed state and re-arms probes', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      degradedThreshold: 1,
      maxAutoRestarts: 1,
      probeResults: [failResult, failResult],
      restartResults: [true, true]
    })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.statuses.at(-1)?.phase).toBe('failed')
    await expect(harness.supervisor.restartNow('manual')).resolves.toBe(true)
    expect(harness.statuses.at(-1)?.phase).toBe('watching')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.statuses.at(-1)?.phase).toBe('watching')
  })

  it('reports failed manual restarts without re-arming the probe loop', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ restartResults: [false] })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(harness.supervisor.restartNow('manual')).resolves.toBe(false)
    expect(harness.statuses.at(-1)).toMatchObject({ phase: 'failed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.statuses.at(-1)?.phase).toBe('failed')
  })

  it('stop disarms probing and rejects late events', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ restartResults: [true] })
    harness.supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    harness.supervisor.stop()
    expect(harness.statuses.at(-1)?.phase).toBe('stopped')
    harness.supervisor.onServiceExited()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.restartReasons).toEqual([])
  })
})
