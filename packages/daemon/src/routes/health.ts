import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../types.js'
import type { RouteContext } from '../types.js'

export function handleHealthGet(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const uptimeMs = Date.now() - ctx.startedAt
  sendJson(res, 200, {
    projectRoot: ctx.projectRoot,
    serverVersion: ctx.serverVersion,
    instanceId: ctx.instanceId,
    uptimeMs,
  })
}
