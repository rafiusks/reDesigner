import { ComponentHandleSchema } from '@redesigner/core'
import { z } from 'zod'

const FrameBase = { seq: z.number().int().nonnegative() }

export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  ...FrameBase,
  payload: z.object({
    serverVersion: z.string(),
    instanceId: z.string().uuid(),
    snapshotSeq: z.number().int().nonnegative(),
    snapshot: z.object({
      current: ComponentHandleSchema.nullable(),
      recent: z.array(ComponentHandleSchema).max(10),
      manifestMeta: z.object({ contentHash: z.string(), componentCount: z.number() }).nullable(),
    }),
  }),
})

export const SelectionUpdatedFrameSchema = z.object({
  type: z.literal('selection.updated'),
  ...FrameBase,
  payload: z.object({
    current: ComponentHandleSchema,
    staleManifest: z.boolean(),
  }),
})

export const ManifestUpdatedFrameSchema = z.object({
  type: z.literal('manifest.updated'),
  ...FrameBase,
  payload: z.object({
    contentHash: z.string(),
    componentCount: z.number(),
  }),
})

export const StaleManifestResolvedFrameSchema = z.object({
  type: z.literal('staleManifest.resolved'),
  ...FrameBase,
  payload: z.object({ count: z.number() }),
})

export const RpcRequestFrameSchema = z.object({
  type: z.literal('rpc.request'),
  ...FrameBase,
  payload: z.object({
    jsonrpc: z.literal('2.0'),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    method: z.enum(['getComputedStyles', 'getDomSubtree']),
    params: z.object({
      handle: ComponentHandleSchema,
      depth: z.number().int().nonnegative().optional(),
    }),
  }),
})

export const RpcResponseFrameSchema = z.object({
  type: z.literal('rpc.response'),
  payload: z.union([
    z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }),
    z.object({
      jsonrpc: z.literal('2.0'),
      id: z.string(),
      error: z.object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      }),
    }),
  ]),
})

export const ResyncGapFrameSchema = z.object({
  type: z.literal('resync.gap'),
  ...FrameBase,
  payload: z.object({
    droppedFrom: z.number(),
    droppedTo: z.number(),
  }),
})

export const ShutdownFrameSchema = z.object({
  type: z.literal('shutdown'),
  ...FrameBase,
  payload: z.object({ reason: z.string() }),
})

export const RpcErrorFrameSchema = z.object({
  type: z.literal('rpc.error'),
  ...FrameBase,
  payload: z.object({
    jsonrpc: z.literal('2.0'),
    id: z.string().nullable(),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
})

export type HelloFrame = z.infer<typeof HelloFrameSchema>
export type SelectionUpdatedFrame = z.infer<typeof SelectionUpdatedFrameSchema>
export type ManifestUpdatedFrame = z.infer<typeof ManifestUpdatedFrameSchema>
export type StaleManifestResolvedFrame = z.infer<typeof StaleManifestResolvedFrameSchema>
export type RpcRequestFrame = z.infer<typeof RpcRequestFrameSchema>
export type RpcResponseFrame = z.infer<typeof RpcResponseFrameSchema>
export type ResyncGapFrame = z.infer<typeof ResyncGapFrameSchema>
export type ShutdownFrame = z.infer<typeof ShutdownFrameSchema>
export type RpcErrorFrame = z.infer<typeof RpcErrorFrameSchema>
