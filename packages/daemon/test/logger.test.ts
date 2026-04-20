import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.js'

describe('logger redaction', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-'))
  })

  function readLines(file: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('redacts key named token', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('startup', { token: 'secret-abcdefghij', pid: 42 })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.token).toBe('[REDACTED]')
    expect(line?.pid).toBe(42)
  })

  it('redacts key named authorization', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('req', { authorization: 'Bearer supersecret' })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.authorization).toBe('[REDACTED]')
  })

  it('redacts key named sec-websocket-protocol', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('ws', {
      'sec-websocket-protocol': 'base64url.bearer.authorization.redesigner.dev.abc123',
    })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.['sec-websocket-protocol']).toBe('[REDACTED]')
  })

  it('redacts key ending in -token (x-session-token)', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('auth', { 'x-session-token': 'sess-secret-value' })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.['x-session-token']).toBe('[REDACTED]')
  })

  it('redacts camelCase key ending in Token (sessionToken)', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('auth', { sessionToken: 'camel-secret-value' })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.sessionToken).toBe('[REDACTED]')
  })

  it('redacts x-csrf-token key', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('req', { 'x-csrf-token': 'csrf-value-here' })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.['x-csrf-token']).toBe('[REDACTED]')
  })

  it('does not redact non-sensitive keys', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('info', { url: 'http://example.com', pid: 99, env: 'prod' })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.url).toBe('http://example.com')
    expect(line?.pid).toBe(99)
    expect(line?.env).toBe('prod')
  })

  it('redacts subprotocol bearer string appearing as a value', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    const bearer = 'base64url.bearer.authorization.redesigner.dev.someTokenValue123'
    logger.info('ws', { header: bearer })
    const raw = fs.readFileSync(path.join(dir, 'd.log'), 'utf8')
    expect(raw).not.toContain('someTokenValue123')
    expect(raw).toContain('[REDACTED_SUBPROTO]')
  })

  it('redacts subprotocol bearer embedded in a larger string value', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('ws', {
      raw: 'redesigner-v1, base64url.bearer.authorization.redesigner.dev.abc_XYZ-123',
    })
    const raw = fs.readFileSync(path.join(dir, 'd.log'), 'utf8')
    expect(raw).not.toContain('abc_XYZ-123')
    expect(raw).toContain('[REDACTED_SUBPROTO]')
    // Non-secret part should remain
    expect(raw).toContain('redesigner-v1')
  })

  it('redacts recursively through nested objects', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('nested', {
      outer: 'ok',
      inner: {
        token: 'deep-secret',
        sessionToken: 'another-secret',
        safe: 'visible',
      },
    })
    const [line] = readLines(path.join(dir, 'd.log'))
    const inner = line?.inner as Record<string, unknown>
    expect(inner.token).toBe('[REDACTED]')
    expect(inner.sessionToken).toBe('[REDACTED]')
    expect(inner.safe).toBe('visible')
    expect(line?.outer).toBe('ok')
  })

  it('redacts array elements containing subproto bearer strings', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('arr', {
      protocols: ['redesigner-v1', 'base64url.bearer.authorization.redesigner.dev.tokenXYZ'],
    })
    const [line] = readLines(path.join(dir, 'd.log'))
    const protocols = line?.protocols as string[]
    expect(protocols[0]).toBe('redesigner-v1')
    expect(protocols[1]).toContain('[REDACTED_SUBPROTO]')
    expect(protocols[1]).not.toContain('tokenXYZ')
  })

  it('redacts array of token values at a token key', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('arr', { authorization: ['Bearer foo', 'Bearer bar'] })
    const [line] = readLines(path.join(dir, 'd.log'))
    expect(line?.authorization).toBe('[REDACTED]')
  })

  it('redacts through deeply nested arrays of objects', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('deep', {
      items: [
        { name: 'a', token: 'secret1' },
        { name: 'b', safe: 'ok' },
      ],
    })
    const [line] = readLines(path.join(dir, 'd.log'))
    const items = line?.items as Array<Record<string, unknown>>
    expect(items[0]?.token).toBe('[REDACTED]')
    expect(items[0]?.name).toBe('a')
    expect(items[1]?.safe).toBe('ok')
  })

  it('also redacts writes to rotated log file', () => {
    // Small maxBytes to force rotation mid-stream
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 200 })
    // Write enough data to trigger rotation
    for (let i = 0; i < 5; i++) {
      logger.info('pad', { x: 'y'.repeat(50) })
    }
    // Now write a sensitive record that may land in the rotated file
    logger.info('secret', { authorization: 'Bearer topsecret' })
    // Check both files
    const files = [path.join(dir, 'd.log'), path.join(dir, 'd.log.1')].filter((f) =>
      fs.existsSync(f),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8')
      expect(content).not.toContain('topsecret')
    }
  })
})
