import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ComponentHandleSchema } from '@redesigner/core'
import { z } from 'zod'
import { problem, readJsonBody, sendJson, sendProblem } from '../types.js'
import type { RouteContext } from '../types.js'

// All Zod schemas at module top-level — CLAUDE.md: in-handler z.object() is a v4 regression cliff.
const BrowserToolBodySchema = z
  .object({
    handle: ComponentHandleSchema,
    depth: z.number().int().nonnegative().optional(),
  })
  .strict()

const TIMEOUT_COMPUTED_STYLES_MS = 5000
const TIMEOUT_DOM_SUBTREE_MS = 10000

export type BrowserToolMethod = 'getComputedStyles' | 'getDomSubtree'

export async function handleBrowserToolPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  method: BrowserToolMethod,
): Promise<void> {
  const reqId = crypto.randomBytes(8).toString('hex')

  // Step 1: Check subscriber count — 0 → 424 ExtensionUnavailable (terminal)
  if (ctx.eventBus.subscriberCount() === 0) {
    sendProblem(
      res,
      problem(
        424,
        'ExtensionUnavailable',
        'no extension subscriber connected; open a browser tab with the extension',
        reqId,
      ),
    )
    return
  }

  // Step 2: tryAcquire — atomically checks+reserves; false → 503 ConcurrencyLimitReached
  if (!ctx.rpcCorrelation.tryAcquire()) {
    sendProblem(
      res,
      problem(
        503,
        'ConcurrencyLimitReached',
        'per-ext concurrent in-flight cap reached; retry when a slot frees',
        reqId,
      ),
      { 'Retry-After': '0' },
    )
    return
  }

  // Slot is now acquired. Release it on any early-exit path before register().
  let slotReleased = false
  const releaseSlot = (): void => {
    if (!slotReleased) {
      slotReleased = true
      ctx.rpcCorrelation.releaseAcquired()
    }
  }

  // Step 3: Parse body
  let body: unknown
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch (e) {
    releaseSlot()
    const code = (e as Error).message === 'PayloadTooLarge' ? 'PayloadTooLarge' : 'InvalidJSON'
    const status = code === 'PayloadTooLarge' ? 413 : 400
    sendProblem(res, problem(status, code, undefined, reqId))
    return
  }

  const parsed = BrowserToolBodySchema.safeParse(body)
  if (!parsed.success) {
    releaseSlot()
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    sendProblem(res, problem(400, 'InvalidRequest', detail, reqId))
    return
  }

  // Step 4: Allocate JSON-RPC 2.0 id
  const rpcId = crypto.randomBytes(16).toString('hex')

  // Step 5: Broadcast rpc.request frame to the connected extension
  ctx.eventBus.broadcast({
    type: 'rpc.request',
    payload: {
      jsonrpc: '2.0',
      id: rpcId,
      method,
      params: { handle: parsed.data.handle, depth: parsed.data.depth },
    },
  })

  // Step 6: Register correlation and await response (slot is consumed; register() won't increment)
  slotReleased = true // register() owns the slot decrement from here on
  const timeoutMs =
    method === 'getComputedStyles' ? TIMEOUT_COMPUTED_STYLES_MS : TIMEOUT_DOM_SUBTREE_MS

  let result: unknown
  try {
    result = await ctx.rpcCorrelation.register(rpcId, timeoutMs)
  } catch (e) {
    // Lowercase match so error-string casing in `new Error(...)` sites doesn't
    // silently fall through to the generic branch. Lifecycle uses 'Shutdown';
    // rpcCorrelation uses 'rpc timeout'; ws/events uses 'ext disconnected'.
    const msg = (e as Error).message.toLowerCase()
    if (msg.includes('timeout')) {
      sendProblem(
        res,
        problem(504, 'ExtensionTimeout', `rpc did not respond within ${timeoutMs}ms`, reqId),
      )
      return
    }
    if (msg.includes('shutdown')) {
      sendProblem(res, problem(503, 'Shutdown', 'daemon is shutting down', reqId), {
        Connection: 'close',
      })
      return
    }
    if (msg.includes('disconnected')) {
      sendProblem(
        res,
        problem(503, 'ExtensionDisconnected', 'extension disconnected mid-flight', reqId),
        { 'Retry-After': '2' },
      )
      return
    }
    // Generic fallback — treat as transient disconnect
    sendProblem(
      res,
      problem(503, 'ExtensionDisconnected', 'extension disconnected mid-flight', reqId),
      { 'Retry-After': '2' },
    )
    return
  }

  sendJson(res, 200, result)
}
