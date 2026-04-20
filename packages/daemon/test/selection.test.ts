/**
 * Tests for `PUT /tabs/{tabId}/selection` (tab-scoped resource) and legacy 410/405
 * behaviour for the old `/selection` and wrong-method paths.
 *
 * Uses the in-process server harness from closeCodes.test.ts (makeCtx +
 * listenOnEphemeral pattern) so no fork is needed. All requests go through
 * http.request or fetch against the real createDaemonServer.
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { SUBPROTO_BEARER_PREFIX } from '../src/auth.js'
import { createDaemonServer } from '../src/server.js'
import { EventBus } from '../src/state/eventBus.js'
import { ManifestWatcher } from '../src/state/manifestWatcher.js'
import { SelectionState, TAB_SEQ_MAP_CAP } from '../src/state/selectionState.js'
import type { RouteContext } from '../src/types.js'
import { RpcCorrelation } from '../src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeCtx(overrides?: Partial<RouteContext>): RouteContext {
  const logger = makeLogger()
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
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

interface Harness {
  url: string
  wsUrl: string
  port: number
  bearer: string
  ctx: RouteContext
  close: () => Promise<void>
}

async function listenOnEphemeral(token: Buffer): Promise<Harness> {
  const bearer = token.toString('utf8')

  const bootstrapToken = Buffer.from(crypto.randomBytes(32))
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const probe = createDaemonServer({ port: 0, token, bootstrapToken, rootToken, ctx: makeCtx() })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const realCtx = makeCtx()
  const real = createDaemonServer({
    port: assigned,
    token,
    bootstrapToken,
    rootToken,
    ctx: realCtx,
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    wsUrl: `ws://127.0.0.1:${assigned}`,
    port: assigned,
    bearer,
    ctx: realCtx,
    close: () => real.close(),
  }
}

/** Make a minimal valid SelectionPutBody for the given tabId. */
function makeSelectionBody(id: string) {
  return {
    nodes: [
      {
        id,
        componentName: 'TestComponent',
        filePath: 'src/Test.tsx',
        lineRange: [1, 10] as [number, number],
        domPath: 'html>body>div',
        parentChain: [],
        timestamp: Date.now(),
      },
    ],
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    meta: { source: 'picker' as const },
  }
}

