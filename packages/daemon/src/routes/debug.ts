import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../types.js'
import type { RouteContext } from '../types.js'

/**
 * GET /__redesigner/debug/state
 *
 * Only registered when process.env.REDESIGNER_DEBUG === '1'.
 * Returns a snapshot of internal daemon state useful for development/debugging.
 * Not intended for production use.
 */
export function handleDebugStateGet(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const { current, recent } = ctx.selectionState.snapshot()
  const cached = ctx.manifestWatcher.getCached()

  const body = {
    selectionState: {
      current,
      recentCount: recent.length,
    },
    sessions: {
      // active session count is not tracked in RouteContext for v0 — placeholder
      active: 0,
    },
    manifestCache: {
      contentHash: cached?.contentHash ?? null,
      componentCount: cached ? Object.keys(cached.components).length : 0,
    },
  }

  sendJson(res, 200, body)
}
