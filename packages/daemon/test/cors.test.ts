/**
 * Tests for CORS + Vary + problem+json + Retry-After + Cache-Control headers.
 *
 * Uses the in-process server harness pattern from selection.test.ts / closeCodes.test.ts.
 * Exchange and revalidate are mounted on a secondary harness (same pattern as
 * closeCodes.test.ts /revalidate section) because those routes are not wired into
 * createDaemonServer yet.
 *
 * Design decisions documented here:
 *
 * OPTIONS on /selection (legacy, 410 on non-GET):
 *   OPTIONS returns Access-Control-Allow-Methods: GET — the resource is gone for
 *   writes but GET still works (backward compat snapshot read). OPTIONS is a
 *   preflight, not a semantic write; returning the remaining allowed method set
 *   is most informative. The 410 applies only to actual non-GET method calls.
 *
 * Cookie rejection status: 400 with apiErrorCode 'invalid-params'.
 *   'invalid-params' is in errors.ts and maps to 400. There is no cookie-specific
 *   code; 'invalid-params' is the closest fit (the cookie is an invalid parameter
 *   for credentialed routes).
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExchangeRoute } from '../src/routes/exchange.js'
import { createRevalidateRoute } from '../src/routes/revalidate.js'
import { createDaemonServer } from '../src/server.js'
import { EventBus } from '../src/state/eventBus.js'
import { ManifestWatcher } from '../src/state/manifestWatcher.js'
import { SelectionState } from '../src/state/selectionState.js'
import type { RouteContext } from '../src/types.js'
import { RpcCorrelation } from '../src/ws/rpcCorrelation.js'
import { cleanupTempDirs, randomTempDir } from './helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Harness helpers (shared with selection.test.ts pattern)
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
    port: assigned,
    bearer,
    ctx: realCtx,
    close: () => real.close(),
  }
}

type RawResponse = { status: number; headers: Record<string, string>; body: string }

function rawRequest(
  port: number,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<RawResponse> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string | number> = {
      Authorization: `Bearer ${bearer}`,
      Host: `127.0.0.1:${port}`,
      ...extraHeaders,
    }
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json'
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr)
    }
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: reqHeaders },
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

/** Minimal valid SelectionPutBody */
function makeSelectionBody() {
  return {
    nodes: [
      {
        id: 'node-1',
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

// ---------------------------------------------------------------------------
// Exchange+Revalidate harness (standalone server — routes not in createDaemonServer)
// ---------------------------------------------------------------------------

const EXT_ID_A = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN_A = `chrome-extension://${EXT_ID_A}`

interface ExchangeHarness {
  port: number
  exchangeRoute: ReturnType<typeof createExchangeRoute>
  bootstrapToken: Buffer
  close: () => Promise<void>
}

async function mountExchangeHarness(): Promise<ExchangeHarness> {
  const logger = makeLogger()
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')
  const projectRoot = randomTempDir('redesigner-cors-exchange-')

  const exchangeRoute = createExchangeRoute({
    rootToken,
    projectRoot,
    logger,
    bootstrapToken,
    trustAnyExtension: true,
  })

  const revalidateRoute = createRevalidateRoute({
    exchange: exchangeRoute,
    rootToken,
    projectRoot,
    logger,
  })

  const server = http.createServer((req, res) => {
    const reqId = crypto.randomBytes(8).toString('hex')
    if (req.url === '/__redesigner/exchange' || req.url?.startsWith('/__redesigner/exchange?')) {
      void exchangeRoute.handler(req, res, reqId)
    } else if (
      req.url === '/__redesigner/revalidate' ||
      req.url?.startsWith('/__redesigner/revalidate?')
    ) {
      void revalidateRoute.handler(req, res, reqId)
    } else {
      res.statusCode = 404
      res.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    exchangeRoute,
    bootstrapToken,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function rawPost(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  body: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          Host: `127.0.0.1:${port}`,
          ...headers,
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
    req.write(body)
    req.end()
  })
}

function rawOptions(
  port: number,
  pathname: string,
  bearer: string,
  extraHeaders?: Record<string, string>,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'OPTIONS',
        headers: {
          Authorization: `Bearer ${bearer}`,
          Host: `127.0.0.1:${port}`,
          Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
          ...extraHeaders,
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
    req.end()
  })
}

// ===========================================================================
// 1. Vary: Origin, Access-Control-Request-Headers on every CORS-reachable response
// ===========================================================================

describe('Vary header on all CORS-reachable responses', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  const VARY_VALUE = 'Origin, Access-Control-Request-Headers'

  const scenarios: Array<{
    label: string
    method: string
    path: string
    body?: unknown
    expectedStatus: number
  }> = [
    { label: '200 GET /selection', method: 'GET', path: '/selection', expectedStatus: 200 },
    {
      label: '200 PUT /tabs/1/selection',
      method: 'PUT',
      path: '/tabs/1/selection',
      body: makeSelectionBody(),
      expectedStatus: 200,
    },
    {
      label: '400 invalid body PUT /tabs/1/selection',
      method: 'PUT',
      path: '/tabs/1/selection',
      body: { bad: 'body' },
      expectedStatus: 400,
    },
    { label: '404 unknown route', method: 'GET', path: '/does-not-exist', expectedStatus: 404 },
    {
      label: '405 wrong method /health POST',
      method: 'POST',
      path: '/health',
      expectedStatus: 405,
    },
    {
      label: '410 legacy PUT /selection',
      method: 'PUT',
      path: '/selection',
      body: makeSelectionBody(),
      expectedStatus: 410,
    },
    {
      label: '405 wrong method /tabs/1/selection POST',
      method: 'POST',
      path: '/tabs/1/selection',
      body: makeSelectionBody(),
      expectedStatus: 405,
    },
  ]

  for (const scenario of scenarios) {
    it(`${scenario.label} carries Vary: ${VARY_VALUE}`, async () => {
      const res = await rawRequest(h.port, scenario.method, scenario.path, h.bearer, scenario.body)
      expect(res.status).toBe(scenario.expectedStatus)
      expect(res.headers.vary).toBe(VARY_VALUE)
    })
  }

  it('401 unauthorized carries Vary header', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', 'wrong-token')
    expect(res.status).toBe(401)
    expect(res.headers.vary).toBe(VARY_VALUE)
  })

  it('421 misdirected request carries Vary header', async () => {
    // Send request with wrong Host header to trigger 421
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/selection',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${h.bearer}`,
            Host: 'evil.example.com',
          },
        },
        (res) => {
          const c: Buffer[] = []
          res.on('data', (d: Buffer) => c.push(d))
          res.on('end', () => {
            const hdrs: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') hdrs[k] = v
              else if (Array.isArray(v)) hdrs[k] = v.join(', ')
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: hdrs,
              body: Buffer.concat(c).toString('utf8'),
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(res.status).toBe(421)
    expect(res.headers.vary).toBe(VARY_VALUE)
  })

  it('OPTIONS preflight carries Vary header', async () => {
    const res = await rawOptions(h.port, '/health', h.bearer)
    expect(res.status).toBe(204)
    expect(res.headers.vary).toBe(VARY_VALUE)
  })

  it('429 rate-limit carries Vary header', async () => {
    // Hammer unauthenticated to hit 429 (burst=10)
    let last429: RawResponse | undefined
    for (let i = 0; i < 15; i++) {
      const res = await rawRequest(h.port, 'GET', '/selection', 'bad-token')
      if (res.status === 429) {
        last429 = res
        break
      }
    }
    expect(last429).toBeDefined()
    expect(last429?.headers.vary).toBe(VARY_VALUE)
  })
})

// ===========================================================================
// 2. Problem bodies: Content-Type exactly application/problem+json; charset=utf-8
// ===========================================================================

describe('Problem body Content-Type includes charset=utf-8', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  const PROBLEM_CT = 'application/problem+json; charset=utf-8'

  it('400 bad body has correct Content-Type', async () => {
    const res = await rawRequest(h.port, 'PUT', '/tabs/1/selection', h.bearer, { bad: 'body' })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toBe(PROBLEM_CT)
  })

  it('401 unauthorized has correct Content-Type (application/json for AuthError body)', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', 'wrong-token')
    expect(res.status).toBe(401)
    // AuthError bodies are emitted via sendJson → application/json (not problem+json)
    expect(res.headers['content-type']).toBe('application/json')
  })

  it('404 not found has correct Content-Type', async () => {
    const res = await rawRequest(h.port, 'GET', '/no-such-route', h.bearer)
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toBe(PROBLEM_CT)
  })

  it('405 method not allowed has correct Content-Type', async () => {
    const res = await rawRequest(h.port, 'POST', '/health', h.bearer)
    expect(res.status).toBe(405)
    expect(res.headers['content-type']).toBe(PROBLEM_CT)
  })

  it('410 legacy /selection has correct Content-Type', async () => {
    const res = await rawRequest(h.port, 'PUT', '/selection', h.bearer, makeSelectionBody())
    expect(res.status).toBe(410)
    expect(res.headers['content-type']).toBe(PROBLEM_CT)
  })

  it('421 misdirected has correct Content-Type', async () => {
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/selection',
          method: 'GET',
          headers: { Authorization: `Bearer ${h.bearer}`, Host: 'evil.example.com' },
        },
        (res) => {
          const c: Buffer[] = []
          res.on('data', (d: Buffer) => c.push(d))
          res.on('end', () => {
            const hdrs: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') hdrs[k] = v
              else if (Array.isArray(v)) hdrs[k] = v.join(', ')
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: hdrs,
              body: Buffer.concat(c).toString('utf8'),
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(res.status).toBe(421)
    expect(res.headers['content-type']).toBe(PROBLEM_CT)
  })
})

// ===========================================================================
// 3. 429 responses include Retry-After: <non-negative integer string>
// ===========================================================================

describe('429 responses include valid Retry-After header', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('429 on unauthenticated burst has Retry-After as non-negative integer string', async () => {
    let last429: RawResponse | undefined
    for (let i = 0; i < 15; i++) {
      const res = await rawRequest(h.port, 'GET', '/selection', 'bad-token')
      if (res.status === 429) {
        last429 = res
        break
      }
    }
    expect(last429).toBeDefined()
    const retryAfter = last429?.headers['retry-after']
    expect(retryAfter).toBeDefined()
    const n = Number(retryAfter)
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
  })
})

// ===========================================================================
// 4 + 5. Cache-Control: no-store, private + Pragma: no-cache on sensitive routes
// ===========================================================================

describe('Cache-Control: no-store, private + Pragma: no-cache on sensitive routes', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('PUT /tabs/{id}/selection 200 response has Cache-Control: no-store, private', async () => {
    const res = await rawRequest(h.port, 'PUT', '/tabs/1/selection', h.bearer, makeSelectionBody())
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('PUT /tabs/{id}/selection 200 response has Pragma: no-cache', async () => {
    const res = await rawRequest(h.port, 'PUT', '/tabs/1/selection', h.bearer, makeSelectionBody())
    expect(res.status).toBe(200)
    expect(res.headers.pragma).toBe('no-cache')
  })

  it('GET /selection 200 response has Cache-Control: no-store, private', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', h.bearer)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('GET /selection 200 response has Pragma: no-cache', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', h.bearer)
    expect(res.status).toBe(200)
    expect(res.headers.pragma).toBe('no-cache')
  })

  it('410 legacy /selection has Cache-Control: no-store, private', async () => {
    const res = await rawRequest(h.port, 'PUT', '/selection', h.bearer, makeSelectionBody())
    expect(res.status).toBe(410)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('410 legacy /selection has Pragma: no-cache', async () => {
    const res = await rawRequest(h.port, 'PUT', '/selection', h.bearer, makeSelectionBody())
    expect(res.status).toBe(410)
    expect(res.headers.pragma).toBe('no-cache')
  })
})

describe('Cache-Control on /__redesigner/exchange and /__redesigner/revalidate', () => {
  afterEach(() => cleanupTempDirs())

  it('POST /__redesigner/exchange 200 has Cache-Control: no-store, private', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('POST /__redesigner/exchange 200 has Pragma: no-cache', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(200)
    expect(res.headers.pragma).toBe('no-cache')
  })

  it('POST /__redesigner/revalidate 200 has Cache-Control: no-store, private', async () => {
    const h = await mountExchangeHarness()
    // First exchange to get a session token
    const exRes = await rawPost(
      h.port,
      '/__redesigner/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    const { sessionToken } = JSON.parse(exRes.body) as { sessionToken: string }

    const res = await rawPost(
      h.port,
      '/__redesigner/revalidate',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Authorization: `Bearer ${sessionToken}`,
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('POST /__redesigner/revalidate 200 has Pragma: no-cache', async () => {
    const h = await mountExchangeHarness()
    const exRes = await rawPost(
      h.port,
      '/__redesigner/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    const { sessionToken } = JSON.parse(exRes.body) as { sessionToken: string }

    const res = await rawPost(
      h.port,
      '/__redesigner/revalidate',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Authorization: `Bearer ${sessionToken}`,
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(200)
    expect(res.headers.pragma).toBe('no-cache')
  })
})

// ===========================================================================
// 6. Cookie header on credentialed routes → rejected
// ===========================================================================

describe('Cookie header on credentialed routes → 400 invalid-params', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  it('PUT /tabs/{id}/selection with Cookie header returns 400', async () => {
    const res = await rawRequest(
      h.port,
      'PUT',
      '/tabs/1/selection',
      h.bearer,
      makeSelectionBody(),
      { Cookie: 'session=abc123' },
    )
    expect(res.status).toBe(400)
  })

  it('PUT /tabs/{id}/selection with Cookie header returns apiErrorCode invalid-params', async () => {
    const res = await rawRequest(
      h.port,
      'PUT',
      '/tabs/1/selection',
      h.bearer,
      makeSelectionBody(),
      { Cookie: 'session=abc123' },
    )
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('invalid-params')
  })

  it('GET /selection with Cookie header returns 400', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', h.bearer, undefined, {
      Cookie: 'session=abc123',
    })
    expect(res.status).toBe(400)
  })

  it('GET /selection/recent with Cookie header returns 400', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection/recent', h.bearer, undefined, {
      Cookie: 'x=y',
    })
    expect(res.status).toBe(400)
  })
})

describe('Cookie header on /__redesigner/exchange → 400', () => {
  afterEach(() => cleanupTempDirs())

  it('POST /__redesigner/exchange with Cookie header returns 400 invalid-params', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/exchange',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Cookie: 'session=abc123',
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('invalid-params')
  })
})

describe('Cookie header on /__redesigner/revalidate → 400', () => {
  afterEach(() => cleanupTempDirs())

  it('POST /__redesigner/revalidate with Cookie header returns 400', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/revalidate',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Cookie: 'session=abc123',
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.status).toBe(400)
  })

  it('POST /__redesigner/revalidate with Cookie header returns apiErrorCode invalid-params', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/revalidate',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Cookie: 'session=abc123',
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('invalid-params')
  })

  it('POST /__redesigner/revalidate with Cookie header returns Content-Type application/problem+json', async () => {
    const h = await mountExchangeHarness()
    const res = await rawPost(
      h.port,
      '/__redesigner/revalidate',
      {
        Origin: ORIGIN_A,
        'Sec-Fetch-Site': 'cross-site',
        Cookie: 'session=abc123',
      },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: h.bootstrapToken.toString('utf8'),
      }),
    )
    await h.close()
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8')
  })
})

