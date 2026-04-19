import { describe, expect, it } from 'vitest'
import {
  ComponentHandleSchema,
  ManifestSchema,
  SELECTION_ID_RE,
  SelectionFileSchema,
} from '../../src/schema'

const validHandle = {
  id: 'abc-123',
  componentName: 'FooComponent',
  filePath: 'src/Foo.tsx',
  lineRange: [1, 10],
  domPath: '#root > div > div.foo',
  parentChain: ['App', 'Layout', 'FooComponent'],
  timestamp: 1_700_000_000_000,
}

describe('SELECTION_ID_RE', () => {
  it('accepts alphanumerics, dashes, underscores', () => {
    expect(SELECTION_ID_RE.test('abc')).toBe(true)
    expect(SELECTION_ID_RE.test('abc-123_x')).toBe(true)
  })
  it('rejects path-traversal characters', () => {
    expect(SELECTION_ID_RE.test('../etc')).toBe(false)
    expect(SELECTION_ID_RE.test('a/b')).toBe(false)
    expect(SELECTION_ID_RE.test('')).toBe(false)
  })
  it('rejects over-length', () => {
    expect(SELECTION_ID_RE.test('a'.repeat(129))).toBe(false)
  })
})

describe('ComponentHandleSchema', () => {
  it('accepts a valid handle', () => {
    expect(ComponentHandleSchema.safeParse(validHandle).success).toBe(true)
  })
  it('rejects unknown keys (strict)', () => {
    expect(ComponentHandleSchema.safeParse({ ...validHandle, extra: 1 }).success).toBe(false)
  })
  it('rejects invalid id', () => {
    expect(
      ComponentHandleSchema.safeParse({ ...validHandle, id: '../../etc/passwd' }).success,
    ).toBe(false)
  })
  it('rejects missing required field', () => {
    const { timestamp: _, ...rest } = validHandle
    expect(ComponentHandleSchema.safeParse(rest).success).toBe(false)
  })
})

describe('SelectionFileSchema', () => {
  it('accepts null current + empty history', () => {
    expect(SelectionFileSchema.safeParse({ current: null, history: [] }).success).toBe(true)
  })
  it('accepts current + non-empty history', () => {
    expect(
      SelectionFileSchema.safeParse({ current: validHandle, history: [validHandle] }).success,
    ).toBe(true)
  })
  it('rejects unknown top-level keys', () => {
    expect(SelectionFileSchema.safeParse({ current: null, history: [], extra: 1 }).success).toBe(
      false,
    )
  })
  it('rejects history > 1000', () => {
    const long = Array(1001).fill(validHandle)
    expect(SelectionFileSchema.safeParse({ current: null, history: long }).success).toBe(false)
  })
})

describe('ManifestSchema', () => {
  const validManifest = {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: '2026-04-19T00:00:00Z',
    contentHash: 'a'.repeat(64),
    components: {
      'src/Foo.tsx::Foo': {
        filePath: 'src/Foo.tsx',
        exportKind: 'named',
        lineRange: [1, 10],
        displayName: 'Foo',
      },
    },
    locs: {
      'src/Foo.tsx:2:4': {
        componentKey: 'src/Foo.tsx::Foo',
        filePath: 'src/Foo.tsx',
        componentName: 'Foo',
      },
    },
  }
  it('accepts a valid manifest', () => {
    expect(ManifestSchema.safeParse(validManifest).success).toBe(true)
  })
  it('rejects unknown top-level keys', () => {
    expect(ManifestSchema.safeParse({ ...validManifest, extra: 1 }).success).toBe(false)
  })
  it('rejects unknown keys inside a ComponentRecord', () => {
    const m = {
      ...validManifest,
      components: {
        'src/Foo.tsx::Foo': { ...validManifest.components['src/Foo.tsx::Foo'], extra: 1 },
      },
    }
    expect(ManifestSchema.safeParse(m).success).toBe(false)
  })
})
