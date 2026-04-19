import { describe, expect, it } from 'vitest'
import { safeJsonParse } from '../../src/safeJsonParse'

describe('safeJsonParse', () => {
  it('parses valid JSON identically to JSON.parse', () => {
    const input = '{"a": 1, "b": [2, 3], "c": {"d": true}}'
    expect(safeJsonParse(input)).toEqual(JSON.parse(input))
  })

  it('strips __proto__ keys', () => {
    const input = '{"__proto__": {"polluted": true}, "a": 1}'
    const parsed = safeJsonParse(input) as { __proto__?: unknown; a: number }
    expect(parsed.__proto__).toBeUndefined()
    expect(parsed.a).toBe(1)
  })

  it('strips constructor keys', () => {
    const input = '{"constructor": {"prototype": {"p": 1}}, "a": 1}'
    const parsed = safeJsonParse(input) as { constructor?: unknown; a: number }
    expect(parsed.constructor).toBeUndefined()
    expect(parsed.a).toBe(1)
  })

  it('strips prototype keys', () => {
    const input = '{"prototype": {"p": 1}, "a": 1}'
    const parsed = safeJsonParse(input) as { prototype?: unknown; a: number }
    expect(parsed.prototype).toBeUndefined()
    expect(parsed.a).toBe(1)
  })

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => safeJsonParse('{not valid')).toThrow(SyntaxError)
  })
})
