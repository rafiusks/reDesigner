import { describe, expect, it } from 'vitest'
import { HandoffSchema, buildHandoff, resolveHandoffPath } from '../../src/handoff.js'

describe('handoff smoke', () => {
  it('HandoffSchema rejects missing required fields', () => {
    expect(HandoffSchema.safeParse({}).success).toBe(false)
  })
  it('resolveHandoffPath yields OS runtime dir path', () => {
    const p = resolveHandoffPath('/tmp')
    expect(p).toMatch(/daemon-v1\.json$/)
  })
  it('buildHandoff produces schema-valid output', () => {
    const h = buildHandoff({
      serverVersion: '0.0.1',
      pid: 123,
      port: 54321,
      token: 'a'.repeat(43),
      bootstrapToken: 'b'.repeat(43),
      projectRoot: '/tmp',
    })
    expect(HandoffSchema.safeParse(h).success).toBe(true)
  })
})
