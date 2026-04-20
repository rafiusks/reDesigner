// @vitest-environment happy-dom

/**
 * Task 25 — wsClient + connPool integration tests.
 *
 * Uses a FakeWebSocket DI'd into createWsClient via the `webSocketCtor` opt.
 * Drives open → hello → reconnect loop via fake timers.
 *
 * Scenarios:
 *  1. open() constructs a ws with subprotocols[1] = "base64url.bearer.authorization.redesigner.dev.<token>"
 *  2. query string includes `v=1` and `since=<n>` + `instance=<id>` when provided
 *  3. ws.protocol !== 'redesigner-v1' on open → treated as 1002 → onSessionRevalidate invoked
 *  4. hello frame → onHello + reducer reset (subsequent 1006 → attempts restarts from 1)
 *  5. onMessage with non-hello frame → onFrame called
 *  6. close 1006 → schedules reconnect after full-jitter delay; opens a new ws
 *  7. close 1002 → onSessionRevalidate called, then reconnect with fresh token
 *  8. close 1002 cap-exhaust (3rd) → onCsHandshakeRefetch + reconnect pauses until caller unblocks
 *  9. close 4406 with accepted list → caller's versionsSupported intersected, highest picked
 * 10. close 1015 → onGiveUp, no reconnect
 * 11. close() before open completes → aborts and no reconnect
 * 12. connPool acquire twice same url → same WsClient, refcount=2
 * 13. connPool release drops refcount, does NOT close until refcount=0
 * 14. connPool LRU eviction at cap
 * 15. connPool re-arm cooldown: after last release, re-acquire within 1s creates a NEW instance (cooldown doesn't block, it re-arms backoff state)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRandom, setRandom } from '../../src/shared/random.js'
import { createConnPool } from '../../src/sw/connPool.js'
import { createWsClient } from '../../src/sw/wsClient.js'
import type { FakeWebSocketCtor, WsClient, WsClientOpts } from '../../src/sw/wsClient.js'

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal WebSocket API impl for tests.
// ---------------------------------------------------------------------------

type Handler<E> = ((ev: E) => void) | null

interface FakeOpenEvent {
  type: 'open'
}

interface FakeCloseEvent {
  type: 'close'
  code: number
  reason: string
  wasClean: boolean
}

interface FakeMessageEvent {
  type: 'message'
  data: string
}

interface FakeErrorEvent {
  type: 'error'
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED

  static readonly instances: FakeWebSocket[] = []

  readyState: number = FakeWebSocket.CONNECTING
  protocol = 'redesigner-v1'
  readonly url: string
  readonly protocols: readonly string[]
  onopen: Handler<FakeOpenEvent> = null
  onclose: Handler<FakeCloseEvent> = null
  onmessage: Handler<FakeMessageEvent> = null
  onerror: Handler<FakeErrorEvent> = null

  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = typeof protocols === 'string' ? [protocols] : (protocols ?? [])
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code: code ?? 1000, reason: reason ?? '' }
    this.readyState = FakeWebSocket.CLOSED
  }

  // ---- test helpers ------------------------------------------------------

  fireOpen(protocol = 'redesigner-v1'): void {
    this.protocol = protocol
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({ type: 'open' })
  }

  fireMessage(data: unknown): void {
    this.onmessage?.({
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data),
    })
  }

  fireClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 })
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0
  }
}

const fakeCtor: FakeWebSocketCtor = FakeWebSocket as unknown as FakeWebSocketCtor

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<WsClientOpts> = {}): WsClientOpts {
  return {
    wsUrl: 'ws://127.0.0.1:5555/events',
    getSessionToken: vi.fn().mockResolvedValue('sess-abc'),
    onHello: vi.fn(),
    onFrame: vi.fn(),
    onClose: vi.fn(),
    onReconnectScheduled: vi.fn(),
    onGiveUp: vi.fn(),
    onSessionRevalidate: vi.fn().mockResolvedValue(undefined),
    onCsHandshakeRefetch: vi.fn(),
    webSocketCtor: fakeCtor,
    ...overrides,
  }
}

beforeEach(() => {
  FakeWebSocket.reset()
  vi.useFakeTimers()
  setRandom(() => 0.5)
})

afterEach(() => {
  vi.useRealTimers()
  resetRandom()
})

// ---------------------------------------------------------------------------
// wsClient — open flow
// ---------------------------------------------------------------------------

describe('wsClient — open flow', () => {
  it('(1) passes subprotocols[1] = "base64url.bearer.authorization.redesigner.dev.<token>"', async () => {
    const client = createWsClient(makeOpts({ getSessionToken: () => Promise.resolve('TOKEN123') }))
    client.open()
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBe(1)
    })
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    expect(ws.protocols).toEqual([
      'redesigner-v1',
      'base64url.bearer.authorization.redesigner.dev.TOKEN123',
    ])
  })

  it('(2) query includes v=1 by default', async () => {
    const client = createWsClient(makeOpts())
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const url = new URL(FakeWebSocket.instances[0]?.url ?? '')
    expect(url.searchParams.get('v')).toBe('1')
  })

  it('(2b) query includes since + instance when provided', async () => {
    const client = createWsClient(makeOpts({ sinceSeq: 42, instanceId: 'inst-xyz' }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const url = new URL(FakeWebSocket.instances[0]?.url ?? '')
    expect(url.searchParams.get('since')).toBe('42')
    expect(url.searchParams.get('instance')).toBe('inst-xyz')
  })

  it('(3) ws.protocol !== redesigner-v1 on open → onSessionRevalidate invoked', async () => {
    const onSessionRevalidate = vi.fn().mockResolvedValue(undefined)
    const client = createWsClient(makeOpts({ onSessionRevalidate }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    ws.fireOpen('something-else')
    // Close was initiated by wsClient — simulate the subsequent onclose.
    ws.fireClose(1002, 'subprotocol-mismatch')
    await vi.waitFor(() => expect(onSessionRevalidate).toHaveBeenCalled())
  })

  it('(4) hello frame invokes onHello and subsequent 1006 restarts attempts from 1', async () => {
    const onHello = vi.fn()
    const client = createWsClient(makeOpts({ onHello }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error()
    ws1.fireOpen()
    ws1.fireMessage({ type: 'hello', serverNonceEcho: 'xyz' })
    expect(onHello).toHaveBeenCalledOnce()
    // Now send a 1006 close — attempts resets because hello cleared the reducer.
    ws1.fireClose(1006)
    expect(client.state().attempts).toBe(1)
    expect(client.state().firstFailedAt).not.toBeNull()
  })

  it('(5) non-hello frame → onFrame invoked', async () => {
    const onFrame = vi.fn()
    const client = createWsClient(makeOpts({ onFrame }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    ws.fireOpen()
    ws.fireMessage({ type: 'hello', serverNonceEcho: 'xyz' })
    ws.fireMessage({ type: 'manifest_update', contentHash: 'h1' })
    expect(onFrame).toHaveBeenCalledWith({ type: 'manifest_update', contentHash: 'h1' })
  })
})

// ---------------------------------------------------------------------------
// wsClient — close-code handling + reconnect
// ---------------------------------------------------------------------------

describe('wsClient — close + reconnect', () => {
  it('(6) 1006 → schedules reconnect after full-jitter delay, opens a new ws', async () => {
    const onReconnectScheduled = vi.fn()
    const client = createWsClient(makeOpts({ onReconnectScheduled }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error()
    ws1.fireOpen()
    ws1.fireMessage({ type: 'hello' })
    ws1.fireClose(1006, 'abnormal')
    // 0.5 * min(30000, 1000 * 2^1) = 1000ms
    expect(onReconnectScheduled).toHaveBeenCalledWith(1000)
    // Advance timers → second ws constructed.
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('(7) 1002 → onSessionRevalidate awaited before reconnect', async () => {
    const revalidate = vi.fn().mockResolvedValue(undefined)
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('tok-1')
      .mockResolvedValue('tok-2')
    const client = createWsClient(
      makeOpts({ onSessionRevalidate: revalidate, getSessionToken: getToken }),
    )
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error()
    ws1.fireOpen()
    ws1.fireClose(1002, 'invalid-token')
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalled())
    // After revalidate resolves, a second ws should open with the new token.
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    expect(FakeWebSocket.instances[1]?.protocols[1]).toBe(
      'base64url.bearer.authorization.redesigner.dev.tok-2',
    )
  })

  it('(8) 1002 cap-exhaust → onCsHandshakeRefetch invoked', async () => {
    const onCs = vi.fn()
    const revalidate = vi.fn().mockResolvedValue(undefined)
    const client = createWsClient(
      makeOpts({ onCsHandshakeRefetch: onCs, onSessionRevalidate: revalidate }),
    )
    client.open()
    // Three 1002 closes in sequence.
    for (let i = 0; i < 3; i += 1) {
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(i + 1))
      const ws = FakeWebSocket.instances[i]
      if (!ws) throw new Error()
      ws.fireOpen()
      ws.fireClose(1002, '')
      if (i < 2) {
        await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(i + 1))
      }
    }
    await vi.waitFor(() => expect(onCs).toHaveBeenCalledOnce())
  })

  it('(9) 4406 with accepted list intersects versionsSupported, reconnects with highest overlap', async () => {
    const client = createWsClient(makeOpts({ versionsSupported: [1, 2, 3] }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error()
    ws1.fireOpen()
    ws1.fireClose(4406, '{"accepted":[1,2]}')
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    const url = new URL(FakeWebSocket.instances[1]?.url ?? '')
    // Highest overlap of [1,2,3] ∩ [1,2] = 2.
    expect(url.searchParams.get('v')).toBe('2')
  })

  it('(9b) 4406 with no overlap → onGiveUp', async () => {
    const onGiveUp = vi.fn()
    const client = createWsClient(makeOpts({ versionsSupported: [1], onGiveUp }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    ws.fireOpen()
    ws.fireClose(4406, '{"accepted":[2,3]}')
    await vi.waitFor(() => expect(onGiveUp).toHaveBeenCalled())
    // No reconnect after give-up.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('(10) 1015 → onGiveUp, no reconnect', async () => {
    const onGiveUp = vi.fn()
    const client = createWsClient(makeOpts({ onGiveUp }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    ws.fireOpen()
    ws.fireClose(1015, 'tls')
    expect(onGiveUp).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('(10b) 1000 → no reconnect, no give-up', async () => {
    const onGiveUp = vi.fn()
    const client = createWsClient(makeOpts({ onGiveUp }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    ws.fireOpen()
    ws.fireClose(1000)
    expect(onGiveUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('(11) close() before open completes → pending socket closed, no reconnect scheduled', async () => {
    const onReconnectScheduled = vi.fn()
    const client = createWsClient(makeOpts({ onReconnectScheduled }))
    client.open()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error()
    client.close()
    expect(ws.closed).not.toBeNull()
    // Even if the socket then fires a close event, no reconnect occurs.
    ws.fireClose(1006)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(onReconnectScheduled).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// connPool
// ---------------------------------------------------------------------------

describe('connPool', () => {
  it('(12) acquire twice same url → same client, refcount=2', () => {
    const pool = createConnPool()
    const build = vi.fn(
      (): WsClient => ({
        open: vi.fn(),
        close: vi.fn(),
        send: vi.fn(),
        state: () => ({
          attempts: 0,
          firstFailedAt: null,
          revalidate1002Failures: 0,
          giveUp: false,
          lastCode: null,
        }),
      }),
    )
    const a = pool.acquire('ws://a', build)
    const b = pool.acquire('ws://a', build)
    expect(a).toBe(b)
    expect(build).toHaveBeenCalledOnce()
    expect(pool.size()).toBe(1)
  })

  it('(13) release drops refcount; close only when refcount=0 + cooldown=0 disables linger', () => {
    // With reArmCooldownMs=0 the pool drops freed entries immediately —
    // useful for unit-testing the "full release closes" contract.
    const pool = createConnPool({ reArmCooldownMs: 0 })
    const close = vi.fn()
    const build = (): WsClient => ({
      open: vi.fn(),
      close,
      send: vi.fn(),
      state: () => ({
        attempts: 0,
        firstFailedAt: null,
        revalidate1002Failures: 0,
        giveUp: false,
        lastCode: null,
      }),
    })
    pool.acquire('ws://a', build)
    pool.acquire('ws://a', build)
    pool.release('ws://a')
    expect(close).not.toHaveBeenCalled()
    pool.release('ws://a')
    expect(close).toHaveBeenCalledOnce()
    expect(pool.size()).toBe(0)
  })

  it('(13b) with default cooldown, release-to-0 lingers and is reused on re-acquire', () => {
    const pool = createConnPool() // default 1s cooldown
    const close = vi.fn()
    let builds = 0
    const build = (): WsClient => {
      builds += 1
      return {
        open: vi.fn(),
        close,
        send: vi.fn(),
        state: () => ({
          attempts: 0,
          firstFailedAt: null,
          revalidate1002Failures: 0,
          giveUp: false,
          lastCode: null,
        }),
      }
    }
    pool.acquire('ws://a', build)
    pool.release('ws://a')
    // Entry lingers: close not called, re-acquire reuses it.
    expect(close).not.toHaveBeenCalled()
    pool.acquire('ws://a', build)
    expect(builds).toBe(1)
  })

  it('(14) LRU eviction at cap — oldest free entry evicted on new-key acquire', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000))
    const pool = createConnPool({ maxSize: 2, reArmCooldownMs: 60_000 })
    const closes: Record<string, ReturnType<typeof vi.fn>> = {}
    const build = (id: string) => (): WsClient => {
      const close = vi.fn()
      closes[id] = close
      return {
        open: vi.fn(),
        close,
        send: vi.fn(),
        state: () => ({
          attempts: 0,
          firstFailedAt: null,
          revalidate1002Failures: 0,
          giveUp: false,
          lastCode: null,
        }),
      }
    }
    pool.acquire('ws://a', build('a'))
    pool.release('ws://a') // freed but lingering (within cooldown)
    vi.setSystemTime(new Date(1_000_010))
    pool.acquire('ws://b', build('b'))
    pool.release('ws://b') // freed but lingering
    vi.setSystemTime(new Date(1_000_020))
    pool.acquire('ws://c', build('c')) // triggers LRU eviction of 'a'
    expect(pool.size()).toBe(2)
    expect(closes.a).toHaveBeenCalledOnce()
    expect(closes.b).not.toHaveBeenCalled()
    expect(closes.c).not.toHaveBeenCalled()
    expect(pool.get('ws://a')).toBeNull()
    vi.useRealTimers()
  })

  it('(15) re-arm cooldown: after cooldown expires, old client is closed and next acquire rebuilds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000))
    const pool = createConnPool({ reArmCooldownMs: 1_000 })
    const close = vi.fn()
    let builds = 0
    const build = (): WsClient => {
      builds += 1
      return {
        open: vi.fn(),
        close,
        send: vi.fn(),
        state: () => ({
          attempts: 0,
          firstFailedAt: null,
          revalidate1002Failures: 0,
          giveUp: false,
          lastCode: null,
        }),
      }
    }
    pool.acquire('ws://a', build)
    pool.release('ws://a')
    // Advance past cooldown — the next acquire sweeps the expired entry.
    vi.setSystemTime(new Date(1_000_000 + 2_000))
    pool.acquire('ws://a', build)
    expect(close).toHaveBeenCalledOnce()
    expect(builds).toBe(2)
    vi.useRealTimers()
  })

  it('size() reports current entries', () => {
    const pool = createConnPool()
    const build = (): WsClient => ({
      open: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      state: () => ({
        attempts: 0,
        firstFailedAt: null,
        revalidate1002Failures: 0,
        giveUp: false,
        lastCode: null,
      }),
    })
    expect(pool.size()).toBe(0)
    pool.acquire('ws://a', build)
    pool.acquire('ws://b', build)
    expect(pool.size()).toBe(2)
  })

  it('get() returns null for unknown key', () => {
    const pool = createConnPool()
    expect(pool.get('ws://nope')).toBeNull()
  })
})
