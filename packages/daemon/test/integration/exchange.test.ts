/**
 * Integration tests for POST /__redesigner/exchange + POST /__redesigner/revalidate.
 *
 * Spins up a real createDaemonServer on an ephemeral port and issues real HTTP
 * requests. No mocks on the network layer. Every fetch call carries
 * AbortSignal.timeout(3000) per CLAUDE.md invariant.
 *
 * Test cases:
 *   1. Valid exchange with correct bootstrapToken + Origin → 200 + ExchangeResponseSchema
 *   2. sessionToken from exchange works on GET /manifest → not 401
 *   3. Invalid bootstrapToken → 401
 *   4. Missing Origin → 403
 *   4a. Origin with q-z characters (invalid ext ID) → 403
 *   4b. Origin with only a-p characters (valid ext ID) → 200
 *   5. clientNonce replay → 401
 *   6. Rate-limit pre-consumption → 429 (drains 5 burst tokens then asserts)
 *   7. POST /__redesigner/revalidate after successful exchange → new sessionToken
 *   8. GET /__redesigner/exchange without Bearer → 401 (unauth path; 401 is stricter than 405)
 *   9. GET /__redesigner/exchange with valid Bearer → 405 Allow: POST (authed but wrong method)
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ExchangeResponseSchema } from '@redesigner/core/schemas'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'
import { cleanupTempDirs, randomTempDir } from '../helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 32 a-p letters — required by ORIGIN_REGEX in exchange.ts
const CHROME_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const FETCH_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeCtx(projectRoot: string): RouteContext {
  const logger = makeLogger()
  const selectionState = new SelectionState()
  const eventBus = new EventBus()
  const rpcCorrelation = new RpcCorrelation(8)
  const manifestWatcher = new ManifestWatcher(
    '/tmp/test-exchange-manifest.json',
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
    instanceId: crypto.randomUUID(),
    startedAt: Date.now() - 1000,
    projectRoot,
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

interface TestHarness {
  port: number
  url: string
  authToken: string
  bootstrapTokenStr: string
  bootstrapTokenBuf: Buffer
  close: () => Promise<void>
}

/**
 * Stand up a createDaemonServer on an ephemeral port with known tokens.
 * Uses the two-step probe pattern (get port → reuse port) from cors.test.ts.
 */
