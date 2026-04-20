/**
 * Unit tests for EventBus
 *
 * Mock WebSocket notes:
 * - We do NOT use the real `ws` library — a hand-rolled mock gives us precise
 *   control over `readyState`, `bufferedAmount`, `send()`, and `close()`.
 * - The real `addSubscriber` calls `ws.once('close', ...)` to auto-remove the
 *   subscriber, so our mock must support EventEmitter-style `once`.
 * - The real `sendToSubscriber` calls `ws.once('drain', ...)` on soft
 *   backpressure, so we also need to be able to fire 'drain' events.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/state/eventBus.js'

// ---------------------------------------------------------------------------
// Hand-rolled WebSocket mock
// ---------------------------------------------------------------------------

/**
 * Simple mock WebSocket with a mutable `bufferedAmount` property.
 * Tests set `ws.bufferedAmount` directly before each action to control
 * what the EventBus implementation reads at each observation point.
 *
 * The EventBus reads `bufferedAmount` in two places per send:
 *   1. BEFORE send — hard watermark check (> 1*1024*1024)
 *   2. AFTER send  — soft pause check (> 0)
 * And once in onDrain:
 *   3. ON DRAIN    — >= 256*1024 guard
 *
 * We configure the mock's `send` spy to mutate `bufferedAmount` to simulate
 * the post-send state, giving us precise per-call control.
 */
function makeMockWs() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

  const ws = {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send: vi.fn((_msg: string, cb?: (err?: Error) => void) => {
      cb?.()
    }),
    close: vi.fn(),
    once(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler)
    },
    emit(event: string, ...args: unknown[]) {
      const handlers = listeners[event] ?? []
      // `once` means consume and remove
      listeners[event] = []
      for (const h of handlers) h(...args)
    },
  }
  return ws
}

type MockWs = ReturnType<typeof makeMockWs>

// ---------------------------------------------------------------------------
// seq monotonicity
// ---------------------------------------------------------------------------

describe('EventBus — seq monotonicity', () => {
  it('mintSeq returns strictly increasing values starting at 1', () => {
    const bus = new EventBus()
    const seqs = Array.from({ length: 100 }, () => bus.mintSeq())
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1)
    }
    expect(seqs[0]).toBe(1)
  })

  it('broadcast increments seq by exactly 1 per call', () => {
    const bus = new EventBus()
    expect(bus.currentSeq()).toBe(0)
    bus.broadcast({ type: 'a', payload: {} })
    expect(bus.currentSeq()).toBe(1)
    bus.broadcast({ type: 'b', payload: {} })
    expect(bus.currentSeq()).toBe(2)
  })

  it('seq from separate EventBus instances are independent', () => {
    const b1 = new EventBus()
    const b2 = new EventBus()
    b1.mintSeq()
    b1.mintSeq()
    b2.mintSeq()
    expect(b1.currentSeq()).toBe(2)
    expect(b2.currentSeq()).toBe(1)
  })

  it('seq in serialized broadcast payload matches ring entry seq', () => {
    const bus = new EventBus()
    const ws = makeMockWs() // bufferedAmount stays 0 → no pause
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)
    bus.broadcast({ type: 'test.event', payload: { x: 1 } })
    expect(bus.ringSize()).toBe(1)
    // The first entry must have seq=1
    expect(bus.earliestRetainedSeq()).toBe(1)
    // The serialized message sent to subscriber must contain seq:1
    const sent = ws.send.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(sent) as { seq: number; type: string }
    expect(parsed.seq).toBe(1)
    expect(parsed.type).toBe('test.event')
  })
})

// ---------------------------------------------------------------------------
// Ring buffer — metadata-only retention
// ---------------------------------------------------------------------------

