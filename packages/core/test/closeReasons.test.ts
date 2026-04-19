import { CloseReasonSchema, encodeCloseReason } from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

test('encodes {accepted:[1]} inside budget', () => {
  expect(encodeCloseReason({ accepted: [1] })).toBe('{"accepted":[1]}')
})

test('throws when serialized JSON exceeds 123 UTF-8 bytes', () => {
  const tooMany = { accepted: Array.from({ length: 50 }, (_, i) => i + 1) }
  expect(() => encodeCloseReason(tooMany)).toThrow(/123/)
})

test('rejects when accepted[] serialization exceeds budget', () => {
  const large = { accepted: Array.from({ length: 30 }, () => 999999999) }
  expect(() => encodeCloseReason(large)).toThrow(/123/)
})

test('CloseReasonSchema rejects unknown keys (strict)', () => {
  expect(() => CloseReasonSchema.parse({ accepted: [1], junk: true } as unknown)).toThrow()
})
