/**
 * WS upgrade protocol tests — subprotocol echo, bearer-via-subprotocol auth,
 * version negotiation (`?v=…` + `redesigner-v<N>` offers), and RFC 6455
 * Sec-WebSocket-Version gating.
 *
 * Tests use a real http.createServer + attachEvents() wiring and drive the
 * upgrade either with the `ws` client library (for happy paths where we
 * want to inspect the accepted subprotocol + hello frame) or raw net.Socket
 * (for cases where we need to craft pre-handshake rejections that the high-
 * level client can't express).
 */

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  MAX_SUBPROTOCOL_ENTRIES,
  SUBPROTO_BEARER_PREFIX,
  extractSubprotocolToken,
} from '../src/auth.js'
import { createDaemonServer } from '../src/server.js'
import { EventBus } from '../src/state/eventBus.js'
import { ManifestWatcher } from '../src/state/manifestWatcher.js'
import { SelectionState } from '../src/state/selectionState.js'
import type { RouteContext } from '../src/types.js'
import { parseQueryVersions } from '../src/ws/events.js'
import { RpcCorrelation } from '../src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Test harness (shared with other WS tests; duplicated to keep this file
// self-contained).
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
 * Raw HTTP/WS upgrade via net.Socket so we can control every header exactly.
 * Resolves once the status line + header terminator arrives, returning the
 * response status, status text, the full header block as a map, and the raw
 * bytes (for tests that want to search for a 101 "Sec-WebSocket-Protocol").
 */
interface RawUpgradeResult {
  status: number
  reason: string
  headers: Record<string, string>
  raw: string
}
function rawUpgrade(port: number, host: string, requestLines: string[]): Promise<RawUpgradeResult> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    const chunks: Buffer[] = []
    let settled = false
    const done = (r: RawUpgradeResult): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(r)
    }
    sock.connect(port, '127.0.0.1', () => {
      const head = [...requestLines, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade']
      // Callers may or may not include Sec-WebSocket-Key / Version / Protocol.
      const out = head.join('\r\n')
      sock.write(`${out}\r\n\r\n`)
    })
    sock.on('data', (c: Buffer) => {
      chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      const idx = raw.indexOf('\r\n\r\n')
      if (idx !== -1) {
        const headerBlock = raw.slice(0, idx)
        const lines = headerBlock.split('\r\n')
        const statusLine = lines[0] ?? ''
        const parts = statusLine.split(' ')
        const status = Number.parseInt(parts[1] ?? '0', 10)
        const reason = parts.slice(2).join(' ')
        const headers: Record<string, string> = {}
        for (const line of lines.slice(1)) {
          const ci = line.indexOf(':')
          if (ci === -1) continue
          headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim()
        }
        done({ status, reason, headers, raw })
      }
    })
    sock.on('end', () => {
      if (settled) return
      const raw = Buffer.concat(chunks).toString('utf8')
      done({ status: 0, reason: '', headers: {}, raw })
    })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        settled = true
        resolve({ status: 0, reason: '', headers: {}, raw: '' })
      } else {
        reject(err)
      }
    })
  })
}

/** Generate a base64 16-byte Sec-WebSocket-Key suitable for RFC 6455 handshake. */
function freshWsKey(): string {
  return crypto.randomBytes(16).toString('base64')
}

/**
 * High-level helper: open a ws client with an explicit subprotocol list and
 * optional raw query string. Returns a promise that resolves with both the
 * protocol the server echoed and the first received message (hello frame),
 * plus the close code if the server closes the socket before hello lands.
 */
