import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConcurrencyGate, createTokenBucket } from '../../src/rateLimit.js'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ─── Token bucket unit tests ──────────────────────────────────────────────────

describe('createTokenBucket — consumption and refill math', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at burst capacity', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    // All 5 initial tokens available
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
    expect(bucket.tryConsume()).toBe(false)
  })

  it('6th tryConsume returns false after exhausting burst=5', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    expect(bucket.tryConsume()).toBe(false)
  })

  it('refills at ratePerSec after 500ms with ratePerSec=10', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    // After 500ms: refill += 10 * 0.5 = 5 tokens, but capped at burst=5
    vi.setSystemTime(500)
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume()).toBe(true)
    }
    expect(bucket.tryConsume()).toBe(false)
  })

  it('refill is capped at burst=5 (not 10) after 1000ms', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    // After 1000ms: would refill 10, but capped at burst=5
    vi.setSystemTime(1000)
    let count = 0
    while (bucket.tryConsume()) count++
    expect(count).toBe(5) // burst cap, not 10
  })

  it('partial refill: 100ms with ratePerSec=10 adds 1 token', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    vi.setSystemTime(100) // 100ms * 10/s = 1 token
    expect(bucket.tryConsume()).toBe(true) // 1 token available
    expect(bucket.tryConsume()).toBe(false) // now empty
  })

  it('200ms refill adds 2 tokens', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    vi.setSystemTime(200)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
  })
})

describe('createTokenBucket — retryAfterSec ceil', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns at least 1 when fully exhausted', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    // tokens ≈ 0; (1-0)/10 = 0.1 → ceil(0.1)=1 → max(1,1)=1
    expect(bucket.retryAfterSec()).toBe(1)
  })

  it('retryAfterSec rounds UP for fractional seconds', () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5 })
    for (let i = 0; i < 5; i++) bucket.tryConsume()
    // After 50ms: +0.5 tokens. tokens≈0.5; (1-0.5)/10=0.05 → ceil=1
    vi.setSystemTime(50)
    expect(bucket.retryAfterSec()).toBe(1)
  })

  it('retryAfterSec=1 for ratePerSec=1 burst=1 after exhaustion', () => {
    const bucket = createTokenBucket({ ratePerSec: 1, burst: 1 })
    bucket.tryConsume()
    // tokens=0; (1-0)/1=1 → ceil(1)=1 → max(1,1)=1
    expect(bucket.retryAfterSec()).toBe(1)
  })

  it('retryAfterSec minimum is 1 even with very high ratePerSec', () => {
    const bucket = createTokenBucket({ ratePerSec: 1000, burst: 10 })
    for (let i = 0; i < 10; i++) bucket.tryConsume()
    // tokens=0; (1-0)/1000=0.001 → ceil=1 → max(1,1)=1
    expect(bucket.retryAfterSec()).toBe(1)
  })

  it('retryAfterSec decreases as tokens refill toward 1', () => {
    const bucket = createTokenBucket({ ratePerSec: 1, burst: 3 })
    for (let i = 0; i < 3; i++) bucket.tryConsume()
    // tokens=0; (1-0)/1=1 → retryAfter=1
    expect(bucket.retryAfterSec()).toBe(1)
    // After 500ms: tokens=0.5; (1-0.5)/1=0.5 → ceil=1 → still 1
    vi.setSystemTime(500)
    expect(bucket.retryAfterSec()).toBe(1)
  })
})

// ─── Concurrency gate ─────────────────────────────────────────────────────────

