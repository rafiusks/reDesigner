/**
 * End-to-end integration test for the daemon child process.
 *
 * Exercises the real spawn lifecycle: fork the built `dist/child.js`, await the
 * ready line on stdout, discover the handoff file, round-trip REST, round-trip
 * WS frames, then shut down gracefully. A second test verifies the SIGTERM
 * fallback when /shutdown is not used.
 *
 * Why we fork the built dist:
 *   The child module guards main() behind `fileURLToPath(import.meta.url) ===
 *   process.argv[1]` — importing it via vitest never runs main(). We must fork
 *   the built artifact to get the real boot sequence, real ephemeral port
 *   discovery, real handoff write, and real shutdown unlink.
 *
 * Key fixtures:
 *   - projectRoot is a randomTempDir(). The daemon resolves the handoff path
 *     from the hash of fs.realpathSync(projectRoot); that path lives outside
 *     projectRoot (under os.tmpdir()/com.redesigner.<uid>/ on darwin, under
 *     XDG_RUNTIME_DIR on linux). Each test uses a unique projectRoot so the
 *     hash (and therefore handoff path) is unique per run.
 *   - A valid minimal manifest is seeded at projectRoot/.redesigner/manifest.json
 *     BEFORE fork so /manifest returns 200 with ETag rather than 503 NotReady.
 *
 * API mismatches vs task description (upstream spec quirks, not test bugs):
 *   - Ready line shape: task described {"ready": true, ...}; actual shape is
 *     {"type":"ready","port":N,"instanceId":"..."} per serializeReadyLine().
 *   - WS auth: Authorization: Bearer <token> HTTP header on the WS upgrade
 *     request (not a subprotocol and not a query param). See src/ws/events.ts.
 *
 * Fork harness: `spawnDaemon()` + `forceKill()` + `seedManifest()` live in
 * test/helpers/forkDaemon.ts so manifestHmr.test.ts can reuse them.
 */

import fs from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { HandoffSchema } from '../../src/handoff.js'
import { CHILD_JS, type DaemonHarness, forceKill, spawnDaemon } from '../helpers/forkDaemon.js'
import { assertNoLeakedResources, snapshotResources } from '../helpers/leakDetector.js'
import { cleanupTempDirs } from '../helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Platform-timed constants
// ---------------------------------------------------------------------------

