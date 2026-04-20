import crypto from 'node:crypto'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNAUTHORIZED_HEADERS, compareToken } from '../../src/auth.js'
import { createLogger } from '../../src/logger.js'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ─── compareToken unit tests ────────────────────────────────────────────────

describe('compareToken — length mismatch handling', () => {
  const expected = Buffer.from('a'.repeat(32), 'utf8')

  it('does not throw RangeError on short input', () => {
    expect(() => compareToken('short', expected)).not.toThrow()
    expect(compareToken('short', expected)).toBe(false)
  })

  it('does not throw RangeError on long input', () => {
    const long = 'z'.repeat(1000)
    expect(() => compareToken(long, expected)).not.toThrow()
    expect(compareToken(long, expected)).toBe(false)
  })

  it('does not throw on empty string', () => {
    expect(() => compareToken('', expected)).not.toThrow()
    expect(compareToken('', expected)).toBe(false)
  })

  it('returns true for exact match', () => {
    expect(compareToken('a'.repeat(32), expected)).toBe(true)
  })
})

describe('compareToken — non-string / undefined inputs', () => {
  const expected = Buffer.from('abc', 'utf8')

  it('returns false for undefined provided', () => {
    expect(compareToken(undefined, expected)).toBe(false)
  })

  it('returns false for number input', () => {
    expect(compareToken(123 as unknown, expected)).toBe(false)
  })

  it('returns false when expected is provided as unknown type (number)', () => {
    // ensure no throw even with unusual types
    expect(compareToken(123 as unknown, Buffer.from('abc'))).toBe(false)
  })

  it('returns false for object input', () => {
    expect(compareToken({} as unknown, expected)).toBe(false)
  })

  it('returns false for null input', () => {
    expect(compareToken(null as unknown, expected)).toBe(false)
  })

  it('returns false for array input', () => {
    expect(compareToken([] as unknown, expected)).toBe(false)
  })

  it('returns false for boolean input', () => {
    expect(compareToken(true as unknown, expected)).toBe(false)
  })
})

// ─── UNAUTHORIZED_HEADERS constant ──────────────────────────────────────────

describe('UNAUTHORIZED_HEADERS', () => {
  it('contains WWW-Authenticate: Bearer realm="redesigner"', () => {
    expect(UNAUTHORIZED_HEADERS['WWW-Authenticate']).toBe('Bearer realm="redesigner"')
  })
})

// ─── Server-level 401 tests ──────────────────────────────────────────────────

function makeCtx(overrides?: Partial<RouteContext>): RouteContext {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
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
    shutdown: () => Promise.resolve(),
    ...overrides,
  }
}