/** PUT /tabs/{tabId}/selection */
function rawPut(
  port: number,
  path: string,
  bearer: string,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const bodyStr = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
          Authorization: `Bearer ${bearer}`,
          Host: `127.0.0.1:${port}`,
        },
      },
      (res) => {
        const c: Buffer[] = []
        res.on('data', (d: Buffer) => c.push(d))
        res.on('end', () => {
          const h: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') h[k] = v
            else if (Array.isArray(v)) h[k] = v.join(', ')
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: h,
            body: Buffer.concat(c).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

/** Generic method request (GET/POST/DELETE/etc.) */
function rawRequest(
  port: number,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string | number> = {
      Authorization: `Bearer ${bearer}`,
      Host: `127.0.0.1:${port}`,
    }
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json'
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr)
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const c: Buffer[] = []
        res.on('data', (d: Buffer) => c.push(d))
        res.on('end', () => {
          const h: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') h[k] = v
            else if (Array.isArray(v)) h[k] = v.join(', ')
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: h,
            body: Buffer.concat(c).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(bodyStr)
    req.end()
  })
}

/** Open a WS connection, wait for hello frame, return ws + hello seq. */
function openWs(
  wsUrl: string,
  port: number,
  bearer: string,
): Promise<{ ws: WebSocket; helloSeq: number }> {
  return new Promise((resolve, reject) => {
    const subprotocols = ['redesigner-v1', `${SUBPROTO_BEARER_PREFIX}${bearer}`]
    const ws = new WebSocket(`${wsUrl}/events?since=0`, subprotocols, {
      headers: { Host: `127.0.0.1:${port}` },
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('hello not received within 2s'))
    }, 2000)
    timer.unref()
    let opened = false
    ws.once('open', () => {
      opened = true
    })
    ws.once('message', (data) => {
      clearTimeout(timer)
      const frame = JSON.parse(String(data)) as { type?: string; seq?: number }
      if (frame.type !== 'hello') {
        ws.terminate()
        reject(new Error(`expected hello, got ${frame.type}`))
        return
      }
      resolve({ ws, helloSeq: frame.seq ?? 0 })
    })
    ws.once('error', (err) => {
      if (!opened) {
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

/** Wait for the next WS frame of the given type, with a 1s timeout. */
function nextWsFrame(
  ws: WebSocket,
  type: string,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${type} frame not received within ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref()
    const onMsg = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>
      if (frame.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(frame)
      }
    }
    ws.on('message', onMsg)
  })
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('PUT /tabs/{tabId}/selection — happy path', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns 200 with selectionSeq and acceptedAt', async () => {
    const res = await rawPut(h.port, '/tabs/42/selection', h.bearer, makeSelectionBody('node-1'))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { selectionSeq: number; acceptedAt: number }
    expect(typeof body.selectionSeq).toBe('number')
    expect(body.selectionSeq).toBeGreaterThanOrEqual(1)
    expect(typeof body.acceptedAt).toBe('number')
    expect(body.acceptedAt).toBeGreaterThan(0)
  })

  it('selectionSeq is per-tab: tab 1 and tab 2 start independently', async () => {
    const r1 = await rawPut(h.port, '/tabs/1/selection', h.bearer, makeSelectionBody('node-a'))
    expect(r1.status).toBe(200)
    const b1 = JSON.parse(r1.body) as { selectionSeq: number }

    const r2 = await rawPut(h.port, '/tabs/2/selection', h.bearer, makeSelectionBody('node-b'))
    expect(r2.status).toBe(200)
    const b2 = JSON.parse(r2.body) as { selectionSeq: number }

    // Both should be at seq 1 (independent counters)
    expect(b1.selectionSeq).toBe(1)
    expect(b2.selectionSeq).toBe(1)
  })

  it('selectionSeq for tab 1 increments independently from tab 2', async () => {
    // tab 1 → seq 1
    const r1 = await rawPut(h.port, '/tabs/1/selection', h.bearer, makeSelectionBody('node-a'))
    expect(r1.status).toBe(200)
    const b1 = JSON.parse(r1.body) as { selectionSeq: number }

    // tab 2 → seq 1
    const r2 = await rawPut(h.port, '/tabs/2/selection', h.bearer, makeSelectionBody('node-b'))
    expect(r2.status).toBe(200)
    const b2 = JSON.parse(r2.body) as { selectionSeq: number }

    // tab 1 again → seq 2 (not 3)
    const r3 = await rawPut(h.port, '/tabs/1/selection', h.bearer, makeSelectionBody('node-c'))
    expect(r3.status).toBe(200)
    const b3 = JSON.parse(r3.body) as { selectionSeq: number }

    expect(b1.selectionSeq).toBe(1)
    expect(b2.selectionSeq).toBe(1)
    expect(b3.selectionSeq).toBe(2)
  })

  it('selection.updated WS notification carries same selectionSeq as PUT response', async () => {
    const { ws } = await openWs(h.wsUrl, h.port, h.bearer)

    const framePromise = nextWsFrame(ws, 'selection.updated')
    const putRes = await rawPut(
      h.port,
      '/tabs/42/selection',
      h.bearer,
      makeSelectionBody('node-ws'),
    )
    expect(putRes.status).toBe(200)
    const putBody = JSON.parse(putRes.body) as { selectionSeq: number }

    const frame = await framePromise
    ws.close(1000)
    await new Promise<void>((resolve) => ws.on('close', resolve))

    const payload = frame.payload as { selectionSeq?: number; tabId?: number }
    expect(payload.selectionSeq).toBe(putBody.selectionSeq)
    expect(payload.tabId).toBe(42)
  })
})

describe('POST /tabs/{tabId}/selection → 405', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns 405 with Allow: PUT header', async () => {
    const res = await rawRequest(
      h.port,
      'POST',
      '/tabs/42/selection',
      h.bearer,
      makeSelectionBody('x'),
    )
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('PUT')
  })

  it('returns problem body with apiErrorCode method-not-allowed', async () => {
    const res = await rawRequest(
      h.port,
      'POST',
      '/tabs/42/selection',
      h.bearer,
      makeSelectionBody('x'),
    )
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('method-not-allowed')
  })

  it('does NOT include Deprecation or Sunset headers', async () => {
    const res = await rawRequest(
      h.port,
      'POST',
      '/tabs/42/selection',
      h.bearer,
      makeSelectionBody('x'),
    )
    expect(res.headers.deprecation).toBeUndefined()
    expect(res.headers.sunset).toBeUndefined()
  })
})