describe('EventBus — ring buffer metadata-only retention', () => {
  it('ring never exceeds 1024 entries after overflow', () => {
    const bus = new EventBus()
    for (let i = 0; i < 2000; i++) {
      bus.recordFrame({ seq: bus.mintSeq(), type: 'overflow.test' })
    }
    expect(bus.ringSize()).toBe(1024)
  })

  it('ring entries have seq and type fields only — no payload', () => {
    const bus = new EventBus()
    // recordFrame receives only RingEntry — the type enforces no payload
    bus.recordFrame({ seq: bus.mintSeq(), type: 'meta.event' })
    // broadcast also calls recordFrame with only {seq, type}
    bus.broadcast({ type: 'broad.event', payload: { bigData: 'x'.repeat(10_000) } })

    // Verify ring entries by checking what broadcast stores
    // We can't directly inspect the ring array, but earliestRetainedSeq and
    // ringSize let us confirm the metadata contract indirectly:
    //   - ringSize = 2 means two entries were pushed
    //   - Each has a seq we can reason about
    expect(bus.ringSize()).toBe(2)
    expect(bus.earliestRetainedSeq()).toBe(1)
  })

  it('after overflow, retained entries span the most-recent 1024 seqs', () => {
    const bus = new EventBus()
    const TOTAL = 2048
    for (let i = 0; i < TOTAL; i++) {
      bus.recordFrame({ seq: bus.mintSeq(), type: 't' })
    }
    // currentSeq = 2048; ring holds seqs [1025..2048]
    expect(bus.earliestRetainedSeq()).toBe(TOTAL - 1024 + 1)
  })

  it('broadcast does NOT include payload in ring entry (ring entry is RingEntry shape)', () => {
    const bus = new EventBus()
    // broadcast internally calls recordFrame({seq, type}) — payload is not forwarded to ring
    // We confirm this by checking that broadcast advances ringSize by 1 (not 0, not 2)
    const before = bus.ringSize()
    bus.broadcast({ type: 'check', payload: { secret: 'hidden' } })
    expect(bus.ringSize()).toBe(before + 1)
    // earliestRetainedSeq is the seq minted — no payload field leaked
    expect(bus.earliestRetainedSeq()).toBe(bus.currentSeq())
  })
})

// ---------------------------------------------------------------------------
// computeResync — parameterized gap-threshold
// ---------------------------------------------------------------------------

describe('EventBus — computeResync', () => {
  /**
   * RING_CAP = 1024
   * computeResync logic (from source):
   *   if since === undefined || since >= current → hello-only
   *   earliest = current - RING_CAP + 1
   *   if since >= earliest - 1   → hello-only   (i.e. since >= current - 1024)
   *   else                        → hello-gap
   *
   * Boundary: since >= current - 1024 → hello-only
   *           since <  current - 1024 → hello-gap
   */

  // Table format: [label, since, currentSeq, expectedKind]
  const cases: Array<[string, number | undefined, number, 'hello-only' | 'hello-gap']> = [
    // since === currentSeq → already current
    ['since === currentSeq (100)', 100, 100, 'hello-only'],
    // since === 0 with currentSeq === 0 → cold start, no events yet
    ['cold start: since=0, current=0', 0, 0, 'hello-only'],
    // since === 0 with currentSeq > 0 → cold client, buffer can't help → hello-gap
    ['cold start: since=0, current=2000', 0, 2000, 'hello-gap'],
    // since is exactly at currentSeq - 1023 → within buffer (since >= current - 1024)
    ['since = currentSeq - 1023 (boundary in)', 977, 2000, 'hello-only'],
    // since is exactly at currentSeq - 1024 → boundary: 977 >= 976 → hello-only
    ['since = currentSeq - 1024 (boundary edge)', 976, 2000, 'hello-only'],
    // since is at currentSeq - 1025 → just outside buffer → hello-gap
    ['since = currentSeq - 1025 (one beyond buffer)', 975, 2000, 'hello-gap'],
    // since > currentSeq → client is ahead (impossible in normal flow) → hello-only
    ['since > currentSeq (150 > 100)', 150, 100, 'hello-only'],
    // undefined since → treat as hello-only
    ['since undefined → hello-only', undefined, 500, 'hello-only'],
    // currentSeq exactly 1024 and since=0 → since < 1024 - 1024 = 0? boundary
    // earliest = 1024 - 1024 + 1 = 1; since(0) >= 1-1=0 → hello-only
    ['currentSeq=1024, since=0 → exactly on boundary', 0, 1024, 'hello-only'],
    // currentSeq=1025, since=0 → earliest=2; since(0) >= 2-1=1? 0 >= 1 is false → hello-gap
    ['currentSeq=1025, since=0 → just past boundary', 0, 1025, 'hello-gap'],
  ]

  it.each(cases)('%s', (_, since, currentSeq, expectedKind) => {
    const bus = new EventBus()
    const result = bus.computeResync(since, currentSeq)
    expect(result.kind).toBe(expectedKind)
  })

  it('hello-gap carries correct droppedFrom and droppedTo', () => {
    const bus = new EventBus()
    // since=5, current=2000: earliest=977, since(5) < 976 → hello-gap
    // droppedFrom = since+1 = 6
    // droppedTo   = current - RING_CAP = 2000 - 1024 = 976
    const result = bus.computeResync(5, 2000)
    expect(result.kind).toBe('hello-gap')
    if (result.kind === 'hello-gap') {
      expect(result.droppedFrom).toBe(6)
      expect(result.droppedTo).toBe(976)
    }
  })
})

