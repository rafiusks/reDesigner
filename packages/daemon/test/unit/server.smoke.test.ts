import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

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
  // ManifestWatcher is never start()'d; its getCached() returns null which is all these tests need.
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
    instanceId: 'test-instance-id',
    startedAt: Date.now() - 1000,
    projectRoot: '/tmp/test-project',
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function listenOnEphemeral(token: Buffer): Promise<{
  url: string
  port: number
  close: () => Promise<void>
}> {
  const bootstrapToken = Buffer.from(crypto.randomBytes(32))
  const rootToken = Buffer.from(crypto.randomBytes(32))
  // Two-phase listen: create server bound to port 0, then re-create at the discovered port
  // so the Host check (which requires exact 127.0.0.1:<port>) is self-consistent.
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
    port: assigned,
    close: () => real.close(),
  }
}

describe('createDaemonServer smoke', () => {
  // Mint random 32 raw bytes, encode as base64url for use as the Bearer string, then feed
  // the UTF-8 bytes of that string to the daemon — compareToken() does a UTF-8 byte compare
  // of the wire-provided bearer against its expected Buffer.
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns 401 with WWW-Authenticate header when Authorization is missing', async () => {
    const res = await fetch(`${handle.url}/health`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="redesigner"')
    expect(res.headers.get('server')).toBe('@redesigner/daemon/0.0.1')
  })

  it('returns 200 { ok: true } when Authorization is valid (spec §3.2)', async () => {
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true })
    expect(res.headers.get('server')).toBe('@redesigner/daemon/0.0.1')
  })

  it('returns 421 HostRejected when Host header is an attacker domain', async () => {
    // Use raw http so we can set Host freely.
    const body = await rawGet(handle.port, '/health', { Host: 'attacker.com' })
    expect(body.status).toBe(421)
    const parsed = JSON.parse(body.body)
    expect(parsed.code).toBe('HostRejected')
    expect(body.headers.server).toBe('@redesigner/daemon/0.0.1')
  })

  it('returns 421 HostRejected for DNS-rebind suffix trap (localhost.attacker.com)', async () => {
    const body = await rawGet(handle.port, '/health', {
      Host: `localhost.attacker.com:${handle.port}`,
    })
    expect(body.status).toBe(421)
    const parsed = JSON.parse(body.body)
    expect(parsed.code).toBe('HostRejected')
  })
})

// Minimal raw HTTP client that lets us override the Host header (fetch won't).
async function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
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
    req.end()
  })
}
