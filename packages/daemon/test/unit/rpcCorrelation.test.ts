/**
 * Unit tests for RpcCorrelation
 *
 * Covers:
 *   - Correlation map lookup: register → resolve happy-path; idempotent no-op after resolution
 *   - Timeout rejection: short real-timer deadline; slot released before reject observable
 *   - Slot-release-before-reject ordering (critical invariant): both explicit reject and timeout
 *   - ext-disconnect rejectAll: all pending promises reject; inFlight returns 0 afterward
 *   - tryAcquire semantics: atomic reserve; releaseAcquired abort path; slot recycled on terminal
 *
 * No fs or ws mocks needed — pure data-structure logic with timers.
 */

import { describe, expect, it, vi } from 'vitest'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Correlation map lookup
// ---------------------------------------------------------------------------

describe('RpcCorrelation — correlation map lookup', () => {
  it('register returns a promise that resolves with the value passed to resolve()', async () => {
    const r = new RpcCorrelation(8)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    r.resolve('req-1', { ok: true })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('resolve is a no-op when id is not in the map (already resolved)', async () => {
    const r = new RpcCorrelation(8)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    r.resolve('req-1', 'first')
    // Second resolve on same id — map entry is gone, must not throw
    expect(() => r.resolve('req-1', 'second')).not.toThrow()
    await expect(p).resolves.toBe('first')
  })

  it('reject is a no-op when id is not in the map (already resolved)', async () => {
    const r = new RpcCorrelation(8)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    r.resolve('req-1', 'first')
    expect(() => r.reject('req-1', new Error('late'))).not.toThrow()
    await expect(p).resolves.toBe('first')
  })

  it('resolve after reject on same id is a no-op (entry already gone)', async () => {
    const r = new RpcCorrelation(8)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    r.reject('req-1', new Error('err'))
    expect(() => r.resolve('req-1', 'late')).not.toThrow()
    await expect(p).rejects.toThrow('err')
  })

  it('inFlight returns 0 after resolve consumes the slot', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p = r.register('req-1', 5_000)
    expect(r.inFlight()).toBe(1)
    r.resolve('req-1', 'done')
    await p
    expect(r.inFlight()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Timeout rejection (real timers, short deadlines)
// ---------------------------------------------------------------------------

describe('RpcCorrelation — timeout rejection', () => {
  it('promise rejects with timeout error after deadline elapses', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p = r.register('req-timeout', 50)
    await expect(p).rejects.toThrow(/rpc timeout/)
  }, 2_000)

  it('timeout error message contains the registered id', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p = r.register('my-special-id', 50)
    await expect(p).rejects.toThrow('my-special-id')
  }, 2_000)

  it('resolving before timeout cancels the timeout (no spurious rejection)', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p = r.register('req-early', 200)
    r.resolve('req-early', 'resolved-early')
    // wait past the timeout window — the promise should already be settled as resolved
    await new Promise((res) => setTimeout(res, 250))
    // Promise was already settled — this is just a final check
    await expect(p).resolves.toBe('resolved-early')
  }, 2_000)
})

// ---------------------------------------------------------------------------
// Slot-release-before-reject ordering (critical invariant)
// ---------------------------------------------------------------------------

describe('RpcCorrelation — slot-release-before-reject ordering', () => {
  /**
   * The invariant: when a correlation entry terminates (resolve, reject, or
   * timeout), the active-count slot MUST be decremented BEFORE the promise
   * rejection microtask is observable to callers.
   *
   * Mechanically: reject(id, err) calls this.active-- then entry.reject(err).
   * The promise rejection propagates asynchronously (microtask queue), so by
   * the time any awaiting code sees the rejection, inFlight() is already back
   * to 0 and tryAcquire() must succeed.
   *
   * This prevents capacity deadlock: a route handler awaiting `register()` at
   * limit capacity gets the slot freed synchronously on the reject call, so
   * the next request can acquire immediately without waiting for settlement.
   */

  it('explicit reject: slot released synchronously so tryAcquire() succeeds before promise settles', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)
    expect(r.inFlight()).toBe(1)

    const p = r.register('req-1', 5_000)
    // Slot is occupied — tryAcquire must fail
    expect(r.tryAcquire()).toBe(false)

    // Reject synchronously — slot must be decremented BEFORE we await
    r.reject('req-1', new Error('forced'))

    // IMMEDIATELY (synchronously, before any await), tryAcquire must succeed
    // because active was decremented inside reject() before scheduling the microtask
    expect(r.tryAcquire()).toBe(true)

    // Cleanup — release the second acquired slot, then confirm promise rejected
    r.releaseAcquired()

    return expect(p).rejects.toThrow('forced')
  })

  it('timeout: slot released before observable rejection; tryAcquire succeeds immediately after timeout fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const r = new RpcCorrelation(1)
      expect(r.tryAcquire()).toBe(true)
      const p = r.register('req-timeout', 100)

      // Slot occupied — cannot acquire
      expect(r.tryAcquire()).toBe(false)

      // Advance timers — the setTimeout callback runs synchronously inside advanceTimersByTime,
      // decrements active, then calls entry.reject(). The rejection is a microtask scheduled
      // but not yet processed.
      vi.advanceTimersByTime(150)

      // Synchronously after timer fires: slot must already be free
      expect(r.inFlight()).toBe(0)
      expect(r.tryAcquire()).toBe(true)
      r.releaseAcquired()

      // Flush microtasks — confirm the promise actually rejected
      await Promise.resolve()
      await expect(p).rejects.toThrow(/rpc timeout/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolve: slot released synchronously so tryAcquire() succeeds before awaiting result', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)

    const p = r.register('req-1', 5_000)
    expect(r.tryAcquire()).toBe(false) // slot occupied

    r.resolve('req-1', 'value')

    // Synchronously after resolve() — slot must be free
    expect(r.tryAcquire()).toBe(true)
    r.releaseAcquired()

    return expect(p).resolves.toBe('value')
  })
})

// ---------------------------------------------------------------------------
// ext-disconnect rejectAll
// ---------------------------------------------------------------------------

describe('RpcCorrelation — rejectAll (ext disconnect)', () => {
  it('rejectAll rejects all pending promises with the given reason', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p1 = r.register('req-1', 5_000)
    r.tryAcquire()
    const p2 = r.register('req-2', 5_000)
    r.tryAcquire()
    const p3 = r.register('req-3', 5_000)

    const disconnectErr = new Error('ext disconnected')
    r.rejectAll(disconnectErr)

    await expect(p1).rejects.toThrow('ext disconnected')
    await expect(p2).rejects.toThrow('ext disconnected')
    await expect(p3).rejects.toThrow('ext disconnected')
  })

  it('inFlight returns 0 after rejectAll', async () => {
    const r = new RpcCorrelation(8)
    r.tryAcquire()
    const p1 = r.register('req-1', 5_000)
    r.tryAcquire()
    const p2 = r.register('req-2', 5_000)
    r.tryAcquire()
    const p3 = r.register('req-3', 5_000)

    expect(r.inFlight()).toBe(3)

    r.rejectAll(new Error('gone'))

    // Slot count must be 0 synchronously — rejectAll calls reject() which decrements inline
    expect(r.inFlight()).toBe(0)

    // Suppress unhandled-rejection noise
    await Promise.allSettled([p1, p2, p3])
  })

  it('rejectAll on empty map is a no-op (no throw, inFlight stays 0)', () => {
    const r = new RpcCorrelation(8)
    expect(() => r.rejectAll(new Error('nothing'))).not.toThrow()
    expect(r.inFlight()).toBe(0)
  })

  it('tryAcquire succeeds after rejectAll clears all slots', async () => {
    const r = new RpcCorrelation(2)
    r.tryAcquire()
    const pa = r.register('a', 5_000)
    r.tryAcquire()
    const pb = r.register('b', 5_000)

    expect(r.tryAcquire()).toBe(false) // at limit

    r.rejectAll(new Error('reset'))

    // Both slots released — can acquire again
    expect(r.tryAcquire()).toBe(true)
    r.releaseAcquired()

    // Suppress unhandled-rejection noise
    await Promise.allSettled([pa, pb])
  })
})

