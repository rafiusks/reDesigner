import { describe, expect, it } from 'vitest'
import { compareToken } from '../../src/auth.js'

describe('compareToken', () => {
  const expected = Buffer.from('a'.repeat(43), 'utf8')
  it('rejects undefined without throw', () => {
    expect(compareToken(undefined, expected)).toBe(false)
  })
  it('rejects empty string', () => {
    expect(compareToken('', expected)).toBe(false)
  })
  it('rejects short string without RangeError', () => {
    expect(() => compareToken('x', expected)).not.toThrow()
    expect(compareToken('x', expected)).toBe(false)
  })
  it('rejects non-string', () => {
    expect(compareToken({} as unknown, expected)).toBe(false)
    expect(compareToken(123 as unknown, expected)).toBe(false)
  })
  it('accepts matching token', () => {
    expect(compareToken('a'.repeat(43), expected)).toBe(true)
  })
})
