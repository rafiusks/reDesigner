/**
 * browserToolProxy integration — daemon HTTP ↔ WS proxy for browser-tool RPCs.
 *
 * Task 31 of the daemon v0 plan. Exercises the daemon's routing glue between
 * POST /computed_styles|/dom_subtree and the extension subscriber on /events:
 *
 *   HTTP caller ─► POST /computed_styles ─► daemon broadcasts rpc.request ─►
 *                  ext replies with rpc.response ─► daemon resolves the
 *                  correlated promise ─► HTTP 200 with the ext's result.
 *
 * Six scenarios per spec §5 error taxonomy + §8 problem+json rows:
 *
 *   1. 424 ExtensionUnavailable — POST with no WS subscriber connected.
 *   2. Happy path — mock ext connects, subscribes, receives rpc.request,
 *      replies with rpc.response, daemon returns 200 with that result.
 *   3. 504 ExtensionTimeout — ext connects, subscribes, receives rpc.request,
 *      never replies. Real 5000ms timeout (TIMEOUT_COMPUTED_STYLES_MS in
 *      routes/browserTools.ts is a module-level constant with no env-override;
 *      see "API mismatches" below).
 *   4. 503 ExtensionDisconnected + Retry-After:2 — ext receives rpc.request,
 *      then WS closes without replying. Daemon's ws/events close handler
 *      rejectAll('ext disconnected')s every pending RPC.
 *   5. 503 Shutdown + Connection:close — ext receives rpc.request, test
 *      triggers POST /shutdown before ext responds; lifecycle.shutdownGracefully
 *      rejectAlls pending RPCs with Error('Shutdown').
 *   6. 503 ConcurrencyLimitReached + Retry-After:0 — 9 concurrent POSTs against
 *      a concurrencyLimit of 8. Mock ext receives 8 rpc.requests (never replies
 *      so all 8 slots stay busy) and the 9th POST is rejected before daemon
 *      broadcasts its rpc.request — we assert the ext sees exactly 8.
 *
 * Harness: fork dist/child.js via spawnDaemon() from test/helpers/forkDaemon.ts.
 * Mock extension is a `ws` client that sends Authorization: Bearer + correct
 * Host header; subscribe protocol is just connecting to /events (§WS upgrade).
 *
 * API mismatches vs task description (real code is the authority):
 *   - Timeouts in routes/browserTools.ts: 5000ms (getComputedStyles) and
 *     10000ms (getDomSubtree), not 6000/11000ms. No env-override — we pay the
 *     full 5s for scenario 3. Full suite runtime ≈ 10–12s.
 *   - rejectAll(Error('Shutdown')) and rejectAll(Error('ext disconnected'))
 *     messages are matched case-insensitively against 'shutdown'/'disconnected'
 *     in the route catch block (fixed alongside this test — 'Shutdown' vs
 *     lowercase 'shutdown' was a bug the task-31 test surfaced). See
 *     routes/browserTools.ts error-taxonomy catch.
 *   - ws/events.ts subscriber message handler was not wired to rpcCorrelation
 *     before this task — added as part of landing task 31 because without it
 *     scenarios 2/4/5 have no path to the right error codes.
 *
 * Flakes / runtime notes:
 *   - singleFork pool ensures integration files run serially, so the 5s
 *     timeout scenario does not stall other test files.
 *   - Teardown closes all WS clients + kills the daemon fork; cleanupTempDirs()
 *     removes the .redesigner dirs created by randomTempDir().
 */

import fs from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CHILD_JS, type DaemonHarness, forceKill, spawnDaemon } from '../helpers/forkDaemon.js'
import { cleanupTempDirs } from '../helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Platform-timed constants
// ---------------------------------------------------------------------------

/** HTTP timeout budget for "fast" requests (non-timeout scenarios). */
const FETCH_TIMEOUT_FAST_MS = 2_000

/** HTTP timeout budget for the "ext never replies → 504" path — computed_styles. */
const FETCH_TIMEOUT_SLOW_MS = 8_000

/** HTTP timeout budget that covers dom_subtree's 10s route timeout. */
const FETCH_TIMEOUT_DOM_SLOW_MS = 12_000

/** Time to wait for the hello frame on a fresh WS connection. */
const HELLO_TIMEOUT_MS = 1_000

/** Time to wait for a single rpc.request frame after POSTing a browser-tool. */
const RPC_REQUEST_TIMEOUT_MS = 1_000

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_HANDLE = {
  id: 'sel-1',
  componentName: 'App',
  filePath: 'src/App.tsx',
  lineRange: [1, 10] as [number, number],
  domPath: 'html>body>div',
  parentChain: [],
  timestamp: 1_700_000_000_000,
}

