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
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { HandoffSchema, discoverHandoff, resolveHandoffPath } from '../../src/handoff.js'
import { assertNoLeakedResources, snapshotResources } from '../helpers/leakDetector.js'
import { cleanupTempDirs, randomTempDir } from '../helpers/randomTempDir.js'

// ---------------------------------------------------------------------------
// Platform-timed constants
// ---------------------------------------------------------------------------

const READY_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 2_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const WS_FRAME_TIMEOUT_MS = 500
const FETCH_TIMEOUT_MS = 2_000

// ---------------------------------------------------------------------------
// Paths to built artefacts
// ---------------------------------------------------------------------------

// import.meta.dirname is available on Node ≥22 per package engines.
const INTEGRATION_DIR = import.meta.dirname
const PACKAGE_DIR = path.resolve(INTEGRATION_DIR, '..', '..')
const CHILD_JS = path.join(PACKAGE_DIR, 'dist', 'child.js')

// ---------------------------------------------------------------------------
// Spawn harness
// ---------------------------------------------------------------------------

interface Harness {
  child: ChildProcess
  projectRoot: string
  manifestPath: string
  handoffPath: string
  port: number
  instanceId: string
  token: string
  urlPrefix: string
  authHeader: string
}

/**
 * Write a minimal valid manifest so /manifest returns 200 instead of 503.
 * The contentHash is ignored by ManifestWatcher — it recomputes from raw bytes
 * — but the schema requires a valid 64-char hex string.
 */
function seedManifest(manifestPath: string): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const manifest = {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: '0'.repeat(64),
    components: {
      'src/App.tsx::App': {
        filePath: 'src/App.tsx',
        exportKind: 'default' as const,
        lineRange: [1, 10],
        displayName: 'App',
      },
    },
    locs: {},
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
}

/**
 * Fork dist/child.js, await the ready line (JSON on stdout with `{type:'ready'}`),
 * discover the handoff, and return a harness.
 */
async function spawnDaemon(): Promise<Harness> {
  const projectRoot = randomTempDir('redesigner-e2e-')
  const realProjectRoot = fs.realpathSync(projectRoot)
  const manifestPath = path.join(realProjectRoot, '.redesigner', 'manifest.json')
  seedManifest(manifestPath)
  const handoffPath = resolveHandoffPath(realProjectRoot)

  const child = fork(CHILD_JS, [], {
    env: {
      ...process.env,
      REDESIGNER_MANIFEST_PATH: manifestPath,
      REDESIGNER_DAEMON_VERSION: '0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  let ready: { port: number; instanceId: string } | null = null
  let stdoutBuf = ''
  let stderrBuf = ''

  const readyPromise = new Promise<{ port: number; instanceId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `ready line not received within ${READY_TIMEOUT_MS}ms; ` +
            `stdout=${JSON.stringify(stdoutBuf)} stderr=${JSON.stringify(stderrBuf)}`,
        ),
      )
    }, READY_TIMEOUT_MS)
    timer.unref()

    const onStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf8')
      // Ready line is newline-terminated; scan complete lines.
      let nl = stdoutBuf.indexOf('\n')
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as {
              type?: unknown
              port?: unknown
              instanceId?: unknown
            }
            if (
              parsed.type === 'ready' &&
              typeof parsed.port === 'number' &&
              typeof parsed.instanceId === 'string'
            ) {
              clearTimeout(timer)
              child.stdout?.off('data', onStdout)
              child.stderr?.off('data', onStderr)
              ready = { port: parsed.port, instanceId: parsed.instanceId }
              resolve(ready)
              return
            }
          } catch {
            // Non-JSON stdout line — ignore and continue.
          }
        }
        nl = stdoutBuf.indexOf('\n')
      }
    }
    const onStderr = (chunk: Buffer): void => {
      stderrBuf += chunk.toString('utf8')
    }
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('exit', (code, signal) => {
      if (ready === null) {
        clearTimeout(timer)
        reject(
          new Error(`child exited before ready: code=${code} signal=${signal} stderr=${stderrBuf}`),
        )
      }
    })
  })

  const { port, instanceId } = await readyPromise

  // Discover handoff to get the token (daemon minted it internally and wrote the file).
  const discovery = discoverHandoff(realProjectRoot)
  if (!discovery) {
    throw new Error(`handoff not discoverable at ${handoffPath}`)
  }
  // Validate exactly against HandoffSchema.
  const validated = HandoffSchema.parse(discovery.parsed)
  expect(validated.instanceId).toBe(instanceId)
  expect(validated.port).toBe(port)

  return {
    child,
    projectRoot: realProjectRoot,
    manifestPath,
    handoffPath,
    port,
    instanceId,
    token: discovery.parsed.token,
    urlPrefix: discovery.urlPrefix,
    authHeader: discovery.authHeader,
  }
}

/**
 * Force-kill the child if still alive; wait for exit; return whether it was
 * already gone. Used in afterEach so a failed test cannot leak a child.
 */
async function forceKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    try {
      child.kill('SIGKILL')
    } catch {
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemon endToEnd — fork + ready + REST + WS + graceful shutdown', () => {
  let before: Set<string>
  let harnesses: Harness[] = []

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
    const h = await spawnDaemon()
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
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/events?since=0`, {
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

    // ----- 5. POST /selection with a valid ComponentHandle.
    const handle = {
      id: 'sel-1',
      componentName: 'App',
      filePath: 'src/App.tsx',
      lineRange: [1, 10] as [number, number],
      domPath: 'html>body>div',
      parentChain: [],
      timestamp: Date.now(),
    }
    const postRes = await fetch(`${h.urlPrefix}/selection`, {
      method: 'POST',
      headers: {
        Authorization: h.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(handle),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(postRes.status).toBe(200)
    const postBody = (await postRes.json()) as { kind: string; current: { id: string } | null }
    expect(postBody.kind).toBe('new')
    expect(postBody.current?.id).toBe('sel-1')

    // ----- 6. GET /selection returns the posted handle.
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
    const h = await spawnDaemon()
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
