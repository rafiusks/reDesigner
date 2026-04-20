// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import * as ensureSessionModule from '../../src/sw/ensureSession.js'
import { persistSelection } from '../../src/sw/persistSelection.js'
import type { PersistSelectionDeps } from '../../src/sw/persistSelection.js'
import * as restModule from '../../src/sw/rest.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_HANDLE = {
  id: 'test-id-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: 1_700_000_000_000,
}

const HTTP_URL = 'http://localhost:9999'
const SESSION_TOKEN = 'tok-abc'
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const TAB_ID = 42

function makeHandshake(overrides?: Record<string, unknown>) {
  return {
    wsUrl: 'ws://localhost:9999/events',
    httpUrl: HTTP_URL,
    bootstrapToken: 'btok-abc',
    editor: 'vscode',
    registeredAtEpochMs: Date.now() - 5000, // registered 5s ago (outside cold-race window)
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<PersistSelectionDeps>): PersistSelectionDeps {
  return {
    tabHandshakes: new Map([[TAB_ID, makeHandshake()]]),
    tabSessions: new Map([[TAB_ID, { sessionToken: SESSION_TOKEN, exp: Date.now() + 300_000 }]]),
    extId: EXT_ID,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Test 1: no handshake
// ---------------------------------------------------------------------------

describe('persistSelection — no handshake', () => {
  test('bails with warn when no handshake for tab; putSelection is not called', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const putSpy = vi.spyOn(restModule, 'putSelection')

    const deps = makeDeps({ tabHandshakes: new Map() })
    await persistSelection(TAB_ID, VALID_HANDLE, deps)

    expect(putSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no handshake for tab'),
      expect.objectContaining({ tabId: TAB_ID }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 2: handle fails schema
// ---------------------------------------------------------------------------

describe('persistSelection — schema mismatch', () => {
  test('bails with warn when handle fails ComponentHandleSchema; putSelection is not called', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const putSpy = vi.spyOn(restModule, 'putSelection')

    const invalidHandle = { id: '', componentName: '' } // missing required fields
    await persistSelection(TAB_ID, invalidHandle, makeDeps())

    expect(putSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('handle schema mismatch'),
      expect.objectContaining({ tabId: TAB_ID }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 3: happy path — session cached, calls putSelection with correct args
// ---------------------------------------------------------------------------

describe('persistSelection — happy path (cached session)', () => {
  test('validates handle, uses cached session, calls putSelection with correct args', async () => {
    const putSpy = vi.spyOn(restModule, 'putSelection').mockResolvedValue({
      selectionSeq: 1,
      acceptedAt: Date.now(),
    })

    await persistSelection(TAB_ID, VALID_HANDLE, makeDeps())

    expect(putSpy).toHaveBeenCalledOnce()
    const callArgs = putSpy.mock.calls[0]
    if (callArgs === undefined) throw new Error('expected putSpy to be called')
    const [args] = callArgs
    expect(args.httpUrl).toBe(HTTP_URL)
    expect(args.tabId).toBe(TAB_ID)
    expect(args.sessionToken).toBe(SESSION_TOKEN)
    expect(args.extId).toBe(EXT_ID)
    expect(args.body).toEqual({ nodes: [VALID_HANDLE] })
    expect(args.timeoutMs).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// Test 4: never rethrows when putSelection throws
// ---------------------------------------------------------------------------

describe('persistSelection — never rethrows on putSelection failure', () => {
  test('resolves even when putSelection rejects', async () => {
    vi.spyOn(restModule, 'putSelection').mockRejectedValue(new Error('network failure'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(persistSelection(TAB_ID, VALID_HANDLE, makeDeps())).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PUT failed'),
      expect.objectContaining({ tabId: TAB_ID, message: 'network failure' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 5: never rethrows when ensureSession throws
// ---------------------------------------------------------------------------

describe('persistSelection — never rethrows on ensureSession failure', () => {
  test('resolves even when ensureSession (via postExchange) rejects', async () => {
    // Empty tabSessions forces a cold ensureSession call; mock postExchange to reject
    vi.spyOn(ensureSessionModule, 'ensureSession').mockRejectedValue(new Error('exchange rejected'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = makeDeps({ tabSessions: new Map() })

    await expect(persistSelection(TAB_ID, VALID_HANDLE, deps)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PUT failed'),
      expect.objectContaining({ tabId: TAB_ID, message: 'exchange rejected' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 6: emits [redesigner:perf] log with correct shape
// ---------------------------------------------------------------------------

describe('persistSelection — perf log', () => {
  test('emits perf log with elapsedMs, pickSeq, cold, and kind fields', async () => {
    vi.spyOn(restModule, 'putSelection').mockResolvedValue({
      selectionSeq: 1,
      acceptedAt: Date.now(),
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await persistSelection(TAB_ID, VALID_HANDLE, makeDeps())

    const perfCalls = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('[redesigner:perf]'),
    )
    expect(perfCalls.length).toBeGreaterThanOrEqual(1)
    const firstPerfCall = perfCalls[0]
    if (firstPerfCall === undefined) throw new Error('expected perf log call')
    const [, perfData] = firstPerfCall as [string, Record<string, unknown>]
    expect(perfData).toMatchObject({
      tabId: TAB_ID,
      kind: 'ok',
      cold: false, // session was cached
    })
    expect(typeof perfData.elapsedMs).toBe('number')
    expect(typeof perfData.pickSeq).toBe('number')
  })

  test('emits perf log with kind=fail on putSelection error', async () => {
    vi.spyOn(restModule, 'putSelection').mockRejectedValue(new Error('oops'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await persistSelection(TAB_ID, VALID_HANDLE, makeDeps())

    const perfCalls = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('[redesigner:perf]'),
    )
    expect(perfCalls.length).toBeGreaterThanOrEqual(1)
    const firstPerfCall = perfCalls[0]
    if (firstPerfCall === undefined) throw new Error('expected perf log call')
    const [, perfData] = firstPerfCall as [string, Record<string, unknown>]
    expect(perfData).toMatchObject({ kind: 'fail' })
  })
})

// ---------------------------------------------------------------------------
// Test 7: two concurrent calls both resolve; each gets distinct pickSeq
// ---------------------------------------------------------------------------

describe('persistSelection — concurrent dispatch', () => {
  test('two back-to-back calls both resolve with distinct pickSeq values', async () => {
    const seqValues: number[] = []
    vi.spyOn(restModule, 'putSelection').mockResolvedValue({
      selectionSeq: 1,
      acceptedAt: Date.now(),
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const [msg, data] = args as [string, Record<string, unknown>]
      if (typeof msg === 'string' && msg.includes('[redesigner:perf]') && data.kind === 'ok') {
        seqValues.push(data.pickSeq as number)
      }
    })

    const deps = makeDeps()
    await Promise.all([
      persistSelection(TAB_ID, VALID_HANDLE, deps),
      persistSelection(TAB_ID, VALID_HANDLE, deps),
    ])

    expect(seqValues).toHaveLength(2)
    expect(seqValues[0]).not.toBe(seqValues[1])

    logSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test 8: cold-start race warning
// ---------------------------------------------------------------------------

describe('persistSelection — cold-start race warning', () => {
  test('emits race warning when pick arrives within 100ms of register', async () => {
    vi.spyOn(restModule, 'putSelection').mockResolvedValue({
      selectionSeq: 1,
      acceptedAt: Date.now(),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // registeredAtEpochMs is only 10ms ago — within cold-race window
    const deps = makeDeps({
      tabHandshakes: new Map([[TAB_ID, makeHandshake({ registeredAtEpochMs: Date.now() - 10 })]]),
    })
    await persistSelection(TAB_ID, VALID_HANDLE, deps)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[redesigner:race]'),
      expect.objectContaining({ tabId: TAB_ID }),
    )
  })
})
