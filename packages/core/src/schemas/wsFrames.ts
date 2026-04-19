import { z } from 'zod'

/** JSON-RPC 2.0 error object (§5). */
export const JsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strict()

/** Method registry for redesigner-v1. */
export const RedesignerMethod = z.enum([
  'rpc.request',
  'selection.updated',
  'handshake.rotated',
  'resync.instanceChanged',
  'resync.gap',
  'hello',
  'ping',
  'pong',
])
export type RedesignerMethod = z.infer<typeof RedesignerMethod>

/**
 * JSON-RPC request frame.
 * - `id` is UUIDv4 string; numeric/null ids forbidden on requests.
 */
export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string().uuid(),
    method: RedesignerMethod,
    params: z.unknown().optional(),
  })
  .strict()
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

/**
 * JSON-RPC notification frame — no `id`.
 */
export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: RedesignerMethod,
    params: z.unknown().optional(),
  })
  .strict()
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>

/**
 * JSON-RPC response frame.
 * `id` may be `null` only in the parse-error / unknown-id case (JSON-RPC §5) — e.g. batch rejection.
 * Exactly one of `result` or `error` is populated (mutual exclusivity enforced by refinement).
 */
export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().uuid(), z.null()]),
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .strict()
  .refine((r) => (r.result !== undefined) !== (r.error !== undefined), {
    message: 'response must have exactly one of result or error',
  })
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>

/** Any inbound frame on the WebSocket — request, notification, or response. */
export const WsFrameSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
])
export type WsFrame = z.infer<typeof WsFrameSchema>
