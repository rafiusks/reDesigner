import { z } from 'zod'
import { ComponentHandleSchema } from '../schema'
import { UUID_V4_RE } from './primitives'

// v0 is single-select; `nodes` has exactly 1 entry. Envelope shape future-proofs
// multi-select (capability advertised as `multiSelect: false` in hello).
// `meta` uses catchall so new fields can be added without a schema bump; `source`
// stays enum-constrained so log-sink consumers can discriminate cleanly.
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

// `selectionSeq` is daemon-side monotonic per tab; resets on daemon restart.
// `acceptedAt` is server-clock Unix-ms at apply time.
// catchall keeps the response forward-compatible — clients ignore unknown keys.
export const SelectionPutResponseSchema = z
  .object({
    selectionSeq: z.number().int().nonnegative(),
    acceptedAt: z.number().int().positive(),
  })
  .catchall(z.unknown())
export type SelectionPutResponse = z.infer<typeof SelectionPutResponseSchema>