// ---------------------------------------------------------------------------
// tryAcquire semantics and slot lifecycle
// ---------------------------------------------------------------------------

describe('RpcCorrelation — tryAcquire semantics', () => {
  it('tryAcquire returns true when below limit', () => {
    const r = new RpcCorrelation(4)
    expect(r.tryAcquire()).toBe(true)
    expect(r.inFlight()).toBe(1)
  })

  it('two back-to-back tryAcquire calls at limit: second returns false', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)
    expect(r.tryAcquire()).toBe(false)
  })

  it('tryAcquire → releaseAcquired → tryAcquire returns true (slot recycled)', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)
    r.releaseAcquired()
    expect(r.inFlight()).toBe(0)
    expect(r.tryAcquire()).toBe(true)
  })

  it('releaseAcquired does not go below 0 (Math.max guard)', () => {
    const r = new RpcCorrelation(8)
    // Call releaseAcquired without a prior tryAcquire — should clamp to 0
    r.releaseAcquired()
    expect(r.inFlight()).toBe(0)
  })

  it('tryAcquire → register → resolve → tryAcquire true (slot released on terminal)', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    expect(r.tryAcquire()).toBe(false) // slot occupied

    r.resolve('req-1', 'ok')
    // Slot released synchronously by resolve()
    expect(r.tryAcquire()).toBe(true)
    r.releaseAcquired()

    return expect(p).resolves.toBe('ok')
  })

  it('tryAcquire → register → reject → tryAcquire true (slot released on terminal)', () => {
    const r = new RpcCorrelation(1)
    expect(r.tryAcquire()).toBe(true)
    const p = r.register('req-1', 5_000)
    expect(r.tryAcquire()).toBe(false) // slot occupied

    r.reject('req-1', new Error('rejected'))
    // Slot released synchronously by reject()
    expect(r.tryAcquire()).toBe(true)
    r.releaseAcquired()

    return expect(p).rejects.toThrow('rejected')
  })

  it('register does NOT increment inFlight (slot was already counted by tryAcquire)', () => {
    const r = new RpcCorrelation(8)
    expect(r.inFlight()).toBe(0)
    r.tryAcquire()
    expect(r.inFlight()).toBe(1)
    r.register('req-1', 5_000)
    // inFlight must still be 1, not 2
    expect(r.inFlight()).toBe(1)

    // Cleanup
    r.resolve('req-1', null)
  })

  it('multiple concurrent registrations track inFlight correctly', async () => {
    const r = new RpcCorrelation(4)
    r.tryAcquire()
    const p1 = r.register('r1', 5_000)
    r.tryAcquire()
    const p2 = r.register('r2', 5_000)
    r.tryAcquire()
    const p3 = r.register('r3', 5_000)

    expect(r.inFlight()).toBe(3)

    r.resolve('r1', 1)
    expect(r.inFlight()).toBe(2)

    r.resolve('r2', 2)
    expect(r.inFlight()).toBe(1)

    await p1
    await p2

    // r3 still pending
    expect(r.inFlight()).toBe(1)

    r.reject('r3', new Error('done'))
    expect(r.inFlight()).toBe(0)

    // Suppress unhandled-rejection noise
    await expect(p3).rejects.toThrow('done')
  })

  it('tryAcquire respects limit exactly (N slots, Nth+1 fails)', () => {
    const LIMIT = 5
    const r = new RpcCorrelation(LIMIT)
    for (let i = 0; i < LIMIT; i++) {
      expect(r.tryAcquire()).toBe(true)
    }
    expect(r.tryAcquire()).toBe(false)
    expect(r.inFlight()).toBe(LIMIT)
  })
})
