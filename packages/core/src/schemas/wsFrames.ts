import { z } from 'zod'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
    id: z.string().regex(UUID_V4_RE, 'must be a UUIDv4 string'),
    method: RedesignerMethod,
    params: z.unknown().optional(),
  })
  .strict()
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

/**
 * JSON-RPC notification frame — no `id`.
 * Strict on purpose: JSON-RPC 2.0 §4.1 does not forbid extra fields, but we reject them
 * on the wire to keep the contract narrow and catch drift early.
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
    id: z.union([z.string().regex(UUID_V4_RE, 'must be a UUIDv4 string'), z.null()]),
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
