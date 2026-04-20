import { expect, test } from 'vitest'
import { compareToken } from '../src/auth.js'

test('returns true on exact match', () => {
  const tok = Buffer.from('a-valid-session-token', 'utf8')
  expect(compareToken('a-valid-session-token', tok)).toBe(true)
})

test('returns false on content mismatch at same length', () => {
  const tok = Buffer.from('aaaa', 'utf8')
  expect(compareToken('aaab', tok)).toBe(false)
})

test('returns false on length mismatch without throwing', () => {
  const tok = Buffer.from('abcd', 'utf8')
  expect(() => compareToken('abc', tok)).not.toThrow()
  expect(compareToken('abc', tok)).toBe(false)
  expect(() => compareToken('abcde', tok)).not.toThrow()
  expect(compareToken('abcde', tok)).toBe(false)
})

test('returns false on non-string provided input', () => {
  const tok = Buffer.from('abc', 'utf8')
  expect(compareToken(undefined, tok)).toBe(false)
  expect(compareToken(null, tok)).toBe(false)
  expect(compareToken(123, tok)).toBe(false)
  expect(compareToken({}, tok)).toBe(false)
})

test('never throws RangeError on pathological length difference', () => {
  const tok = Buffer.from('short', 'utf8')
  const huge = 'x'.repeat(10_000)
  expect(() => compareToken(huge, tok)).not.toThrow()
  expect(compareToken(huge, tok)).toBe(false)
})
