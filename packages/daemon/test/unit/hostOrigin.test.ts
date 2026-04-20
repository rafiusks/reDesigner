/**
 * Integration tests for Host-header rebinding defense, WS Origin allowlist,
 * and the "no 3xx from any route" requirement.
 *
 * These tests exercise the real HTTP/WS server (ephemeral port) so they catch
 * regressions in middleware ordering, not just the isolated helper functions.
 */

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { shouldRejectOrigin } from '../../src/ws/events.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<RouteContext>): RouteContext {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

/**
 * Two-phase ephemeral listen: probe port 0 → get assigned port → re-create
 * server at that exact port so the Host-check (127.0.0.1:<exactPort>) works.
 */
async function listenOnEphemeral(token: Buffer): Promise<{
  url: string
  wsUrl: string
  port: number
  bearer: string
  close: () => Promise<void>
}> {
  const bearer = Buffer.from(token).toString('utf8')
  const probe = createDaemonServer({ port: 0, token, ctx: makeCtx() })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({ port: assigned, token, ctx: makeCtx() })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    wsUrl: `ws://127.0.0.1:${assigned}`,
    port: assigned,
    bearer,
    close: () => real.close(),
  }
}

/**
 * Raw HTTP request giving full control over headers (fetch overrides Host).
 */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const h: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') h[k] = v
          else if (Array.isArray(v)) h[k] = v.join(', ')
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: h,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Attempt a WS upgrade with an explicit Origin header; return the HTTP status
 * that the server replies with on rejection, or 101 on acceptance.
 * Resolves once the connection either opens or the raw response arrives.
 */
function wsConnectWithOrigin(
  wsUrl: string,
  port: number,
  bearer: string,
  origin: string | undefined,
): Promise<{ status: number; opened: boolean }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      Authorization: `Bearer ${bearer}`,
    }
    if (origin !== undefined) {
      headers.Origin = origin
    }

    const ws = new WebSocket(`${wsUrl}/events`, { headers, followRedirects: false })

    ws.on('open', () => {
      ws.close()
      resolve({ status: 101, opened: true })
    })

    ws.on('unexpected-response', (_, res) => {
      resolve({ status: res.statusCode ?? 0, opened: false })
    })

    ws.on('error', (err: NodeJS.ErrnoException) => {
      // Connection reset counts as a rejection
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        resolve({ status: 0, opened: false })
      } else {
        reject(err)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Unit tests for shouldRejectOrigin (complement smoke test, no real server)
// ---------------------------------------------------------------------------

describe('shouldRejectOrigin — unit', () => {
  it('rejects literal string "null" (null Origin from opaque context)', () => {
    expect(shouldRejectOrigin('null')).toBe(true)
  })

  it('accepts undefined Origin (absent header — native non-browser client)', () => {
    expect(shouldRejectOrigin(undefined)).toBe(false)
  })

  it('accepts chrome-extension:// origin', () => {
    expect(shouldRejectOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(false)
  })

  it('accepts moz-extension:// origin', () => {
    expect(shouldRejectOrigin('moz-extension://some-uuid')).toBe(false)
  })

  it('accepts vscode-webview:// origin', () => {
    expect(shouldRejectOrigin('vscode-webview://some-id')).toBe(false)
  })

  it('rejects https://evil.com', () => {
    expect(shouldRejectOrigin('https://evil.com')).toBe(true)
  })

  it('rejects http://localhost (browser same-origin probe)', () => {
    expect(shouldRejectOrigin('http://localhost')).toBe(true)
  })

  it('rejects http://127.0.0.1 (loopback browser origin)', () => {
    expect(shouldRejectOrigin('http://127.0.0.1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: Host-header rebinding (real server)
// ---------------------------------------------------------------------------

describe('Host-header DNS-rebinding defense — integration', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns 421 HostRejected for Host: evil.com', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: 'evil.com',
    })
    expect(res.status).toBe(421)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.code).toBe('HostRejected')
  })

  it('returns 421 HostRejected for Host: localhost.attacker.com:<port> (DNS-rebind suffix trap)', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: `localhost.attacker.com:${handle.port}`,
    })
    expect(res.status).toBe(421)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.code).toBe('HostRejected')
  })

  it('returns 421 HostRejected for Host with port mismatch', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: `127.0.0.1:${handle.port + 1}`,
    })
    expect(res.status).toBe(421)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.code).toBe('HostRejected')
  })

  it('accepts request with Host: 127.0.0.1:<port>', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: `127.0.0.1:${handle.port}`,
      Authorization: `Bearer ${bearer}`,
    })
    // 200 from /health — Host was accepted
    expect(res.status).toBe(200)
  })

  it('accepts request with Host: localhost:<port> (now in literal allowlist)', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: `localhost:${handle.port}`,
      Authorization: `Bearer ${bearer}`,
    })
    expect(res.status).toBe(200)
  })

  it('accepts request with Host: [::1]:<port> (IPv6 loopback literal)', async () => {
    const res = await rawRequest(handle.port, 'GET', '/health', {
      Host: `[::1]:${handle.port}`,
      Authorization: `Bearer ${bearer}`,
    })
    expect(res.status).toBe(200)
  })

  it('returns 421 HostRejected when Host is absent', async () => {
    // Craft a minimal HTTP/1.0 request with no Host header
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const sock = new net.Socket()
      const chunks: Buffer[] = []
      sock.connect(handle.port, '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.0\r\n\r\n')
      })
      sock.on('data', (c: Buffer) => chunks.push(c))
      sock.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const firstLine = raw.split('\r\n')[0]
        const status = Number.parseInt(firstLine?.split(' ')[1] ?? '0', 10)
        resolve({ status })
      })
      sock.on('error', reject)
    })
    expect(res.status).toBe(421)
  })
})

