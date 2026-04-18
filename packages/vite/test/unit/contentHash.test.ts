import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { computeContentHash, canonicalize } from '../../src/core/contentHash'

const baseManifest = () => ({
  schemaVersion: '1.0' as const,
  framework: 'react',
  generatedAt: new Date(0).toISOString(),
  contentHash: '',
  components: {},
  locs: {},
})

describe('canonicalize', () => {
  it('sorts object keys at every level', () => {
    const s = canonicalize({ b: 1, a: { z: 2, y: 1 } })
    expect(s).toBe('{"a":{"y":1,"z":2},"b":1}')
  })
  it('produces UTF-8 bytes with no trailing newline', () => {
    expect(canonicalize({ x: '🎉' }).endsWith('\n')).toBe(false)
  })
})

describe('computeContentHash', () => {
  it('excludes generatedAt and contentHash from hash', () => {
    const m1 = { ...baseManifest(), generatedAt: '2020-01-01T00:00:00.000Z', contentHash: 'foo' }
    const m2 = { ...baseManifest(), generatedAt: '2099-12-31T23:59:59.000Z', contentHash: 'bar' }
    expect(computeContentHash(m1)).toBe(computeContentHash(m2))
  })
  it('property: key-order in components does not change hash', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.record({
          filePath: fc.string({ minLength: 1 }),
          exportKind: fc.constantFrom<'default' | 'named'>('default', 'named'),
          lineRange: fc.tuple(fc.nat(), fc.nat()),
          displayName: fc.string({ minLength: 1 }),
        }), { minKeys: 1, maxKeys: 5 }),
        (components) => {
          const entries = Object.entries(components)
          const shuffled = Object.fromEntries([...entries].reverse())
          const h1 = computeContentHash({ ...baseManifest(), components })
          const h2 = computeContentHash({ ...baseManifest(), components: shuffled })
          expect(h1).toBe(h2)
        },
      ),
      { numRuns: 100 },
    )
  })
})
