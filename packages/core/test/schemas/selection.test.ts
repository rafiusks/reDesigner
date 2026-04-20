import { describe, expect, test } from 'vitest'
import { SelectionPutBodySchema, SelectionPutResponseSchema } from '../../src/schemas/selection.js'

const validHandle = {
  id: 'test-id-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: 1_700_000_000_000,
}

describe('SelectionPutBodySchema', () => {
  test('validates body WITH clientId', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      clientId: '00000000-0000-4000-8000-000000000001',
    })
    expect(r.success).toBe(true)
  })

  test('validates body WITHOUT clientId (optional)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle] })
    expect(r.success).toBe(true)
  })

  test('rejects body with foreign top-level field (.strict preserved)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle], foo: 1 })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe('unrecognized_keys')
    }
  })

  test('rejects malformed clientId (not UUIDv4)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle], clientId: 'not-a-uuid' })
    expect(r.success).toBe(false)
  })

  test('meta accepts unknown fields via catchall', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      meta: { source: 'picker', pickSeq: 42 },
    })
    expect(r.success).toBe(true)
  })

  test('meta rejects invalid source enum', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      meta: { source: 'picker-v2' },
    })
    expect(r.success).toBe(false)
  })
})

describe('SelectionPutResponseSchema (forward-evolvable)', () => {
  test('validates known fields', () => {
    const r = SelectionPutResponseSchema.safeParse({
      selectionSeq: 1,
      acceptedAt: 1_700_000_000_000,
    })
    expect(r.success).toBe(true)
  })

  test('accepts unknown future field via catchall AND preserves its value', () => {
    const r = SelectionPutResponseSchema.safeParse({
      selectionSeq: 1,
      acceptedAt: 1_700_000_000_000,
      futureField: 'x',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect((r.data as { futureField?: unknown }).futureField).toBe('x')
    }
  })
})
