import { spawn as nodeSpawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Logger } from '../core/types-internal'

export interface DaemonHandle {
  pid: number
  shutdown(): Promise<void>
  stdout: Readable
  stdin: Writable
  stderr: Readable
}

export interface DaemonBridgeOptions {
  mode: 'auto' | 'required' | 'off'
  projectRoot: string
  manifestPath: string
  importer: () => Promise<{
    startDaemon: (opts: { manifestPath: string }) => Promise<DaemonHandle>
  }>
  logger: Logger
  /** Injectable spawn (for taskkill test seams). */
  spawn?: typeof nodeSpawn
}

export interface DaemonShutdownOptions {
  logger: Logger
  spawn?: typeof nodeSpawn
}

const REQUIRED_HANDLE_KEYS = ['pid', 'shutdown', 'stdout', 'stdin', 'stderr'] as const

// If the daemon package's module graph has a top-level-await that never resolves
// (hung network I/O, pathological bootstrap), the dynamic import() would pin this
// process forever — Node has no API to abort an in-flight import. We race it
// against a 2s timer and fall through (or throw in required mode) if it wins.
// The pending import still leaks in the background; callers that care about pool
// hygiene (vitest workers) must run in `pool: 'forks', isolate: true` so the
// leaked import dies with the fork.
const IMPORT_TIMEOUT_MS = 2_000

class DaemonImportTimeoutError extends Error {
  constructor(ms: number) {
    super(`daemon package import did not settle within ${ms}ms`)
    this.name = 'DaemonImportTimeoutError'
  }
}

/**
 * Handoff wire contract matching spec §4 (Handoff shape). Kept inline rather than
 * imported from @redesigner/daemon so the bridge stays self-contained when the
 * daemon package is not installed (optional runtime peer; auto mode falls back to
 * manifest-only). Authentication-relevant fields only: host, port, token, instanceId.
 */
interface Handoff {
  serverVersion: string
  instanceId: string
  pid: number
  host: string
  port: number
  token: string
  projectRoot: string
  startedAt: number
}

/**
 * Resolve handoff path per spec §4 OS runtime-dir rules. Mirrors
 * `@redesigner/daemon`'s `resolveHandoffPath` — replicated inline so the bridge
 * doesn't take a hard dep on the daemon package (optional peer). Must stay in
 * lockstep: Linux $XDG_RUNTIME_DIR/redesigner, macOS $TMPDIR/com.redesigner.${uid},
 * Windows %LOCALAPPDATA%\redesigner\${uid}; fallback on Linux to
 * ${os.tmpdir()}/redesigner-${uid}/ when XDG_RUNTIME_DIR is unset.
 */
function resolveHandoffPath(projectRoot: string): string {
  const uid =
    process.platform === 'win32' ? (process.env.USERNAME ?? 'w') : String(process.getuid?.() ?? 'w')
  let real: string
  try {
    real = fs.realpathSync(projectRoot)
  } catch {
    real = projectRoot
  }
  const projectHash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16)
  let root: string
  if (process.platform === 'linux') {
    root = process.env.XDG_RUNTIME_DIR
      ? path.join(process.env.XDG_RUNTIME_DIR, 'redesigner')
      : path.join(os.tmpdir(), `redesigner-${uid}`)
  } else if (process.platform === 'darwin') {
    root = path.join(os.tmpdir(), `com.redesigner.${uid}`)
  } else if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    root = path.join(base, 'redesigner', uid)
  } else {
    // Unsupported platform: return a path that won't exist → readFileSync throws →
    // shutdownPosix falls through to SIGTERM, matching auto-mode soft-fail posture.
    root = path.join(os.tmpdir(), `redesigner-${uid}`)
  }
  return path.join(root, projectHash, 'daemon-v1.json')
}

export class DaemonBridge {
  private handle: DaemonHandle | null = null
  private shutdownCalled = false
  private signalHandlers: Array<{ signal: NodeJS.Signals; fn: () => void }> = []
  private handoffPath: string | null = null

