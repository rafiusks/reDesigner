import { describe, expect, it } from 'vitest'
import { safeJsonParse } from '../../src/safeJsonParse'

describe('safeJsonParse', () => {
  it('parses valid JSON identically to JSON.parse', () => {
    const input = '{"a": 1, "b": [2, 3], "c": {"d": true}}'
    expect(safeJsonParse(input)).toEqual(JSON.parse(input))
  })

  it('does not pollute Object.prototype via __proto__ key', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length
    const input = '{"__proto__": {"polluted": true}, "a": 1}'
    const parsed = safeJsonParse(input) as Record<string, unknown>
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before)
    expect(parsed.a).toBe(1)
  })

  it('strips __proto__ as an own property (no pollution vector)', () => {
    const input = '{"__proto__": {"x": 1}, "a": 1}'
    const parsed = safeJsonParse(input) as Record<string, unknown>
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false)
    expect(parsed.a).toBe(1)
  })

  it('strips constructor as an own property', () => {
    const input = '{"constructor": {"prototype": {"p": 1}}, "a": 1}'
    const parsed = safeJsonParse(input) as Record<string, unknown>
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false)
    expect(parsed.a).toBe(1)
  })

  it('strips prototype as an own property', () => {
    const input = '{"prototype": {"p": 1}, "a": 1}'
    const parsed = safeJsonParse(input) as Record<string, unknown>
    expect(Object.hasOwn(parsed, 'prototype')).toBe(false)
    expect(parsed.a).toBe(1)
  })

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => safeJsonParse('{not valid')).toThrow(SyntaxError)
  })
})
