import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from './logger.js'
// Re-export problem helpers from problem.ts so existing imports from types.ts keep working.
export type { ProblemResponse } from './problem.js'
export { problem, sendProblem } from './problem.js'
import type { EventBus } from './state/eventBus.js'
import type { ManifestWatcher } from './state/manifestWatcher.js'
import type { SelectionState } from './state/selectionState.js'
import type { RpcCorrelation } from './ws/rpcCorrelation.js'

export interface RouteContext {
  selectionState: SelectionState
  manifestWatcher: ManifestWatcher
  eventBus: EventBus
  rpcCorrelation: RpcCorrelation
  logger: Logger
  serverVersion: string
  instanceId: string
  startedAt: number
  projectRoot: string
  shutdown: () => Promise<void>
}

export async function readJsonBody(req: IncomingMessage, cap: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > cap) {
        req.destroy()
        reject(new Error('PayloadTooLarge'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('InvalidJSON'))
      }
    })
    req.on('error', reject)
  })
}

// Caller is responsible for Vary/ACAO via applyCorsHeaders or upstream gate.
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}