// ===========================================================================
// 7. No response sets Access-Control-Allow-Credentials: true
// ===========================================================================

describe('Access-Control-Allow-Credentials is never true', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  const routes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/selection' },
    { method: 'GET', path: '/selection/recent' },
    { method: 'GET', path: '/manifest' },
    { method: 'PUT', path: '/tabs/1/selection', body: makeSelectionBody() },
    { method: 'PUT', path: '/selection', body: makeSelectionBody() }, // 410
    { method: 'POST', path: '/health' }, // 405
    { method: 'GET', path: '/no-such-route' }, // 404
  ]

  for (const route of routes) {
    it(`${route.method} ${route.path} never sets Access-Control-Allow-Credentials: true`, async () => {
      const res = await rawRequest(h.port, route.method, route.path, h.bearer, route.body)
      expect(res.headers['access-control-allow-credentials']).not.toBe('true')
    })
  }

  it('OPTIONS preflight never sets Access-Control-Allow-Credentials: true', async () => {
    const res = await rawOptions(h.port, '/health', h.bearer)
    expect(res.headers['access-control-allow-credentials']).not.toBe('true')
  })

  it('401 response never sets Access-Control-Allow-Credentials: true', async () => {
    const res = await rawRequest(h.port, 'GET', '/selection', 'wrong-token')
    expect(res.headers['access-control-allow-credentials']).not.toBe('true')
  })
})