async function listenOnEphemeral(
  token: Buffer,
  ctxOverrides?: Partial<RouteContext>,
): Promise<{
  url: string
  port: number
  close: () => Promise<void>
}> {
  const bootstrapToken = Buffer.from(crypto.randomBytes(32))
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const probe = createDaemonServer({
    port: 0,
    token,
    bootstrapToken,
    rootToken,
    ctx: makeCtx(ctxOverrides),
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({
    port: assigned,
    token,
    bootstrapToken,
    rootToken,
    ctx: makeCtx(ctxOverrides),
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    port: assigned,
    close: () => real.close(),
  }
}

describe('401 response body — no length oracle across malformed auth inputs', () => {
  // "No length oracle" means all bad-auth variants produce bodies of the same byte length
  // so an attacker cannot distinguish (missing / short / long / wrong scheme) from body size.
  // Each body contains a unique reqId in the `instance` field, so raw bytes differ;
  // we compare structure (same keys, same non-instance field values) and byte length.
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  interface Auth401Body {
    status: number
    code: string
    title: string
    type: string
    instance: string
    detail?: string
  }

  async function get401(
    extraHeaders: Record<string, string> = {},
  ): Promise<{ body: Auth401Body; bytes: Uint8Array }> {
    const res = await fetch(`${handle.url}/health`, {
      headers: {
        ...extraHeaders,
      },
    })
    expect(res.status).toBe(401)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { body: JSON.parse(Buffer.from(bytes).toString('utf8')) as Auth401Body, bytes }
  }

  it('missing Authorization and Bearer short have same byte length (no length oracle)', async () => {
    const a = await get401()
    const b = await get401({ Authorization: 'Bearer short' })
    expect(b.bytes.length).toBe(a.bytes.length)
  })

  it('missing Authorization and Bearer very long have same byte length (no length oracle)', async () => {
    const a = await get401()
    const b = await get401({ Authorization: `Bearer ${'z'.repeat(200)}` })
    expect(b.bytes.length).toBe(a.bytes.length)
  })

  it('missing Authorization and malformed scheme have same byte length (no length oracle)', async () => {
    const a = await get401()
    const b = await get401({ Authorization: 'Basic foo' })
    expect(b.bytes.length).toBe(a.bytes.length)
  })

  it('all four variants produce same-length bodies', async () => {
    const a = await get401()
    const b = await get401({ Authorization: 'Bearer short' })
    const c = await get401({ Authorization: `Bearer ${'x'.repeat(200)}` })
    const d = await get401({ Authorization: 'Basic foo' })
    expect(b.bytes.length).toBe(a.bytes.length)
    expect(c.bytes.length).toBe(a.bytes.length)
    expect(d.bytes.length).toBe(a.bytes.length)
  })

  it('all four variants omit "detail" field (no info leak)', async () => {
    const a = await get401()
    const b = await get401({ Authorization: 'Bearer short' })
    const c = await get401({ Authorization: `Bearer ${'x'.repeat(200)}` })
    const d = await get401({ Authorization: 'Basic foo' })
    for (const { body } of [a, b, c, d]) {
      expect(body.detail).toBeUndefined()
    }
  })

  it('all four variants have status=401 and code=Unauthorized', async () => {
    const a = await get401()
    const b = await get401({ Authorization: 'Bearer short' })
    const c = await get401({ Authorization: `Bearer ${'x'.repeat(200)}` })
    const d = await get401({ Authorization: 'Basic foo' })
    for (const { body } of [a, b, c, d]) {
      expect(body.status).toBe(401)
      expect(body.code).toBe('Unauthorized')
    }
  })
})

describe('WWW-Authenticate header on 401', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('missing auth includes WWW-Authenticate: Bearer realm="redesigner"', async () => {
    const res = await fetch(`${handle.url}/health`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="redesigner"')
  })

  it('wrong bearer includes WWW-Authenticate', async () => {
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: 'Bearer wrongtoken' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="redesigner"')
  })

  it('malformed scheme includes WWW-Authenticate', async () => {
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: 'Basic foo' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="redesigner"')
  })
})

// ─── Logger token redaction ──────────────────────────────────────────────────

describe('logger token redaction', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-auth-'))
    logFile = path.join(dir, 'test.log')
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  function readLog(): unknown[] {
    return fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it('redacts token at depth 1', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { token: 'secret-value-123' })
    const entry = (readLog() as Array<Record<string, unknown>>)[0]
    expect(entry).toBeDefined()
    expect(entry?.token).toBe('[REDACTED]')
  })

  it('does not leak token value in any field at depth 1', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { token: 'supersecret123' })
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('supersecret123')
  })

  it('redacts token nested at depth 2', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { inner: { token: 'nested-secret' } })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('nested-secret')
    expect(raw).toContain('[REDACTED]')
  })

  it('redacts token nested at depth 3', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { a: { b: { token: 'deep-secret-xyz' } } })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('deep-secret-xyz')
    expect(raw).toContain('[REDACTED]')
  })

  it('preserves non-token fields at depth 1', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { token: 'secret', pid: 42, name: 'test' })
    const entry = (readLog() as Array<Record<string, unknown>>)[0]
    expect(entry).toBeDefined()
    expect(entry?.token).toBe('[REDACTED]')
    expect(entry?.pid).toBe(42)
    expect(entry?.name).toBe('test')
  })

  it('preserves non-token nested object fields', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { config: { host: 'localhost', token: 'tok123' } })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('tok123')
    expect(raw).toContain('localhost')
  })

  it('does NOT redact array elements (only top-level key check)', () => {
    // The logger redact function only checks key names, not array values.
    // Arrays are passed through as-is. This documents the current behavior.
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { items: ['value1', 'value2'] })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).toContain('value1')
  })

  it('redacts token regardless of other keys present', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', {
      requestId: 'req-123',
      token: 'my-bearer-token',
      userId: 'user-456',
      method: 'GET',
    })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('my-bearer-token')
    expect(raw).toContain('req-123')
    expect(raw).toContain('user-456')
    expect(raw).toContain('GET')
  })

  it('handles undefined meta gracefully', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    expect(() => logger.info('msg with no meta')).not.toThrow()
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).toContain('msg with no meta')
  })

  it('redacts deeply nested token in multi-level object', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', {
      request: {
        headers: {
          token: 'bearer-xyz-789',
        },
      },
    })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('bearer-xyz-789')
    expect(raw).toContain('[REDACTED]')
  })

  it('redacts token in warn level', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.warn('warning', { token: 'warn-secret-val' })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('warn-secret-val')
    expect(raw).toContain('[REDACTED]')
  })

  it('redacts token in error level', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.error('error', { token: 'error-secret-val' })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('error-secret-val')
    expect(raw).toContain('[REDACTED]')
  })

  it('redacts token in debug level', () => {
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.debug?.('debug', { token: 'debug-secret-val' })
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).not.toContain('debug-secret-val')
    expect(raw).toContain('[REDACTED]')
  })

  it('does not redact non-token key named "authorization" (not in redact list)', () => {
    // The logger only redacts the literal key 'token', not 'authorization'.
    // This documents current behavior: 'authorization' is NOT redacted by the logger.
    const logger = createLogger({ file: logFile, maxBytes: 1_000_000 })
    logger.info('msg', { authorization: 'bearer-token-value' })
    // 'authorization' is passed through as-is (current implementation)
    const raw = fs.readFileSync(logFile, 'utf8')
    expect(raw).toContain('authorization')
  })
})
