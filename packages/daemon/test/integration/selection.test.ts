/**
 * Integration tests for PUT /tabs/:tabId/selection.
 *
 * Spins up a real createDaemonServer on an ephemeral port and issues real HTTP
 * requests. No mocks on the network layer. Every fetch call carries
 * AbortSignal.timeout(3000) per CLAUDE.md invariant.
 *
 * Test cases:
 *   1. Accepts body WITH clientId, returns {selectionSeq, acceptedAt}
 *   2. Accepts body WITHOUT clientId (optional field)
 *   3. Rejects body with foreign top-level field (.strict enforced → 400)
 *   4. Rejects body with invalid clientId (not UUIDv4 → 400)
 *   5. Rejects PUT without auth → 401 with AuthError body (token-unknown)
 */

import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
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

const FETCH_TIMEOUT_MS = 3000

// A valid ComponentHandle that satisfies ComponentHandleSchema.
// staleManifest check in selection.ts does not reject the PUT — it only
// annotates provenance — so any valid handle works for response-shape tests.
const validHandle = {
  id: 'test-node-abc123',
  componentName: 'TestButton',
  filePath: 'src/components/TestButton.tsx',
  lineRange: [1, 20] as [number, number],
  domPath: 'html>body>div>button',
  parentChain: ['App', 'Section'],
  timestamp: Date.now(),
}

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
    '/tmp/test-selection-manifest.json',
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
  authTokenStr: string
  close: () => Promise<void>
}

async function spawnServer(): Promise<TestHarness> {
  const authTokenStr = crypto.randomBytes(32).toString('base64url')
  const authTokenBuf = Buffer.from(authTokenStr, 'utf8')
  const bootstrapTokenBuf = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')
  const rootToken = Buffer.from(crypto.randomBytes(32))
  const projectRoot = randomTempDir('redesigner-selection-it-')

  // Probe for an ephemeral port, then reuse it for the real server.
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
    authTokenStr,
    close: () => real.close(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PUT /tabs/:tabId/selection', () => {
  let h: TestHarness

  beforeEach(async () => {
    h = await spawnServer()
  })

  afterEach(async () => {
    await h.close()
    cleanupTempDirs()
  })

  // -------------------------------------------------------------------------
  // 1. Accepts body WITH clientId, returns {selectionSeq, acceptedAt}
  // -------------------------------------------------------------------------
  test('accepts body WITH clientId, returns {selectionSeq, acceptedAt}', async () => {
    const body = { nodes: [validHandle], clientId: crypto.randomUUID() }
    const res = await fetch(`${h.url}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.authTokenStr}`,
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(200)
    const parsed = (await res.json()) as Record<string, unknown>
    expect(parsed).toHaveProperty('selectionSeq')
    expect(parsed).toHaveProperty('acceptedAt')
    expect(typeof parsed.selectionSeq).toBe('number')
    expect(typeof parsed.acceptedAt).toBe('number')
    // selectionSeq is a non-negative integer
    expect(Number.isInteger(parsed.selectionSeq)).toBe(true)
    expect(parsed.selectionSeq as number).toBeGreaterThanOrEqual(0)
    // acceptedAt is a positive Unix-ms timestamp
    expect(parsed.acceptedAt as number).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // 2. Accepts body WITHOUT clientId (optional field)
  // -------------------------------------------------------------------------
  test('accepts body WITHOUT clientId (optional field)', async () => {
    const body = { nodes: [validHandle] }
    const res = await fetch(`${h.url}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.authTokenStr}`,
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(200)
    const parsed = (await res.json()) as Record<string, unknown>
    expect(parsed).toHaveProperty('selectionSeq')
    expect(parsed).toHaveProperty('acceptedAt')
  })

  // -------------------------------------------------------------------------
  // 3. Rejects body with foreign top-level field (.strict enforced → 400)
  // -------------------------------------------------------------------------
  test('rejects body with foreign top-level field (.strict enforced)', async () => {
    const body = { nodes: [validHandle], foo: 1 }
    const res = await fetch(`${h.url}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.authTokenStr}`,
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // 4. Rejects body with invalid clientId (not UUIDv4 → 400)
  // -------------------------------------------------------------------------
  test('rejects body with invalid clientId (not UUIDv4)', async () => {
    const body = { nodes: [validHandle], clientId: 'not-a-uuid' }
    const res = await fetch(`${h.url}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.authTokenStr}`,
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // 5. Rejects PUT without auth → 401 with AuthError body (token-unknown)
  // -------------------------------------------------------------------------
  test('rejects PUT without auth → 401 with AuthError body (token-unknown)', async () => {
    const body = { nodes: [validHandle] }
    const res = await fetch(`${h.url}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
        // No Authorization header
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(res.status).toBe(401)
    const parsed = (await res.json()) as Record<string, unknown>
    expect(parsed.error).toBe('auth')
    expect(parsed.reason).toBe('token-unknown')
  })
})
