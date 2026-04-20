/**
 * Subprotocol bearer non-leakage tests.
 *
 * Verifies that the sentinel bearer string never surfaces in:
 *   A. WS close-frame bytes (1002 close-frame reason payload)
 *   B. HTTP 421 response body
 *   C. Logger call arguments
 *
 * A sentinel bearer of the form `base64url.bearer.authorization.redesigner.dev.<SUFFIX>`
 * is used so that the test can search for the unique suffix without false-positive
 * matches against constant definitions in source files.
 */

import crypto from 'node:crypto'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBPROTO_BEARER_PREFIX } from '../src/auth.js'
import { createDaemonServer } from '../src/server.js'
import { EventBus } from '../src/state/eventBus.js'
import { ManifestWatcher } from '../src/state/manifestWatcher.js'
import { SelectionState } from '../src/state/selectionState.js'
import type { RouteContext } from '../src/types.js'
import { RpcCorrelation } from '../src/ws/rpcCorrelation.js'

// Sentinel bearer — unique suffix is what tests search for. The full string
// matches SUBPROTO_BEARER_RE so it will be redacted if it reaches the logger.
const SENTINEL_BEARER_SUFFIX = 'SENTINEL_TEST_BEARER_ABC123'
const SENTINEL_BEARER = `${SUBPROTO_BEARER_PREFIX}${SENTINEL_BEARER_SUFFIX}`

// ---------------------------------------------------------------------------
// Harness helpers (self-contained; mirrors patterns from wsUpgrade.test.ts)
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

async function listenOnEphemeral(
  token: Buffer,
  ctx?: RouteContext,
): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const probe = createDaemonServer({ port: 0, token, ctx: ctx ?? makeCtx() })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({ port: assigned, token, ctx: ctx ?? makeCtx() })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    port: assigned,
    close: () => real.close(),
  }
}

/** Generate a base64 16-byte Sec-WebSocket-Key for RFC 6455 handshakes. */
function freshWsKey(): string {
  return crypto.randomBytes(16).toString('base64')
}

/**
 * Opens a raw TCP socket, performs a WS upgrade with the given subprotocol
 * header, then collects ALL bytes from the connection until the socket closes.
 * Returns the concatenated raw byte string (UTF-8 decoded) covering the HTTP
 * response line, headers, and any WS frames including the close frame.
 */
