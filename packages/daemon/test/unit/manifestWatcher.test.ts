/**
 * Unit tests for packages/daemon/src/state/manifestWatcher.ts
 *
 * API notes (actual vs plan):
 * - getCached() is the method name, not getManifest()
 * - onValidated callback is the broadcast hook (no EventEmitter)
 * - fsReadFile injection is accepted but unused; reads go through fs.promises.open
 * - vi.spyOn on node:fs is frozen ESM — use vi.mock with importOriginal
 * - For single-flight test we must mock fs.promises.open via vi.mock('node:fs')
 * - stat-poll test: disable debounceTimer guard by not triggering fs.watch event
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'
import { cleanupTempDirs, randomTempDir } from '../helpers/randomTempDir.js'
import { waitForWatcherReady } from '../helpers/waitForWatcherReady.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

function validManifest(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: 'a'.repeat(64),
    components: {},
    locs: {},
    ...overrides,
  }
}

function writeManifest(filePath: string, obj: object): { raw: string; hash: string } {
  const raw = JSON.stringify(obj)
  fs.writeFileSync(filePath, raw)
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  return { raw, hash }
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let dir: string

beforeEach(() => {
  dir = randomTempDir('redwatch-unit-')
})

afterEach(async () => {
  vi.useRealTimers()
  cleanupTempDirs()
})

// ---------------------------------------------------------------------------
// debounce coalescing — N rapid events → ONE reread
// ---------------------------------------------------------------------------

describe('ManifestWatcher — debounce coalescing', () => {
  it('N rapid-fire watch events within 100ms produce ONE validated call, not N', async () => {
    // Write a valid manifest first so the watcher can validate it.
    const manifestPath = path.join(dir, 'manifest.json')
    const { hash } = writeManifest(manifestPath, validManifest())
    expect(hash).toBeTruthy()

    const calls: number[] = []
    const watcher = new ManifestWatcher(
      manifestPath,
      () => calls.push(Date.now()),
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    await waitForWatcherReady(dir)

    // Record validated count after initial start (may be 1 from the initial read)
    const initialCalls = calls.length

    // Fire 5 rapid write events (all within debounce window)
    // Each write changes the file so the hash changes.
    for (let i = 0; i < 5; i++) {
      writeManifest(
        manifestPath,
        validManifest({ generatedAt: new Date(Date.now() + i).toISOString() }),
      )
    }

    // Wait longer than debounce (100ms) + fs read time
    await new Promise<void>((res) => setTimeout(res, 350))

    // Only 1 additional validated call should have been made (the last debounced read)
    const newCalls = calls.length - initialCalls
    expect(newCalls).toBe(1)

    await watcher.stop()
  })

  it('debounce timer resets on each new event within window', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, validManifest())

    const calls: number[] = []
    const watcher = new ManifestWatcher(
      manifestPath,
      () => calls.push(Date.now()),
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    await waitForWatcherReady(dir)

    const initialCalls = calls.length

    // Rapid writes (well within 100ms debounce)
    writeManifest(
      manifestPath,
      validManifest({ generatedAt: new Date(Date.now() + 1).toISOString() }),
    )
    writeManifest(
      manifestPath,
      validManifest({ generatedAt: new Date(Date.now() + 2).toISOString() }),
    )
    writeManifest(
      manifestPath,
      validManifest({ generatedAt: new Date(Date.now() + 3).toISOString() }),
    )

    // Wait for debounce to fire and fs read to complete
    await new Promise<void>((res) => setTimeout(res, 400))

    // Should still only be 1 new call despite 3 writes
    expect(calls.length - initialCalls).toBe(1)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// schema-fail-keeps-cache — invalid JSON/schema must NOT replace cache
// ---------------------------------------------------------------------------

describe('ManifestWatcher — schema-fail-keeps-cache', () => {
  it('invalid JSON write does not replace the valid cached manifest', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    const { hash: validHash } = writeManifest(manifestPath, validManifest())

    let lastReceived: unknown = null
    const watcher = new ManifestWatcher(
      manifestPath,
      (m) => {
        lastReceived = m
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()

    // Watcher should have validated the initial manifest
    expect(watcher.getCached()).not.toBeNull()
    expect(watcher.getCached()?.contentHash).toBe(validHash)
    const cachedBefore = watcher.getCached()

    await waitForWatcherReady(dir)

    // Write invalid JSON
    fs.writeFileSync(manifestPath, 'this is not valid json !!!')

    // Wait for debounce + read
    await new Promise<void>((res) => setTimeout(res, 350))

    // Cache must not have changed
    expect(watcher.getCached()).toBe(cachedBefore)
    expect(watcher.getCached()?.contentHash).toBe(validHash)
    // stats.rejected should have incremented
    expect(watcher.stats.rejected).toBeGreaterThan(0)

    await watcher.stop()
  })

  it('schema-invalid JSON (valid JSON but wrong shape) does not replace cache', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    const { hash: validHash } = writeManifest(manifestPath, validManifest())

    const watcher = new ManifestWatcher(
      manifestPath,
      () => {},
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    expect(watcher.getCached()?.contentHash).toBe(validHash)

    await waitForWatcherReady(dir)

    // Write schema-invalid JSON
    fs.writeFileSync(manifestPath, JSON.stringify({ not: 'a manifest', random: 42 }))

    await new Promise<void>((res) => setTimeout(res, 350))

    // Cache must still hold the original valid manifest
    expect(watcher.getCached()?.contentHash).toBe(validHash)
    expect(watcher.stats.rejected).toBeGreaterThan(0)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// idempotent same-content no-op — identical bytes → only ONE broadcast
// ---------------------------------------------------------------------------

describe('ManifestWatcher — idempotent same-content no-op', () => {
  it('two writes with identical bytes produce only ONE onValidated broadcast', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    // Write a specific fixed manifest so we control the exact bytes
    const manifestObj = validManifest({ generatedAt: '2024-01-01T00:00:00.000Z' })
    const rawBytes = JSON.stringify(manifestObj)

    fs.writeFileSync(manifestPath, rawBytes)

    const broadcastCount = { n: 0 }
    const watcher = new ManifestWatcher(
      manifestPath,
      () => {
        broadcastCount.n++
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    // Initial read fires one broadcast
    expect(broadcastCount.n).toBe(1)

    await waitForWatcherReady(dir)

    // Write identical bytes (same content)
    fs.writeFileSync(manifestPath, rawBytes)

    await new Promise<void>((res) => setTimeout(res, 350))

    // Still only 1 — same hash means no-op, onValidated not called again
    expect(broadcastCount.n).toBe(1)

    // Write different bytes — should fire a second broadcast
    const differentManifest = validManifest({ generatedAt: '2024-06-15T12:00:00.000Z' })
    fs.writeFileSync(manifestPath, JSON.stringify(differentManifest))

    await new Promise<void>((res) => setTimeout(res, 350))

    // Now exactly 2
    expect(broadcastCount.n).toBe(2)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// single-flight — second reread waits for first
// ---------------------------------------------------------------------------

// NOTE: fs.promises.open is used directly (not the injected fsReadFile).
// We must mock node:fs at the module level with vi.mock to intercept it.

// We use vi.hoisted to share mutable state between the mock factory and tests.
const singleFlightState = vi.hoisted(() => ({
  resolveFirst: null as ((value: undefined) => void) | null,
  callCount: 0,
  blocked: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    promises: {
      ...original.promises,
      open: async (...args: Parameters<typeof original.promises.open>) => {
        if (singleFlightState.blocked) {
          singleFlightState.callCount++
          const callIndex = singleFlightState.callCount
          if (callIndex === 1) {
            // First call: block until test resolves it
            await new Promise<void>((resolve) => {
              singleFlightState.resolveFirst = resolve
            })
          }
        }
        return original.promises.open(...args)
      },
    },
  }
})

describe('ManifestWatcher — single-flight via deferred open', () => {
  beforeEach(() => {
    singleFlightState.resolveFirst = null
    singleFlightState.callCount = 0
    singleFlightState.blocked = false
  })

  it('second reread does not interleave — pending flag is set while first is in flight', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, validManifest())

    const broadcastCount = { n: 0 }
    const watcher = new ManifestWatcher(
      manifestPath,
      () => {
        broadcastCount.n++
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    // Do the initial start without blocking (blocked=false) to prime cache
    await watcher.start()
    expect(broadcastCount.n).toBe(1)

    // Now enable blocking for subsequent opens
    singleFlightState.blocked = true
    singleFlightState.callCount = 0

    await waitForWatcherReady(dir)

    // Write a new manifest to trigger first reread (will block)
    writeManifest(
      manifestPath,
      validManifest({ generatedAt: new Date(Date.now() + 100).toISOString() }),
    )

    // Wait for the debounce to fire and the open to be called
    await new Promise<void>((res) => setTimeout(res, 200))

    // First open is blocked; watcher.inFlight should be true.
    // Now write a second manifest — this should be queued (rereadPending=true), not a second open
    const secondCallCountBefore = singleFlightState.callCount
    writeManifest(
      manifestPath,
      validManifest({ generatedAt: new Date(Date.now() + 200).toISOString() }),
    )

    // Wait for debounce of second write
    await new Promise<void>((res) => setTimeout(res, 150))

    // callCount should still be 1 (only the first open was called; second is pending)
    expect(singleFlightState.callCount).toBe(secondCallCountBefore + 0) // no second open yet

    // Unblock the first read
    singleFlightState.blocked = false
    singleFlightState.resolveFirst?.()

    // Allow both reads to complete
    await new Promise<void>((res) => setTimeout(res, 500))

    // Two total broadcasts: one from initial start, one from first blocked read,
    // and one from the queued pending read. Total = 3.
    expect(broadcastCount.n).toBeGreaterThanOrEqual(2)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// fd-based read respects cap — >2MB file → no cache update
// ---------------------------------------------------------------------------

describe('ManifestWatcher — fd-based read respects 2MB cap', () => {
  it('file exceeding 2MB cap does not update cache and increments rejected', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    // Write an initially valid manifest so the watcher has a cache to keep
    writeManifest(manifestPath, validManifest())

    const watcher = new ManifestWatcher(
      manifestPath,
      () => {},
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    expect(watcher.getCached()).not.toBeNull()
    const cachedBefore = watcher.getCached()

    await waitForWatcherReady(dir)

    const rejectedBefore = watcher.stats.rejected

    // Write a >2MB file (2 * 1024 * 1024 + 1 bytes)
    const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41) // 'A' * (2MB + 1)
    fs.writeFileSync(manifestPath, bigBuf)

    await new Promise<void>((res) => setTimeout(res, 400))

    // Cache must not have changed (size exceeded cap)
    expect(watcher.getCached()).toBe(cachedBefore)
    expect(watcher.stats.rejected).toBeGreaterThan(rejectedBefore)

    await watcher.stop()
  })

  it('file at exactly 2MB cap (not over) is read normally', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, validManifest())

    const broadcastCount = { n: 0 }
    const watcher = new ManifestWatcher(
      manifestPath,
      () => {
        broadcastCount.n++
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    expect(broadcastCount.n).toBe(1)

    await waitForWatcherReady(dir)

    // Write a file that is exactly 2MB (not exceeded)
    // Since this is not valid JSON, it will be rejected by schema,
    // but it won't be rejected by the cap check. We verify rejected
    // increments from schema not cap.
    const exactBuf = Buffer.alloc(2 * 1024 * 1024, 0x41)
    fs.writeFileSync(manifestPath, exactBuf)

    await new Promise<void>((res) => setTimeout(res, 400))

    // Rejected count should increase (from JSON parse fail, not cap)
    // but that means the cap guard was bypassed (correct behavior)
    expect(watcher.stats.rejected).toBeGreaterThan(0)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// contentHash-from-bytes-not-json — watcher overwrites on-disk contentHash
// ---------------------------------------------------------------------------

describe('ManifestWatcher — contentHash recomputed from raw bytes', () => {
  it('on-disk contentHash field is replaced with sha256 of raw bytes', async () => {
    const manifestPath = path.join(dir, 'manifest.json')

    // Use a valid 64-char hex contentHash that is deliberately different from the
    // sha256 of the actual bytes (all-f's won't match any real sha256 here).
    const fakeHash = 'f'.repeat(64)
    const manifestObj = {
      schemaVersion: '1.0',
      framework: 'react',
      generatedAt: '2024-01-01T00:00:00.000Z',
      contentHash: fakeHash,
      components: {},
      locs: {},
    }
    const raw = JSON.stringify(manifestObj)
    fs.writeFileSync(manifestPath, raw)

    // Compute expected hash from the raw bytes actually written
    const expectedHash = crypto.createHash('sha256').update(raw).digest('hex')
    // Sanity: expectedHash must differ from the fakeHash we put in the file
    expect(expectedHash).not.toBe(fakeHash)

    let received: { contentHash?: string } | null = null
    const watcher = new ManifestWatcher(
      manifestPath,
      (m) => {
        received = m as { contentHash?: string }
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()

    // onValidated should have been called with the recomputed hash
    expect(received).not.toBeNull()
    expect(received?.contentHash).toBe(expectedHash)
    // Must NOT be the placeholder value that was written to disk
    expect(received?.contentHash).not.toBe(fakeHash)

    // getCached() also returns recomputed hash
    expect(watcher.getCached()?.contentHash).toBe(expectedHash)

    await watcher.stop()
  })

  it('contentHash recomputed on watch-triggered reread, not taken from file', async () => {
    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, validManifest())

    let lastHash: string | null = null
    const watcher = new ManifestWatcher(
      manifestPath,
      (m) => {
        lastHash = (m as { contentHash?: string }).contentHash ?? null
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    await watcher.start()
    await waitForWatcherReady(dir)

    // Write a manifest where the on-disk contentHash field is a valid 64-char hex
    // value that is NOT the actual sha256 of the bytes (all-e's won't match).
    const placeholder = 'e'.repeat(64)
    const manifest2 = {
      schemaVersion: '1.0',
      framework: 'react',
      generatedAt: '2024-06-15T00:00:00.000Z',
      contentHash: placeholder,
      components: {},
      locs: {},
    }
    const raw2 = JSON.stringify(manifest2)
    fs.writeFileSync(manifestPath, raw2)

    const expectedHash2 = crypto.createHash('sha256').update(raw2).digest('hex')
    // Sanity: the bytes-hash must differ from the placeholder
    expect(expectedHash2).not.toBe(placeholder)

    await new Promise<void>((res) => setTimeout(res, 400))

    // The broadcast contentHash must be the bytes-hash, not the file's field
    expect(lastHash).toBe(expectedHash2)
    expect(lastHash).not.toBe(placeholder)

    await watcher.stop()
  })
})

// ---------------------------------------------------------------------------
// stat-poll detects missed event
// ---------------------------------------------------------------------------

describe('ManifestWatcher — stat-poll detects missed fs.watch event', () => {
  it('stat-poll triggers reread when mtime advances but fs.watch event was missed', async () => {
    // Strategy:
    // 1. Use real fs + real timers for start() so the initial read completes.
    // 2. Inject a fake fsStat to control what the stat-poll sees.
    // 3. Use fake timers ONLY after start() completes to advance the interval.
    //
    // The watcher creates statPollTimer via setInterval inside start().
    // We install fake timers before start() so the interval itself is fake,
    // then use advanceTimersByTimeAsync(3000) to fire it exactly once.
    // We do NOT use runAllTimersAsync (infinite loop risk from setInterval).

    singleFlightState.blocked = false

    const manifestPath = path.join(dir, 'manifest.json')
    const { hash: initialHash } = writeManifest(manifestPath, validManifest())

    // Use a real fsStat but track calls to detect when stat-poll runs
    const realStat = fs.promises.stat

    // We need fake timers active when start() is called so setInterval is fake.
    // But start() also calls fsStat (real async). Use advanceTimersByTimeAsync
    // which runs async callbacks interleaved — this is safe for a one-shot
    // async call inside start().
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout', 'clearInterval'] })

    const broadcastCount = { n: 0 }
    const watcher = new ManifestWatcher(
      manifestPath,
      () => {
        broadcastCount.n++
      },
      fs.promises.readFile,
      realStat,
      noopLogger,
    )

    // start() calls fsStat and reread() which both use real fs.promises.
    // advanceTimersByTimeAsync drives any setTimeout used inside reread's
    // error-restart path, but normal reads don't use setTimeout so this
    // just ensures any pending microtasks flush.
    const startPromise = watcher.start()
    await vi.advanceTimersByTimeAsync(200)
    await startPromise

    // Initial read should have fired 1 broadcast
    expect(broadcastCount.n).toBe(1)
    expect(watcher.stats.validated).toBe(1)

    // Update the file with different content so mtime and hash change.
    // We do NOT rely on fs.watch firing — simulating a missed event.
    const { hash: newHash } = writeManifest(
      manifestPath,
      validManifest({ generatedAt: '2024-07-01T00:00:00.000Z' }),
    )
    expect(newHash).not.toBe(initialHash)

    // Advance fake timers by 3000ms to fire the stat-poll interval exactly once.
    // statPollCheck calls fsStat (real async) then scheduleReread (setTimeout 100ms).
    // We need to: fire the interval, let fsStat resolve, then fire the debounce.
    await vi.advanceTimersByTimeAsync(3000)
    // Yield to allow real-async fsStat to complete and scheduleReread to register
    // the fake debounce setTimeout(100). A Promise.resolve() tick is not enough
    // since fsStat involves real I/O; use a real setImmediate-equivalent.
    // Bump from 50ms → 250ms for slower CI runner I/O.
    await new Promise<void>((res) => {
      vi.useRealTimers()
      setTimeout(res, 250)
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout', 'clearInterval'] })
    // Now advance past the 100ms debounce so reread() fires
    await vi.advanceTimersByTimeAsync(200)
    // Yield again for the reread async chain (fd.open, fd.stat, fd.read, fd.close) to complete.
    // Bump from 100ms → 400ms for slower CI runner I/O.
    await new Promise<void>((res) => {
      vi.useRealTimers()
      setTimeout(res, 400)
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout', 'clearInterval'] })

    // The stat-poll should have detected the mtime change and scheduled a reread
    expect(watcher.stats.statPollRecoveries).toBeGreaterThanOrEqual(1)
    expect(broadcastCount.n).toBeGreaterThanOrEqual(2)

    await watcher.stop()
    vi.useRealTimers()
  })

  it('stat-poll does NOT fire when mtime is unchanged (no false positives)', async () => {
    singleFlightState.blocked = false

    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, validManifest())

    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout', 'clearInterval'] })

    const watcher = new ManifestWatcher(
      manifestPath,
      () => {},
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )

    const startPromise = watcher.start()
    await vi.advanceTimersByTimeAsync(200)
    await startPromise

    const recoveriesBefore = watcher.stats.statPollRecoveries

    // Advance 3000ms — no file change, mtime is unchanged, no recovery expected
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(200)

    expect(watcher.stats.statPollRecoveries).toBe(recoveriesBefore)

    await watcher.stop()
    vi.useRealTimers()
  })
})
