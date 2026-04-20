// @vitest-environment happy-dom

/**
 * Task 23 — SW entry (index.ts) + hydrate (hydrate.ts) integration tests.
 *
 * Covers:
 *  1. All top-level addListener calls registered synchronously before any await.
 *  2. globalThis.__bootEpoch incremented on each SW boot.
 *  3. hydrate reads storage.session under opaque s_<uuid> key.
 *  4. readyPromise.catch surfaces hydrate error via sendResponse.
 *  5. Poisoned storage.session payload cleared + empty-state fallback.
 *  6. chrome.storage.session.setAccessLevel called with TRUSTED_CONTEXTS.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChromeMock } from '../chromeMock/index.js'

// happy-dom rewrites import.meta.url to a non-file URL; fall back to __dirname-style
// resolution via process.cwd() when fileURLToPath fails.
function resolveSwIndexPath(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    return resolve(dirname(here), '../../src/sw/index.ts')
  } catch {
    // In happy-dom, resolve from the ext package root (process cwd).
    return resolve(process.cwd(), 'src/sw/index.ts')
  }
}

const SW_INDEX_SRC_PATH = resolveSwIndexPath()

type ChromeMock = ReturnType<typeof makeChromeMock>

function installChrome(mock: ChromeMock): () => void {
  const original = globalThis.chrome
  // @ts-expect-error -- test env
  globalThis.chrome = mock
  return () => {
    globalThis.chrome = original
  }
}

function resetBootEpoch(): void {
  ;(globalThis as unknown as { __bootEpoch?: number }).__bootEpoch = 0
}

function resetSessionKey(): void {
  Reflect.deleteProperty(globalThis as unknown as object, '__sessionKey')
}

// --- Shared helpers for importing SW / hydrate modules fresh per test ---

async function importFreshSw(): Promise<typeof import('../../src/sw/index.js')> {
  vi.resetModules()
  return await import('../../src/sw/index.js')
}

async function importFreshHydrate(): Promise<typeof import('../../src/sw/hydrate.js')> {
  vi.resetModules()
  return await import('../../src/sw/hydrate.js')
}

// ---------------------------------------------------------------------------
// (1) Top-level listeners registered before any await
// ---------------------------------------------------------------------------

describe('sw/index — top-level listeners', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('registers onInstalled listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.runtime.onInstalled._listeners.length).toBeGreaterThanOrEqual(1)
  })

  it('registers onStartup listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.runtime.onStartup._listeners.length).toBeGreaterThanOrEqual(1)
  })

  it('registers onMessage listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.runtime.onMessage._listeners.length).toBeGreaterThanOrEqual(1)
  })

  it('registers onConnect listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.runtime.onConnect._listeners.length).toBeGreaterThanOrEqual(1)
  })

  it('registers action.onClicked listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.action._getListeners('onClicked').length).toBeGreaterThanOrEqual(1)
  })

  it('registers commands.onCommand listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.commands._getListeners('onCommand').length).toBeGreaterThanOrEqual(1)
  })

  it('registers tabs.onActivated listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.tabs._getListeners('onActivated').length).toBeGreaterThanOrEqual(1)
  })

  it('registers tabs.onRemoved listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.tabs._getListeners('onRemoved').length).toBeGreaterThanOrEqual(1)
  })

  it('registers windows.onFocusChanged listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.windows._getListeners('onFocusChanged').length).toBeGreaterThanOrEqual(1)
  })

  it('registers idle.onStateChanged listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.idle._getListeners('onStateChanged').length).toBeGreaterThanOrEqual(1)
  })

  it('registers alarms.onAlarm listener at top level', async () => {
    await importFreshSw()
    expect(chromeMock.alarms._getListeners('onAlarm').length).toBeGreaterThanOrEqual(1)
  })

  it('source file has no top-level await before last addListener call', () => {
    const src = readFileSync(SW_INDEX_SRC_PATH, 'utf8')

    // Strip line comments and block comments to avoid false positives.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // Find position of the last `.addListener(` in the (stripped) source.
    const lastAddListenerIdx = stripped.lastIndexOf('.addListener(')
    expect(lastAddListenerIdx).toBeGreaterThan(-1)

    const before = stripped.slice(0, lastAddListenerIdx)

    // ESLint no-restricted-syntax rule stand-in: no `await` or `async function`
    // keywords may appear before the final top-level addListener registration.
    // `async (msg, sender) =>` or `async function` inside a listener body is
    // fine because listener callbacks don't execute at module-load time — but
    // to keep this guard strict, Task 23 uses only sync handlers that delegate
    // to readyPromise.then(). Any async fn body or await before the final
    // addListener points at a spec violation.
    expect(before).not.toMatch(/\bawait\b/)
    expect(before).not.toMatch(/\basync\s+function\b/)
    expect(before).not.toMatch(/\basync\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// (2) globalThis.__bootEpoch incremented
// ---------------------------------------------------------------------------

describe('sw/index — __bootEpoch', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('increments from 0 to 1 on first SW load', async () => {
    await importFreshSw()
    expect((globalThis as unknown as { __bootEpoch?: number }).__bootEpoch).toBe(1)
  })

  it('increments again on subsequent import (SW resurrection)', async () => {
    await importFreshSw()
    // Simulate SW wake — module cache already cleared via resetModules in helper.
    await importFreshSw()
    expect((globalThis as unknown as { __bootEpoch?: number }).__bootEpoch).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// (3) Hydrate reads under opaque s_<uuid> key
// ---------------------------------------------------------------------------

describe('sw/hydrate — opaque session key', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('makeSessionKey returns s_<uuid>', async () => {
    const mod = await importFreshHydrate()
    const key = mod.makeSessionKey()
    expect(key.startsWith(mod.SESSION_KEY_PREFIX)).toBe(true)
    expect(key).toMatch(/^s_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('hydrate reuses globalThis.__sessionKey if already set', async () => {
    const seededKey = 's_00000000-0000-4000-8000-000000000000'
    ;(globalThis as unknown as { __sessionKey?: string }).__sessionKey = seededKey

    const seededState = {
      instanceId: 'inst-1',
      bootstrapToken: 'btok',
      sessionToken: 'stok',
      sessionExp: 123,
      tabs: {},
      activePickClientId: null,
      activePickCounter: 0,
      lastSeq: 0,
    }
    await chromeMock.storage.session.set({ [seededKey]: seededState })
    chromeMock._recorder.clear()

    const { hydrate } = await importFreshHydrate()
    const result = await hydrate()

    expect(result.sessionKey).toBe(seededKey)
    expect(result.failed).toBe(false)
    expect(result.state.sessionToken).toBe('stok')
    expect(result.state.instanceId).toBe('inst-1')

    // Confirm the actual chrome.storage.session.get call used that key.
    const getEffects = chromeMock._recorder
      .snapshot()
      .filter((e) => e.type === 'storage.session.get')
    expect(getEffects.length).toBeGreaterThan(0)
    const firstGet = getEffects[0]?.args as string[] | null
    expect(Array.isArray(firstGet)).toBe(true)
    expect(firstGet).toContain(seededKey)
  })

  it('hydrate generates a fresh s_<uuid> key when none is set and stores it on globalThis', async () => {
    const { hydrate, SESSION_KEY_PREFIX } = await importFreshHydrate()
    const result = await hydrate()

    expect(result.sessionKey.startsWith(SESSION_KEY_PREFIX)).toBe(true)
    expect((globalThis as unknown as { __sessionKey?: string }).__sessionKey).toBe(
      result.sessionKey,
    )
  })
})

// ---------------------------------------------------------------------------
// (6) setAccessLevel called with TRUSTED_CONTEXTS at boot
// ---------------------------------------------------------------------------

describe('sw/hydrate — setAccessLevel', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('calls chrome.storage.session.setAccessLevel with TRUSTED_CONTEXTS', async () => {
    const { hydrate } = await importFreshHydrate()
    await hydrate()

    const setAccessLevelEffects = chromeMock._recorder
      .snapshot()
      .filter((e) => e.type === 'storage.session.setAccessLevel')
    expect(setAccessLevelEffects).toHaveLength(1)
    expect(setAccessLevelEffects[0]?.args).toEqual({ accessLevel: 'TRUSTED_CONTEXTS' })
  })

  it('swallows setAccessLevel throw (older Chrome) and still hydrates', async () => {
    // Override setAccessLevel to throw.
    const origSetAccessLevel = chromeMock.storage.session.setAccessLevel
    chromeMock.storage.session.setAccessLevel = () => {
      throw new Error('not supported')
    }
    try {
      const { hydrate } = await importFreshHydrate()
      const result = await hydrate()
      expect(result.failed).toBe(false)
    } finally {
      chromeMock.storage.session.setAccessLevel = origSetAccessLevel
    }
  })
})

// ---------------------------------------------------------------------------
// (5) Poisoned storage cleared + empty state fallback
// ---------------------------------------------------------------------------

describe('sw/hydrate — poisoned storage fallback', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('clears session storage and returns empty state when payload is corrupt', async () => {
    const seededKey = 's_11111111-1111-4111-8111-111111111111'
    ;(globalThis as unknown as { __sessionKey?: string }).__sessionKey = seededKey

    // Seed with an obviously invalid payload (wrong shape).
    await chromeMock.storage.session.set({
      [seededKey]: { sessionToken: 12345, tabs: 'not-an-object' },
    })
    chromeMock._recorder.clear()

    const { hydrate } = await importFreshHydrate()
    const result = await hydrate()

    expect(result.failed).toBe(true)
    expect(result.state.sessionToken).toBeNull()
    expect(result.state.instanceId).toBeNull()
    expect(result.state.tabs).toEqual({})
    expect(result.state.lastSeq).toBe(0)

    const removeEffects = chromeMock._recorder
      .snapshot()
      .filter((e) => e.type === 'storage.session.remove')
    expect(removeEffects.length).toBeGreaterThan(0)
    const firstRemoveArg = removeEffects[0]?.args
    expect(
      (Array.isArray(firstRemoveArg) ? firstRemoveArg : [firstRemoveArg]).includes(seededKey),
    ).toBe(true)
  })

  it('returns empty-state defaults when storage is truly empty', async () => {
    const { hydrate } = await importFreshHydrate()
    const result = await hydrate()

    expect(result.failed).toBe(false)
    expect(result.state).toMatchObject({
      instanceId: null,
      bootstrapToken: null,
      sessionToken: null,
      sessionExp: null,
      tabs: {},
      activePickClientId: null,
      activePickCounter: 0,
      lastSeq: 0,
      recent: [],
      dormantReason: null,
    })
  })
})

// ---------------------------------------------------------------------------
// (4) readyPromise.catch surfaces error to pending handler
// ---------------------------------------------------------------------------

describe('sw/index — readyPromise error surfaces via sendResponse', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
    resetBootEpoch()
    resetSessionKey()
  })

  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('onMessage handler replies with {error} when hydrate fails catastrophically', async () => {
    // Force storage.session.get to throw synchronously.
    chromeMock.storage.session.get = () => {
      return Promise.reject(new Error('session storage unavailable'))
    }
    // Also break remove so hydrate cannot recover cleanly — this simulates
    // an environment where the hydrate readyPromise rejects.
    chromeMock.storage.session.remove = () => {
      return Promise.reject(new Error('remove failed'))
    }

    await importFreshSw()

    // Dispatch a message and capture sendResponse.
    const sendResponse = vi.fn()
    const listeners = chromeMock.runtime.onMessage._listeners
    expect(listeners.length).toBeGreaterThan(0)
    const keepOpen = (listeners[0] as (...a: unknown[]) => unknown)(
      { type: 'noop-for-test' },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    )
    // Handler must return true to keep channel open for async response.
    expect(keepOpen).toBe(true)

    // Wait for readyPromise.catch to fire sendResponse.
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled()
    })
    const firstCallArg = sendResponse.mock.calls[0]?.[0] as { error?: string } | undefined
    expect(firstCallArg).toBeDefined()
    expect(typeof firstCallArg?.error).toBe('string')
  })
})
