/**
 * E-14: daemon-real — drives `DaemonBridge.start()` against three real local
 * fixture packages in `test/fixtures/_daemon-packages/{throws,no-export,tla}`.
 * Each fixture is imported by absolute file path so Node treats it as a distinct
 * ESM entry (separate spec, separate import-cache slot). That matters for the
 * `tla` case: its top-level-await never resolves, and Node has no API to abort
 * an in-flight import. The bridge races it against a 2s timer and continues
 * (auto) or throws (required), but the pending import keeps leaking in the
 * background. We run inside `pool: 'forks', isolate: true, fileParallelism:
 * false` (test/vitest.daemon-real.config.ts) so that leaked import dies with
 * the fork rather than pinning the vitest worker pool.
 *
 * Fixtures use `_` prefix on the parent dir so test/fixtures/_runner.test.ts
 * (which auto-discovers fixture/input.tsx pairs) skips them — same trick as
 * _fake-daemon from E-16.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonBridge } from '../../src/integration/daemonBridge'

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const PKG_DIR = path.join(PKG_ROOT, 'test/fixtures/_daemon-packages')
// Import by file:// URL — avoids node module resolution entirely and guarantees
// each fixture gets its own import-cache entry keyed by absolute path.
const THROWS_URL = pathToFileURL(path.join(PKG_DIR, 'throws/index.js')).href
const NO_EXPORT_URL = pathToFileURL(path.join(PKG_DIR, 'no-export/index.js')).href
const TLA_URL = pathToFileURL(path.join(PKG_DIR, 'tla/index.js')).href

interface Collector {
  info: string[]
  warn: string[]
  error: string[]
  debug: string[]
  logger: {
    info: (m: string) => void
    warn: (m: string) => void
    error: (m: string) => void
    debug: (m: string) => void
  }
}

function makeCollector(): Collector {
  const c = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    debug: [] as string[],
  }
  return {
    ...c,
    logger: {
      info: (m: string) => c.info.push(m),
      warn: (m: string) => c.warn.push(m),
      error: (m: string) => c.error.push(m),
      debug: (m: string) => c.debug.push(m),
    },
  }
}

// Swallow unhandled rejections originating from the leaked TLA import. The
// TLA fixture hangs on `await new Promise(() => {})` which never rejects, but
// we guard against any surprise rejection from the worker's microtask queue
// polluting the test run.
function installUnhandledGuard(): () => void {
  const seen: unknown[] = []
  const handler = (reason: unknown) => {
    seen.push(reason)
  }
  process.on('unhandledRejection', handler)
  return () => {
    process.off('unhandledRejection', handler)
  }
}

describe('DaemonBridge start (real fixture packages)', () => {
  let uninstallGuard: (() => void) | undefined

  beforeEach(() => {
    uninstallGuard = installUnhandledGuard()
  })

  afterEach(() => {
    uninstallGuard?.()
    uninstallGuard = undefined
  })

  it('auto + throws package → no throw, warn captured, shutdown safe', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    await expect(
      bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: () => import(THROWS_URL),
        logger: c.logger,
      }),
    ).resolves.toBeUndefined()
    // The fixture `throw new Error('simulated daemon package bootstrap failure')`
    // has no ERR_MODULE_* code, so it hits the generic-error branch.
    expect(c.warn).toHaveLength(1)
    expect(c.warn[0]).toContain('errored on import')
    expect(c.warn[0]).toContain('simulated daemon package bootstrap failure')
    // Shutdown must be a no-op after a failed start (no handle was ever set).
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)

  it('auto + no-export package → no throw, warn captured, shutdown safe', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    await expect(
      bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        // Cast through unknown: the fixture does not satisfy the importer's
        // return type (missing startDaemon), which is exactly the condition
        // under test — the bridge's shape check must catch it at runtime.
        importer: () =>
          import(NO_EXPORT_URL) as unknown as ReturnType<
            Parameters<typeof bridge.start>[0]['importer']
          >,
        logger: c.logger,
      }),
    ).resolves.toBeUndefined()
    expect(c.warn).toHaveLength(1)
    expect(c.warn[0]).toContain('does not export startDaemon')
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)

  it('auto + tla package → bounded start (<3s), warn captured, shutdown safe', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    const t0 = Date.now()
    await expect(
      bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: () => import(TLA_URL),
        logger: c.logger,
      }),
    ).resolves.toBeUndefined()
    const elapsed = Date.now() - t0
    // Timer is 2s; generous slack for CI scheduling but must stay under 3s
    // to prove the race actually fired (not just that the test itself timed out).
    expect(elapsed).toBeGreaterThanOrEqual(1_800)
    expect(elapsed).toBeLessThan(3_000)
    expect(c.warn).toHaveLength(1)
    expect(c.warn[0]).toContain('timed out')
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)

  it('required + throws package → rejects with package error message', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    let caught: Error | undefined
    try {
      await bridge.start({
        mode: 'required',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: () => import(THROWS_URL),
        logger: c.logger,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/daemon required but errored on import/)
    // Original package error message is preserved in the rewrap.
    expect(caught?.message).toContain('simulated daemon package bootstrap failure')
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)

  it('required + no-export package → rejects', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    await expect(
      bridge.start({
        mode: 'required',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: () =>
          import(NO_EXPORT_URL) as unknown as ReturnType<
            Parameters<typeof bridge.start>[0]['importer']
          >,
        logger: c.logger,
      }),
    ).rejects.toThrow(/daemon required but package does not export startDaemon/)
    // After a rejected start(), shutdown must still be safe (idempotent no-op).
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)

  it('required + tla package → rejects within bounded time', async () => {
    const c = makeCollector()
    const bridge = new DaemonBridge()
    const t0 = Date.now()
    await expect(
      bridge.start({
        mode: 'required',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: () => import(TLA_URL),
        logger: c.logger,
      }),
    ).rejects.toThrow(/daemon required but import timed out/)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(1_800)
    expect(elapsed).toBeLessThan(3_000)
    await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()
  }, 10_000)
})