async function spawnServer(): Promise<TestHarness> {
  // Use base64url so the token is valid ASCII — fetch rejects ByteStrings
  // that contain characters > 255. Buffer.from(str, 'utf8') on the server
  // side round-trips correctly.
  const authTokenStr = crypto.randomBytes(32).toString('base64url')
  const authTokenBuf = Buffer.from(authTokenStr, 'utf8')

  // bootstrapToken stored as a base64url string so we can pass it as JSON.
  const bootstrapTokenStr = crypto.randomBytes(32).toString('base64url')
  const bootstrapTokenBuf = Buffer.from(bootstrapTokenStr, 'utf8')

  const rootToken = Buffer.from(crypto.randomBytes(32))
  const projectRoot = randomTempDir('redesigner-exchange-it-')

  // Step 1: probe on :0 to get an available port, then close.
  const probe = createDaemonServer({
    port: 0,
    token: authTokenBuf,
    bootstrapToken: bootstrapTokenBuf,
    rootToken,
    ctx: makeCtx(projectRoot),
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  // Step 2: real server on the assigned port.
  const real = createDaemonServer({
    port: assigned,
    token: authTokenBuf,
    bootstrapToken: bootstrapTokenBuf,
    rootToken,
    ctx: makeCtx(projectRoot),
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))

  return {
    port: assigned,
    url: `http://127.0.0.1:${assigned}`,
    authToken: authTokenStr,
    bootstrapTokenStr,
    bootstrapTokenBuf,
    close: () => real.close(),
  }
}

/**
 * Low-level POST helper using node:http directly, so we can set any headers.
 * Unlike fetch, this lets us control Host precisely.
 */
function rawPost(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; bodyText: string }> {
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
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exchange + revalidate integration', () => {
  let h: TestHarness

  beforeEach(async () => {
    h = await spawnServer()
  })

  afterEach(async () => {
    await h.close()
    cleanupTempDirs()
  })

  // -------------------------------------------------------------------------
  // 1. Valid exchange → 200 + parseable ExchangeResponseSchema
  // -------------------------------------------------------------------------
  test('valid exchange → 200 + ExchangeResponseSchema with sessionToken/exp/serverNonce', async () => {
    const clientNonce = crypto.randomUUID()
    const res = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    expect(res.status).toBe(200)
    const data = ExchangeResponseSchema.parse(await res.json())
    expect(data.sessionToken.length).toBeGreaterThan(0)
    expect(data.serverNonce.length).toBeGreaterThanOrEqual(16)
    // exp should be roughly now + 300s (within 10s tolerance for CI slowness)
    const now = Date.now()
    expect(data.exp).toBeGreaterThan(now + 290_000)
    expect(data.exp).toBeLessThan(now + 310_000)
  })

  // -------------------------------------------------------------------------
  // 2. sessionToken from exchange works on GET /manifest → not 401.
  //    The ext never sees the daemon authToken (it's in the on-disk handoff
  //    file), so the SW must use exchange-minted sessionTokens for all
  //    REST calls. server.ts's Bearer check falls back to
  //    exchange.isSessionActive(extId, bearer) when the authToken compare
  //    misses, with extId parsed from the chrome-extension:// Origin.
  //    /manifest returns 503 NotReady when no manifest is loaded — that is
  //    OK; we just need NOT 401 to prove the Bearer was accepted.
  // -------------------------------------------------------------------------
  test('sessionToken works on GET /manifest → not 401', async () => {
    const clientNonce = crypto.randomUUID()
    const exchangeRes = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(exchangeRes.status).toBe(200)
    const data = ExchangeResponseSchema.parse(await exchangeRes.json())

    const manifestRes = await fetch(`${h.url}/manifest`, {
      headers: {
        Authorization: `Bearer ${data.sessionToken}`,
        Origin: CHROME_EXT_ORIGIN,
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).not.toBe(401)
  })

  // Also confirm the authToken path still works — existing internal tooling
  // (tests, CLI shutdown helpers, vite bridge) authenticate directly with
  // the handoff-sourced authToken and must not regress.
  test('authToken still works on GET /manifest (backward compat) → not 401', async () => {
    const manifestRes = await fetch(`${h.url}/manifest`, {
      headers: {
        Authorization: `Bearer ${h.authToken}`,
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).not.toBe(401)
  })

  // Session token with neither Origin nor X-Redesigner-Ext-Id → 401. Both
  // headers are valid extId carriers; without either the session fallback
  // has no way to identify the calling extension.
  test('sessionToken with no extId source → 401', async () => {
    const clientNonce = crypto.randomUUID()
    const exchangeRes = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = ExchangeResponseSchema.parse(await exchangeRes.json())

    const manifestRes = await fetch(`${h.url}/manifest`, {
      headers: {
        Authorization: `Bearer ${data.sessionToken}`,
        Host: `127.0.0.1:${h.port}`,
        // Intentionally no Origin, no X-Redesigner-Ext-Id.
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).toBe(401)
  })

  // X-Redesigner-Ext-Id header works in lieu of Origin — matches real SW
  // GET behavior where Chrome strips Origin on privileged extension fetches.
  test('sessionToken with X-Redesigner-Ext-Id header (no Origin) → not 401', async () => {
    const clientNonce = crypto.randomUUID()
    const exchangeRes = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = ExchangeResponseSchema.parse(await exchangeRes.json())

    // Ext ID extracted from the 32-letter suffix of CHROME_EXT_ORIGIN.
    const extId = CHROME_EXT_ORIGIN.slice('chrome-extension://'.length)
    const manifestRes = await fetch(`${h.url}/manifest`, {
      headers: {
        Authorization: `Bearer ${data.sessionToken}`,
        'X-Redesigner-Ext-Id': extId,
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).not.toBe(401)
  })

  // Mismatched X-Redesigner-Ext-Id → 401 (forged header can't impersonate
  // a different extension's pinned session).
  test('sessionToken with wrong X-Redesigner-Ext-Id → 401', async () => {
    const clientNonce = crypto.randomUUID()
    const exchangeRes = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = ExchangeResponseSchema.parse(await exchangeRes.json())

    const manifestRes = await fetch(`${h.url}/manifest`, {
      headers: {
        Authorization: `Bearer ${data.sessionToken}`,
        'X-Redesigner-Ext-Id': 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 3. Invalid bootstrapToken → 401
  // -------------------------------------------------------------------------
  test('invalid bootstrapToken → 401', async () => {
    const clientNonce = crypto.randomUUID()
    const wrongToken = crypto.randomBytes(32).toString('base64url') // different token
    const res = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: wrongToken }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 4. Missing Origin → 403
  // -------------------------------------------------------------------------
  test('missing Origin header → 403', async () => {
    const clientNonce = crypto.randomUUID()
    // Use rawPost to avoid any automatic Origin injection by fetch
    const result = await rawPost(
      h.port,
      '/__redesigner/exchange',
      {
        // Deliberately no Origin header
        'Sec-Fetch-Site': 'cross-site',
      },
      JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
    )
    expect(result.status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 4a. Origin with q-z characters (invalid ext ID) → 403
  // -------------------------------------------------------------------------
  test('Origin with q-z characters (not valid Chrome ext ID) → 403', async () => {
    const clientNonce = crypto.randomUUID()
    // q-z letters fall outside [a-p]; digits also fail the char class.
    const invalidOrigin = 'chrome-extension://abcdefghijklmnopqrstuvwxyz123456'
    const result = await rawPost(
      h.port,
      '/__redesigner/exchange',
      {
        Origin: invalidOrigin,
        'Sec-Fetch-Site': 'cross-site',
      },
      JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
    )
    expect(result.status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 4b. Origin with only a-p characters (valid ext ID) → 200
  // -------------------------------------------------------------------------
  test('Origin with only a-p characters (valid Chrome ext ID) → 200', async () => {
    const clientNonce = crypto.randomUUID()
    const validOrigin = 'chrome-extension://pabcdefghijklmnopabcdefghijklmno' // all a-p
    const res = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: validOrigin,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(200)
    const data = ExchangeResponseSchema.parse(await res.json())
    expect(data.sessionToken).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 5. clientNonce replay → 401
  // -------------------------------------------------------------------------
  test('clientNonce replay → 401 on second use', async () => {
    const clientNonce = crypto.randomUUID()

    // First use — should succeed
    const first = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(first.status).toBe(200)

    // Second use of same nonce — replay must be rejected
    const second = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(second.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 6. Rate-limit pre-consumption: drain the per-(Origin, peerAddr) failed-exchange
  //    bucket (burst=5) with bad tokens, then assert 429.
  //    Note: on success the bucket resets, so we must keep all requests failing.
  // -------------------------------------------------------------------------
  test('rate-limit bucket: drain 5 failed attempts → 429 on 6th', async () => {
    const wrongToken = crypto.randomBytes(32).toString('base64url')

    // Drain burst (5 tokens). Each request must fail with 401.
    for (let i = 0; i < 5; i++) {
      const res = await rawPost(
        h.port,
        '/__redesigner/exchange',
        {
          Origin: CHROME_EXT_ORIGIN,
          'Sec-Fetch-Site': 'cross-site',
        },
        JSON.stringify({ clientNonce: crypto.randomUUID(), bootstrapToken: wrongToken }),
      )
      // Must fail but not yet rate-limited
      expect(res.status).not.toBe(429)
    }

    // 6th request — bucket should be empty now
    const overLimit = await rawPost(
      h.port,
      '/__redesigner/exchange',
      {
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
      },
      JSON.stringify({ clientNonce: crypto.randomUUID(), bootstrapToken: wrongToken }),
    )
    expect(overLimit.status).toBe(429)
  })

  // -------------------------------------------------------------------------
  // 7. POST /__redesigner/revalidate after successful exchange → new sessionToken
  // -------------------------------------------------------------------------
  test('revalidate after exchange → new sessionToken, same ExchangeResponseSchema shape', async () => {
    // Step 1: exchange
    const exchangeNonce = crypto.randomUUID()
    const exchangeRes = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce: exchangeNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(exchangeRes.status).toBe(200)
    const exchangeBody = ExchangeResponseSchema.parse(await exchangeRes.json())

    // Step 2: revalidate with the session token as Bearer + fresh nonce
    const revalidateNonce = crypto.randomUUID()
    const revalidateRes = await fetch(`${h.url}/__redesigner/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${exchangeBody.sessionToken}`,
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ clientNonce: revalidateNonce, bootstrapToken: h.bootstrapTokenStr }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(revalidateRes.status).toBe(200)
    const revalidateBody = ExchangeResponseSchema.parse(await revalidateRes.json())

    // New session token must be minted (different from the exchange one)
    expect(revalidateBody.sessionToken).not.toBe(exchangeBody.sessionToken)
    expect(revalidateBody.serverNonce.length).toBeGreaterThanOrEqual(16)
    expect(revalidateBody.exp).toBeGreaterThan(Date.now())

    // Old session token must be invalidated for further revalidation calls.
    // Attempting revalidate with the old sessionToken returns 401 because
    // exchange.rotateSession() replaces the active session for the ext-ID.
    const oldTokenRevalidate = await fetch(`${h.url}/__redesigner/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${exchangeBody.sessionToken}`,
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({
        clientNonce: crypto.randomUUID(),
        bootstrapToken: h.bootstrapTokenStr,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(oldTokenRevalidate.status).toBe(401)

    // New session token is valid for further revalidation.
    const newTokenRevalidate = await fetch(`${h.url}/__redesigner/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${revalidateBody.sessionToken}`,
        Origin: CHROME_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
        Host: `127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({
        clientNonce: crypto.randomUUID(),
        bootstrapToken: h.bootstrapTokenStr,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(newTokenRevalidate.status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // 8. GET /__redesigner/exchange without Bearer → 401
  //    (unauth path; 401 is stricter than 405 for unauthenticated requests)
  // -------------------------------------------------------------------------
  test('GET /__redesigner/exchange without Bearer → 401', async () => {
    const res = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 9. GET /__redesigner/exchange with valid Bearer → 405 Allow: POST
  //    (authed but wrong method; daemon knows the path exists)
  // -------------------------------------------------------------------------
  test('GET /__redesigner/exchange with valid Bearer → 405 Allow: POST', async () => {
    const res = await fetch(`${h.url}/__redesigner/exchange`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${h.authToken}`,
        Host: `127.0.0.1:${h.port}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(405)
    const allow = res.headers.get('allow') ?? ''
    expect(allow).toContain('POST')
  })
})
