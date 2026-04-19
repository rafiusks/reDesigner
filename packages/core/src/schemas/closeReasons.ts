import { z } from 'zod'

/**
 * Structured close-reason body for WebSocket close frames.
 * RFC 6455 limits the reason to 123 UTF-8 bytes — callers MUST use `encodeCloseReason`,
 * which serializes and asserts that budget.
 */
export const CloseReasonSchema = z
  .object({
    /** Accepted protocol versions, used in 4406 closes. */
    accepted: z.array(z.number().int().positive()).optional(),
  })
  .strict()
export type CloseReason = z.infer<typeof CloseReasonSchema>

const MAX_REASON_BYTES = 123

/**
 * Validate + serialize a CloseReason. Throws if the JSON exceeds RFC 6455's
 * 123-byte reason budget (UTF-8 bytes, not code points).
 */
export function encodeCloseReason(reason: CloseReason): string {
  const parsed = CloseReasonSchema.parse(reason)
  const serialized = JSON.stringify(parsed)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_REASON_BYTES) {
    throw new Error(
      `CloseReason exceeds RFC 6455 budget: ${bytes} bytes > ${MAX_REASON_BYTES} (${MAX_REASON_BYTES} max).`,
    )
  }
  return serialized
}
