/**
 * Circuit-breaker tests for DaemonBackend.
 *
 * Key facts about the circuit breaker (from daemonBackend.ts):
 *   AUTH_CIRCUIT_BREAKER_LIMIT = 5
 *   AUTH_CIRCUIT_BREAKER_WINDOW_MS = 5000
 *   UNREACHABLE_TTL_MS = 1000
 *
 * recordAuthFail(instanceId) logic:
 *   - If instanceId changed: reset consecutiveAuthFails=0
 *   - If lastAuthFailAt !== 0 AND now-lastAuthFailAt < 5000: increment count
 *   - Else (initial or outside window): reset count to 1
 *   - Set lastAuthFailAt=now; returns true if count >= 5
 *
 * Per-call timing constraint: each non-tripping call calls markUnreachable
 * (non-permanent) which sets unreachableUntil = Date.now() + 1000. The next
 * call must be at least 1001ms later (to pass isUnreachable()), but also within
 * the 5s window from the last call to keep the streak alive.
 * Using STEP_MS=2000 satisfies both: 2000 > 1000 (bypasses TTL) and 2000 < 5000
 * (within window).
 *
 * Each non-tripping getCurrentSelection() call:
 *   - Fetch #1 → 401 → recordAuthFail (count++) → sleep 100ms → re-discover
 *   - Fetch #2 → 401 → markUnreachable(TTL=1s) → return null
 * Tripping call: Fetch #1 → 401 → recordAuthFail → TRIP → markUnreachable(permanent)
 *   → return null (NO fetch #2)
 * After trip: isUnreachable()=true → skips fetch entirely.
 *
 * Mock strategy: vi.spyOn(fs, 'lstatSync'/'readFileSync') so discoverHandoff()
 * returns a valid fake handoff. vi.stubGlobal('fetch') for HTTP responses.
 */
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonBackend } from '../../src/daemonBackend.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual }
})

// ─── Helpers ────────────────────────────────────────────────────────────────

const FAKE_PID = process.pid
// Start at non-zero time: t=0 causes lastAuthFailAt=0 edge case (window resets on call 2).
const T0 = 100_000
// Step between calls: > UNREACHABLE_TTL_MS(1000) and < AUTH_CIRCUIT_BREAKER_WINDOW_MS(5000).
const STEP_MS = 2000

function fakeHandoffJson(instanceId = 'inst-A'): string {
  return JSON.stringify({
    serverVersion: '0.0.1',
    instanceId,
    pid: FAKE_PID,
    host: '127.0.0.1',
    port: 9999,
    token: 'tok-abc',
    projectRoot: '/tmp/fake-project',
  })
}

function makeBackend(): DaemonBackend {
  return new DaemonBackend({
    projectRoot: '/tmp/fake-project',
    manifestPath: '/tmp/fake-project/.redesigner/manifest.json',
    selectionPath: '/tmp/fake-project/.redesigner/selection.json',
  })
}

function fakeStat(): fs.Stats {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid,
    mode: 0o100600,
    size: 100,
  } as unknown as fs.Stats
}

function stub401(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ code: 'Unauthorized', status: 401 }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function stub200(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ current: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function setupFs(instanceId = 'inst-A'): void {
  vi.spyOn(fs, 'lstatSync').mockReturnValue(fakeStat())
  vi.spyOn(fs, 'readFileSync').mockReturnValue(fakeHandoffJson(instanceId) as unknown as Buffer)
}

/** Run N getCurrentSelection() calls with STEP_MS fake-time spacing. */
async function runCalls(backend: DaemonBackend, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(T0 + i * STEP_MS)
    await backend.getCurrentSelection()
  }
}

// ─── Suite 1: 5×401 trips the breaker ────────────────────────────────────────

describe('DaemonBackend circuit breaker — 5×401 trip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    setupFs('inst-A')
    stub401()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('5 consecutive 401s trip the breaker — 6th call skips fetch', async () => {
    const backend = makeBackend()
    const fetchFn = vi.mocked(globalThis.fetch)

    // Calls 0–4 (times T0, T0+2s, T0+4s, T0+6s, T0+8s)
    // Each pair of consecutive calls is within the 5s window.
    await runCalls(backend, 5)
    const countAtTrip = fetchFn.mock.calls.length

    // 6th call: permanentUnreachable=true → isUnreachable()=true → no fetch
    vi.setSystemTime(T0 + 5 * STEP_MS)
    const result = await backend.getCurrentSelection()
    expect(result).toBeNull()
    expect(fetchFn.mock.calls.length).toBe(countAtTrip)
  }, 15_000)

  it('5 consecutive 401s all return null', async () => {
    const backend = makeBackend()
    await runCalls(backend, 5)
    // After trip, result is null and no more fetches
    vi.setSystemTime(T0 + 5 * STEP_MS)
    expect(await backend.getCurrentSelection()).toBeNull()
  }, 15_000)
})