// ===========================================================================
// 8. OPTIONS preflight returns correct Access-Control-Allow-Methods per route
// ===========================================================================

describe('OPTIONS preflight — correct Access-Control-Allow-Methods per route', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let h: Harness

  beforeEach(async () => {
    h = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await h.close()
  })

  const preflightTable: Array<{ path: string; expectedMethods: string }> = [
    { path: '/health', expectedMethods: 'GET' },
    // /selection — legacy resource; GET still works, writes are 410.
    // OPTIONS reports GET as the allowed method (not 410 — OPTIONS is preflight, not a write).
    { path: '/selection', expectedMethods: 'GET' },
    { path: '/tabs/42/selection', expectedMethods: 'PUT' },
    { path: '/manifest', expectedMethods: 'GET' },
    { path: '/selection/recent', expectedMethods: 'GET' },
    { path: '/computed_styles', expectedMethods: 'POST' },
    { path: '/dom_subtree', expectedMethods: 'POST' },
    { path: '/shutdown', expectedMethods: 'POST' },
  ]

  for (const { path, expectedMethods } of preflightTable) {
    it(`OPTIONS ${path} → 204 with Allow-Methods: ${expectedMethods}`, async () => {
      const res = await rawOptions(h.port, path, h.bearer)
      expect(res.status).toBe(204)
      expect(res.headers['access-control-allow-methods']).toBe(expectedMethods)
    })
  }

  it('OPTIONS /health returns Access-Control-Max-Age: 300', async () => {
    const res = await rawOptions(h.port, '/health', h.bearer)
    expect(res.headers['access-control-max-age']).toBe('300')
  })

  it('OPTIONS /health echoes Access-Control-Request-Headers as Access-Control-Allow-Headers', async () => {
    const res = await rawOptions(h.port, '/health', h.bearer, {
      'Access-Control-Request-Headers': 'authorization, content-type',
    })
    expect(res.headers['access-control-allow-headers']).toBe('authorization, content-type')
  })

  it('OPTIONS with disallowed Origin → 403 + CorsError body', async () => {
    const res = await rawOptions(h.port, '/health', h.bearer, {
      Origin: 'https://evil.example.com',
    })
    expect(res.status).toBe(403)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.error).toBe('cors')
    expect(body.reason).toBe('malformed-origin')
  })

  it('OPTIONS unknown route → 404', async () => {
    const res = await rawOptions(h.port, '/no-such-route', h.bearer)
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// 8b. OPTIONS for /__redesigner/* routes
// ===========================================================================

describe('OPTIONS preflight for /__redesigner routes', () => {
  afterEach(() => cleanupTempDirs())

  it('OPTIONS /__redesigner/exchange → 204 with Allow-Methods: POST', async () => {
    const h = await mountExchangeHarness()
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/__redesigner/exchange',
          method: 'OPTIONS',
          headers: {
            Host: `127.0.0.1:${h.port}`,
            Origin: ORIGIN_A,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization',
          },
        },
        (res) => {
          const c: Buffer[] = []
          res.on('data', (d: Buffer) => c.push(d))
          res.on('end', () => {
            const hdrs: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') hdrs[k] = v
              else if (Array.isArray(v)) hdrs[k] = v.join(', ')
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: hdrs,
              body: Buffer.concat(c).toString('utf8'),
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    await h.close()
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toBe('POST')
  })

  it('OPTIONS /__redesigner/revalidate → 204 with Allow-Methods: POST', async () => {
    const h = await mountExchangeHarness()
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/__redesigner/revalidate',
          method: 'OPTIONS',
          headers: {
            Host: `127.0.0.1:${h.port}`,
            Origin: ORIGIN_A,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization',
          },
        },
        (res) => {
          const c: Buffer[] = []
          res.on('data', (d: Buffer) => c.push(d))
          res.on('end', () => {
            const hdrs: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') hdrs[k] = v
              else if (Array.isArray(v)) hdrs[k] = v.join(', ')
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: hdrs,
              body: Buffer.concat(c).toString('utf8'),
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    await h.close()
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toBe('POST')
  })
})
