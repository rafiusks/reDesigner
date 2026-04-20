// @vitest-environment happy-dom

/**
 * Task 27 — rpc + manifestCache integration tests.
 *
 * Covers:
 *  1. `insert` awaits persist (persist mock returns after 10ms fake time;
 *     await resolves after).
 *  2. Monotonic counter increments; nextCounter after 3 calls returns 0, 1, 2.
 *  3. graceWindowMs: wakeAt=0, now=2000 → 3000 (floor); now=10000 → 10000;
 *     now=20000 → 15000 (cap).
 *  4. resolve small result returns {truncated:false, value}.
 *  5. resolve >512KB result returns {truncated:true, partial, fullBytes}.
 *  6. sweepPastDeadline returns entries older than deadlineAt; leaves younger.
 *  7. manifest cache single-flight: two concurrent get(wsUrl) calls → one
 *     fetcher invocation, both get the result.
 *  8. per-wsUrl: get('wss://a') + get('wss://b') → two fetcher invocations.
 *  9. invalidate bumps seq; in-flight fetch discards its write.
 * 10. resetAll clears in-flight promises.
 */

import type { Manifest } from '@redesigner/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManifestCache } from '../../src/sw/manifestCache.js'
import type { InFlightRpc } from '../../src/sw/rpc.js'
import { createRpcManager } from '../../src/sw/rpc.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRpc(overrides: Partial<InFlightRpc> = {}): InFlightRpc {
  return {
    id: 'rpc-1',
    method: 'test/method',
    startedAt: 1_000_000,
    deadlineAt: 1_005_000,
    counter: 0,
    ...overrides,
  }
}

function makeManifest(partial: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: 'abc123',
    components: {},
    locs: {},
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// RPC Manager
// ---------------------------------------------------------------------------

describe('rpcManager — insert awaits persist', () => {
  it('(1) insert does not return until persist resolves', async () => {
    vi.useFakeTimers()

    let persistResolve!: () => void
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persistResolve = resolve
        }),
    )

    const mgr = createRpcManager({ persist })

    let insertDone = false
    const insertPromise = mgr.insert(makeRpc()).then(() => {
      insertDone = true
    })

    // Persist has been called but not resolved yet.
    expect(persist).toHaveBeenCalledTimes(1)
    expect(insertDone).toBe(false)

    // Resolve the persist promise.
    persistResolve()
    await insertPromise

    expect(insertDone).toBe(true)

    vi.useRealTimers()
  })
})

describe('rpcManager — monotonic counter', () => {
  it('(2) nextCounter increments by one each call, starting at 0', () => {
    const mgr = createRpcManager()
    expect(mgr.nextCounter()).toBe(0)
    expect(mgr.nextCounter()).toBe(1)
    expect(mgr.nextCounter()).toBe(2)
  })
})

describe('rpcManager — graceWindowMs', () => {
  it('(3a) now - wakeAt < 3000: floor to 3000', () => {
    const mgr = createRpcManager({ wakeAt: 0 })
    expect(mgr.graceWindowMs(2_000)).toBe(3_000)
  })

  it('(3b) now - wakeAt = 10000: returns 10000', () => {
    const mgr = createRpcManager({ wakeAt: 0 })
    expect(mgr.graceWindowMs(10_000)).toBe(10_000)
  })

  it('(3c) now - wakeAt > 15000: cap to 15000', () => {
    const mgr = createRpcManager({ wakeAt: 0 })
    expect(mgr.graceWindowMs(20_000)).toBe(15_000)
  })

  it('(3d) uses wakeAt offset correctly', () => {
    const mgr = createRpcManager({ wakeAt: 1_000 })
    // now - wakeAt = 3000 - 1000 = 2000 → floor to 3000
    expect(mgr.graceWindowMs(3_000)).toBe(3_000)
    // now - wakeAt = 12000 - 1000 = 11000 → 11000
    expect(mgr.graceWindowMs(12_000)).toBe(11_000)
    // now - wakeAt = 20000 - 1000 = 19000 → cap to 15000
    expect(mgr.graceWindowMs(20_000)).toBe(15_000)
  })
})

