/**
 * Task 16 — shared utilities: clock, random, constants, editors, errors.
 *
 * Tests for:
 *  - constants: exact literal values matching spec §2
 *  - clock: injectable Date.now() replacement
 *  - random: nextFullJitterDelay(n) full jitter with injectable Math.random
 *  - editors: EditorSchema allowlist + URL builders + project-root constraint
 *  - errors: re-export from @redesigner/core/schemas/errors
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { now, resetClock, setClock } from '../../src/shared/clock'
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MANIFEST_CACHE_DEADLINE_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WELCOME_POLL_DURATION_MS,
  WELCOME_POLL_MS,
} from '../../src/shared/constants'
import {
  type Editor,
  EditorSchema,
  OutsideProjectRootError,
  buildEditorDeeplink,
} from '../../src/shared/editors'
import { ApiErrorCodeToRpc, RpcErrorCode } from '../../src/shared/errors'
import { nextFullJitterDelay, resetRandom, setRandom } from '../../src/shared/random'

describe('shared/constants', () => {
  it('exports PING_INTERVAL_MS = 20000', () => {
    expect(PING_INTERVAL_MS).toBe(20_000)
  })

  it('exports PONG_TIMEOUT_MS = 5000', () => {
    expect(PONG_TIMEOUT_MS).toBe(5_000)
  })

  it('exports MANIFEST_CACHE_DEADLINE_MS = 3000', () => {
    expect(MANIFEST_CACHE_DEADLINE_MS).toBe(3_000)
  })

  it('exports BACKOFF_CAP_MS = 30000', () => {
    expect(BACKOFF_CAP_MS).toBe(30_000)
  })

  it('exports BACKOFF_BASE_MS = 1000', () => {
    expect(BACKOFF_BASE_MS).toBe(1_000)
  })

  it('exports WELCOME_POLL_MS = 3000', () => {
    expect(WELCOME_POLL_MS).toBe(3_000)
  })

  it('exports WELCOME_POLL_DURATION_MS = 120000', () => {
    expect(WELCOME_POLL_DURATION_MS).toBe(120_000)
  })
})

describe('shared/clock', () => {
  afterEach(() => {
    resetClock()
  })

  it('now() returns current Date.now() by default', () => {
    const before = Date.now()
    const current = now()
    const after = Date.now()
    expect(current).toBeGreaterThanOrEqual(before)
    expect(current).toBeLessThanOrEqual(after)
  })

  it('setClock() allows injection of a custom clock function', () => {
    setClock(() => 42)
    expect(now()).toBe(42)
  })

  it('resetClock() restores Date.now()', () => {
    setClock(() => 99)
    expect(now()).toBe(99)
    resetClock()
    const before = Date.now()
    const current = now()
    const after = Date.now()
    expect(current).toBeGreaterThanOrEqual(before)
    expect(current).toBeLessThanOrEqual(after)
  })
})

describe('shared/random', () => {
  afterEach(() => {
    resetRandom()
  })

  it('nextFullJitterDelay(0) with 0.5 random returns 500', () => {
    setRandom(() => 0.5)
    // 0.5 * min(30000, 1000 * 2^0) = 0.5 * 1000 = 500
    expect(nextFullJitterDelay(0)).toBe(500)
  })

  it('nextFullJitterDelay(3) with 0.5 random returns 4000', () => {
    setRandom(() => 0.5)
    // 0.5 * min(30000, 1000 * 2^3) = 0.5 * 8000 = 4000
    expect(nextFullJitterDelay(3)).toBe(4000)
  })

  it('nextFullJitterDelay(6) with 0.5 random returns 15000 (cap binds)', () => {
    setRandom(() => 0.5)
    // 0.5 * min(30000, 1000 * 2^6) = 0.5 * min(30000, 64000) = 0.5 * 30000 = 15000
    expect(nextFullJitterDelay(6)).toBe(15000)
  })

  it('nextFullJitterDelay(10) with 0.5 random returns 15000 (cap still binds)', () => {
    setRandom(() => 0.5)
    // 0.5 * min(30000, 1000 * 2^10) = 0.5 * 30000 = 15000
    expect(nextFullJitterDelay(10)).toBe(15000)
  })

  it('nextFullJitterDelay(5) with 0 random returns 0', () => {
    setRandom(() => 0)
    expect(nextFullJitterDelay(5)).toBe(0)
  })

  it('nextFullJitterDelay(0) with 0.999 random returns ~999', () => {
    setRandom(() => 0.999)
    // 0.999 * 1000 ≈ 999
    const result = nextFullJitterDelay(0)
    expect(result).toBeCloseTo(999, 1)
  })

  it('throws RangeError on negative attempts', () => {
    expect(() => nextFullJitterDelay(-1)).toThrow(RangeError)
  })

  it('throws RangeError on non-integer attempts', () => {
    expect(() => nextFullJitterDelay(1.5)).toThrow(RangeError)
  })
})

describe('shared/editors', () => {
  it('EditorSchema.parse("vscode") succeeds', () => {
    const result = EditorSchema.parse('vscode')
    expect(result).toBe('vscode')
  })

  it('EditorSchema.parse("notepad") throws', () => {
    expect(() => EditorSchema.parse('notepad')).toThrow()
  })

  it('buildEditorDeeplink for vscode returns correct URL', () => {
    const url = buildEditorDeeplink({
      editor: 'vscode',
      filePath: '/project/src/file.ts',
      line: 42,
      col: 10,
      projectRoot: '/project',
    })
    expect(url).toBe('vscode://file//project/src/file.ts:42:10')
  })

  it('buildEditorDeeplink for cursor returns correct URL', () => {
    const url = buildEditorDeeplink({
      editor: 'cursor',
      filePath: '/project/src/file.ts',
      line: 42,
      col: 10,
      projectRoot: '/project',
    })
    expect(url).toBe('cursor://file//project/src/file.ts:42:10')
  })

  it('buildEditorDeeplink for webstorm returns correct URL', () => {
    const url = buildEditorDeeplink({
      editor: 'webstorm',
      filePath: '/project/src/file.ts',
      line: 42,
      col: 10,
      projectRoot: '/project',
    })
    expect(url).toBe('webstorm://open?file=/project/src/file.ts&line=42&column=10')
  })

  it('buildEditorDeeplink for zed returns correct URL', () => {
    const url = buildEditorDeeplink({
      editor: 'zed',
      filePath: '/project/src/file.ts',
      line: 42,
      col: 10,
      projectRoot: '/project',
    })
    expect(url).toBe('zed://file/project/src/file.ts:42:10')
  })

  it('throws OutsideProjectRootError when filePath is not under projectRoot', () => {
    expect(() =>
      buildEditorDeeplink({
        editor: 'vscode',
        filePath: '/other/src/file.ts',
        line: 1,
        col: 1,
        projectRoot: '/project',
      }),
    ).toThrow(OutsideProjectRootError)
  })

  it('normalizes trailing slashes in projectRoot', () => {
    const url = buildEditorDeeplink({
      editor: 'vscode',
      filePath: '/project/src/file.ts',
      line: 1,
      col: 1,
      projectRoot: '/project/',
    })
    // Should not throw and should produce valid URL
    expect(url).toBe('vscode://file//project/src/file.ts:1:1')
  })
})

describe('shared/errors', () => {
  it('re-exports RpcErrorCode from @redesigner/core/schemas/errors', () => {
    expect(RpcErrorCode.ExtensionDisconnected).toBe(-32001)
  })

  it('re-exports ApiErrorCodeToRpc from @redesigner/core/schemas/errors', () => {
    expect(ApiErrorCodeToRpc).toBeDefined()
    expect(ApiErrorCodeToRpc['extension-disconnected']).toBe(RpcErrorCode.ExtensionDisconnected)
  })
})
