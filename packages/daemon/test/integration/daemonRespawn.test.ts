/**
 * MCP shim ↔ daemon respawn integration.
 *
 * Task 32 of daemon v0 plan — File 2. Exercises the DaemonBackend shim's
 * recovery behavior across a real daemon kill + respawn cycle.
 *
 * Scenarios:
 *   1. Kill → respawn: first call after daemon dies returns null (connect
 *      refused; shim caches `unreachable`). After test-owned respawn (simulating
 *      the Vite bridge's respawn policy) and one UNREACHABLE_TTL_MS window,
 *      a subsequent call re-discovers the handoff and succeeds.
 *   2. Token rotation: kill daemon; respawn; the cached auth header is now
 *      stale. Next call → 401 → 100ms backoff → invalidate cache → full
 *      re-discovery → re-read handoff (new token) → retry → 200.
 *
 * Why the test owns respawn (not the bridge):
 *   The "bridge respawn" is implemented in packages/vite/src/integration/
 *   daemonBridge.ts and is tightly coupled to Vite's HMR lifecycle. Driving a
 *   full Vite dev server in a daemon integration test is out of scope. We
 *   simulate the bridge's role by re-forking the daemon manually after
 *   confirming the old one has exited; the shim-side contract (ECONNREFUSED
 *   → re-discover, 401 → backoff+invalidate+re-discover, eventual success) is
 *   the actual assertion surface.
 *
 * Timing / UNREACHABLE_TTL_MS notes:
 *   DaemonBackend.UNREACHABLE_TTL_MS = 1000ms. After a connection failure,
 *   `isUnreachable()` short-circuits subsequent calls for 1s to avoid
 *   thundering-retry. Tests that need a "first post-respawn call" to actually
 *   hit the network must wait out that window. We use an explicit 1100ms sleep
 *   to cross the TTL boundary with margin.
 *
 * API mismatches vs task description:
 *   - The "bridge-level respawn" described in the task is not reified as an
 *     in-scope component here; we substitute a test-managed respawn. See above.
 *   - Task mentions "token-rotated → shim 401". The shim's current
 *     getCurrentSelection() path handles 401 by sleeping 100ms, invalidating
 *     its parsed cache, re-discovering, and retrying. This is the code path
 *     we exercise.
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DaemonBackend } from '../../../mcp/src/daemonBackend.js'
import { HandoffSchema, resolveHandoffPath } from '../../src/handoff.js'
import {
  CHILD_JS,
  type DaemonHarness,
  forceKill,
  seedManifest,
  spawnDaemon,
} from '../helpers/forkDaemon.js'
import { cleanupTempDirs, randomTempDir } from '../helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const READY_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 2_000
// DaemonBackend.UNREACHABLE_TTL_MS = 1000. Sleep with margin to cross the TTL.
const UNREACHABLE_WAIT_MS = 1_100
// DaemonBackend.AUTH_RETRY_SLEEP_MS = 100. Nothing to wait for in the test
// itself — the shim sleeps internally and re-discovers.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Fork a daemon against an existing projectRoot + manifestPath (used for
 * respawning where spawnDaemon would randomize the projectRoot).
 */
async function forkDaemonAt(
  manifestPath: string,
): Promise<{ child: ChildProcess; port: number; instanceId: string }> {
  const child = fork(CHILD_JS, [], {
    env: {
      ...process.env,
      REDESIGNER_MANIFEST_PATH: manifestPath,
      REDESIGNER_DAEMON_VERSION: '0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const ready = await new Promise<{ port: number; instanceId: string }>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`ready timeout after ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    )
    t.unref()
    let buf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) {
          try {
            const parsed = JSON.parse(line) as { type?: string; port?: number; instanceId?: string }
            if (parsed.type === 'ready' && parsed.port && parsed.instanceId) {
              clearTimeout(t)
              resolve({ port: parsed.port, instanceId: parsed.instanceId })
              return
            }
          } catch {}
        }
        nl = buf.indexOf('\n')
      }
    })
    child.once('exit', (code) => {
      if (code !== null) reject(new Error(`daemon exited ${code} before ready`))
    })
  })
  return { child, port: ready.port, instanceId: ready.instanceId }
}