describe('rpcManager — resolve', () => {
  it('(4) small result returns {truncated:false, value}', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist })

    await mgr.insert(makeRpc({ id: 'r1' }))
    const env = await mgr.resolve('r1', { hello: 'world' })

    expect(env.truncated).toBe(false)
    expect(env.value).toEqual({ hello: 'world' })
    expect(env.partial).toBeUndefined()
    expect(env.fullBytes).toBeUndefined()
  })

  it('(5) >512KB result returns {truncated:true, partial, fullBytes}', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist, maxResultBytes: 100 })

    await mgr.insert(makeRpc({ id: 'r2' }))
    // Produce a payload that exceeds 100 bytes when JSON-encoded.
    const largeValue = { data: 'x'.repeat(200) }
    const env = await mgr.resolve('r2', largeValue)

    expect(env.truncated).toBe(true)
    expect(typeof env.partial).toBe('string')
    expect((env.partial as string).length).toBeLessThanOrEqual(100)
    expect(typeof env.fullBytes).toBe('number')
    expect(env.fullBytes as number).toBeGreaterThan(100)
    expect(env.value).toBeUndefined()
  })

  it('(5b) resolve removes the entry from current()', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist })

    await mgr.insert(makeRpc({ id: 'r3' }))
    expect(mgr.current().length).toBe(1)

    await mgr.resolve('r3', 'ok')
    expect(mgr.current().length).toBe(0)
  })
})

describe('rpcManager — sweepPastDeadline', () => {
  it('(6) returns entries with deadlineAt < now, leaves younger entries', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist })

    const expired = makeRpc({ id: 'exp', deadlineAt: 1_000 })
    const young = makeRpc({ id: 'young', deadlineAt: 9_000 })

    await mgr.insert(expired)
    await mgr.insert(young)

    const swept = await mgr.sweepPastDeadline(5_000)

    expect(swept.length).toBe(1)
    expect(swept[0]?.id).toBe('exp')

    // Only the young entry remains in current().
    const remaining = mgr.current()
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.id).toBe('young')
  })

  it('(6b) sweep with no expired entries returns empty array', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist })

    await mgr.insert(makeRpc({ id: 'r1', deadlineAt: 9_000 }))
    const swept = await mgr.sweepPastDeadline(1_000)
    expect(swept).toHaveLength(0)
    expect(mgr.current()).toHaveLength(1)
  })

  it('(6c) sweep persists after removing expired entries', async () => {
    const calls: number[] = []
    const persist = vi.fn(async () => {
      calls.push(Date.now())
    })
    const mgr = createRpcManager({ persist })

    await mgr.insert(makeRpc({ id: 'r1', deadlineAt: 500 }))
    const callsBefore = persist.mock.calls.length
    await mgr.sweepPastDeadline(1_000)
    // persist should have been called once more for the sweep
    expect(persist.mock.calls.length).toBe(callsBefore + 1)
  })
})

describe('rpcManager — reject', () => {
  it('reject removes the entry and persists', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const mgr = createRpcManager({ persist })

    await mgr.insert(makeRpc({ id: 'r1' }))
    expect(mgr.current().length).toBe(1)

    await mgr.reject('r1', { code: 'timeout', message: 'timed out' })
    expect(mgr.current().length).toBe(0)
    // persist called for insert + reject
    expect(persist).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// ManifestCache
// ---------------------------------------------------------------------------

describe('manifestCache — single-flight', () => {
  it('(7) two concurrent get() calls share one fetcher invocation', async () => {
    let fetchResolve!: (m: Manifest) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Manifest>((res) => {
          fetchResolve = res
        }),
    )

    const cache = createManifestCache()

    const p1 = cache.get('wss://daemon', { fetcher })
    const p2 = cache.get('wss://daemon', { fetcher })

    expect(fetcher).toHaveBeenCalledTimes(1)

    const manifest = makeManifest({ contentHash: 'single-flight' })
    fetchResolve(manifest)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.contentHash).toBe('single-flight')
    // Still only one fetcher invocation.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('(7b) subsequent get() after resolution returns cached manifest without fetching', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'cached' }))
    const cache = createManifestCache()

    await cache.get('wss://daemon', { fetcher })
    await cache.get('wss://daemon', { fetcher })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('manifestCache — per-wsUrl isolation', () => {
  it('(8) get() for different wsUrls invokes fetcher separately', async () => {
    const fetcherA = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'a' }))
    const fetcherB = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'b' }))

    const cache = createManifestCache()

    const [ra, rb] = await Promise.all([
      cache.get('wss://a', { fetcher: fetcherA }),
      cache.get('wss://b', { fetcher: fetcherB }),
    ])

    expect(fetcherA).toHaveBeenCalledTimes(1)
    expect(fetcherB).toHaveBeenCalledTimes(1)
    expect(ra.contentHash).toBe('a')
    expect(rb.contentHash).toBe('b')
  })
})