// ---------------------------------------------------------------------------
// Integration: WS Origin allowlist (real WS server)
// ---------------------------------------------------------------------------

describe('WS Origin allowlist — integration', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('rejects upgrade when Origin is literal "null"', async () => {
    const result = await wsConnectWithOrigin(handle.wsUrl, handle.port, bearer, 'null')
    expect(result.opened).toBe(false)
    expect(result.status).toBe(403)
  })

  it('accepts upgrade when Origin header is absent (native non-browser client)', async () => {
    const result = await wsConnectWithOrigin(handle.wsUrl, handle.port, bearer, undefined)
    expect(result.opened).toBe(true)
  })

  it('accepts upgrade with chrome-extension:// Origin', async () => {
    const result = await wsConnectWithOrigin(
      handle.wsUrl,
      handle.port,
      bearer,
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    )
    expect(result.opened).toBe(true)
  })

  it('accepts upgrade with moz-extension:// Origin', async () => {
    const result = await wsConnectWithOrigin(
      handle.wsUrl,
      handle.port,
      bearer,
      'moz-extension://some-uuid@firefox',
    )
    expect(result.opened).toBe(true)
  })

  it('accepts upgrade with vscode-webview:// Origin', async () => {
    const result = await wsConnectWithOrigin(
      handle.wsUrl,
      handle.port,
      bearer,
      'vscode-webview://some-extension-id',
    )
    expect(result.opened).toBe(true)
  })

  it('rejects upgrade with https://evil.com Origin', async () => {
    const result = await wsConnectWithOrigin(handle.wsUrl, handle.port, bearer, 'https://evil.com')
    expect(result.opened).toBe(false)
    expect(result.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Integration: WS Host-header allowlist (real WS server)
//
// Mirrors the HTTP path: the WS upgrade uses the same hostAllow() predicate
// and rejects with 421 Misdirected Request (not 400) on a Host mismatch.
// ---------------------------------------------------------------------------

/**
 * Raw WS upgrade via net.Socket so we can set Host explicitly. `ws`'s client
 * rewrites Host from the URL, which makes it impossible to exercise the
 * server's host check through the high-level API.
 *
 * Resolves as soon as the response's status line + header terminator arrive.
 * On a 101 accept the socket stays open (WebSocket protocol takes over), so
 * we can't wait for 'end'.
 */
function rawWsUpgrade(
  port: number,
  host: string,
  bearer: string,
): Promise<{ status: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    const chunks: Buffer[] = []
    let settled = false
    const done = (result: { status: number; reason: string }): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(result)
    }
    sock.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /events HTTP/1.1',
        `Host: ${host}`,
        `Authorization: Bearer ${bearer}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ]
      sock.write(lines.join('\r\n'))
    })
    sock.on('data', (c: Buffer) => {
      chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      // Headers terminator — enough to parse the status line whether the
      // response is a 101 (no body) or a 4xx close-with-headers.
      if (raw.includes('\r\n\r\n')) {
        const firstLine = raw.split('\r\n')[0] ?? ''
        const parts = firstLine.split(' ')
        const status = Number.parseInt(parts[1] ?? '0', 10)
        const reason = parts.slice(2).join(' ')
        done({ status, reason })
      }
    })
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const firstLine = raw.split('\r\n')[0] ?? ''
      const parts = firstLine.split(' ')
      const status = Number.parseInt(parts[1] ?? '0', 10)
      const reason = parts.slice(2).join(' ')
      done({ status, reason })
    })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

describe('WS Host-header allowlist — integration', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('rejects WS upgrade with Host: localhost.attacker.com:<port> → 421 (suffix trap)', async () => {
    const res = await rawWsUpgrade(handle.port, `localhost.attacker.com:${handle.port}`, bearer)
    expect(res.status).toBe(421)
  })

  it('rejects WS upgrade with Host: evil.com → 421 (not 400)', async () => {
    const res = await rawWsUpgrade(handle.port, 'evil.com', bearer)
    expect(res.status).toBe(421)
  })

  it('accepts WS upgrade with Host: localhost:<port> (shared allowlist)', async () => {
    const res = await rawWsUpgrade(handle.port, `localhost:${handle.port}`, bearer)
    // 101 Switching Protocols = accepted upgrade. The handshake completes
    // (or would complete) because the Host allowlist and auth both passed.
    expect(res.status).toBe(101)
  })

  it('accepts WS upgrade with Host: [::1]:<port> (IPv6 loopback literal)', async () => {
    const res = await rawWsUpgrade(handle.port, `[::1]:${handle.port}`, bearer)
    expect(res.status).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// Integration: no 3xx from any HTTP route (§5 spec requirement)
// ---------------------------------------------------------------------------

describe('no 3xx from any HTTP route — integration', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  /**
   * All routes under test. We include correct-method and wrong-method variants
   * to exercise all code paths. We don't include trailing slashes or variant
   * paths that would hit 404 — the spec requirement is that 404 is fine but 3xx
   * is never emitted.
   */
  const routes: Array<{ method: string; path: string; body?: string }> = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/selection' },
    { method: 'GET', path: '/selection/recent' },
    { method: 'GET', path: '/manifest' },
    {
      method: 'PUT',
      path: '/tabs/42/selection',
      body: JSON.stringify({
        nodes: [
          {
            id: 'test-1',
            componentName: 'App',
            filePath: 'src/App.tsx',
            lineRange: [1, 10],
            domPath: 'div',
            parentChain: [],
            timestamp: 0,
          },
        ],
        clientId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    },
    {
      method: 'POST',
      path: '/computed_styles',
      body: JSON.stringify({ extensionId: 'x', requestId: 'r', selector: 'div' }),
    },
    {
      method: 'POST',
      path: '/dom_subtree',
      body: JSON.stringify({ extensionId: 'x', requestId: 'r', selector: 'div' }),
    },
    { method: 'POST', path: '/shutdown' },
    // Wrong methods that hit 405 or 410 (not 3xx)
    { method: 'POST', path: '/health' },
    // Legacy /selection — 410 Gone (not 3xx)
    { method: 'POST', path: '/selection' },
    { method: 'DELETE', path: '/selection' },
    // Wrong method on tab-scoped path → 405 (not 3xx)
    { method: 'POST', path: '/tabs/42/selection' },
    // Unknown route → 404 (not 3xx)
    { method: 'GET', path: '/v1/browser/unknown' },
    { method: 'GET', path: '/nonexistent' },
    // Path with trailing slash → 404 (not 3xx redirect)
    { method: 'GET', path: '/health/' },
  ]

  for (const route of routes) {
    it(`${route.method} ${route.path} → never 3xx`, async () => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${bearer}`,
      }
      if (route.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(Buffer.byteLength(route.body))
      }

      const res = await rawRequest(handle.port, route.method, route.path, headers, route.body)
      // Any non-3xx status is acceptable (2xx, 4xx, 5xx). A 3xx means the server
      // is redirecting, which spec §5 explicitly forbids.
      expect(
        res.status < 300 || res.status >= 400,
        `${route.method} ${route.path} returned HTTP ${res.status} — 3xx redirect is forbidden by spec §5`,
      ).toBe(true)
    })
  }
})
