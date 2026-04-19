import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ComponentHandleSchema } from '@redesigner/core'
import { problem, readJsonBody, sendJson, sendProblem } from '../types.js'
import type { RouteContext } from '../types.js'

// All Zod schemas at module top-level — CLAUDE.md: in-handler z.object() is a v4 regression cliff.
const BodySchema = ComponentHandleSchema

export function handleSelectionGet(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const { current } = ctx.selectionState.snapshot()
  sendJson(res, 200, { current })
}

export function handleSelectionRecentGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const reqId = crypto.randomBytes(8).toString('hex')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const nParam = url.searchParams.get('n')
  let n = 10
  if (nParam !== null) {
    const parsed = Number(nParam)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      sendProblem(
        res,
        problem(400, 'InvalidRequest', 'n must be an integer between 1 and 100', reqId),
      )
      return
    }
    n = parsed
  }
  const { recent } = ctx.selectionState.snapshot()
  sendJson(res, 200, recent.slice(0, n))
}

export async function handleSelectionPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const reqId = crypto.randomBytes(8).toString('hex')
  let body: unknown
  try {
    body = await readJsonBody(req, 16 * 1024)
  } catch (e) {
    const code = (e as Error).message === 'PayloadTooLarge' ? 'PayloadTooLarge' : 'InvalidJSON'
    const status = code === 'PayloadTooLarge' ? 413 : 400
    sendProblem(res, problem(status, code, undefined, reqId))
    return
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    sendProblem(res, problem(400, 'InvalidRequest', detail, reqId))
    return
  }

  const handle = parsed.data
  const manifest = ctx.manifestWatcher.getCached()
  const staleManifest =
    manifest === null ||
    !Object.values(manifest.components).some(
      (c) =>
        c.filePath === handle.filePath &&
        c.lineRange[0] <= handle.lineRange[0] &&
        c.lineRange[1] >= handle.lineRange[1],
    )

  const provenance =
    manifest?.contentHash !== undefined
      ? { receivedAt: Date.now(), staleManifest, manifestContentHashAtIntake: manifest.contentHash }
      : { receivedAt: Date.now(), staleManifest }

  const result = ctx.selectionState.apply({ handle, provenance })

  if (result.kind === 'new' || result.kind === 'promoted') {
    const current = result.current
    if (current !== null) {
      ctx.eventBus.broadcast({
        type: 'selection.updated',
        payload: { current, staleManifest },
      })
    }
  }

  sendJson(res, 200, { kind: result.kind, current: result.current })
}
