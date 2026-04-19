import { z } from 'zod'
import { ComponentHandleSchema } from '../schema'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * `PUT /tabs/{tabId}/selection` request body.
 * v0 is single-select only — `nodes` has exactly 1 entry. The envelope shape
 * future-proofs multi-select (capability advertised as `multiSelect: false` in hello).
 */
export const SelectionPutBodySchema = z
  .object({
    nodes: z.array(ComponentHandleSchema).min(1).max(1),
    clientId: z.string().regex(UUID_V4_RE, 'clientId must be a UUIDv4 string'),
    meta: z
      .object({
        source: z.enum(['picker', 'mcp', 'dev']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type SelectionPutBody = z.infer<typeof SelectionPutBodySchema>

/**
 * `PUT /tabs/{tabId}/selection` response body.
 * `selectionSeq` is per-tab monotonic; `acceptedAt` is Unix-ms server clock.
 */
export const SelectionPutResponseSchema = z
  .object({
    selectionSeq: z.number().int().nonnegative(),
    acceptedAt: z.number().int().positive(),
  })
  .strict()
export type SelectionPutResponse = z.infer<typeof SelectionPutResponseSchema>
