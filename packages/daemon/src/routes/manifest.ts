import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { problem, sendJson, sendProblem } from '../types.js'
import type { RouteContext } from '../types.js'

export function handleManifestGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const reqId = crypto.randomBytes(8).toString('hex')
  const manifest = ctx.manifestWatcher.getCached()

  if (manifest === null) {
    sendProblem(res, problem(503, 'NotReady', 'manifest not yet available', reqId), {
      'Retry-After': '1',
    })
    return
  }

  const etag = `"${manifest.contentHash}"`
  const ifNoneMatch = req.headers['if-none-match']

  if (ifNoneMatch === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  sendJson(res, 200, manifest, { ETag: etag })
}
