import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { problem, readJsonBody, sendJson, sendProblem } from '../types.js'
import type { RouteContext } from '../types.js'

export async function handleShutdownPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const reqId = crypto.randomBytes(8).toString('hex')
  let body: unknown
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch (e) {
    const code = (e as Error).message === 'PayloadTooLarge' ? 'PayloadTooLarge' : 'InvalidJSON'
    const status = code === 'PayloadTooLarge' ? 413 : 400
    sendProblem(res, problem(status, code, undefined, reqId))
    return
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).instanceId !== 'string'
  ) {
    sendProblem(res, problem(400, 'InvalidRequest', 'body must have instanceId: string', reqId))
    return
  }

  const { instanceId } = body as { instanceId: string }
  if (instanceId !== ctx.instanceId) {
    sendProblem(
      res,
      problem(404, 'InstanceMismatch', `expected ${ctx.instanceId}, got ${instanceId}`, reqId),
    )
    return
  }

  sendJson(res, 200, { drainDeadlineMs: 100 })
  void ctx.shutdown()
}