describe('Legacy PUT /selection → 410 Gone', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('PUT /selection returns 410 Gone with apiErrorCode endpoint-moved', async () => {
    const res = await rawRequest(h.port, 'PUT', '/selection', h.bearer, makeSelectionBody('x'))
    expect(res.status).toBe(410)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('endpoint-moved')
  })

  it('PUT /selection detail mentions /tabs/{tabId}/selection', async () => {
    const res = await rawRequest(h.port, 'PUT', '/selection', h.bearer, makeSelectionBody('x'))
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(String(body.detail ?? '')).toMatch(/\/tabs\/\{tabId\}\/selection/)
  })

  it('POST /selection returns 410 (path resolution precedes method dispatch)', async () => {
    const res = await rawRequest(h.port, 'POST', '/selection', h.bearer, makeSelectionBody('x'))
    expect(res.status).toBe(410)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('endpoint-moved')
  })

  it('GET /selection still returns 200 (backward compat for snapshot read)', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', h.bearer)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { current: unknown }
    expect(body).toHaveProperty('current')
  })
})

describe('Legacy POST /selection — previously 200, now 410', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('POST /selection returns 410 (was previously 200)', async () => {
    // The old bare-handle POST body that used to work:
    const oldBody = {
      id: 'sel-old',
      componentName: 'App',
      filePath: 'src/App.tsx',
      lineRange: [1, 10],
      domPath: 'html>body>div',
      parentChain: [],
      timestamp: Date.now(),
    }
    const res = await rawRequest(h.port, 'POST', '/selection', h.bearer, oldBody)
    expect(res.status).toBe(410)
  })
})

describe('tabId range validation', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('PUT /tabs/0/selection returns 400', async () => {
    const res = await rawPut(h.port, '/tabs/0/selection', h.bearer, makeSelectionBody('node-z'))
    expect(res.status).toBe(400)
  })

  it('PUT /tabs/99999999999999999999/selection returns 400', async () => {
    const res = await rawPut(
      h.port,
      '/tabs/99999999999999999999/selection',
      h.bearer,
      makeSelectionBody('node-big'),
    )
    expect(res.status).toBe(400)
  })
})

describe('tabSeqMap LRU cap', () => {
  it(`keeps map size at most TAB_SEQ_MAP_CAP (${TAB_SEQ_MAP_CAP}) after CAP+1 distinct tabIds`, () => {
    const state = new SelectionState()
    for (let tabId = 1; tabId <= TAB_SEQ_MAP_CAP + 1; tabId++) {
      state.nextTabSeq(tabId)
    }
    expect(state.tabSeqMapSize()).toBeLessThanOrEqual(TAB_SEQ_MAP_CAP)
  })

  it('LRU touch: revisiting an existing tabId does not grow the map beyond CAP', () => {
    const state = new SelectionState()
    // Fill to cap
    for (let tabId = 1; tabId <= TAB_SEQ_MAP_CAP; tabId++) {
      state.nextTabSeq(tabId)
    }
    expect(state.tabSeqMapSize()).toBe(TAB_SEQ_MAP_CAP)
    // Revisit an existing entry multiple times — size must not grow
    for (let i = 0; i < 10; i++) {
      state.nextTabSeq(1)
    }
    expect(state.tabSeqMapSize()).toBe(TAB_SEQ_MAP_CAP)
  })

  it('evicts the oldest entry first when over cap', () => {
    const state = new SelectionState()
    // Fill to cap; tabId=1 is the oldest
    for (let tabId = 1; tabId <= TAB_SEQ_MAP_CAP; tabId++) {
      state.nextTabSeq(tabId)
    }
    // Insert one more new tabId — should evict tabId=1 (oldest)
    // Seq for tabId=1 was 1; after eviction nextTabSeq(1) should restart at 1
    state.nextTabSeq(TAB_SEQ_MAP_CAP + 1)
    expect(state.tabSeqMapSize()).toBe(TAB_SEQ_MAP_CAP)
    // tabId=1 was evicted; fresh call should return 1 (reset counter)
    expect(state.nextTabSeq(1)).toBe(1)
  })
})