describe('createConcurrencyGate', () => {
  it('acquire() succeeds up to limit', () => {
    const gate = createConcurrencyGate(3)
    expect(gate.acquire()).toBe(true)
    expect(gate.acquire()).toBe(true)
    expect(gate.acquire()).toBe(true)
  })

  it('acquire() fails at limit+1', () => {
    const gate = createConcurrencyGate(3)
    gate.acquire()
    gate.acquire()
    gate.acquire()
    expect(gate.acquire()).toBe(false)
  })

  it('inFlight() tracks active count', () => {
    const gate = createConcurrencyGate(5)
    expect(gate.inFlight()).toBe(0)
    gate.acquire()
    gate.acquire()
    expect(gate.inFlight()).toBe(2)
    gate.release()
    expect(gate.inFlight()).toBe(1)
  })

  it('release() allows a new acquire() after limit was reached', () => {
    const gate = createConcurrencyGate(2)
    gate.acquire()
    gate.acquire()
    expect(gate.acquire()).toBe(false) // limit reached
    gate.release()
    expect(gate.acquire()).toBe(true) // slot freed
  })

  it('release() is idempotent at 0', () => {
    const gate = createConcurrencyGate(2)
    // release when nothing acquired — should not go negative
    gate.release()
    expect(gate.inFlight()).toBe(0)
    gate.acquire()
    expect(gate.inFlight()).toBe(1)
  })

  it('inFlight() returns 0 after all released', () => {
    const gate = createConcurrencyGate(3)
    gate.acquire()
    gate.acquire()
    gate.release()
    gate.release()
    expect(gate.inFlight()).toBe(0)
  })
})

// ─── Server-level rate-limit integration tests ────────────────────────────────

function makeCtx(overrides?: Partial<RouteContext>): RouteContext {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
  const selectionState = new SelectionState()
  const eventBus = new EventBus()
  const rpcCorrelation = new RpcCorrelation(8)
  const manifestWatcher = new ManifestWatcher(
    '/tmp/test-manifest.json',
    () => {},
    vi.fn() as unknown as typeof import('node:fs').promises.readFile,
    vi.fn() as unknown as typeof import('node:fs').promises.stat,
    logger,
  )
  return {
    selectionState,
    manifestWatcher,
    eventBus,
    rpcCorrelation,
    logger,
    serverVersion: '0.0.1',
    instanceId: 'test-instance',
    startedAt: Date.now() - 1000,
    projectRoot: '/tmp/test-project',
    shutdown: () => Promise.resolve(),
    ...overrides,
  }
}

async function listenOnEphemeral(token: Buffer): Promise<{
  url: string
  port: number
  close: () => Promise<void>
}> {
  const bootstrapToken = Buffer.from(crypto.randomBytes(32))
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const probe = createDaemonServer({ port: 0, token, bootstrapToken, rootToken, ctx: makeCtx() })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({
    port: assigned,
    token,
    bootstrapToken,
    rootToken,
    ctx: makeCtx(),
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    port: assigned,
    close: () => real.close(),
  }
}

describe('server unauth bucket — limits unauthenticated requests', () => {
  // The unauth bucket has ratePerSec=10, burst=10.
  // Sending >10 unauthenticated requests rapidly should hit 429.
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('11th unauthenticated request returns 429', async () => {
    let last429 = false
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${handle.url}/health`)
      if (res.status === 429) {
        last429 = true
        break
      }
    }
    expect(last429).toBe(true)
  })

  it('429 response includes Retry-After header', async () => {
    let retryAfter: string | null = null
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${handle.url}/health`)
      if (res.status === 429) {
        retryAfter = res.headers.get('retry-after')
        break
      }
    }
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
  })
})

describe('server unauth bucket — authenticated requests bypass unauth bucket', () => {
  // Authenticated requests go directly to the per-route bucket (getBucket: 100/s burst 100).
  // They must NOT be rate-limited by the 10/s unauth bucket.
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('20 authenticated requests all succeed (not rate-limited by unauth bucket)', async () => {
    const results: number[] = []
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${handle.url}/health`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      results.push(res.status)
    }
    // None should be 429 from the unauth bucket (getBucket allows 100/s burst=100)
    expect(results.every((s) => s === 200)).toBe(true)
  })

  it('bad-auth requests 429 but valid-auth request still succeeds', async () => {
    // Exhaust the unauth bucket with bad-auth requests
    for (let i = 0; i < 11; i++) {
      await fetch(`${handle.url}/health`, {
        headers: { Authorization: 'Bearer wrongtoken' },
      })
    }

    // Valid-auth request must still work (not counted against unauth bucket)
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
  })
})