interface ClientOpenResult {
  opened: boolean
  acceptedProtocol: string
  helloPayload: Record<string, unknown> | null
  closeCode: number | null
  closeReason: string
  upgradeHeaders: Record<string, string | string[] | undefined>
}
function openWsClient(
  wsUrl: string,
  port: number,
  path: string,
  subprotocols: string[],
  extraHeaders: Record<string, string> = {},
): Promise<ClientOpenResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}${path}`, subprotocols, {
      headers: {
        Host: `127.0.0.1:${port}`,
        ...extraHeaders,
      },
    })
    let opened = false
    let helloPayload: Record<string, unknown> | null = null
    let upgradeHeaders: Record<string, string | string[] | undefined> = {}
    let acceptedProtocol = ''
    let closeCode: number | null = null
    let closeReason = ''
    let settled = false

    const finalize = (): void => {
      if (settled) return
      settled = true
      resolve({
        opened,
        acceptedProtocol,
        helloPayload,
        closeCode,
        closeReason,
        upgradeHeaders,
      })
    }

    ws.on('upgrade', (res) => {
      upgradeHeaders = res.headers
    })
    ws.on('open', () => {
      opened = true
      acceptedProtocol = ws.protocol
    })
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>
        if (parsed.type === 'hello') {
          helloPayload = parsed
          // For happy-path tests we want to resolve once hello arrives;
          // close on our side so the server cleans up and unref timers.
          ws.close(1000)
        }
      } catch {
        // ignore non-hello
      }
    })
    ws.on('close', (code, reason) => {
      closeCode = code
      closeReason = reason.toString('utf8')
      finalize()
    })
    ws.on('error', () => {
      // 'close' will still fire after error for post-upgrade errors. For
      // pre-handshake rejections 'unexpected-response' fires instead.
    })
    ws.on('unexpected-response', (_, res) => {
      upgradeHeaders = res.headers
      closeReason = `HTTP ${res.statusCode ?? 0}`
      finalize()
    })
  })
}

// ---------------------------------------------------------------------------
// Unit: extractSubprotocolToken
// ---------------------------------------------------------------------------

describe('extractSubprotocolToken — unit', () => {
  const mkReq = (val: string | undefined): http.IncomingMessage => {
    const r = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage
    ;(r as unknown as { headers: Record<string, string | undefined> }).headers = {
      'sec-websocket-protocol': val,
    }
    return r
  }

  it('returns empty result when header absent', () => {
    const out = extractSubprotocolToken(mkReq(undefined))
    expect(out.entries).toEqual([])
    expect(out.versionedOffers).toEqual([])
    expect(out.bearer).toBeNull()
    expect(out.tooMany).toBe(false)
  })

  it('parses comma-separated entries and trims whitespace', () => {
    const out = extractSubprotocolToken(mkReq('redesigner-v1, redesigner-v2 , other'))
    expect(out.entries).toEqual(['redesigner-v1', 'redesigner-v2', 'other'])
    expect(out.versionedOffers).toEqual(['redesigner-v1', 'redesigner-v2'])
  })

  it('extracts bearer via fixed-prefix suffix (dots in prefix preserved)', () => {
    const bearer = 'a.b.c-with-dots.and-dashes'
    const out = extractSubprotocolToken(mkReq(`redesigner-v1, ${SUBPROTO_BEARER_PREFIX}${bearer}`))
    expect(out.bearer).toBe(bearer)
  })

  it('bearer-only offer: bearer captured, no versioned offers', () => {
    const out = extractSubprotocolToken(mkReq(`${SUBPROTO_BEARER_PREFIX}token-123`))
    expect(out.bearer).toBe('token-123')
    expect(out.versionedOffers).toEqual([])
  })

  it('empty bearer suffix → null bearer', () => {
    const out = extractSubprotocolToken(mkReq(`redesigner-v1, ${SUBPROTO_BEARER_PREFIX}`))
    expect(out.bearer).toBeNull()
  })

  it(`flags tooMany when entry count > ${MAX_SUBPROTOCOL_ENTRIES}`, () => {
    const entries = Array.from({ length: MAX_SUBPROTOCOL_ENTRIES + 1 }, (_, i) => `sp${i}`)
    const out = extractSubprotocolToken(mkReq(entries.join(',')))
    expect(out.tooMany).toBe(true)
  })

  it(`does NOT flag tooMany at exactly ${MAX_SUBPROTOCOL_ENTRIES}`, () => {
    const entries = Array.from({ length: MAX_SUBPROTOCOL_ENTRIES }, (_, i) => `sp${i}`)
    const out = extractSubprotocolToken(mkReq(entries.join(',')))
    expect(out.tooMany).toBe(false)
  })

  it('array header value is joined (Node can deliver as array)', () => {
    const r = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage
    ;(r as unknown as { headers: Record<string, string[]> }).headers = {
      'sec-websocket-protocol': ['redesigner-v1', `${SUBPROTO_BEARER_PREFIX}tok`],
    }
    const out = extractSubprotocolToken(r)
    expect(out.versionedOffers).toEqual(['redesigner-v1'])
    expect(out.bearer).toBe('tok')
  })
})

// ---------------------------------------------------------------------------
// Unit: parseQueryVersions
// ---------------------------------------------------------------------------

describe('parseQueryVersions — unit', () => {
  it('null/undefined → null (param absent)', () => {
    expect(parseQueryVersions(null)).toBeNull()
    expect(parseQueryVersions(undefined)).toBeNull()
  })

  it('empty string → [] (param present but empty)', () => {
    expect(parseQueryVersions('')).toEqual([])
  })

  it('zero filtered out → []', () => {
    expect(parseQueryVersions('0')).toEqual([])
  })

  it('trailing comma tolerated → [1]', () => {
    expect(parseQueryVersions('1,')).toEqual([1])
  })

  it('negative rejected by regex → []', () => {
    expect(parseQueryVersions('-1')).toEqual([])
  })

  it('float rejected by regex → []', () => {
    expect(parseQueryVersions('1.5')).toEqual([])
  })

  it('whitespace trimmed → [1]', () => {
    expect(parseQueryVersions(' 1 ')).toEqual([1])
  })

  it('dedupe + desc sort → [2, 1]', () => {
    expect(parseQueryVersions('1,2,1')).toEqual([2, 1])
  })
})

// ---------------------------------------------------------------------------
// Integration: WS upgrade — subprotocol echo + version negotiation
// ---------------------------------------------------------------------------

describe('WS upgrade — subprotocol echo + version negotiation', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('echoes redesigner-v1 only; never echoes bearer subprotocol (raw inspect)', async () => {
    // Offer multiple versions + the bearer. Response must echo only the highest
    // supported versioned entry.
    const subprotoHeader = [
      'redesigner-v1',
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
      'redesigner-v99', // unsupported; just distraction
    ].join(', ')
    const res = await rawUpgrade(handle.port, `127.0.0.1:${handle.port}`, [
      'GET /events HTTP/1.1',
      `Sec-WebSocket-Key: ${freshWsKey()}`,
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Protocol: ${subprotoHeader}`,
    ])
    expect(res.status).toBe(101)
    expect(res.headers['sec-websocket-protocol']).toBe('redesigner-v1')
    // Sanity: the bearer prefix must not leak into the response anywhere.
    expect(res.raw).not.toContain(SUBPROTO_BEARER_PREFIX)
  })

  it('happy path: ws client sees acceptedProtocol=redesigner-v1 and negotiatedV=1 in hello', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', [
      'redesigner-v1',
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
    ])
    expect(result.opened).toBe(true)
    expect(result.acceptedProtocol).toBe('redesigner-v1')
    expect(result.helloPayload).not.toBeNull()
    const payload = (result.helloPayload as Record<string, unknown>).payload as Record<
      string,
      unknown
    >
    expect(payload.negotiatedV).toBe(1)
  })

  it('?v=1,2 + redesigner-v1,v2 offer: negotiatedV=1 (max of intersection with [1])', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events?v=1,2', [
      'redesigner-v1',
      'redesigner-v2',
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
    ])
    expect(result.opened).toBe(true)
    expect(result.acceptedProtocol).toBe('redesigner-v1')
    const payload = (result.helloPayload as Record<string, unknown>).payload as Record<
      string,
      unknown
    >
    expect(payload.negotiatedV).toBe(1)
  })

  it('bearer-only offer: server refuses to echo bearer → client observes disconnect (1006)', async () => {
    // There's nothing safe for the server to echo (the only client entry is
    // the bearer itself; the ws client would reject a no-protocol ack), so
    // the server drops the socket. Client sees abnormal closure.
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', [
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
    ])
    expect(result.opened).toBe(false)
    expect(result.closeCode).toBe(1006)
    // Bearer prefix must never appear in any echoed header.
    const echoed = result.upgradeHeaders['sec-websocket-protocol']
    const echoedStr = Array.isArray(echoed) ? echoed.join(',') : (echoed ?? '')
    expect(echoedStr).not.toContain(SUBPROTO_BEARER_PREFIX)
  })

  it('subprotocol list with 9 entries → 1002 close (handshake completes with safe echo)', async () => {
    // 9 versioned entries — exceeds MAX_SUBPROTOCOL_ENTRIES (8). Server
    // picks one of the client's offered versioned entries to echo so the
    // client accepts the subprotocol ack, then closes 1002.
    const many = Array.from({ length: 9 }, (_, i) => `redesigner-v${i + 1}`)
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', [
      ...many,
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
    ])
    expect(result.closeCode).toBe(1002)
    // Bearer must never be echoed, even on failure paths.
    const echoed = result.upgradeHeaders['sec-websocket-protocol']
    const echoedStr = Array.isArray(echoed) ? echoed.join(',') : (echoed ?? '')
    expect(echoedStr).not.toContain(SUBPROTO_BEARER_PREFIX)
    expect(echoedStr).toMatch(/^redesigner-v\d+$/)
  })

  it('uniform 1002 on wrong token via subprotocol bearer (handshake opens, then close)', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', [
      'redesigner-v1',
      `${SUBPROTO_BEARER_PREFIX}wrong-token`,
    ])
    // Handshake completes (echoes redesigner-v1) so the structured close
    // code reaches the client. Client-observed 'opened' is true but we
    // immediately close 1002 before any frames flow.
    expect(result.closeCode).toBe(1002)
    expect(result.helloPayload).toBeNull()
  })

  it('uniform 1002 on wrong token via Authorization header (no subproto bearer)', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', ['redesigner-v1'], {
      Authorization: 'Bearer wrong-token',
    })
    expect(result.closeCode).toBe(1002)
    expect(result.helloPayload).toBeNull()
  })

  it('uniform 1002 when no bearer is provided at all', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', ['redesigner-v1'])
    expect(result.closeCode).toBe(1002)
    expect(result.helloPayload).toBeNull()
  })

  it('Sec-WebSocket-Version != 13 → HTTP 426 Upgrade Required', async () => {
    const res = await rawUpgrade(handle.port, `127.0.0.1:${handle.port}`, [
      'GET /events HTTP/1.1',
      `Sec-WebSocket-Key: ${freshWsKey()}`,
      'Sec-WebSocket-Version: 8',
      'Sec-WebSocket-Protocol: redesigner-v1',
      `Authorization: Bearer ${bearer}`,
    ])
    expect(res.status).toBe(426)
    expect(res.headers['sec-websocket-version']).toBe('13')
  })

  it('Sec-WebSocket-Version absent → HTTP 426', async () => {
    const res = await rawUpgrade(handle.port, `127.0.0.1:${handle.port}`, [
      'GET /events HTTP/1.1',
      `Sec-WebSocket-Key: ${freshWsKey()}`,
      'Sec-WebSocket-Protocol: redesigner-v1',
      `Authorization: Bearer ${bearer}`,
    ])
    expect(res.status).toBe(426)
    expect(res.headers['sec-websocket-version']).toBe('13')
  })

  it('?v=2 with only v2 in subprotocols and no v1: 4406 close with {accepted:[1]}', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events?v=2', [
      'redesigner-v2',
      `${SUBPROTO_BEARER_PREFIX}${bearer}`,
    ])
    expect(result.closeCode).toBe(4406)
    expect(result.closeReason).toBe(JSON.stringify({ accepted: [1] }))
  })

  it('Authorization header + redesigner-v1 (back-compat path) works', async () => {
    const result = await openWsClient(handle.wsUrl, handle.port, '/events', ['redesigner-v1'], {
      Authorization: `Bearer ${bearer}`,
    })
    expect(result.opened).toBe(true)
    expect(result.acceptedProtocol).toBe('redesigner-v1')
  })
})
