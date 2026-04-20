/**
 * Tests for the /__redesigner/handshake.json middleware (Task 13).
 *
 * Coverage (per plan):
 *  1. GET with valid fetch-metadata → 200 + X-Redesigner-Bootstrap header + Zod-valid body
 *  2. GET without Origin (curl-style) → 200
 *  3. GET with Origin: chrome-extension://<32 lowercase letters> → 200
 *  4. GET with Origin: chrome-extension://abc (invalid format) → 403
 *  5. GET with Origin: http://evil.example.com → 403
 *  6. GET with Sec-Fetch-Dest: document → 403
 *  7. GET with Sec-Fetch-Site: same-origin → 403
 *  8. GET with Host: evil.example.com → 421
 *  9. POST → 405 with Allow: GET
 * 10. Cache-Control: no-store, private present
 * 11. Pragma: no-cache present
 * 12. Body bootstrapToken matches header X-Redesigner-Bootstrap
 * 13. Multiple GETs return SAME token (stable for lifetime)
 * 14. Missing daemon info → 503 extension-disconnected
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HandshakeSchema } from '@redesigner/core/schemas'
import { describe, expect, it } from 'vitest'
import {
  type HandshakeMiddlewareOptions,
  createBootstrapState,
  createHandshakeMiddleware,
} from '../../src/bootstrap'

interface MockResponse {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  ended: boolean
}

function mockReqRes(opts: {
  method?: string
  host?: string
  origin?: string | undefined
  secFetchDest?: string | undefined
  secFetchSite?: string | undefined
  url?: string
}): { req: IncomingMessage; res: ServerResponse; captured: MockResponse } {
  const headers: Record<string, string> = {}
  if (opts.host) headers.host = opts.host
  if (opts.origin !== undefined) headers.origin = opts.origin
  if (opts.secFetchDest !== undefined) headers['sec-fetch-dest'] = opts.secFetchDest
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite

  const req = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/__redesigner/handshake.json',
    headers,
  } as unknown as IncomingMessage

  const captured: MockResponse = { statusCode: 200, headers: {}, body: '', ended: false }
  const res = {
    get statusCode() {
      return captured.statusCode
    },
    set statusCode(v: number) {
      captured.statusCode = v
    },
    setHeader(name: string, value: string | string[]) {
      captured.headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()]
    },
    end(body?: string) {
      if (body) captured.body = body
      captured.ended = true
    },
  } as unknown as ServerResponse

  return { req, res, captured }
}

function makeOptions(
  overrides: Partial<HandshakeMiddlewareOptions> = {},
): HandshakeMiddlewareOptions {
  return {
    viteServerPort: () => 5173,
    bootstrap: createBootstrapState({ readBootstrap: () => ({ bootstrapToken: 'a'.repeat(43) }) }),
    getDaemonInfo: () => ({ port: 4919, serverVersion: '0.0.1' }),
    pluginVersion: '0.0.0',
    editor: 'vscode',
    ...overrides,
  }
}

describe('/__redesigner/handshake.json middleware', () => {
  it('GET with valid fetch-metadata → 200 + X-Redesigner-Bootstrap header + Zod-valid body', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      origin: undefined,
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {
      throw new Error('next() should not be called on match')
    })
    expect(captured.statusCode).toBe(200)
    expect(typeof captured.headers['x-redesigner-bootstrap']).toBe('string')
    expect(captured.headers['content-type']).toContain('application/json')
    const body = JSON.parse(captured.body) as unknown
    const parsed = HandshakeSchema.safeParse(body)
    expect(parsed.success).toBe(true)
  })

  it('GET without Origin → 200 (Origin-absent allowed)', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: '127.0.0.1:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(200)
  })

  it('GET with Origin: chrome-extension://<32 lowercase letters> → 200', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      origin: `chrome-extension://${'a'.repeat(32)}`,
      secFetchDest: 'empty',
      secFetchSite: 'cross-site',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(200)
  })

  it('GET with Origin: chrome-extension://abc (invalid format) → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      origin: 'chrome-extension://abc',
      secFetchDest: 'empty',
      secFetchSite: 'cross-site',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
    expect(captured.headers['content-type']).toContain('application/problem+json')
    const body = JSON.parse(captured.body) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('host-rejected')
  })

  it('GET with Origin: http://evil.example.com → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      origin: 'http://evil.example.com',
      secFetchDest: 'empty',
      secFetchSite: 'cross-site',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
  })

  it('GET with Sec-Fetch-Dest: document → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'document',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
  })

  it('GET with Sec-Fetch-Site: same-origin → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'same-origin',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
  })

  it('GET with Sec-Fetch-Site: same-site → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'same-site',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
  })

  it('GET with Origin: "null" (literal) → 403', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      origin: 'null',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(403)
    const body = JSON.parse(captured.body) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('host-rejected')
  })

  it('GET with Host: evil.example.com → 421', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'evil.example.com',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(421)
    const body = JSON.parse(captured.body) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('host-rejected')
  })

  it('POST → 405 with Allow: GET', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      method: 'POST',
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(405)
    expect(captured.headers.allow).toBe('GET')
    const body = JSON.parse(captured.body) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('method-not-allowed')
    expect(captured.headers['cache-control']).toBe('no-store, private')
    expect(captured.headers.pragma).toBe('no-cache')
    expect(captured.headers.vary).toBe('Origin, Sec-Fetch-Site, Sec-Fetch-Dest')
  })

  it('Cache-Control: no-store, private is set', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.headers['cache-control']).toBe('no-store, private')
  })

  it('Pragma: no-cache is set', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.headers.pragma).toBe('no-cache')
  })

  it('Vary: Origin, Sec-Fetch-Site, Sec-Fetch-Dest is set', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    const vary = captured.headers.vary
    expect(typeof vary).toBe('string')
    expect(vary).toContain('Origin')
    expect(vary).toContain('Sec-Fetch-Site')
    expect(vary).toContain('Sec-Fetch-Dest')
  })

  it('Body bootstrapToken matches header X-Redesigner-Bootstrap', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(200)
    const headerToken = captured.headers['x-redesigner-bootstrap']
    const body = JSON.parse(captured.body) as { bootstrapToken: string }
    expect(typeof headerToken).toBe('string')
    expect(body.bootstrapToken).toBe(headerToken)
  })

  it('Multiple GETs return SAME token (stable for lifetime)', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const r1 = mockReqRes({ host: 'localhost:5173', secFetchDest: 'empty', secFetchSite: 'none' })
    const r2 = mockReqRes({ host: 'localhost:5173', secFetchDest: 'empty', secFetchSite: 'none' })
    mw(r1.req, r1.res, () => {})
    mw(r2.req, r2.res, () => {})
    expect(r1.captured.statusCode).toBe(200)
    expect(r2.captured.statusCode).toBe(200)
    const t1 = r1.captured.headers['x-redesigner-bootstrap']
    const t2 = r2.captured.headers['x-redesigner-bootstrap']
    expect(t1).toBe(t2)
    expect(typeof t1).toBe('string')
    expect((t1 as string).length).toBeGreaterThan(0)
  })

  it('GET with [::1]:port Host → 200', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      host: '[::1]:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(200)
  })

  it('daemon not ready → 503 extension-disconnected', () => {
    const mw = createHandshakeMiddleware(makeOptions({ getDaemonInfo: () => null }))
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    expect(captured.statusCode).toBe(503)
    const body = JSON.parse(captured.body) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('extension-disconnected')
    expect(captured.headers.vary).toBe('Origin, Sec-Fetch-Site, Sec-Fetch-Dest')
  })

  it('wsUrl points at daemon /events; httpUrl points at daemon root', () => {
    const mw = createHandshakeMiddleware(
      makeOptions({ getDaemonInfo: () => ({ port: 42000, serverVersion: '9.9.9' }) }),
    )
    const { req, res, captured } = mockReqRes({
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    mw(req, res, () => {})
    const body = JSON.parse(captured.body) as {
      wsUrl: string
      httpUrl: string
      daemonVersion: string
    }
    expect(body.wsUrl).toBe('ws://127.0.0.1:42000/events')
    expect(body.httpUrl).toBe('http://127.0.0.1:42000')
    expect(body.daemonVersion).toBe('9.9.9')
  })

  it('request to a non-matching path → next() called', () => {
    const mw = createHandshakeMiddleware(makeOptions())
    const { req, res, captured } = mockReqRes({
      url: '/index.html',
      host: 'localhost:5173',
      secFetchDest: 'empty',
      secFetchSite: 'none',
    })
    let nextCalled = false
    mw(req, res, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(captured.ended).toBe(false)
  })
})
