/**
 * Tests for the /exchange endpoint handler + TOFU ext-ID pinning.
 *
 * Tests exercise the factory directly by mounting the returned handler on a
 * real http.Server at an ephemeral port. Each test gets a unique projectRoot
 * (tmpdir + UUID) so the TOFU file is isolated per test.
 *
 * Session-token derivation (see routes/exchange.ts):
 *   sessionToken = HMAC-SHA256(
 *     rootToken,
 *     Buffer.concat([clientNonceBuf, serverNonceBuf, iatBE8])
 *   ).toString('base64url').replace(/=+$/, '')
 * where iatBE8 is an 8-byte big-endian UInt64 of `iat` (seconds since epoch).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTrustedExtIdPath } from '../src/handoff.js'
import type { Logger } from '../src/logger.js'
import { createExchangeRoute } from '../src/routes/exchange.js'
import { cleanupTempDirs, randomTempDir } from './helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LoggerEntry {
  level: string
  msg: string
  meta: Record<string, unknown> | undefined
}

interface LocalLogger extends Logger {
  entries: LoggerEntry[]
}

function makeLogger(): LocalLogger {
  const entries: LoggerEntry[] = []
  return {
    info: (msg, meta) => {
      entries.push({ level: 'info', msg, meta })
    },
    warn: (msg, meta) => {
      entries.push({ level: 'warn', msg, meta })
    },
    error: (msg, meta) => {
      entries.push({ level: 'error', msg, meta })
    },
    debug: (msg, meta) => {
      entries.push({ level: 'debug', msg, meta })
    },
    entries,
  }
}

interface Harness {
  url: string
  port: number
  route: ReturnType<typeof createExchangeRoute>
  close: () => Promise<void>
}

async function mountHandler(opts: {
  rootToken: Buffer
  projectRoot: string
  bootstrapToken?: Buffer
  now?: () => number
  boot?: { at: number }
  trustAnyExtension?: boolean
  pinnedExtensionId?: string
}): Promise<Harness> {
  const logger = makeLogger()
  const routeOpts: Parameters<typeof createExchangeRoute>[0] = {
    rootToken: opts.rootToken,
    projectRoot: opts.projectRoot,
    logger,
  }
  if (opts.bootstrapToken !== undefined) routeOpts.bootstrapToken = opts.bootstrapToken
  if (opts.now !== undefined) routeOpts.now = opts.now
  if (opts.boot !== undefined) routeOpts.boot = opts.boot
  if (opts.trustAnyExtension !== undefined) routeOpts.trustAnyExtension = opts.trustAnyExtension
  if (opts.pinnedExtensionId !== undefined) routeOpts.pinnedExtensionId = opts.pinnedExtensionId
  const route = createExchangeRoute(routeOpts)

  const server = http.createServer((req, res) => {
    const reqId = crypto.randomBytes(8).toString('hex')
    void route.handler(req, res, reqId)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    route,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function rawPost(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
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
          ...headers,
        },
      },
      (res: IncomingMessage) => {
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
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const EXT_ID_A = 'abcdefghijklmnopabcdefghijklmnop' // 32 a-p letters
const EXT_ID_B = 'pabcdefghijklmnopabcdefghijklmno' // distinct 32 a-p letters
const ORIGIN_A = `chrome-extension://${EXT_ID_A}`
const ORIGIN_B = `chrome-extension://${EXT_ID_B}`

function defaultExchangeHeaders(origin: string): Record<string, string> {
  return {
    Origin: origin,
    'Sec-Fetch-Site': 'cross-site',
  }
}

function uniqueProjectRoot(): string {
  const base = randomTempDir(`redesigner-exchange-${crypto.randomUUID()}-`)
  return base
}

function expectedSessionToken(
  rootToken: Buffer,
  clientNonce: string,
  serverNonce: string,
  iat: number,
): string {
  const iatBE = Buffer.alloc(8)
  iatBE.writeBigUInt64BE(BigInt(iat))
  const mac = crypto.createHmac('sha256', rootToken)
  mac.update(Buffer.from(clientNonce, 'utf8'))
  mac.update(Buffer.from(serverNonce, 'utf8'))
  mac.update(iatBE)
  return mac.digest('base64url').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// bootstrapToken flows as a string on the wire (JSON). We encode random bytes
// as base64url so `buf.toString('utf8')` is byte-reversible into the exact
// same Buffer on the server side (compareToken does UTF-8 byte compare).
describe('createExchangeRoute — successful exchange', () => {
  let harness: Harness
  let projectRoot: string
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')

  beforeEach(async () => {
    projectRoot = uniqueProjectRoot()
    harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })
  })

  afterEach(async () => {
    await harness.close()
    cleanupTempDirs()
  })

  it('mints sessionToken = HMAC(rootToken, clientNonce || serverNonce || iat)', async () => {
    const iatMs = 1_700_000_000_000
    const iat = Math.floor(iatMs / 1000)
    await harness.close() // discard old harness — rebuild with injected now
    harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      now: () => iatMs,
    })

    const clientNonce = crypto.randomBytes(16).toString('base64url')
    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce,
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as {
      sessionToken: string
      exp: number
      serverNonce: string
    }
    expect(body).toHaveProperty('sessionToken')
    expect(body).toHaveProperty('exp')
    expect(body).toHaveProperty('serverNonce')

    const expected = expectedSessionToken(rootToken, clientNonce, body.serverNonce, iat)
    expect(body.sessionToken).toBe(expected)
  })

  it('response exp is ≤ 300s from now (spec: TTL ≤ 300s)', async () => {
    const iatMs = 1_700_000_000_000
    await harness.close()
    harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      now: () => iatMs,
    })

    const clientNonce = crypto.randomBytes(16).toString('base64url')
    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce,
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { exp: number }
    expect(body.exp).toBeGreaterThan(iatMs)
    expect(body.exp - iatMs).toBeLessThanOrEqual(300_000)
  })

  it('serverNonce is fresh-random per mint', async () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const clientNonce = crypto.randomBytes(16).toString('base64url')
      const res = await rawPost(
        harness.port,
        '/exchange',
        defaultExchangeHeaders(ORIGIN_A),
        JSON.stringify({
          clientNonce,
          bootstrapToken: bootstrapToken.toString('utf8'),
        }),
      )
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { serverNonce: string }
      expect(nonces.has(body.serverNonce)).toBe(false)
      nonces.add(body.serverNonce)
    }
    expect(nonces.size).toBe(3)
  })

  it('sessionToken is base64url-no-pad (no = or +/ chars)', async () => {
    const clientNonce = crypto.randomBytes(16).toString('base64url')
    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce,
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    const body = JSON.parse(res.body) as { sessionToken: string }
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(body.sessionToken).not.toMatch(/[+/=]/)
  })
})

describe('createExchangeRoute — TOFU ext-ID pinning', () => {
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')

  afterEach(() => {
    cleanupTempDirs()
  })

  it('writes trusted-ext-id file on first successful exchange', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const clientNonce = crypto.randomBytes(16).toString('base64url')
    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce,
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(200)

    const trustedPath = resolveTrustedExtIdPath(projectRoot)
    expect(fs.existsSync(trustedPath)).toBe(true)
    const contents = fs.readFileSync(trustedPath, 'utf8').trim()
    expect(contents).toBe(EXT_ID_A)
    // Verify 0o600 on POSIX
    if (process.platform !== 'win32') {
      const st = fs.lstatSync(trustedPath)
      expect(st.mode & 0o777).toBe(0o600)
    }

    expect(harness.route.getTrustedExtId()).toBe(EXT_ID_A)
    await harness.close()
  })

  it('rejects second exchange from a different ext-ID with 403 + apiErrorCode unknown-extension', async () => {
    const projectRoot = uniqueProjectRoot()
    // Configure boot window in the past so auto-reset cannot apply.
    const harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      boot: { at: Date.now() - 60_000 },
    })

    // First exchange — pins to EXT_ID_A.
    const res1 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res1.status).toBe(200)
    expect(harness.route.getTrustedExtId()).toBe(EXT_ID_A)

    // Second exchange from a different extension origin — must be rejected.
    const res2 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_B),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res2.status).toBe(403)
    const body = JSON.parse(res2.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('unknown-extension')

    await harness.close()
  })

  it('auto-reset: pinned ext-ID replaced when boot recent + single origin in 10s window', async () => {
    const projectRoot = uniqueProjectRoot()
    // First exchange pins EXT_ID_A; second exchange from EXT_ID_B within the boot
    // window with only one prior origin triggers auto-reset (existing-pin case).
    const bootAt = Date.now()
    const harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      boot: { at: bootAt },
      now: () => bootAt + 1000, // within 10s window
    })

    // First exchange from EXT_ID_A — pins the ext-ID.
    const res1 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res1.status).toBe(200)
    expect(harness.route.getTrustedExtId()).toBe(EXT_ID_A)

    // Auto-reset: second request still within 10s window — pin clears and re-pins to EXT_ID_B.
    const res2 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_B),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res2.status).toBe(200)
    expect(harness.route.getTrustedExtId()).toBe(EXT_ID_B)

    await harness.close()
  })

  it('pinnedExtensionId CLI override: mismatched ext-ID rejected even when no trust file exists', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      pinnedExtensionId: EXT_ID_A,
    })

    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_B),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(403)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.apiErrorCode).toBe('unknown-extension')
    await harness.close()
  })

  it('trustAnyExtension=true: bypasses TOFU entirely', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({
      rootToken,
      projectRoot,
      bootstrapToken,
      trustAnyExtension: true,
      boot: { at: Date.now() - 60_000 },
    })

    // First from A — accepted.
    const r1 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(r1.status).toBe(200)

    // Second from B — also accepted (TOFU off).
    const r2 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_B),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(r2.status).toBe(200)
    await harness.close()
  })
})

describe('createExchangeRoute — session rotation', () => {
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')

  afterEach(() => {
    cleanupTempDirs()
  })

  it('new exchange from same extId invalidates the prior session', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res1 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res1.status).toBe(200)
    const body1 = JSON.parse(res1.body) as { sessionToken: string }
    expect(harness.route.isSessionActive(EXT_ID_A, body1.sessionToken)).toBe(true)

    const res2 = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res2.status).toBe(200)
    const body2 = JSON.parse(res2.body) as { sessionToken: string }

    // Tokens differ (fresh serverNonce → fresh HMAC).
    expect(body2.sessionToken).not.toBe(body1.sessionToken)
    // Prior session no longer active; new one is.
    expect(harness.route.isSessionActive(EXT_ID_A, body1.sessionToken)).toBe(false)
    expect(harness.route.isSessionActive(EXT_ID_A, body2.sessionToken)).toBe(true)

    await harness.close()
  })
})

describe('createExchangeRoute — gates & validation', () => {
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')

  afterEach(() => {
    cleanupTempDirs()
  })

  it('rejects wrong bootstrapToken', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: 'definitely-wrong-token',
      }),
    )
    expect(res.status).toBe(401)
    await harness.close()
  })

  it('rejects Sec-Fetch-Site: same-origin', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'same-origin' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(403)
    await harness.close()
  })

  it('accepts Sec-Fetch-Site: none (direct nav)', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      { Origin: ORIGIN_A, 'Sec-Fetch-Site': 'none' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(200)
    await harness.close()
  })

  it('rejects non-chrome-extension Origin', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(403)
    await harness.close()
  })

  it('rejects chrome-extension Origin with malformed ext-ID (not 32 lowercase)', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      { Origin: 'chrome-extension://UPPERCASE123', 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(403)
    await harness.close()
  })

  it('rejects missing Origin', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      { 'Sec-Fetch-Site': 'cross-site' },
      JSON.stringify({
        clientNonce: crypto.randomBytes(16).toString('base64url'),
        bootstrapToken: bootstrapToken.toString('utf8'),
      }),
    )
    expect(res.status).toBe(403)
    await harness.close()
  })

  it('rejects invalid JSON with 400', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      'not-json',
    )
    expect(res.status).toBe(400)
    await harness.close()
  })

  it('rejects schema-invalid body with 400', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const res = await rawPost(
      harness.port,
      '/exchange',
      defaultExchangeHeaders(ORIGIN_A),
      JSON.stringify({ clientNonce: 'short', bootstrapToken: '' }),
    )
    expect(res.status).toBe(400)
    await harness.close()
  })

  it('one-shot clientNonce: replay returns 401', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    const clientNonce = crypto.randomBytes(16).toString('base64url')
    const body = JSON.stringify({
      clientNonce,
      bootstrapToken: bootstrapToken.toString('utf8'),
    })

    const r1 = await rawPost(harness.port, '/exchange', defaultExchangeHeaders(ORIGIN_A), body)
    expect(r1.status).toBe(200)

    const r2 = await rawPost(harness.port, '/exchange', defaultExchangeHeaders(ORIGIN_A), body)
    expect(r2.status).toBe(401)
    await harness.close()
  })
})

describe('createExchangeRoute — per-(Origin, peerAddr) failed-exchange rate-limit', () => {
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const bootstrapToken = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')

  afterEach(() => {
    cleanupTempDirs()
  })

  it('too many failed exchanges from the same (Origin, peerAddr) → 429', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    // Wrong bootstrap token — each one is a failed attempt.
    // Bucket is burst=5, ratePerSec=1 → 6th attempt in the same second is 429.
    let saw429 = false
    for (let i = 0; i < 12; i++) {
      const res = await rawPost(
        harness.port,
        '/exchange',
        defaultExchangeHeaders(ORIGIN_A),
        JSON.stringify({
          clientNonce: crypto.randomBytes(16).toString('base64url'),
          bootstrapToken: 'wrong-token',
        }),
      )
      if (res.status === 429) {
        saw429 = true
        expect(res.headers['retry-after']).toBeDefined()
        break
      }
    }
    expect(saw429).toBe(true)

    await harness.close()
  })

  it('successful exchanges do NOT count against the failed-exchange bucket', async () => {
    const projectRoot = uniqueProjectRoot()
    const harness = await mountHandler({ rootToken, projectRoot, bootstrapToken })

    // 20 successful exchanges must all succeed with 200.
    for (let i = 0; i < 20; i++) {
      const res = await rawPost(
        harness.port,
        '/exchange',
        defaultExchangeHeaders(ORIGIN_A),
        JSON.stringify({
          clientNonce: crypto.randomBytes(16).toString('base64url'),
          bootstrapToken: bootstrapToken.toString('utf8'),
        }),
      )
      expect(res.status).toBe(200)
    }
    await harness.close()
  })
})

describe('resolveTrustedExtIdPath', () => {
  afterEach(() => {
    cleanupTempDirs()
  })

  it('returns a path ending with trusted-ext-id', () => {
    const projectRoot = uniqueProjectRoot()
    const p = resolveTrustedExtIdPath(projectRoot)
    expect(p).toMatch(/trusted-ext-id$/)
  })

  it('same projectRoot → same path', () => {
    const projectRoot = uniqueProjectRoot()
    const p1 = resolveTrustedExtIdPath(projectRoot)
    const p2 = resolveTrustedExtIdPath(projectRoot)
    expect(p1).toBe(p2)
  })

  it('shares parent directory with handoff path (same projectHash)', async () => {
    const projectRoot = uniqueProjectRoot()
    const { resolveHandoffPath } = await import('../src/handoff.js')
    const trusted = resolveTrustedExtIdPath(projectRoot)
    const handoff = resolveHandoffPath(projectRoot)
    expect(path.dirname(trusted)).toBe(path.dirname(handoff))
  })
})