// ─── Suite 2: 4 consecutive stays under threshold ────────────────────────────

describe('DaemonBackend circuit breaker — 4 consecutive stays under threshold', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    setupFs('inst-A')
    stub401()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('4 consecutive 401s — breaker not tripped, 5th call still makes a fetch', async () => {
    const backend = makeBackend()
    const fetchFn = vi.mocked(globalThis.fetch)

    await runCalls(backend, 4)
    const countAfter4 = fetchFn.mock.calls.length

    // 5th call: count→5 → trips on this call, but the fetch IS made (first attempt)
    vi.setSystemTime(T0 + 4 * STEP_MS)
    await backend.getCurrentSelection()
    expect(fetchFn.mock.calls.length).toBeGreaterThan(countAfter4)
  }, 15_000)
})

// ─── Suite 3: instanceId and permanentUnreachable ─────────────────────────────

describe('DaemonBackend circuit breaker — permanentUnreachable behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('after trip, changing instanceId in fs does NOT clear permanentUnreachable', async () => {
    setupFs('inst-A')
    stub401()
    const backend = makeBackend()
    await runCalls(backend, 5) // trip

    // Simulate daemon restart: new instanceId + successful 200
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setupFs('inst-B')
    const fn200 = stub200()

    vi.setSystemTime(T0 + 6 * STEP_MS)
    const result = await backend.getCurrentSelection()

    // permanentUnreachable is a hard stop — consumer must create new instance
    expect(result).toBeNull()
    expect(fn200.mock.calls.length).toBe(0) // fetch was NOT called
  }, 15_000)

  it('fresh DaemonBackend after trip succeeds with 200', async () => {
    setupFs('inst-A')
    stub401()
    const tripped = makeBackend()
    await runCalls(tripped, 5) // trip first backend

    // New backend instance, 200 responses
    vi.unstubAllGlobals()
    const fn200 = stub200()
    vi.setSystemTime(T0 + 6 * STEP_MS)

    const fresh = makeBackend()
    const result = await fresh.getCurrentSelection()

    // Fresh backend calls fetch and gets null (200 with no selection)
    expect(fn200.mock.calls.length).toBeGreaterThan(0)
    expect(result).toBeNull()
  }, 15_000)
})

// ─── Suite 4: window reset ────────────────────────────────────────────────────

describe('DaemonBackend circuit breaker — window reset', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    setupFs('inst-A')
    stub401()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('auth fail >5s after last fail resets streak (not a trip)', async () => {
    const backend = makeBackend()
    const fetchFn = vi.mocked(globalThis.fetch)

    // 4 calls, last at T0+3*STEP_MS = T0+6000, lastAuthFailAt=T0+6000
    await runCalls(backend, 4)

    // 5th call: >5s after last (T0+6000+5001=T0+11001) → resets to 1
    // Also >1s after unreachableUntil (T0+7000) → isUnreachable()=false
    vi.setSystemTime(T0 + 3 * STEP_MS + 5001)
    await backend.getCurrentSelection()
    // count reset to 1 — NOT tripped

    // 6th call: count→2, not tripped → makes fetch
    const countBefore6th = fetchFn.mock.calls.length
    vi.setSystemTime(T0 + 3 * STEP_MS + 5001 + STEP_MS)
    await backend.getCurrentSelection()
    expect(fetchFn.mock.calls.length).toBeGreaterThan(countBefore6th)
  }, 15_000)

  it('5 calls within window trip the breaker; 6th skips fetch', async () => {
    const backend = makeBackend()
    const fetchFn = vi.mocked(globalThis.fetch)

    // 5 calls with STEP_MS=2000 spacing all within 5s window between consecutive calls
    await runCalls(backend, 5)
    const countAtTrip = fetchFn.mock.calls.length

    // 6th call: breaker tripped → skips fetch
    vi.setSystemTime(T0 + 5 * STEP_MS)
    await backend.getCurrentSelection()
    expect(fetchFn.mock.calls.length).toBe(countAtTrip)
  }, 15_000)
})
