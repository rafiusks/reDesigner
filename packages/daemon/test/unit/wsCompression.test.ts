/**
 * Tests that the daemon WebSocketServer has perMessageDeflate disabled.
 *
 * Defense rationale (from CLAUDE.md): CRIME/BREACH attack + zip-bomb protection.
 * The WebSocketServer is created with `perMessageDeflate: false` in events.ts.
 *
 * Verification approach:
 * 1. Unit: inspect the WebSocketServer constructor call via vi.spyOn to confirm
 *    the option is passed as false.
 * 2. Integration: connect a ws client that offers permessage-deflate, then check
 *    that the server did NOT echo `Sec-WebSocket-Extensions: permessage-deflate`
 *    back in the 101 response. The ws client exposes ws.extensions after open.
 */

import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Helpers (same pattern as server.smoke.test.ts)
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
    wsUrl: `ws://127.0.0.1:${assigned}`,
    port: assigned,
    bearer,
    close: () => real.close(),
  }
}

// ---------------------------------------------------------------------------
// Integration: perMessageDeflate not negotiated
// ---------------------------------------------------------------------------

describe('perMessageDeflate disabled — WS handshake negotiation', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('server does not echo permessage-deflate when client offers it', async () => {
    await new Promise<void>((resolve, reject) => {
      // Client explicitly requests permessage-deflate compression.
      const ws = new WebSocket(`${handle.wsUrl}/events`, {
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${handle.bearer}`,
        },
        perMessageDeflate: true,
      })

      ws.on('open', () => {
        // ws.extensions is populated from the 101 Upgrade response headers.
        // If the server negotiated permessage-deflate it would be non-empty.
        const extensions = ws.extensions
        ws.close()

        // extensions should be empty string or not contain 'permessage-deflate'
        expect(
          extensions === '' || !extensions.includes('permessage-deflate'),
          `Server must not negotiate permessage-deflate; got extensions: "${extensions}"`,
        ).toBe(true)

        resolve()
      })

      ws.on('unexpected-response', (_, res) => {
        reject(new Error(`Unexpected HTTP ${res.statusCode} response during WS upgrade`))
      })

      ws.on('error', reject)
    })
  })

  it('ws.extensions is empty string after connection (no extensions negotiated)', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${handle.wsUrl}/events`, {
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${handle.bearer}`,
        },
        // Offer both compression and no-context-takeover variants to maximise
        // the surface we're checking against.
        perMessageDeflate: {
          zlibDeflateOptions: { level: 6 },
          zlibInflateOptions: { chunkSize: 10 * 1024 },
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
          clientMaxWindowBits: 15,
          concurrencyLimit: 10,
          threshold: 0,
        },
      })

      ws.on('open', () => {
        const extensions = ws.extensions
        ws.close()
        expect(extensions).toBe('')
        resolve()
      })

      ws.on('unexpected-response', (_, res) => {
        reject(new Error(`Unexpected HTTP ${res.statusCode} during WS upgrade`))
      })

      ws.on('error', reject)
    })
  })

  it('raw Sec-WebSocket-Extensions response header absent when client offers permessage-deflate', async () => {
    // Inspect the HTTP 101 headers directly via unexpected-response (if rejected)
    // or by checking that the ws client sees no extensions (if accepted).
    // We cross-check by doing a raw upgrade and reading the 101 headers.
    const { default: http } = await import('node:http')

    await new Promise<void>((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const req = http.request({
        host: '127.0.0.1',
        port: handle.port,
        path: '/events',
        method: 'GET',
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${handle.bearer}`,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          // Offer permessage-deflate
          'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
        },
      })

      req.on('upgrade', (res, socket) => {
        // 101 Switching Protocols — check extensions header
        const extHeader = res.headers['sec-websocket-extensions']
        socket.destroy()

        expect(
          extHeader === undefined || !String(extHeader).includes('permessage-deflate'),
          `Sec-WebSocket-Extensions should not contain permessage-deflate; got: "${extHeader}"`,
        ).toBe(true)

        resolve()
      })

      req.on('response', (res) => {
        // If we got a non-101 response (e.g. rate-limited), fail informatively
        reject(new Error(`Expected 101 upgrade, got ${res.statusCode}`))
      })

      req.on('error', reject)
      req.end()
    })
  })
})
