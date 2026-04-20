/**
 * E-16: shutdown — real-subprocess integration test for DaemonBridge.
 *
 * Spawns the fake daemon at test/fixtures/fake-daemon/daemon.mjs via
 * `['node', path]` with `shell: false` and `stdio: ['pipe','pipe','pipe']`,
 * then drives DaemonBridge.shutdown() and observes OS-level behavior:
 *
 *   POSIX: SIGTERM → clean flush; if no exit within 2 s, escalate to SIGKILL.
 *   Windows: stdin `{"op":"shutdown"}\n` → 1.5 s ack timeout → on ack, 1.5 s
 *            exit wait; otherwise fallback to `taskkill /T /F`.
 *   Idempotency: double-call performs one flush + one signal/taskkill.
 *
 * `testTimeout: 10_000` because the Windows fallback path spends 1.5 s on the
 * ack timer plus up to 1.5 s spawning taskkill — too thin against the 5 s default.
 */

import { type ChildProcess, spawn as nodeSpawn, type spawn as spawnType } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonBridge, type DaemonHandle } from '../../src/integration/daemonBridge'

const isPosix = process.platform !== 'win32'
const isWindows = process.platform === 'win32'
const itPosix = isPosix ? it : it.skip
const itWindows = isWindows ? it : it.skip

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
// Underscore prefix opts the directory out of the fixture runner at
// test/fixtures/_runner.test.ts (it skips `_`-prefixed dirs).
const FAKE_DAEMON = path.join(PKG_ROOT, 'test/fixtures/_fake-daemon/daemon.mjs')

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

// Spawn the fake daemon and return a DaemonHandle + the raw ChildProcess so
// tests can observe exit semantics (`.signalCode`, `.exitCode`, `.killed`).
function spawnFakeDaemon(mode: string): { handle: DaemonHandle; child: ChildProcess } {
  const child = nodeSpawn('node', [FAKE_DAEMON, mode], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!child.stdout || !child.stdin || !child.stderr) {
    throw new Error('fake daemon spawned without pipes')
  }
  // Fail fast if node couldn't launch (rare: missing binary etc.)
  child.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[fake-daemon] spawn error:', err)
  })
  const handle: DaemonHandle = {
    pid: child.pid ?? -1,
    shutdown: async () => {
      /* unused by DaemonBridge; see daemonBridge.ts shutdown() — it signals
         the pid directly rather than delegating to handle.shutdown. */
    },
    stdout: child.stdout,
    stdin: child.stdin,
    stderr: child.stderr,
  }
  return { handle, child }
}

