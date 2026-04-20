import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleHealthGet } from '../../src/routes/health.js'
import { handleSelectionGet } from '../../src/routes/selection.js'
import { handleShutdownPost } from '../../src/routes/shutdown.js'
import { EventBus } from '../../src/state/eventBus.js'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { SelectionState } from '../../src/state/selectionState.js'
import type { RouteContext } from '../../src/types.js'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

// Minimal mock IncomingMessage and ServerResponse for in-process testing.
function mockReq(opts: {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const ee = new EventEmitter() as unknown as IncomingMessage
  ;(ee as unknown as Record<string, unknown>).url = opts.url ?? '/'
  ;(ee as unknown as Record<string, unknown>).method = opts.method ?? 'GET'
  ;(ee as unknown as Record<string, unknown>).headers = opts.headers ?? {}
  // Schedule body emission in the next tick so handlers can attach listeners first
  if (opts.body !== undefined) {
    const body = opts.body
    setImmediate(() => {
      ee.emit('data', Buffer.from(body, 'utf8'))
      ee.emit('end')
    })
  } else {
    setImmediate(() => {
      ee.emit('end')
    })
  }
  return ee
}

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(data?: string): void
}

function mockRes(): MockRes & ServerResponse {
  const r: MockRes = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      r.headers[name.toLowerCase()] = value
    },
    end(data?: string) {
      if (data !== undefined) r.body = data
    },
  }
  return r as unknown as MockRes & ServerResponse
}

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

describe('GET /selection (empty state)', () => {
  it('returns 200 {current: null}', () => {
    const req = mockReq({ url: '/selection', method: 'GET' })
    const res = mockRes()
    const ctx = makeCtx()
    handleSelectionGet(req, res, ctx)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ current: null })
  })
})

describe('GET /health', () => {
  it('returns 200 { ok: true } per spec §3.2', () => {
    const req = mockReq({ url: '/health', method: 'GET' })
    const res = mockRes()
    const ctx = makeCtx()
    handleHealthGet(req, res, ctx)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ ok: true })
  })
})

describe('POST /shutdown', () => {
  it('returns 404 InstanceMismatch when instanceId does not match', async () => {
    const req = mockReq({
      url: '/shutdown',
      method: 'POST',
      body: JSON.stringify({ instanceId: 'wrong-id' }),
    })
    const res = mockRes()
    const ctx = makeCtx()
    await handleShutdownPost(req, res, ctx)
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('InstanceMismatch')
  })

  it('returns 200 {drainDeadlineMs: 100} with correct instanceId and calls shutdown', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx({ shutdown })
    const req = mockReq({
      url: '/shutdown',
      method: 'POST',
      body: JSON.stringify({ instanceId: ctx.instanceId }),
    })
    const res = mockRes()
    await handleShutdownPost(req, res, ctx)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ drainDeadlineMs: 100 })
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
