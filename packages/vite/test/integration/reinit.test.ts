/**
 * E-11: reinit — simulates a Vite config-change restart and verifies the four
 * invariants from §8.3 of the design spec.
 *
 * Strategy: Option B (manual lifecycle) — create a server, trigger closeBundle
 * on the plugin directly, then create a fresh server. Option A (server.restart())
 * was not used because Vite's restart machinery depends on real file-watchers that
 * are unreliable in a headless vitest environment.
 *
 * Invariants tested:
 *   1. Old writer released the owner-lock after shutdown.
 *   2. New writer produced an empty manifest immediately on construction.
 *   3. process._getActiveHandles() count is stable (±1 tolerance) across the restart.
 *   4. No duplicate-daemon warnings in logger output (trivially satisfied when
 *      @redesigner/daemon is absent, but the capture confirms no double-start path ran).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ESBuildOptions,
  type InlineConfig,
  type Logger,
  type Plugin,
  type ViteDevServer,
  createServer,
} from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../../src/core/types-public'
import redesigner from '../../src/index'

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')

// Build a minimal ViteDevServer config.
function baseServerConfig(
  dir: string,
  manifestPath: string,
  extra: Partial<InlineConfig> = {},
): InlineConfig {
  return {
    root: dir,
    configFile: false,
    esbuild: { jsx: 'automatic' } as ESBuildOptions,
    server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
    resolve: {
      alias: {
        'react/jsx-dev-runtime': path.join(REACT_DIR, 'jsx-dev-runtime.js'),
        'react/jsx-runtime': path.join(REACT_DIR, 'jsx-runtime.js'),
        react: path.join(REACT_DIR, 'index.js'),
      },
    },
    clearScreen: false,
    ...extra,
    plugins: [
      redesigner({ daemon: 'off', manifestPath }),
      ...(extra.plugins ? (Array.isArray(extra.plugins) ? extra.plugins : [extra.plugins]) : []),
    ],
  }
}

// Scaffold a minimal tmpdir project.
function scaffoldProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(
    path.join(dir, 'src/App.tsx'),
    'export default function App() { return <div>hello</div> }\n',
  )
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'reinit-test', type: 'module', version: '0.0.0', private: true }),
  )
  return dir
}

// Race server.close() against a 2s ceiling to avoid macOS watcher hang.
async function safeClose(server: ViteDevServer | undefined): Promise<void> {
  if (!server) return
  await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
}

// Find the redesigner plugin in a server's resolved plugin list.
function findRedesignerPlugin(server: ViteDevServer): Plugin | undefined {
  return server.config.plugins.find((p) => p.name === 'redesigner')
}

// Invoke closeBundle on a plugin (it may be async or wrapped in a Rollup hook object).
async function invokeCloseBundle(plugin: Plugin): Promise<void> {
  if (typeof plugin.closeBundle === 'function') {
    await (plugin.closeBundle as () => Promise<void>)()
    return
  }
  if (
    plugin.closeBundle &&
    typeof plugin.closeBundle === 'object' &&
    'handler' in plugin.closeBundle
  ) {
    const handler = (plugin.closeBundle as { handler: () => Promise<void> }).handler
    if (typeof handler === 'function') {
      await handler()
    }
  }
}

// Read manifest JSON from disk.
function readManifestSync(p: string): Manifest {
  return JSON.parse(readFileSync(p, 'utf8')) as Manifest
}

// Snapshot active handle count.
function activeHandleCount(): number {
  return (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length
}

// ─────────────────────────────────────────────────────────────────────────────
// Reinit lifecycle test
// ─────────────────────────────────────────────────────────────────────────────
describe('reinit: plugin restart lifecycle', () => {
  let dir: string
  let server1: ViteDevServer | undefined
  let server2: ViteDevServer | undefined

  // manifestPath is relative to the project root — keep it inside the tmpdir so
  // each test is isolated and the .owner-lock probe is reliable.
  const REL_MANIFEST = '.redesigner/manifest.json'

  beforeEach(() => {
    dir = scaffoldProject('redesigner-reinit-')
    server1 = undefined
    server2 = undefined
  }, 5000)

  afterEach(async () => {
    // Defensive cleanup: server2 first (most recent), then server1.
    await safeClose(server2)
    server2 = undefined
    await safeClose(server1)
    server1 = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('old shutdown fires, new writer is clean, handles stable, no duplicate daemon', async () => {
    // ─── Capture active handles BEFORE first server starts ───────────────
    const handlesBefore = activeHandleCount()

    // ─── Capture logger output for daemon duplication invariant ──────────
    const warnings1: string[] = []
    const warnings2: string[] = []

    const makeLogger = (bucket: string[]): Logger => ({
      info: vi.fn(),
      warn: (_msg: string) => {
        bucket.push(_msg)
      },
      warnOnce: vi.fn(),
      error: vi.fn(),
      clearScreen: vi.fn(),
      hasErrorLogged: vi.fn(() => false),
      hasWarned: false,
    })

    // ─── Phase 1: start OLD server ────────────────────────────────────────
    server1 = await createServer({
      ...baseServerConfig(dir, REL_MANIFEST, { customLogger: makeLogger(warnings1) }),
    })

    const manifestPath = path.join(dir, REL_MANIFEST)
    const lockPath = `${manifestPath}.owner-lock`

    // Immediately after server1 starts, the manifest and lock must exist.
    expect(existsSync(manifestPath), 'manifest written synchronously on startup').toBe(true)
    expect(existsSync(lockPath), 'owner-lock acquired on startup').toBe(true)

    // Do a transform so server1 has some state (a non-empty flush later distinguishes old
    // from new). We do this to ensure server1 actually wrote something to its internal
    // state map before we trigger shutdown.
    await server1.transformRequest('/src/App.tsx')

    // ─── Phase 2: simulate restart — trigger old closeBundle ─────────────
    const oldPlugin = findRedesignerPlugin(server1)
    expect(oldPlugin, 'redesigner plugin found in server1').toBeDefined()
    if (!oldPlugin) return

    await invokeCloseBundle(oldPlugin)

    // After closeBundle: lock must be released (unlinked by shutdown()).
    expect(existsSync(lockPath), 'owner-lock released after old writer shutdown').toBe(false)

    // Invariant 1: the lock was cleared, meaning a new writer CAN acquire it.
    // Confirm by probing with openSync wx — this would throw if the lock still existed.
    // We then close it immediately.
    let probeFd: number | null = null
    try {
      probeFd = openSync(lockPath, 'wx')
    } catch (err) {
      throw new Error(`Invariant 1 FAILED: owner-lock was not released after closeBundle. ${err}`)
    } finally {
      if (probeFd !== null) {
        try {
          closeSync(probeFd)
          unlinkSync(lockPath)
        } catch {}
      }
    }

    // ─── Phase 3: start NEW server (simulates Vite rebuild after config change) ──
    // This must succeed — if the old lock was still held, ManifestWriter would throw
    // "two dev servers targeting the same manifestPath".
    server2 = await createServer({
      ...baseServerConfig(dir, REL_MANIFEST, { customLogger: makeLogger(warnings2) }),
    })

    // Invariant 2: new manifest has empty components/locs (fresh ManifestWriter state).
    const newManifest = readManifestSync(manifestPath)
    expect(
      Object.keys(newManifest.components),
      'new writer manifest has empty components',
    ).toHaveLength(0)
    expect(Object.keys(newManifest.locs), 'new writer manifest has empty locs').toHaveLength(0)
    expect(newManifest.schemaVersion, 'new manifest has correct schema version').toBe('1.0')

    // ─── Phase 4: teardown server2 gracefully ────────────────────────────
    const newPlugin = findRedesignerPlugin(server2)
    expect(newPlugin, 'redesigner plugin found in server2').toBeDefined()
    if (newPlugin) await invokeCloseBundle(newPlugin)

    await safeClose(server2)
    server2 = undefined

    await safeClose(server1)
    server1 = undefined

    // ─── Invariant 3: handle count stable ────────────────────────────────
    // Measure AFTER both servers are closed. The count must not grow by ≥2
    // compared to the pre-first-server baseline.
    const handlesAfter = activeHandleCount()
    const leak = handlesAfter - handlesBefore
    expect(
      leak,
      `Handle leak detected: +${leak} handles. Before=${handlesBefore}, After=${handlesAfter}`,
    ).toBeLessThan(2)

    // ─── Invariant 4: no duplicate daemon ────────────────────────────────
    // daemon: 'off' means DaemonBridge.start() returns immediately — no warnings expected.
    // We confirm no start/warning path was triggered twice in either session.
    const allWarnings = [...warnings1, ...warnings2]
    const daemonStartWarnings = allWarnings.filter(
      (w) =>
        w.includes('daemon package not installed') ||
        w.includes('daemon package errored on import') ||
        w.includes('daemon started'),
    )
    // With daemon: 'off', zero daemon-related warnings should exist.
    expect(daemonStartWarnings, 'no daemon warnings expected when daemon is off').toHaveLength(0)
  }, 30000)
})
