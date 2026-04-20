import { describe, expect, it, vi } from 'vitest'
import { createShutdownCoordinator } from '../../src/lifecycle.js'

describe('shutdown coordinator', () => {
  it('drain deadline starts after trigger, not coordinator creation', async () => {
    vi.useFakeTimers()
    const coord = createShutdownCoordinator({ drainDeadlineMs: 100 })
    vi.advanceTimersByTime(50) // 50ms of "idle" before trigger must not count
    coord.trigger()
    const p = coord.awaitComplete()
    vi.advanceTimersByTime(100)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('awaitComplete stays pending if timers advance before trigger', async () => {
    vi.useFakeTimers()
    const coord = createShutdownCoordinator({ drainDeadlineMs: 100 })
    vi.advanceTimersByTime(100) // no trigger yet — must not resolve
    let settled = false
    const p = coord.awaitComplete().then(() => {
      settled = true
    })
    // flush microtasks without advancing wall-clock
    await Promise.resolve()
    expect(settled).toBe(false)
    coord.trigger()
    vi.advanceTimersByTime(100)
    await p
    expect(settled).toBe(true)
    vi.useRealTimers()
  })

  it('trigger is idempotent', async () => {
    vi.useFakeTimers()
    const coord = createShutdownCoordinator({ drainDeadlineMs: 100 })
    coord.trigger()
    coord.trigger() // second call must be a no-op, not reset the timer
    const p = coord.awaitComplete()
    vi.advanceTimersByTime(100)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})