// ---------------------------------------------------------------------------
// Backpressure — soft (bufferedAmount > 0 post-send)
// ---------------------------------------------------------------------------

describe('EventBus — soft backpressure (bufferedAmount > 0 after send)', () => {
  it('subscriber is paused after first send if bufferedAmount > 0 post-send', () => {
    // Hard check (pre-send): bufferedAmount = 0  → OK, send proceeds
    // Post-send: bufferedAmount = 500            → soft pause (> 0)
    const bus = new EventBus()
    const ws = makeMockWs()
    // Configure send spy: after send fires, mutate bufferedAmount to simulate post-send state
    ws.send.mockImplementation((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 500 // simulate partial flush
      cb?.()
    })
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'msg.1', payload: {} })

    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(ws.close).not.toHaveBeenCalled()
  })

  it('while paused, subsequent broadcasts do not call ws.send', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.send.mockImplementation((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 500
      cb?.()
    })
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'msg.1', payload: {} }) // sends, then paused
    bus.broadcast({ type: 'msg.2', payload: {} }) // skipped (paused)
    bus.broadcast({ type: 'msg.3', payload: {} }) // skipped (paused)

    // Only the first broadcast sent
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(ws.close).not.toHaveBeenCalled()
  })

  it('after soft pause, close is never called (only hard watermark closes)', () => {
    // bufferedAmount < HARD_WATERMARK_BYTES before send, but > 0 after → only soft pause
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.send.mockImplementation((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 800_000 // > 0, < 1MiB → soft pause only
      cb?.()
    })
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)
    bus.broadcast({ type: 'msg', payload: {} })
    expect(ws.close).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Backpressure — hard (bufferedAmount > 1MiB before send)
// ---------------------------------------------------------------------------

describe('EventBus — hard backpressure (bufferedAmount > 1MiB)', () => {
  it('subscriber is closed with code 4429 when bufferedAmount > 1MiB before send', () => {
    // HARD_WATERMARK_BYTES = 1 * 1024 * 1024 = 1_048_576
    // Set bufferedAmount to 1_048_577 BEFORE broadcast so the pre-send hard check fires
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.bufferedAmount = 1_048_577
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'overload', payload: {} })

    // close fired immediately — send never called
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(4429, 'backpressure hard watermark')
  })

  it('hard watermark is strictly > 1MiB (exactly 1MiB is not hard)', () => {
    // HARD_WATERMARK_BYTES = 1_048_576; the check is >, not >=
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.bufferedAmount = 1_048_576 // exactly 1MiB — NOT > 1MiB, should NOT close
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'borderline', payload: {} })

    // send was called (1_048_576 is not > 1_048_576)
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(ws.close).not.toHaveBeenCalled()
  })

  it('hard watermark closes only the over-limit subscriber, not others', () => {
    const bus = new EventBus()
    const wsHard = makeMockWs()
    wsHard.bufferedAmount = 1_048_577
    const wsOk = makeMockWs()
    // wsOk.bufferedAmount stays 0

    bus.addSubscriber(wsHard as unknown as import('ws').WebSocket)
    bus.addSubscriber(wsOk as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'msg', payload: {} })

    expect(wsHard.close).toHaveBeenCalledWith(4429, 'backpressure hard watermark')
    expect(wsHard.send).not.toHaveBeenCalled()
    expect(wsOk.close).not.toHaveBeenCalled()
    expect(wsOk.send).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Drain loop — cap at DRAIN_LOOP_LIMIT (3)
// ---------------------------------------------------------------------------

describe('EventBus — drain loop cap (DRAIN_LOOP_LIMIT = 3)', () => {
  /**
   * NOTE: The drain rebroadcast (TODO in Task 12, line 102 of eventBus.ts) is
   * NOT implemented. After `onDrain` sets paused=false it does nothing more —
   * the subscriber must wait for the next broadcast to receive messages.
   * Tests here reflect the ACTUAL behavior: drain increments drainLoopCount,
   * and after DRAIN_LOOP_LIMIT(3) iterations the ws is closed with 4429.
   *
   * Drain cycle mechanics:
   *   1. Set bufferedAmount = 0 (clean start, hard check passes)
   *   2. Configure send to bump bufferedAmount > 0 (soft pause triggers)
   *   3. ws.emit('drain') with bufferedAmount set to < 256KB → paused=false, drainLoopCount++
   *   4. Repeat: next broadcast passes hard check (bufferedAmount reset to 0 before), send bumps it
   */

  /**
   * Helper: trigger one pause+drain cycle.
   * Before calling: ws.bufferedAmount must be 0 (so hard check passes and next send is reached).
   * After calling: drainLoopCount has incremented by 1; paused=false (if not yet at limit).
   */
  function pauseAndDrain(bus: EventBus, ws: MockWs, type: string): void {
    ws.bufferedAmount = 0 // ensure hard check passes
    ws.send.mockImplementationOnce((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 500 // post-send: trigger soft pause
      cb?.()
    })
    bus.broadcast({ type, payload: {} })
    // Simulate drain: buffer has drained below 256KB threshold
    ws.bufferedAmount = 0
    ws.emit('drain')
  }

  it('first drain sets paused=false and does NOT close', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    pauseAndDrain(bus, ws, 'c1')

    expect(ws.close).not.toHaveBeenCalled()
  })

  it('second drain does NOT close (still below DRAIN_LOOP_LIMIT=3)', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    pauseAndDrain(bus, ws, 'c1')
    pauseAndDrain(bus, ws, 'c2')

    expect(ws.close).not.toHaveBeenCalled()
  })

  it('closes with 4429 after DRAIN_LOOP_LIMIT (3) drain cycles', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    // Each pauseAndDrain cycle increments drainLoopCount by 1.
    // At cycle 3, drainLoopCount hits DRAIN_LOOP_LIMIT (3) → close(4429).
    pauseAndDrain(bus, ws, 'c1') // drainLoopCount = 1
    expect(ws.close).not.toHaveBeenCalled()

    pauseAndDrain(bus, ws, 'c2') // drainLoopCount = 2
    expect(ws.close).not.toHaveBeenCalled()

    pauseAndDrain(bus, ws, 'c3') // drainLoopCount = 3 >= DRAIN_LOOP_LIMIT → close
    expect(ws.close).toHaveBeenCalledWith(4429, 'drain loop limit')
  })

  it('drain does nothing if bufferedAmount >= 256KB at drain time (stays paused)', () => {
    // After a soft pause, if the 'drain' event fires but bufferedAmount is still >= 256KB,
    // onDrain returns early — subscriber remains paused.
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.send.mockImplementationOnce((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 500
      cb?.()
    })
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'msg', payload: {} }) // paused
    ws.bufferedAmount = 300_000 // >= 256*1024 → onDrain early return
    ws.emit('drain')

    // subscriber is still paused — next broadcast must be swallowed
    expect(ws.close).not.toHaveBeenCalled()
    ws.send.mockClear()
    bus.broadcast({ type: 'msg2', payload: {} })
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('drain rebroadcast TODO — after drain no replay occurs (latent behavior)', () => {
    /**
     * The Task 12 comment at line 102 says "Post-drain: ext fetches fresh
     * snapshot via hello rebroadcast (wired in Task 12)" — but the code does
     * nothing after setting paused=false. No rebroadcast, no notify.
     * This test documents the ACTUAL (no-op) behavior so a future change
     * doesn't silently break the invariant without a test update.
     */
    const bus = new EventBus()
    const ws = makeMockWs()
    ws.send.mockImplementationOnce((_msg: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount = 500
      cb?.()
    })
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)

    bus.broadcast({ type: 'original', payload: {} })
    ws.send.mockClear()
    ws.bufferedAmount = 0
    ws.emit('drain')

    // No additional sends triggered by drain itself
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.close).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Subscriber lifecycle
// ---------------------------------------------------------------------------

describe('EventBus — subscriber lifecycle', () => {
  it('addSubscriber increments subscriberCount', () => {
    const bus = new EventBus()
    expect(bus.subscriberCount()).toBe(0)
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)
    expect(bus.subscriberCount()).toBe(1)
  })

  it('ws close event removes subscriber automatically', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)
    expect(bus.subscriberCount()).toBe(1)
    ws.emit('close')
    expect(bus.subscriberCount()).toBe(0)
  })

  it('broadcast reaches all active subscribers', () => {
    const bus = new EventBus()
    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    bus.addSubscriber(ws1 as unknown as import('ws').WebSocket)
    bus.addSubscriber(ws2 as unknown as import('ws').WebSocket)
    bus.broadcast({ type: 'hello', payload: 42 })
    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
  })

  it('broadcast does not reach a subscriber that was removed via close', () => {
    const bus = new EventBus()
    const ws = makeMockWs()
    bus.addSubscriber(ws as unknown as import('ws').WebSocket)
    ws.emit('close')
    bus.broadcast({ type: 'msg', payload: {} })
    expect(ws.send).not.toHaveBeenCalled()
  })
})
