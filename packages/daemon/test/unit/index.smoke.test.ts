import { describe, expect, it } from 'vitest'
import { startDaemon } from '../../src/index.js'

describe('startDaemon smoke', () => {
  it('module exports function signature', () => {
    expect(typeof startDaemon).toBe('function')
  })
})