  async start(opts: DaemonBridgeOptions): Promise<void> {
    if (opts.mode === 'off') return
    let mod: Awaited<ReturnType<typeof opts.importer>>
    try {
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DaemonImportTimeoutError(IMPORT_TIMEOUT_MS)),
          IMPORT_TIMEOUT_MS,
        )
        // Don't keep the event loop alive purely for this timer (matters for short-lived hosts).
        timer.unref?.()
      })
      try {
        mod = await Promise.race([opts.importer(), timeoutPromise])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (err: unknown) {
      if (err instanceof DaemonImportTimeoutError) {
        if (opts.mode === 'required') {
          throw new Error(`[redesigner] daemon required but import timed out: ${err.message}`)
        }
        opts.logger.warn(
          `[redesigner] daemon package import timed out after ${IMPORT_TIMEOUT_MS}ms (continuing): ${err.message}`,
        )
        return
      }
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      const message = (err as Error | undefined)?.message ?? String(err)
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        if (opts.mode === 'required') {
          throw new Error(`[redesigner] daemon required but not installed: ${message}`)
        }
        opts.logger.warn(
          '[redesigner] daemon package not installed — running in manifest-only mode',
        )
        return
      }
      const stack = (err as Error | undefined)?.stack ?? String(err)
      if (opts.mode === 'required') {
        throw new Error(`[redesigner] daemon required but errored on import: ${message}`)
      }
      opts.logger.warn(`[redesigner] daemon package errored on import (continuing): ${stack}`)
      return
    }

    // Shape check: module loaded but might not export startDaemon (wrong package
    // installed, stale version, etc.). Treat as a soft failure in auto mode so the
    // build continues in manifest-only mode; hard fail in required mode.
    if (typeof mod?.startDaemon !== 'function') {
      if (opts.mode === 'required') {
        throw new Error('[redesigner] daemon required but package does not export startDaemon')
      }
      opts.logger.warn(
        '[redesigner] daemon package does not export startDaemon — running in manifest-only mode',
      )
      return
    }

    const handle = await mod.startDaemon({ manifestPath: opts.manifestPath })
    const handleRecord = handle as unknown as Record<string, unknown>
    for (const key of REQUIRED_HANDLE_KEYS) {
      const value = handleRecord[key]
      if (value === undefined || value === null) {
        throw new Error(`[redesigner] daemon handle missing required field "${key}"`)
      }
    }

    handle.stdout.on('data', (buf: Buffer) =>
      opts.logger.info(`[daemon] ${buf.toString().trimEnd()}`),
    )
    handle.stderr.on('data', (buf: Buffer) =>
      opts.logger.warn(`[daemon] ${buf.toString().trimEnd()}`),
    )
    this.handle = handle
    this.handoffPath = resolveHandoffPath(opts.projectRoot)

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    // SIGHUP is POSIX-only — registering on Windows deadlocks the process (nodejs/node#10165).
    if (process.platform !== 'win32') signals.push('SIGHUP')
    for (const sig of signals) {
      const fn = () => {
        void this.shutdown(opts)
      }
      process.on(sig, fn)
      this.signalHandlers.push({ signal: sig, fn })
    }
  }

  async shutdown(opts: DaemonShutdownOptions): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true
    for (const { signal, fn } of this.signalHandlers) process.off(signal, fn)
    this.signalHandlers = []
    const h = this.handle
    if (!h) return
    if (process.platform === 'win32') {
      await this.shutdownWindows(h, opts)
    } else {
      await this.shutdownPosix(h, opts)
    }
    this.handle = null
  }

  private async shutdownPosix(h: DaemonHandle, opts: DaemonShutdownOptions): Promise<void> {
    // Preferred path: authenticated POST /shutdown per spec §4 alive-orphan sequence.
    // Read handoff → authenticated fetch with 500ms timeout → if OK, wait 500ms for
    // graceful exit → else fall through to signal. Any failure (missing file, parse,
    // network, non-200) silently falls through to SIGTERM → SIGKILL.
    const posted = await this.tryPostShutdown(h)
    if (posted) return

    try {
      process.kill(h.pid, 'SIGTERM')
    } catch {}
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000)
      h.stdout.once('end', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        process.kill(h.pid, 'SIGKILL')
      } catch {}
      opts.logger.warn('[redesigner] daemon did not exit on SIGTERM; escalated to SIGKILL')
    }
  }

  /**
   * Authenticated POST /shutdown. Returns true iff the daemon acknowledged AND
   * the child exited within 500ms. False means caller should fall back to signals.
   * Any thrown error inside is swallowed — the shutdown is best-effort.
   */
  private async tryPostShutdown(h: DaemonHandle): Promise<boolean> {
    const handoffPath = this.handoffPath
    if (!handoffPath) return false
    let handoff: Handoff
    try {
      const raw = fs.readFileSync(handoffPath, 'utf8')
      handoff = JSON.parse(raw) as Handoff
      if (
        typeof handoff.host !== 'string' ||
        typeof handoff.port !== 'number' ||
        typeof handoff.token !== 'string' ||
        typeof handoff.instanceId !== 'string'
      ) {
        return false
      }
    } catch {
      return false
    }
    let ok = false
    try {
      const res = await fetch(`http://${handoff.host}:${handoff.port}/shutdown`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handoff.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ instanceId: handoff.instanceId }),
        signal: AbortSignal.timeout(500),
      })
      ok = res.ok
    } catch {
      return false
    }
    if (!ok) return false
    // Daemon accepted shutdown — give it 500ms to exit gracefully. If stdout
    // 'end' fires within the window, the child is down and we're done; otherwise
    // fall back to signals (returns false).
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500)
      timer.unref?.()
      h.stdout.once('end', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async shutdownWindows(h: DaemonHandle, opts: DaemonShutdownOptions): Promise<void> {
    const spawn = opts.spawn ?? nodeSpawn
    let acked = false
    const ackPromise = new Promise<void>((resolve) => {
      let buf = ''
      const timer = setTimeout(() => {
        h.stdout.off('data', onData)
        resolve()
      }, 1500)
      const onData = (chunk: Buffer) => {
        buf += chunk.toString()
        let idx = buf.indexOf('\n')
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line) {
            try {
              const msg = JSON.parse(line) as { ack?: unknown }
              if (msg.ack === true) {
                acked = true
                clearTimeout(timer)
                h.stdout.off('data', onData)
                resolve()
                return
              }
            } catch {}
          }
          idx = buf.indexOf('\n')
        }
      }
      h.stdout.on('data', onData)
    })
    try {
      h.stdin.write('{"op":"shutdown"}\n')
    } catch {
      /* missing stdin → straight to taskkill */
    }
    await ackPromise
    if (acked) {
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 1500)
        h.stdout.once('end', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      if (exited) return
    }
    const tk = spawn('taskkill', ['/T', '/F', '/PID', String(h.pid)])
    const ok = await new Promise<boolean>((resolve) =>
      tk.on('close', (code: number | null) => resolve(code === 0)),
    )
    if (!ok) {
      opts.logger.warn(
        `[redesigner] taskkill non-zero exit for PID ${h.pid}; manual cleanup may be required`,
      )
    }
  }
}