type RpcRequestFrame = {
  type: 'rpc.request'
  seq: number
  payload: {
    jsonrpc: '2.0'
    id: string
    method: 'getComputedStyles' | 'getDomSubtree'
    params: { handle: Record<string, unknown>; depth?: number }
  }
}

// ---------------------------------------------------------------------------
// WS helpers — mock extension client
// ---------------------------------------------------------------------------

interface MockExt {
  ws: WebSocket
  /** FIFO of rpc.request frames observed since the last drain. */
  requests: RpcRequestFrame[]
  /** Awaitable for the next rpc.request frame; resolves with the frame. */
  nextRpcRequest: () => Promise<RpcRequestFrame>
  /** Send a well-formed rpc.response tied to a previously-seen request id. */
  replyResult: (id: string, result: unknown) => void
  /** Close the WS from the ext side (simulates extension crash). */
  close: () => void
}

async function connectMockExt(h: DaemonHarness): Promise<MockExt> {
  const requests: RpcRequestFrame[] = []
  const waiters: Array<(f: RpcRequestFrame) => void> = []

  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/events`, ['redesigner-v1'], {
    headers: {
      Host: `127.0.0.1:${h.port}`,
      // Origin must either be absent or match the chrome-extension://… allowlist;
      // undefined per undici default is fine.
      Authorization: h.authHeader,
    },
  })

  // Wait for both 'open' and the 'hello' frame before returning — this
  // guarantees ctx.eventBus.subscriberCount() === 1 from the daemon's side
  // (handleUpgrade has already registered the subscriber by the time hello
  // lands on the wire).
  const openPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), HELLO_TIMEOUT_MS)
    timer.unref()
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  const helloPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello frame timeout')), HELLO_TIMEOUT_MS)
    timer.unref()
    ws.once('message', (data) => {
      clearTimeout(timer)
      try {
        const frame = JSON.parse(String(data)) as { type?: unknown }
        if (frame.type !== 'hello') {
          reject(new Error(`expected hello, got ${JSON.stringify(frame.type)}`))
          return
        }
      } catch (err) {
        reject(new Error(`hello parse: ${String(err)}`))
        return
      }
      resolve()
    })
  })
  await openPromise
  await helloPromise

  // After hello, route future messages into the RPC request ring buffer.
  ws.on('message', (data) => {
    let frame: unknown
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    const t = (frame as { type?: unknown }).type
    if (t === 'rpc.request') {
      const rpc = frame as RpcRequestFrame
      if (waiters.length > 0) {
        const w = waiters.shift()
        if (w) w(rpc)
      } else {
        requests.push(rpc)
      }
    }
    // Other frame types (selection.updated, shutdown, etc.) are ignored here.
  })

  return {
    ws,
    requests,
    nextRpcRequest: () =>
      new Promise<RpcRequestFrame>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`rpc.request not received within ${RPC_REQUEST_TIMEOUT_MS}ms`)),
          RPC_REQUEST_TIMEOUT_MS,
        )
        timer.unref()
        const tryResolve = (): void => {
          const next = requests.shift()
          if (next !== undefined) {
            clearTimeout(timer)
            resolve(next)
            return
          }
          waiters.push((f) => {
            clearTimeout(timer)
            resolve(f)
          })
        }
        tryResolve()
      }),
    replyResult: (id, result) => {
      ws.send(
        JSON.stringify({
          type: 'rpc.response',
          payload: { jsonrpc: '2.0', id, result },
        }),
      )
    },
    close: () => {
      ws.close()
    },
  }
}

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return
  return new Promise<void>((resolve) => {
    ws.once('close', () => resolve())
  })
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function postBrowserTool(
  h: DaemonHarness,
  path: '/computed_styles' | '/dom_subtree',
  body: unknown,
  timeoutMs: number = FETCH_TIMEOUT_FAST_MS,
): Promise<Response> {
  return fetch(`${h.urlPrefix}${path}`, {
    method: 'POST',
    headers: {
      Authorization: h.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browserToolProxy — HTTP ↔ WS proxy for browser-tool RPCs', () => {
  let harnesses: DaemonHarness[] = []
  let wsClients: WebSocket[] = []

  beforeAll(() => {
    if (!fs.existsSync(CHILD_JS)) {
      throw new Error(
        `built child entry missing at ${CHILD_JS}; run \`pnpm --filter @redesigner/daemon build\` first`,
      )
    }
  })

  afterEach(async () => {
    // Close WS clients first so their 'close' handlers fire while the daemon
    // is still alive (otherwise rejectAll happens post-mortem, which is a
    // silent no-op, but kept tidy regardless).
    for (const ws of wsClients) {
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close()
        }
      } catch {
        // swallow — best-effort teardown
      }
    }
    wsClients = []

    for (const h of harnesses) {
      await forceKill(h.child)
      try {
        fs.unlinkSync(h.handoffPath)
      } catch {
        // best-effort — shutdownGracefully normally does this
      }
    }
    harnesses = []
    cleanupTempDirs()
  })

  async function boot(): Promise<DaemonHarness> {
    const h = await spawnDaemon({ tempDirPrefix: 'redesigner-bt-' })
    harnesses.push(h)
    return h
  }

  async function mockExt(h: DaemonHarness): Promise<MockExt> {
    const ext = await connectMockExt(h)
    wsClients.push(ext.ws)
    return ext
  }

  // -------------------------------------------------------------------------
  // Scenario 1 — 424 ExtensionUnavailable
  // -------------------------------------------------------------------------

  it('POST /computed_styles with no WS subscriber → 424 ExtensionUnavailable', async () => {
    const h = await boot()
    const res = await postBrowserTool(h, '/computed_styles', { handle: SAMPLE_HANDLE })
    expect(res.status).toBe(424)
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    const body = (await res.json()) as { code?: string; status?: number; type?: string }
    expect(body.code).toBe('ExtensionUnavailable')
    expect(body.status).toBe(424)
    expect(typeof body.type).toBe('string')
  })

  it('POST /dom_subtree with no WS subscriber → 424 ExtensionUnavailable', async () => {
    const h = await boot()
    const res = await postBrowserTool(h, '/dom_subtree', { handle: SAMPLE_HANDLE })
    expect(res.status).toBe(424)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('ExtensionUnavailable')
  })

  // -------------------------------------------------------------------------
  // Scenario 2 — Happy path
  // -------------------------------------------------------------------------

  it('happy path /computed_styles: ext replies with result → HTTP 200 passes result through', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    const resultPayload = { color: 'rgb(255, 0, 0)', fontSize: '14px' }

    const fetchPromise = postBrowserTool(h, '/computed_styles', {
      handle: SAMPLE_HANDLE,
      depth: 2,
    })

    // Wait for the daemon's rpc.request frame to land on the ext.
    const rpcReq = await ext.nextRpcRequest()
    expect(rpcReq.type).toBe('rpc.request')
    expect(rpcReq.payload.method).toBe('getComputedStyles')
    expect(rpcReq.payload.params.handle.id).toBe(SAMPLE_HANDLE.id)
    expect(rpcReq.payload.params.depth).toBe(2)
    expect(typeof rpcReq.payload.id).toBe('string')
    expect(rpcReq.payload.id).toMatch(/^[0-9a-f]{32}$/)

    // Reply with matching id.
    ext.replyResult(rpcReq.payload.id, resultPayload)

    const res = await fetchPromise
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual(resultPayload)
  })

  it('happy path /dom_subtree: ext replies with result → HTTP 200', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    const resultPayload = { tag: 'div', children: [{ tag: 'span', children: [] }] }

    const fetchPromise = postBrowserTool(h, '/dom_subtree', { handle: SAMPLE_HANDLE })

    const rpcReq = await ext.nextRpcRequest()
    expect(rpcReq.payload.method).toBe('getDomSubtree')
    ext.replyResult(rpcReq.payload.id, resultPayload)

    const res = await fetchPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual(resultPayload)
  })

  // -------------------------------------------------------------------------
  // Scenario 3 — 504 ExtensionTimeout
  // -------------------------------------------------------------------------
  //
  // Real timers: TIMEOUT_COMPUTED_STYLES_MS = 5000. No env/DI override.
  // Fetch timeout extended to 8000ms to cover the 5s route timeout + margin.

  it('ext connects but never replies → 504 ExtensionTimeout after 5s', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    const started = Date.now()
    const fetchPromise = postBrowserTool(
      h,
      '/computed_styles',
      { handle: SAMPLE_HANDLE },
      FETCH_TIMEOUT_SLOW_MS,
    )

    // Ext sees the request but stays silent.
    const rpcReq = await ext.nextRpcRequest()
    expect(rpcReq.payload.method).toBe('getComputedStyles')

    const res = await fetchPromise
    const elapsed = Date.now() - started
    expect(res.status).toBe(504)
    const body = (await res.json()) as { code?: string; detail?: string }
    expect(body.code).toBe('ExtensionTimeout')
    // Must be at least the real 5000ms timeout (small scheduling slack).
    expect(elapsed).toBeGreaterThanOrEqual(4_900)
    expect(body.detail).toMatch(/5000ms/)
  }, 10_000) // per-test timeout

  // -------------------------------------------------------------------------
  // Scenario 4 — 503 ExtensionDisconnected
  // -------------------------------------------------------------------------

  it('ext disconnects mid-flight → 503 ExtensionDisconnected + Retry-After:2', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    const fetchPromise = postBrowserTool(h, '/computed_styles', { handle: SAMPLE_HANDLE })
    const rpcReq = await ext.nextRpcRequest()
    expect(rpcReq.payload.method).toBe('getComputedStyles')

    // Close the WS from the ext side without replying. ws/events onClose
    // rejectAll('ext disconnected')s pending RPCs.
    ext.close()
    await waitForClose(ext.ws)

    const res = await fetchPromise
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('ExtensionDisconnected')
    expect(res.headers.get('retry-after')).toBe('2')
  })

  // -------------------------------------------------------------------------
  // Scenario 5 — 503 Shutdown
  // -------------------------------------------------------------------------

  it('/shutdown mid-flight → pending RPC resolves to 503 Shutdown + Connection:close', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    const fetchPromise = postBrowserTool(h, '/computed_styles', { handle: SAMPLE_HANDLE })
    const rpcReq = await ext.nextRpcRequest()
    expect(rpcReq.payload.method).toBe('getComputedStyles')

    // Fire /shutdown; the daemon's rpcCorrelation.rejectAll(Error('Shutdown'))
    // drops the pending browser-tool RPC.
    const shutdownRes = await fetch(`${h.urlPrefix}/shutdown`, {
      method: 'POST',
      headers: { Authorization: h.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: h.instanceId }),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_FAST_MS),
    })
    expect(shutdownRes.status).toBe(200)

    const res = await fetchPromise
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('Shutdown')
    expect(res.headers.get('connection')?.toLowerCase()).toBe('close')
  })

  // -------------------------------------------------------------------------
  // Scenario 6 — 503 ConcurrencyLimitReached
  // -------------------------------------------------------------------------

  it('9 concurrent POSTs: 8 are admitted, 9th → 503 ConcurrencyLimitReached + Retry-After:0', async () => {
    const h = await boot()
    const ext = await mockExt(h)

    // Track incoming rpc.request frames — ext receives 8, never 9.
    // We don't reply, so all 8 slots stay occupied until daemon shutdown.
    let rpcRequestCount = 0
    ext.ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as { type?: unknown }
        if (frame.type === 'rpc.request') rpcRequestCount++
      } catch {
        // ignore
      }
    })

    // Split across both routes: each route's rate-limit bucket is burst:5,
    // but the concurrency limit is shared at 8 across both. 5 + 4 = 9 requests
    // all clear their rate buckets; only 8 can claim a concurrency slot.
    // dom_subtree's route timeout is 10s, so its fetch budget has to cover
    // that + overhead.
    //
    // Each fetch must drain its body immediately via .then(r => {status,
    // headers, body}) so AbortSignal.timeout cannot abort the body read
    // after .json() — the signal stays attached to the response stream
    // until consumed, and 12s is tight against the 10s dom_subtree timeout.
    type Captured = {
      status: number
      retryAfter: string | null
      body: Record<string, unknown>
    }
    const drainToJson = async (p: Promise<Response>): Promise<Captured> => {
      const r = await p
      const status = r.status
      const retryAfter = r.headers.get('retry-after')
      const body = (await r.json()) as Record<string, unknown>
      return { status, retryAfter, body }
    }
    const fetches: Array<Promise<Captured>> = [
      ...Array.from({ length: 5 }, () =>
        drainToJson(
          postBrowserTool(h, '/computed_styles', { handle: SAMPLE_HANDLE }, FETCH_TIMEOUT_SLOW_MS),
        ),
      ),
      ...Array.from({ length: 4 }, () =>
        drainToJson(
          postBrowserTool(h, '/dom_subtree', { handle: SAMPLE_HANDLE }, FETCH_TIMEOUT_DOM_SLOW_MS),
        ),
      ),
    ]

    const settled = await Promise.allSettled(fetches)

    // The 8 admitted RPCs wait 5s/10s for ext + never get a reply → 504.
    // The 9th is rejected synchronously before daemon broadcasts its
    // rpc.request, so it's the only 503.
    const captured: Captured[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        captured.push(r.value)
      } else {
        throw new Error(`fetch rejected: ${String((r as PromiseRejectedResult).reason)}`)
      }
    }

    const concurrencyRejections = captured.filter(
      (c) => c.status === 503 && c.body.code === 'ConcurrencyLimitReached',
    )
    const timeouts = captured.filter((c) => c.status === 504 && c.body.code === 'ExtensionTimeout')
    expect(concurrencyRejections.length).toBe(1)
    expect(timeouts.length).toBe(8)
    const rejection = concurrencyRejections[0]
    if (!rejection) throw new Error('unreachable')
    expect(rejection.retryAfter).toBe('0')

    // The ext saw exactly 8 rpc.request frames (the 9th was rejected before
    // daemon broadcast).
    expect(rpcRequestCount).toBe(8)
  }, 20_000) // per-test: covers dom_subtree's 10s timeout + overhead
})
