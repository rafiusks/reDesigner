import { describe, expect, it } from 'vitest'
import { serializeReadyLine } from '../../src/child.js'

describe('ready line', () => {
  it('emits required fields as JSON + newline', () => {
    const line = serializeReadyLine({
      port: 54321,
      instanceId: '00000000-0000-0000-0000-000000000000',
    })
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line.trim())
    expect(parsed.type).toBe('ready')
    expect(parsed.port).toBe(54321)
    expect(parsed.instanceId).toBeDefined()
  })
})
