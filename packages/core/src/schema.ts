import { z } from 'zod'

export const SELECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

const ComponentRecordSchema = z
  .object({
    filePath: z.string().min(1).max(4096),
    exportKind: z.enum(['default', 'named']),
    lineRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    displayName: z.string().min(1).max(256),
  })
  .strict()

const LocRecordSchema = z
  .object({
    componentKey: z.string().min(1).max(8192),
    filePath: z.string().min(1).max(4096),
    componentName: z.string().min(1).max(256),
  })
  .strict()

export const ComponentHandleSchema = z
  .object({
    id: z.string().regex(SELECTION_ID_RE, 'id must match /^[A-Za-z0-9_-]{1,128}$/'),
    componentName: z.string().min(1).max(256),
    filePath: z.string().min(1).max(4096),
    lineRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    domPath: z.string().max(8192),
    parentChain: z.array(z.string().max(256)).max(64),
    timestamp: z.number().int().nonnegative(),
  })
  .strict()

export const SelectionFileSchema = z
  .object({
    current: ComponentHandleSchema.nullable(),
    history: z.array(ComponentHandleSchema).max(1000),
  })
  .strict()

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    framework: z.literal('react'),
    generatedAt: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'contentHash must be 64-char hex'),
    components: z.record(z.string(), ComponentRecordSchema),
    locs: z.record(z.string(), LocRecordSchema),
  })
  .strict()