/** Kill daemon and await full exit (handoff unlinked by shutdown path). */
async function killAndAwait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise<void>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error('daemon did not exit on SIGTERM within 2s')),
        2_000,
      )
      t.unref()
    }),
  ])
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('daemon respawn — MCP shim recovery across kill + respawn', () => {
  const harnesses: DaemonHarness[] = []
  const extraChildren: ChildProcess[] = []

  beforeAll(() => {
    if (!fs.existsSync(CHILD_JS)) {
      throw new Error(
        `built child entry missing at ${CHILD_JS}; run \`pnpm --filter @redesigner/daemon build\` first`,
      )
    }
  })

  afterEach(async () => {
    for (const c of extraChildren) {
      await forceKill(c)
    }
    extraChildren.length = 0
    for (const h of harnesses) {
      await forceKill(h.child)
      try {
        fs.unlinkSync(h.handoffPath)
      } catch {}
    }
    harnesses.length = 0
    cleanupTempDirs()
  })

  // -------------------------------------------------------------------------
  // Scenario 1: kill + test-managed respawn → shim re-discovers and recovers.
  // -------------------------------------------------------------------------
  it('kill daemon → shim returns null until respawn → next-call re-discovers + succeeds', async () => {
    const h = await spawnDaemon({ tempDirPrefix: 'redesigner-resp-kill-' })
    harnesses.push(h)

    const backend = new DaemonBackend({
      projectRoot: h.projectRoot,
      manifestPath: h.manifestPath,
      selectionPath: path.join(h.manifestDir, 'selection.json'),
    })

    // Warm-up: first call cold-reads handoff, succeeds.
    const first = await backend.getCurrentSelection()
    expect(first).toBeNull() // empty selection; 200 with { current: null }

    // Kill daemon + await exit. The handoff file is unlinked by the shutdown
    // path, so the post-kill call will hit `handoff missing` → unreachable.
    await killAndAwait(h.child)
    expect(fs.existsSync(h.handoffPath)).toBe(false)

    // Call after kill — handoff gone → discoverHandoff fails → markUnreachable.
    const afterKill = await backend.getCurrentSelection()
    expect(afterKill).toBeNull()

    // Simulate the bridge's respawn-once-with-backoff: wait past the
    // UNREACHABLE_TTL_MS window, then re-fork the daemon with the SAME project
    // root (same manifest path → same handoff path → shim's cached path
    // survives and resolves to a fresh, valid file).
    await sleep(UNREACHABLE_WAIT_MS)

    const respawn = await forkDaemonAt(h.manifestPath)
    extraChildren.push(respawn.child)
    expect(respawn.instanceId).not.toBe(h.instanceId) // fresh instance

    // Next call — the shim's cached handoff.parsed is stale or null; the path
    // is cached. discoverHandoff re-reads the file, re-verifies pid live, and
    // succeeds. Selection is empty → 200 with { current: null }.
    const afterRespawn = await backend.getCurrentSelection()
    expect(afterRespawn).toBeNull()

    // Sanity: the new handoff reports the respawned instanceId.
    const newHandoff = HandoffSchema.parse(JSON.parse(fs.readFileSync(h.handoffPath, 'utf8')))
    expect(newHandoff.instanceId).toBe(respawn.instanceId)
    expect(newHandoff.pid).toBe(respawn.child.pid)
  }, 15_000)

  // -------------------------------------------------------------------------
  // Scenario 2: token rotation — 401 triggers backoff + re-discovery.
  //
  // Sequence:
  //   1. Start daemon A. backend.getCurrentSelection() warms handoff cache
  //      with A's token.
  //   2. Kill A, respawn daemon B — fresh token + fresh instanceId. The
  //      handoff file on disk now contains B's token; the backend's IN-MEMORY
  //      cache still has A's authHeader.
  //   3. Wait out UNREACHABLE_TTL_MS so the backend's circuit breaker from the
  //      kill-phase fetch failure doesn't short-circuit the next call.
  //   4. Call getCurrentSelection() with the stale cache.
  //        - Network call uses A's (stale) auth header → 401 from daemon B.
  //        - Shim: recordAuthFail → sleep 100ms → invalidateParsed +
  //          discoverHandoff → reads file → B's token now loaded → retry → 200.
  // -------------------------------------------------------------------------
  it('token rotation on respawn → shim 401 → re-discover → retry succeeds', async () => {
    const projectRoot = randomTempDir('redesigner-resp-tok-')
    const realProjectRoot = fs.realpathSync(projectRoot)
    const manifestPath = path.join(realProjectRoot, '.redesigner', 'manifest.json')
    seedManifest(manifestPath)
    const handoffPath = resolveHandoffPath(realProjectRoot)

    // Start daemon A.
    const daemonA = await forkDaemonAt(manifestPath)
    extraChildren.push(daemonA.child)
    const handoffA = HandoffSchema.parse(JSON.parse(fs.readFileSync(handoffPath, 'utf8')))

    const backend = new DaemonBackend({
      projectRoot: realProjectRoot,
      manifestPath,
      selectionPath: path.join(realProjectRoot, '.redesigner', 'selection.json'),
    })

    // Warm up: backend caches A's authHeader.
    expect(await backend.getCurrentSelection()).toBeNull()

    // Kill daemon A; handoff is unlinked.
    await killAndAwait(daemonA.child)
    extraChildren.length = 0 // already killed+awaited
    expect(fs.existsSync(handoffPath)).toBe(false)

    // Respawn daemon B with the SAME manifest path. Fresh crypto randomBytes →
    // new token. Fresh crypto.randomUUID → new instanceId. Since the handoff
    // file was cleanly unlinked, B boots via the happy path (no reclaim).
    const daemonB = await forkDaemonAt(manifestPath)
    extraChildren.push(daemonB.child)
    const handoffB = HandoffSchema.parse(JSON.parse(fs.readFileSync(handoffPath, 'utf8')))
    expect(handoffB.token).not.toBe(handoffA.token) // token rotated
    expect(handoffB.instanceId).not.toBe(handoffA.instanceId)

    // Cross the UNREACHABLE_TTL_MS window so the backend's cached unreachable
    // verdict (from the post-kill ECONNREFUSED) doesn't short-circuit.
    await sleep(UNREACHABLE_WAIT_MS)

    // The backend still has A's cached authHeader in memory. Next call:
    //   - Fetch #1 → 401 (B rejects A's token)
    //   - recordAuthFail → sleep 100ms → invalidate + re-discover → reads new token
    //   - Fetch #2 → 200 with { current: null }
    // Result: null (empty selection), NOT a thrown error, NOT a permanent trip.
    const result = await backend.getCurrentSelection()
    expect(result).toBeNull()

    // A subsequent call should work immediately (cache now has B's token).
    const result2 = await backend.getCurrentSelection()
    expect(result2).toBeNull()
  }, 15_000)
})
