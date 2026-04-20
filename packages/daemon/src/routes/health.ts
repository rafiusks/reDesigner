import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../types.js'
import type { RouteContext } from '../types.js'

export function handleHealthGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): void {
  // Spec §3.2: /health returns { ok: true }.
  // DEFERRED DECISION (task 12): spec calls for session-token-only gating but current
  // callers (mcp, vite) use the root operator token. Deferring the session-token-only
  // gate to a follow-up task that updates mcp/vite clients simultaneously.
  // Current behaviour: root-token gate (inherited from server.ts auth middleware).
  sendJson(res, 200, { ok: true })
}
