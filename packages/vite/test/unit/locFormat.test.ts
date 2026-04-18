import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatLoc, parseLoc } from '../../src/core/locFormat'

describe('formatLoc / parseLoc', () => {
  it('roundtrips simple input', () => {
    const s = formatLoc('src/components/Button.tsx', 12, 4)
    expect(s).toBe('src/components/Button.tsx:12:4')
    expect(parseLoc(s)).toEqual({ filePath: 'src/components/Button.tsx', line: 12, col: 4 })
  })

  it('rejects backslash in filePath', () => {
    expect(() => formatLoc('src\\x.tsx', 1, 1)).toThrow(/posix separator/)
  })

  it('rejects drive-letter prefix', () => {
    expect(() => formatLoc('C:/x.tsx', 1, 1)).toThrow(/drive letter|absolute/)
  })

  it('parses unicode filenames', () => {
    const s = 'src/🎉/Button.tsx:1:1'
    expect(parseLoc(s)).toEqual({ filePath: 'src/🎉/Button.tsx', line: 1, col: 1 })
  })

  it('property: parseLoc(formatLoc(p, l, c)) roundtrips', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — filter rejects control chars from fast-check generator
          .filter((s) => !/[\r\n\x00-\x1f]/.test(s) && !s.includes('\\') && !/^[A-Za-z]:/.test(s)),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (p, l, c) => {
          const formatted = formatLoc(p, l, c)
          const parsed = parseLoc(formatted)
          expect(parsed).toEqual({ filePath: p, line: l, col: c })
        },
      ),
      { numRuns: 200 },
    )
  })
})