function collectRawWsBytes(
  port: number,
  subprotocolHeader: string,
  wrongAuth: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    const chunks: Buffer[] = []
    let settled = false

    const done = (): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(Buffer.concat(chunks).toString('latin1'))
    }

    // 1s fallback: server closes the socket after sending the close frame,
    // so 'end'/'close' normally fires within ~50ms. The timeout is safety only.
    const timeout = setTimeout(() => {
      done()
    }, 1000)

    sock.connect(port, '127.0.0.1', () => {
      // Use a bad token so auth fails and we get a 1002 close frame.
      const authLine = wrongAuth ? 'Authorization: Bearer bad-token-that-wont-match' : ''
      const lines = [
        'GET /events HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${freshWsKey()}`,
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${subprotocolHeader}`,
      ]
      if (authLine) lines.push(authLine)
      sock.write(`${lines.join('\r\n')}\r\n\r\n`)
    })

    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    sock.on('end', () => {
      clearTimeout(timeout)
      done()
    })

    sock.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        done()
      } else {
        if (!settled) {
          settled = true
          reject(err)
        }
      }
    })

    sock.on('close', () => {
      clearTimeout(timeout)
      done()
    })
  })
}

/**
 * Issues a raw HTTP GET request (not a WS upgrade) to collect the HTTP response
 * bytes including the body. This is used for the 421 leakage test where we want
 * to send an unexpected Host and see that the 421 body doesn't echo headers back.
 */
function rawHttpGet(port: number, host: string, extraHeaders: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    const chunks: Buffer[] = []
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        sock.destroy()
        resolve(Buffer.concat(chunks).toString('latin1'))
      }
    }, 1000)

    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      sock.destroy()
      resolve(Buffer.concat(chunks).toString('latin1'))
    }

    sock.connect(port, '127.0.0.1', () => {
      const lines = ['GET / HTTP/1.1', `Host: ${host}`, 'Connection: close', ...extraHeaders]
      sock.write(`${lines.join('\r\n')}\r\n\r\n`)
    })

    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      // Once we have a complete response (headers + body terminator), we can
      // stop waiting. A simple heuristic: stop as soon as we see the body.
      const raw = Buffer.concat(chunks).toString('latin1')
      if (raw.includes('\r\n\r\n')) {
        // Give a brief moment for the full body then resolve.
        setTimeout(done, 50)
      }
    })

    sock.on('end', done)
    sock.on('close', done)

    sock.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
          resolve(Buffer.concat(chunks).toString('latin1'))
        } else {
          reject(err)
        }
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Test A — 1002 close-frame bytes don't contain the bearer suffix
// ---------------------------------------------------------------------------

describe('subproto leakage — Test A: 1002 close-frame bytes', () => {
  // Use a real server token; the sentinel bearer is offered as subprotocol with
  // a deliberately wrong value so auth always fails → server sends 1002.
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('close-frame reason bytes do not contain bearer suffix on auth failure (wrong auth via header)', async () => {
    // Subprotocol header contains sentinel. Auth fails via explicit wrong
    // Authorization header so we don't need to worry about token length.
    const subprotoHeader = `redesigner-v1, ${SENTINEL_BEARER}`
    const raw = await collectRawWsBytes(handle.port, subprotoHeader, true)

    // The connection should produce a 101 then a close frame (1002).
    // In either case the sentinel suffix must never appear in the raw bytes.
    expect(raw).not.toContain(SENTINEL_BEARER_SUFFIX)
  })

  it('close-frame reason bytes do not contain bearer suffix when bearer is the auth mechanism', async () => {
    // Use sentinel as the bearer in the subprotocol — this is the actual auth
    // path. Auth will fail because sentinel !== real token.
    const subprotoHeader = `redesigner-v1, ${SENTINEL_BEARER}`
    // No Authorization header — auth goes through subprotocol bearer path.
    const raw = await collectRawWsBytes(handle.port, subprotoHeader, false)

    expect(raw).not.toContain(SENTINEL_BEARER_SUFFIX)
  })

  it('raw bytes do not echo subprotocol header back in any form', async () => {
    // Also confirm the prefix itself is not echoed as-is in response headers.
    const subprotoHeader = `redesigner-v1, ${SENTINEL_BEARER}`
    const raw = await collectRawWsBytes(handle.port, subprotoHeader, true)

    // The bearer prefix must not appear in the HTTP handshake response.
    expect(raw).not.toContain(SUBPROTO_BEARER_PREFIX)
  })
})

// ---------------------------------------------------------------------------
// Test B — 421 response body contains no subprotocol
// ---------------------------------------------------------------------------

describe('subproto leakage — Test B: 421 response body', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('421 body does not contain sentinel bearer suffix', async () => {
    // Host mismatch triggers 421 Misdirected Request. The Sec-WebSocket-Protocol
    // header carries the sentinel. The response body must not echo it back.
    const raw = await rawHttpGet(handle.port, 'evil.example.com', [
      `Sec-WebSocket-Protocol: ${SENTINEL_BEARER}`,
    ])

    expect(raw).toContain('421')
    expect(raw).not.toContain(SENTINEL_BEARER_SUFFIX)
  })

  it('421 body does not contain bearer prefix', async () => {
    const raw = await rawHttpGet(handle.port, 'evil.example.com', [
      `Sec-WebSocket-Protocol: redesigner-v1, ${SENTINEL_BEARER}`,
    ])

    expect(raw).toContain('421')
    // The full bearer prefix must not appear in the 421 body either.
    expect(raw).not.toContain(SUBPROTO_BEARER_PREFIX)
  })
})

// ---------------------------------------------------------------------------
// Test C — Logger never receives bearer suffix
// ---------------------------------------------------------------------------

describe('subproto leakage — Test C: logger never receives bearer suffix', () => {
  it('no logger call contains sentinel suffix after WS upgrade with sentinel bearer', async () => {
    const bearer = crypto.randomBytes(32).toString('base64url')
    const token = Buffer.from(bearer, 'utf8')
    const ctx = makeCtx()

    const probe = createDaemonServer({ port: 0, token, ctx })
    await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
    const assigned = (probe.server.address() as AddressInfo).port
    await probe.close()

    const real = createDaemonServer({ port: assigned, token, ctx })
    await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))

    try {
      // Trigger wrong-auth path with sentinel in subprotocol.
      const subprotoHeader = `redesigner-v1, ${SENTINEL_BEARER}`
      await collectRawWsBytes(assigned, subprotoHeader, true)

      // Also trigger tooMany-entries path with sentinel embedded.
      const manyEntries = Array.from({ length: 9 }, (_, i) => `redesigner-v${i + 1}`)
      await collectRawWsBytes(assigned, `${manyEntries.join(', ')}, ${SENTINEL_BEARER}`, false)

      // Inspect every logger call.
      const logger = ctx.logger as ReturnType<typeof makeLogger>
      const allCalls = [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
        ...(logger.debug?.mock?.calls ?? []),
      ]

      for (const callArgs of allCalls) {
        const serialized = JSON.stringify(callArgs)
        expect(serialized).not.toContain(SENTINEL_BEARER_SUFFIX)
      }
    } finally {
      await real.close()
    }
  }, 10_000)

  it('logger does not receive sentinel suffix when host-rejected WS upgrade carries sentinel', async () => {
    const bearer = crypto.randomBytes(32).toString('base64url')
    const token = Buffer.from(bearer, 'utf8')
    const ctx = makeCtx()

    const probe = createDaemonServer({ port: 0, token, ctx })
    await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
    const assigned = (probe.server.address() as AddressInfo).port
    await probe.close()

    const real = createDaemonServer({ port: assigned, token, ctx })
    await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))

    try {
      // The WS host-rejected path in events.ts logs the host — NOT the subprotocol.
      // But we send sentinel in subprotocol anyway to confirm it doesn't leak.
      const sock = new net.Socket()
      await new Promise<void>((resolveConn, rejectConn) => {
        const chunks: Buffer[] = []
        let done = false
        const timeout = setTimeout(() => {
          if (!done) {
            done = true
            sock.destroy()
            resolveConn()
          }
        }, 1000)

        sock.connect(assigned, '127.0.0.1', () => {
          const lines = [
            'GET /events HTTP/1.1',
            'Host: evil.example.com',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${freshWsKey()}`,
            'Sec-WebSocket-Version: 13',
            `Sec-WebSocket-Protocol: redesigner-v1, ${SENTINEL_BEARER}`,
          ]
          sock.write(`${lines.join('\r\n')}\r\n\r\n`)
        })
        sock.on('data', (c: Buffer) => {
          chunks.push(c)
          const raw = Buffer.concat(chunks).toString('latin1')
          // Once we see the status line + end-of-headers, we're done.
          if (raw.includes('\r\n\r\n') && !done) {
            clearTimeout(timeout)
            done = true
            sock.destroy()
            resolveConn()
          }
        })
        sock.on('end', () => {
          if (!done) {
            clearTimeout(timeout)
            done = true
            resolveConn()
          }
        })
        sock.on('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout)
          if (!done) {
            done = true
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') resolveConn()
            else rejectConn(err)
          }
        })
      })

      const logger = ctx.logger as ReturnType<typeof makeLogger>
      const allCalls = [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
        ...(logger.debug?.mock?.calls ?? []),
      ]

      for (const callArgs of allCalls) {
        const serialized = JSON.stringify(callArgs)
        expect(serialized).not.toContain(SENTINEL_BEARER_SUFFIX)
      }
    } finally {
      await real.close()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Bonus: circular reference guard in redactValue does not throw
// ---------------------------------------------------------------------------

describe('redactValue — circular reference guard', () => {
  it('circular object does not throw and produces [Circular] marker somewhere', async () => {
    const { redactValue } = await import('../src/logger.js')
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj // circular!
    let result: unknown
    expect(() => {
      result = redactValue(obj)
    }).not.toThrow()
    // The serialized result must contain '[Circular]' somewhere.
    expect(JSON.stringify(result)).toContain('[Circular]')
  })

  it('circular array does not throw and produces [Circular] marker', async () => {
    const { redactValue } = await import('../src/logger.js')
    const arr: unknown[] = [1, 2]
    arr.push(arr) // circular!
    let result: unknown
    expect(() => {
      result = redactValue(arr)
    }).not.toThrow()
    expect(JSON.stringify(result)).toContain('[Circular]')
  })
})
