import { z } from 'zod'
import { ComponentHandleSchema } from '../schema'
import { UUID_V4_RE } from './primitives'

/**
 * `PUT /tabs/{tabId}/selection` request body.
 * v0 is single-select only — `nodes` has exactly 1 entry. The envelope shape
 * future-proofs multi-select (capability advertised as `multiSelect: false` in hello).
 *
 * clientId: optional per Slice E. The daemon does not consume it (grep-confirmed).
 * meta: .catchall(z.unknown()) per Slice E.1 so Stage 2 can add pickSeq etc. without
 *   a schema bump. source is enum-constrained to prevent log-drift.
 */
export const SelectionPutBodySchema = z
  .object({
    nodes: z.array(ComponentHandleSchema).min(1).max(1),
    clientId: z.string().regex(UUID_V4_RE, 'clientId must be a UUIDv4 string').optional(),
    meta: z
      .object({
        source: z.enum(['picker', 'mcp', 'dev']),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .strict()
export type SelectionPutBody = z.infer<typeof SelectionPutBodySchema>

/**
 * `PUT /tabs/{tabId}/selection` response body.
 * `selectionSeq` is daemon-side monotonic per tab, assigned at selectionState.apply
 * time; resets on daemon restart. `acceptedAt` is Unix-ms server clock at apply time.
 *
 * .catchall(z.unknown()) per Slice E.1: response schemas must be forward-compatible.
 * Stage 2 will add fields (e.g., server-echoed pickSeq). Clients ignore unknown keys.
 * .passthrough() is deprecated in Zod v4; .catchall is the idiomatic replacement.
 */
export const SelectionPutResponseSchema = z
  .object({
    selectionSeq: z.number().int().nonnegative(),
    acceptedAt: z.number().int().positive(),
  })
  .catchall(z.unknown())
export type SelectionPutResponse = z.infer<typeof SelectionPutResponseSchema>
