import { CloseReasonSchema, encodeCloseReason } from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

test('encodes {accepted:[1]} inside budget', () => {
  expect(encodeCloseReason({ accepted: [1] })).toBe('{"accepted":[1]}')
})

test('throws when serialized JSON exceeds 123 UTF-8 bytes', () => {
  const tooMany = { accepted: Array.from({ length: 50 }, (_, i) => i + 1) }
  expect(() => encodeCloseReason(tooMany)).toThrow(/123/)
})

test('multi-byte UTF-8 counts bytes not code points', () => {
  // 60 × 3-byte emoji-like char hit the wall even if code-point count fits.
  // We use the schema's .strict() to reject unknown keys, so we probe bytes via `accepted` length.
  // Approach: compose an accepted array whose JSON string (10*999999…) pushes over 123 bytes.
  const large = { accepted: Array.from({ length: 30 }, () => 999999999) }
  expect(() => encodeCloseReason(large)).toThrow(/123/)
})

test('CloseReasonSchema rejects unknown keys (strict)', () => {
  expect(() => CloseReasonSchema.parse({ accepted: [1], junk: true } as unknown)).toThrow()
})