// Wait for `{"ready":true}` on stdout so we know the subprocess is fully up
// before we start testing shutdown behavior. Prevents races where the
// SIGTERM handler hasn't been installed yet in the child.
async function waitForReady(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => {
      child.stdout?.off('data', onData)
      reject(new Error(`fake daemon did not signal ready within ${timeoutMs}ms`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      if (buf.includes('"ready":true')) {
        clearTimeout(t)
        child.stdout?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
  })
}

// Wait for subprocess exit; resolves `{ code, signal }`.
function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

describe('DaemonBridge shutdown (real subprocess)', () => {
  let children: ChildProcess[] = []

  beforeEach(() => {
    children = []
  })

  afterEach(async () => {
    // Reap any surviving subprocesses so we don't pin the vitest worker pool.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      // Close stdin so the subprocess doesn't hold the parent alive either.
      try {
        child.stdin?.end()
      } catch {}
    }
    // Give OS a tick to reap.
    await new Promise((r) => setImmediate(r))
    children = []
  })

  itPosix(
    'POSIX: SIGTERM → clean exit, no SIGKILL escalation',
    async () => {
      const { handle, child } = spawnFakeDaemon('clean')
      children.push(child)
      await waitForReady(child)

      const c = makeCollector()
      const bridge = new DaemonBridge()
      await bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: async () => ({ startDaemon: async () => handle }),
        logger: c.logger,
      })

      const t0 = Date.now()
      await bridge.shutdown({ logger: c.logger })
      const elapsed = Date.now() - t0

      const { code, signal } = await waitForExit(child)
      // Clean daemon exits 0 on SIGTERM.
      expect(code === 0 || signal === 'SIGTERM').toBe(true)
      // Must NOT have taken 2s+ — that would mean escalation fired.
      expect(elapsed).toBeLessThan(2_000)
      expect(c.warn.filter((m) => m.includes('SIGKILL'))).toHaveLength(0)
    },
    10_000,
  )

  itPosix(
    'POSIX: SIGTERM ignored → SIGKILL after 2 s; warn logged',
    async () => {
      const { handle, child } = spawnFakeDaemon('ignore-sigterm')
      children.push(child)
      await waitForReady(child)

      const c = makeCollector()
      const bridge = new DaemonBridge()
      await bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: async () => ({ startDaemon: async () => handle }),
        logger: c.logger,
      })

      const t0 = Date.now()
      await bridge.shutdown({ logger: c.logger })
      const elapsed = Date.now() - t0

      const { signal } = await waitForExit(child)
      expect(signal).toBe('SIGKILL')
      // The 2s escalation must have fired; allow generous slack for CI scheduling.
      expect(elapsed).toBeGreaterThanOrEqual(1_900)
      expect(c.warn.some((m) => m.includes('escalated to SIGKILL'))).toBe(true)
    },
    10_000,
  )

  itPosix(
    'POSIX: double shutdown is idempotent (one signal, no throws)',
    async () => {
      const { handle, child } = spawnFakeDaemon('clean')
      children.push(child)
      await waitForReady(child)

      const c = makeCollector()
      const bridge = new DaemonBridge()
      await bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: async () => ({ startDaemon: async () => handle }),
        logger: c.logger,
      })

      // Spy process.kill to count real signal deliveries to our pid.
      const killSpy = vi.spyOn(process, 'kill')
      try {
        const [s1, s2] = await Promise.all([
          bridge.shutdown({ logger: c.logger }),
          bridge.shutdown({ logger: c.logger }),
        ])
        expect(s1).toBeUndefined()
        expect(s2).toBeUndefined()

        // A third post-hoc call must also be a no-op.
        await expect(bridge.shutdown({ logger: c.logger })).resolves.toBeUndefined()

        const sigCalls = killSpy.mock.calls.filter((args) => args[0] === child.pid)
        // Bridge should issue exactly one SIGTERM; no SIGKILL (daemon exits fast).
        expect(sigCalls).toHaveLength(1)
        expect(sigCalls[0]?.[1]).toBe('SIGTERM')
      } finally {
        killSpy.mockRestore()
      }

      const { code, signal } = await waitForExit(child)
      expect(code === 0 || signal === 'SIGTERM').toBe(true)
      expect(c.warn.filter((m) => m.includes('SIGKILL'))).toHaveLength(0)
    },
    10_000,
  )

  // Windows-only: exercises shutdownWindows in daemonBridge; skipped on POSIX.
  itWindows(
    'Windows: stdin shutdown ack → clean exit, no taskkill',
    async () => {
      const { handle, child } = spawnFakeDaemon('windows-ack')
      children.push(child)
      await waitForReady(child)

      const c = makeCollector()
      const spawnSpy = vi.fn(nodeSpawn) as unknown as typeof spawnType
      const bridge = new DaemonBridge()
      await bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: async () => ({ startDaemon: async () => handle }),
        logger: c.logger,
      })

      await bridge.shutdown({ logger: c.logger, spawn: spawnSpy })

      expect(spawnSpy as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
      const { code, signal } = await waitForExit(child)
      expect(code === 0 || signal === 'SIGTERM').toBe(true)
    },
    10_000,
  )

  itWindows(
    'Windows: no ack within 1500 ms → taskkill fallback',
    async () => {
      const { handle, child } = spawnFakeDaemon('windows-no-ack')
      children.push(child)
      await waitForReady(child)

      const c = makeCollector()
      // Fake taskkill: resolve with code=0 so the bridge treats it as success,
      // but never actually signal the subprocess — afterEach reaps it.
      const taskkillProc = {
        on(ev: string, cb: (...args: unknown[]) => void) {
          if (ev === 'close') setImmediate(() => cb(0))
          return taskkillProc
        },
      } as unknown as ChildProcess
      const spawnSpy = vi.fn(() => taskkillProc) as unknown as typeof spawnType

      const bridge = new DaemonBridge()
      await bridge.start({
        mode: 'auto',
        projectRoot: '/tmp',
        manifestPath: '/tmp/manifest.json',
        importer: async () => ({ startDaemon: async () => handle }),
        logger: c.logger,
      })

      const t0 = Date.now()
      await bridge.shutdown({ logger: c.logger, spawn: spawnSpy })
      const elapsed = Date.now() - t0

      const spawnMock = spawnSpy as unknown as ReturnType<typeof vi.fn>
      expect(spawnMock).toHaveBeenCalledOnce()
      const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]]
      expect(cmd).toBe('taskkill')
      expect(args).toEqual(expect.arrayContaining(['/T', '/F', '/PID', String(handle.pid)]))
      // Ack timer is 1.5 s; spawn fires immediately after. Allow slack.
      expect(elapsed).toBeGreaterThanOrEqual(1_400)
    },
    10_000,
  )
})
