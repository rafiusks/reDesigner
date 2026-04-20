import crypto from 'node:crypto'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServer } from '../../src/server.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    instanceId: 'instance-A',
    startedAt: Date.now() - 1000,
    projectRoot: '/tmp/test-project',
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

type ServerHandle = {
  url: string
  port: number
  bearer: string
  token: Buffer
  ctx: RouteContext
  server: http.Server
  close: () => Promise<void>
}

async function listenOnEphemeral(ctxOverrides?: Partial<RouteContext>): Promise<ServerHandle> {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  const ctx = makeCtx(ctxOverrides)

  const bootstrapToken = Buffer.from(crypto.randomBytes(32))
  const rootToken = Buffer.from(crypto.randomBytes(32))
  // Two-phase: discover port then re-bind so Host check is self-consistent.
  const probe = createDaemonServer({ port: 0, token, bootstrapToken, rootToken, ctx })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({ port: assigned, token, bootstrapToken, rootToken, ctx })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    port: assigned,
    bearer,
    token,
    ctx,
    server: real.server,
    close: () => real.close(),
  }
}

async function postShutdown(
  handle: ServerHandle,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${handle.url}/shutdown`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${handle.bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, body: json }
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('POST /shutdown — instanceId mismatch → 404', () => {
  let handle: ServerHandle

  beforeEach(async () => {
    handle = await listenOnEphemeral({ instanceId: 'instance-A' })
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns 404 with code InstanceMismatch when instanceId does not match', async () => {
    const { status, body } = await postShutdown(handle, { instanceId: 'instance-B' })
    expect(status).toBe(404)
    const b = body as Record<string, unknown>
    expect(b.code).toBe('InstanceMismatch')
    expect(b.status).toBe(404)
  })

  it('server is still alive after instanceId mismatch', async () => {
    await postShutdown(handle, { instanceId: 'wrong-id' })
    // Server still responds to health check
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: `Bearer ${handle.bearer}` },
    })
    expect(res.status).toBe(200)
  })

  it('shutdown() callback is NOT called on mismatch', async () => {
    await postShutdown(handle, { instanceId: 'instance-B' })
    expect(handle.ctx.shutdown).not.toHaveBeenCalled()
  })
})

describe('POST /shutdown — correct instanceId → 200 + graceful close', () => {
  it('returns 200 with drainDeadlineMs in body', async () => {
    const handle = await listenOnEphemeral({ instanceId: 'instance-A' })
    try {
      const { status, body } = await postShutdown(handle, { instanceId: 'instance-A' })
      expect(status).toBe(200)
      const b = body as Record<string, unknown>
      expect(typeof b.drainDeadlineMs).toBe('number')
      expect(b.drainDeadlineMs).toBeGreaterThan(0)
    } finally {
      await handle.close()
    }
  })

  it('calls shutdown() callback after responding', async () => {
    const shutdownFn = vi.fn().mockResolvedValue(undefined)
    const handle = await listenOnEphemeral({ instanceId: 'instance-A', shutdown: shutdownFn })
    try {
      await postShutdown(handle, { instanceId: 'instance-A' })
      // Fire-and-forget; give microtasks a tick to run
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      expect(shutdownFn).toHaveBeenCalled()
    } finally {
      await handle.close()
    }
  })

  it('server closes after real shutdown (server.close injected via shutdown hook)', async () => {
    // Use real server close as the shutdown hook so we can verify server stops.
    let serverRef: http.Server | null = null

    const handle = await listenOnEphemeral({
      instanceId: 'instance-A',
      shutdown: () =>
        new Promise<void>((resolve) => {
          serverRef?.close(() => resolve())
        }),
    })
    serverRef = handle.server

    const { status } = await postShutdown(handle, { instanceId: 'instance-A' })
    expect(status).toBe(200)

    // Wait for server to close
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    expect(handle.server.listening).toBe(false)
    // No explicit close() needed since shutdown() called server.close()
  })
})

describe('POST /shutdown — missing or invalid body → 400', () => {
  let handle: ServerHandle

  beforeEach(async () => {
    handle = await listenOnEphemeral({ instanceId: 'instance-A' })
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns 400 when body is empty object (no instanceId)', async () => {
    const { status, body } = await postShutdown(handle, {})
    expect(status).toBe(400)
    const b = body as Record<string, unknown>
    expect(b.code).toBe('InvalidRequest')
  })

  it('returns 400 when instanceId is a number not a string', async () => {
    const { status, body } = await postShutdown(handle, { instanceId: 42 })
    expect(status).toBe(400)
    const b = body as Record<string, unknown>
    expect(b.code).toBe('InvalidRequest')
  })

  it('returns 400 when body is null', async () => {
    const res = await fetch(`${handle.url}/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
      },
      body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when body is not JSON', async () => {
    const res = await fetch(`${handle.url}/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    const b = (await res.json()) as Record<string, unknown>
    expect(b.code).toBe('InvalidJSON')
  })

  it('returns 400 when instanceId is missing from body', async () => {
    const { status } = await postShutdown(handle, { other: 'field' })
    expect(status).toBe(400)
  })

  it('shutdown() is NOT called on invalid body', async () => {
    await postShutdown(handle, {})
    expect(handle.ctx.shutdown).not.toHaveBeenCalled()
  })
})

describe('POST /shutdown — unauthenticated → 401', () => {
  let handle: ServerHandle

  beforeEach(async () => {
    handle = await listenOnEphemeral({ instanceId: 'instance-A' })
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns 401 without auth', async () => {
    const res = await fetch(`${handle.url}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: 'instance-A' }),
    })
    expect(res.status).toBe(401)
  })

  it('shutdown() NOT called on 401', async () => {
    await fetch(`${handle.url}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: 'instance-A' }),
    })
    expect(handle.ctx.shutdown).not.toHaveBeenCalled()
  })
})