describe('manifestCache — invalidate', () => {
  it('(9) invalidate bumps seq; in-flight fetch discards its write', async () => {
    let fetchResolve!: (m: Manifest) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Manifest>((res) => {
          fetchResolve = res
        }),
    )

    const cache = createManifestCache()

    // Start a fetch but do not resolve yet.
    const p = cache.get('wss://daemon', { fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const seqBefore = cache.seq('wss://daemon')

    // Invalidate while fetch is in-flight.
    cache.invalidate('wss://daemon')
    expect(cache.seq('wss://daemon')).toBeGreaterThan(seqBefore)

    // Now resolve the stale fetch.
    fetchResolve(makeManifest({ contentHash: 'stale' }))

    // The stale promise still resolves (the caller gets the value), but the
    // cache should NOT store the stale manifest.
    await p

    // Cache should have no stored manifest for this url (was cleared by invalidate).
    // A fresh get() should invoke fetcher again.
    const fetcher2 = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'fresh' }))
    const result = await cache.get('wss://daemon', { fetcher: fetcher2 })
    expect(fetcher2).toHaveBeenCalledTimes(1)
    expect(result.contentHash).toBe('fresh')
  })

  it('(9b) invalidate returns seq incremented by 1', () => {
    const cache = createManifestCache()
    expect(cache.seq('wss://daemon')).toBe(0)
    cache.invalidate('wss://daemon')
    expect(cache.seq('wss://daemon')).toBe(1)
    cache.invalidate('wss://daemon')
    expect(cache.seq('wss://daemon')).toBe(2)
  })
})

describe('manifestCache — resetAll', () => {
  it('(10) resetAll clears in-flight promises so next get() starts a new fetch', async () => {
    let fetchResolve!: (m: Manifest) => void
    const fetcher1 = vi.fn(
      () =>
        new Promise<Manifest>((res) => {
          fetchResolve = res
        }),
    )

    const cache = createManifestCache()

    // Start a fetch but do not resolve.
    const stalePromise = cache.get('wss://daemon', { fetcher: fetcher1 })
    expect(fetcher1).toHaveBeenCalledTimes(1)

    // Simulate SW wake: reset all in-flight promises.
    cache.resetAll()

    // A new get() should start a fresh fetch (not join the stale promise).
    const fetcher2 = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'after-reset' }))
    const result = await cache.get('wss://daemon', { fetcher: fetcher2 })
    expect(fetcher2).toHaveBeenCalledTimes(1)
    expect(result.contentHash).toBe('after-reset')

    // Clean up the stale promise to avoid unhandled rejections.
    fetchResolve(makeManifest())
    await stalePromise
  })

  it('(10b) resetAll keeps resolved manifests; get() still hits cache', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeManifest({ contentHash: 'pre-reset' }))
    const cache = createManifestCache()

    await cache.get('wss://daemon', { fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)

    // resetAll keeps manifests.
    cache.resetAll()

    // get() should return from cache without re-fetching.
    const result = await cache.get('wss://daemon', { fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.contentHash).toBe('pre-reset')
  })
})

describe('manifestCache — seq tracking', () => {
  it('seq starts at 0 for unseen urls', () => {
    const cache = createManifestCache()
    expect(cache.seq('wss://unknown')).toBe(0)
  })

  it('seq increments on first fetch start', async () => {
    const cache = createManifestCache()
    expect(cache.seq('wss://daemon')).toBe(0)

    // Starting a fetch bumps seq to 1 (expectedSeq).
    const p = cache.get('wss://daemon', {
      fetcher: () => Promise.resolve(makeManifest()),
    })
    // seq was bumped to 1 before the async fetch.
    expect(cache.seq('wss://daemon')).toBe(1)
    await p
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
