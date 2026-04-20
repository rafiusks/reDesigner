import fs from 'node:fs'
import type http from 'node:http'
import type { Logger } from './logger.js'
import type { EventBus } from './state/eventBus.js'
import type { ManifestWatcher } from './state/manifestWatcher.js'
import type { RpcCorrelation } from './ws/rpcCorrelation.js'

// Default drain budget — kept in sync with POST /shutdown response body.
const DEFAULT_DRAIN_DEADLINE_MS = 100
// Windows retry parameters — AV lock is routine; POSIX uses a single attempt.
const WIN_UNLINK_MAX_ATTEMPTS = 3
const WIN_UNLINK_BACKOFF_MS = 100

export interface ShutdownOpts {
  server: http.Server
  manifestWatcher: ManifestWatcher
  rpcCorrelation: RpcCorrelation
  eventBus: EventBus
  handoffPath: string
  logger: Logger
  drainDeadlineMs?: number
}

// RFC 6455 §7.4.1: 1012 means the server is restarting / going away.
const WS_CLOSE_SERVER_RESTART = 1012

/**
 * Orchestrate graceful shutdown.
 *
 * Ordering is load-bearing:
 *   1. server.unref — stop pinning the event loop; keep accepting only in-flight work.
 *   2. Broadcast WS `shutdown` frame so subscribers suppress reconnect.
 *   3. Reject pending RPCs with Error('Shutdown') — frees their slots, unblocks callers.
 *   4. Drain in-flight HTTP, capped by drainDeadlineMs.
 *   5. manifestWatcher.stop() — release fs.watch + timers.
 *   6. unlinkHandoffWithRetry — remove handoff *before* any ack (caller writes ack
 *      after we return; bridge's read-on-ack is its "handoff is gone" signal).
 */
export async function shutdownGracefully(opts: ShutdownOpts, reason: string): Promise<void> {
  const drainDeadlineMs = opts.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS
  opts.logger.info('[shutdown] initiated', { reason })

  // 1. Stop accepting new connections (soft — already-accepted sockets continue).
  opts.server.unref()

  // 2. Broadcast shutdown frame so subscribers can distinguish from net failure,
  //    then close all WS connections with 1012 (server restart/maintenance per
  //    RFC 6455 §7.4.1). Ordering: broadcast first so the client sees the
  //    structured shutdown frame before the close frame.
  try {
    opts.eventBus.broadcast({ type: 'shutdown', payload: { reason } })
  } catch (err) {
    opts.logger.warn('[shutdown] broadcast failed', { err: String(err) })
  }
  try {
    opts.eventBus.closeAllSubscribers(WS_CLOSE_SERVER_RESTART, 'server restart')
  } catch (err) {
    opts.logger.warn('[shutdown] closeAllSubscribers failed', { err: String(err) })
  }

  // 3. Reject pending RPCs — they release slots inside RpcCorrelation.reject.
  opts.rpcCorrelation.rejectAll(new Error('Shutdown'))

  // 4. Drain in-flight HTTP with deadline.
  const drainPromise = new Promise<void>((resolve) => {
    opts.server.close(() => resolve())
  })
  let timeoutHandle: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, drainDeadlineMs)
    timeoutHandle.unref()
  })
  await Promise.race([drainPromise, timeoutPromise])
  if (timeoutHandle !== null) clearTimeout(timeoutHandle)

  // 5. Stop watcher (fs.watch + stat-poll timers).
  try {
    await opts.manifestWatcher.stop()
  } catch (err) {
    opts.logger.warn('[shutdown] watcher stop failed', { err: String(err) })
  }

  // 6. Unlink handoff BEFORE caller writes its ack/exit.
  unlinkHandoffWithRetry(opts.handoffPath, opts.logger)
}

/**
 * Idempotent handoff unlink.
 *
 * - POSIX: single attempt; ENOENT is success.
 * - Windows: up to 3 attempts with a 100ms busy-wait between EPERM retries
 *   (AV lock is routine). Final failure is logged WARN and swallowed — the
 *   caller writes an ack-with-unlink-failed payload and exits 0 anyway so the
 *   bridge's reclaim path on next start cleans up.
 *
 * Sync + busy-wait is deliberate: shutdown is synchronous-to-exit; a yielding
 * sleep would race the process exit on Windows.
 */
export function unlinkHandoffWithRetry(path: string, logger: Logger): void {
  const maxAttempts = process.platform === 'win32' ? WIN_UNLINK_MAX_ATTEMPTS : 1
  for (let i = 0; i < maxAttempts; i++) {
    try {
      fs.unlinkSync(path)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return
      if (i === maxAttempts - 1) {
        logger.warn('[shutdown] handoff unlink failed', { err: String(err) })
        return
      }
      // Sync busy-wait — see docblock for rationale.
      const deadline = Date.now() + WIN_UNLINK_BACKOFF_MS
      while (Date.now() < deadline) {
        /* spin */
      }
    }
  }
}

/**
 * Create a drain coordinator whose deadline starts at trigger(), not creation.
 *
 * Load-bearing: `POST /shutdown` creates the coordinator on handler entry but
 * must flush its 200 response before the clock starts — otherwise the response
 * serialization counts against the 100ms budget. Tests assert this with fake
 * timers.
 *
 * - `trigger()` is idempotent — second call is a no-op (does not reset timer).
 * - `awaitComplete()` returns a Promise resolved once the deadline elapses
 *   after trigger; before trigger, it stays pending regardless of wall-clock.
 */
export function createShutdownCoordinator(opts: { drainDeadlineMs: number }): {
  trigger: () => void
  awaitComplete: () => Promise<void>
} {
  let triggered = false
  let resolveFn: (() => void) | null = null
  const complete = new Promise<void>((r) => {
    resolveFn = r
  })
  return {
    trigger: () => {
      if (triggered) return
      triggered = true
      setTimeout(() => resolveFn?.(), opts.drainDeadlineMs).unref()
    },
    awaitComplete: () => complete,
  }
}
