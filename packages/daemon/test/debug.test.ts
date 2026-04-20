/**
 * Tests for /debug/state endpoint and /health spec compliance.
 *
 * The /debug/state endpoint is only registered when REDESIGNER_DEBUG=1.
 * We test it by creating servers with the env var set vs unset.
 */
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServer } from '../src/server.js'
import { EventBus } from '../src/state/eventBus.js'
import { ManifestWatcher } from '../src/state/manifestWatcher.js'
import { SelectionState } from '../src/state/selectionState.js'
import type { RouteContext } from '../src/types.js'
import { RpcCorrelation } from '../src/ws/rpcCorrelation.js'

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
    instanceId: 'test-instance-id',
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
    ctx: ctx ?? makeCtx(),
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({
    port: assigned,
    token,
    bootstrapToken,
    rootToken,
    ctx: ctx ?? makeCtx(),
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${assigned}`,
    port: assigned,
    close: () => real.close(),
  }
}

describe('GET /health', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
  })

  it('returns { ok: true } per spec §3.2 when authenticated with root token', async () => {
    const res = await fetch(`${handle.url}/health`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Spec §3.2: /health returns { ok: true }
    // DEFERRED DECISION: session-token-only gating deferred to a follow-up task.
    // Root-token auth currently accepted for /health; see task 12 implementation notes.
    expect(body.ok).toBe(true)
  })

  it('returns 401 when no token provided', async () => {
    const res = await fetch(`${handle.url}/health`)
    expect(res.status).toBe(401)
  })
})

describe('GET /__redesigner/debug/state — env gate off (default)', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    // Ensure debug env is NOT set for these tests
    // biome-ignore lint/performance/noDelete: env var removal requires delete; undefined assignment leaves key present
    delete process.env.REDESIGNER_DEBUG
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
    // biome-ignore lint/performance/noDelete: env var removal requires delete; undefined assignment leaves key present
    delete process.env.REDESIGNER_DEBUG
  })

  it('returns 404 when REDESIGNER_DEBUG is not set', async () => {
    const res = await fetch(`${handle.url}/__redesigner/debug/state`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /__redesigner/debug/state — env gate on', () => {
  const bearer = crypto.randomBytes(32).toString('base64url')
  const token = Buffer.from(bearer, 'utf8')
  let handle: Awaited<ReturnType<typeof listenOnEphemeral>>

  beforeEach(async () => {
    process.env.REDESIGNER_DEBUG = '1'
    handle = await listenOnEphemeral(token)
  })
  afterEach(async () => {
    await handle.close()
    // biome-ignore lint/performance/noDelete: env var removal requires delete; undefined assignment leaves key present
    delete process.env.REDESIGNER_DEBUG
  })

  it('returns 200 with debug state shape when REDESIGNER_DEBUG=1', async () => {
    const res = await fetch(`${handle.url}/__redesigner/debug/state`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Shape: selectionState, sessions, manifestCache
    expect(body).toHaveProperty('selectionState')
    expect(body).toHaveProperty('sessions')
    expect(body).toHaveProperty('manifestCache')
  })

  it('returns 401 when no token provided even with debug on', async () => {
    const res = await fetch(`${handle.url}/__redesigner/debug/state`)
    expect(res.status).toBe(401)
  })

  it('selectionState.current is null when no selection set', async () => {
    const res = await fetch(`${handle.url}/__redesigner/debug/state`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const body = (await res.json()) as { selectionState: { current: unknown } }
    expect(body.selectionState.current).toBeNull()
  })
})