const SHUTDOWN_TIMEOUT_MS = 2_000
const WS_FRAME_TIMEOUT_MS = 500
const FETCH_TIMEOUT_MS = 2_000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemon endToEnd — fork + ready + REST + WS + graceful shutdown', () => {
  let before: Set<string>
  let harnesses: DaemonHarness[] = []

  beforeAll(() => {
    if (!fs.existsSync(CHILD_JS)) {
      throw new Error(
        `built child entry missing at ${CHILD_JS}; run \`pnpm --filter @redesigner/daemon build\` first`,
      )
    }
  })

  afterEach(async () => {
    for (const h of harnesses) {
      await forceKill(h.child)
      // Best-effort cleanup of the handoff file in case shutdown didn't run.
      try {
        fs.unlinkSync(h.handoffPath)
      } catch {}
    }
    harnesses = []
    cleanupTempDirs()
  })

  it('full round-trip: ready → handoff → REST → WS → /shutdown', async () => {
    before = snapshotResources()
    const h = await spawnDaemon({ tempDirPrefix: 'redesigner-e2e-' })
    harnesses.push(h)

    // ----- 1. Handoff validates against HandoffSchema exactly.
    const raw = fs.readFileSync(h.handoffPath, 'utf8')
    const parsed = HandoffSchema.parse(JSON.parse(raw))
    expect(parsed.instanceId).toBe(h.instanceId)
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(h.port)
    expect(parsed.projectRoot).toBe(h.projectRoot)

    // ----- 2. GET /health → 200
    const health = await fetch(`${h.urlPrefix}/health`, {
      headers: { Authorization: h.authHeader },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as Record<string, unknown>
    expect(healthBody.instanceId).toBe(h.instanceId)
    expect(healthBody.projectRoot).toBe(h.projectRoot)

    // ----- 3. GET /manifest — manifest was seeded before fork so expect 200 + ETag.
    const manifestRes = await fetch(`${h.urlPrefix}/manifest`, {
      headers: { Authorization: h.authHeader },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(manifestRes.status).toBe(200)
    expect(manifestRes.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)

    // ----- 4. Open WS BEFORE posting selection so we can observe the updated frame.
    const frames: unknown[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/events?since=0`, ['redesigner-v1'], {
      headers: {
        Host: `127.0.0.1:${h.port}`,
        Authorization: h.authHeader,
      },
    })

    const helloPromise = new Promise<{ seq: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('hello frame not received within 500ms')),
        WS_FRAME_TIMEOUT_MS,
      )
      timer.unref()
      ws.once('message', (data) => {
        clearTimeout(timer)
        const frame = JSON.parse(String(data)) as { type?: string; seq?: number }
        frames.push(frame)
        expect(frame.type).toBe('hello')
        resolve({ seq: frame.seq ?? 0 })
      })
      ws.once('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), FETCH_TIMEOUT_MS)
      timer.unref()
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', reject)
    })
    await helloPromise

    // Arm a listener for the next frame (selection.updated).
    const selectionUpdatedPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`selection.updated not received within ${WS_FRAME_TIMEOUT_MS}ms`)),
        WS_FRAME_TIMEOUT_MS,
      )
      timer.unref()
      const onMsg = (data: Buffer | ArrayBuffer | Buffer[]): void => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>
        frames.push(frame)
        if (frame.type === 'selection.updated') {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(frame)
        }
      }
      ws.on('message', onMsg)
    })

    // ----- 5. PUT /tabs/42/selection with a valid SelectionPutBody.
    const TAB_ID = 42
    const putBody = {
      nodes: [
        {
          id: 'sel-1',
          componentName: 'App',
          filePath: 'src/App.tsx',
          lineRange: [1, 10] as [number, number],
          domPath: 'html>body>div',
          parentChain: [],
          timestamp: Date.now(),
        },
      ],
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      meta: { source: 'dev' as const },
    }
    const postRes = await fetch(`${h.urlPrefix}/tabs/${TAB_ID}/selection`, {
      method: 'PUT',
      headers: {
        Authorization: h.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(putBody),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(postRes.status).toBe(200)
    const putResBody = (await postRes.json()) as { selectionSeq: number; acceptedAt: number }
    expect(typeof putResBody.selectionSeq).toBe('number')
    expect(putResBody.selectionSeq).toBeGreaterThanOrEqual(1)

    // ----- 6. GET /selection returns the PUT handle.
    const getRes = await fetch(`${h.urlPrefix}/selection`, {
      headers: { Authorization: h.authHeader },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { current: { id: string } | null }
    expect(getBody.current?.id).toBe('sel-1')

    // ----- 7. GET /selection/recent contains it.
    const recentRes = await fetch(`${h.urlPrefix}/selection/recent`, {
      headers: { Authorization: h.authHeader },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(recentRes.status).toBe(200)
    const recentBody = (await recentRes.json()) as Array<{ id: string }>
    expect(recentBody.some((r) => r.id === 'sel-1')).toBe(true)

    // ----- 8. selection.updated frame arrived within 500ms.
    const selUpdated = await selectionUpdatedPromise
    expect(selUpdated.type).toBe('selection.updated')
    expect((selUpdated.payload as { current: { id: string } }).current.id).toBe('sel-1')

    // ----- 9. POST /shutdown with matching instanceId — 200, child exits 0 within 2s.
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        h.child.once('exit', (code, signal) => resolve({ code, signal }))
      },
    )

    // Close WS first to avoid racing the shutdown broadcast with an unhandled error.
    ws.close()

    const shutdownRes = await fetch(`${h.urlPrefix}/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: h.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instanceId: h.instanceId }),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(shutdownRes.status).toBe(200)

    const exit = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child did not exit within ${SHUTDOWN_TIMEOUT_MS}ms`)),
          SHUTDOWN_TIMEOUT_MS,
        )
        timer.unref()
      }),
    ])
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()

    // ----- 10. Handoff file unlinked by shutdownGracefully.
    expect(fs.existsSync(h.handoffPath)).toBe(false)

    // ----- 11. No leaked resources in the parent.
    // 'exit' fires before the underlying ProcessWrap handle is finalised; wait
    // for 'close' (stdio fds flushed + handle retired) before snapshotting.
    if (h.child.exitCode === null && h.child.signalCode === null) {
      await new Promise<void>((resolve) => h.child.once('close', () => resolve()))
    } else {
      // Already exited; still await one 'close' tick if stdio hasn't closed.
      await new Promise<void>((resolve) => {
        if (
          (h.child.stdout === null || h.child.stdout.destroyed) &&
          (h.child.stderr === null || h.child.stderr.destroyed)
        ) {
          resolve()
        } else {
          h.child.once('close', () => resolve())
        }
      })
    }
    // Remove remaining listeners so the process handle can retire on the next tick.
    h.child.removeAllListeners()
    // Give libuv a few event-loop turns to release the ProcessWrap handle; on
    // Node 22 the handle is retired asynchronously after 'close' + 'exit'.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const after = snapshotResources()
    assertNoLeakedResources(before, after)
  })

  it('SIGTERM fallback: child exits cleanly when signalled without /shutdown', async () => {
    const h = await spawnDaemon({ tempDirPrefix: 'redesigner-e2e-' })
    harnesses.push(h)

    // Don't call /shutdown. Send SIGTERM directly; the signal handler in child.ts
    // drives the same shutdownGracefully path.
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        h.child.once('exit', (code, signal) => resolve({ code, signal }))
      },
    )
    h.child.kill('SIGTERM')

    const exit = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`)),
          SHUTDOWN_TIMEOUT_MS,
        )
        timer.unref()
      }),
    ])
    // Graceful path: process.exit(0) runs after shutdownGracefully, so code=0 + signal=null.
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()

    // Handoff must still be unlinked on the SIGTERM path.
    expect(fs.existsSync(h.handoffPath)).toBe(false)
  })
})
