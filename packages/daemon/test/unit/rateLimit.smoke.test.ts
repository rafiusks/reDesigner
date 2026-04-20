import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConcurrencyGate, createTokenBucket } from '../../src/rateLimit.js'

describe('token bucket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  it('allows up to burst then 429', () => {
    const bucket = createTokenBucket({ ratePerSec: 100, burst: 30 })
    for (let i = 0; i < 30; i++) expect(bucket.tryConsume()).toBe(true)
    expect(bucket.tryConsume()).toBe(false)
  })

  it('refills at ratePerSec', () => {
    const bucket = createTokenBucket({ ratePerSec: 100, burst: 30 })
    for (let i = 0; i < 30; i++) bucket.tryConsume()
    vi.setSystemTime(100)
    expect(bucket.tryConsume()).toBe(true)
  })

  it('retryAfter returns at least 1 second when exhausted', () => {
    const bucket = createTokenBucket({ ratePerSec: 100, burst: 30 })
    for (let i = 0; i < 30; i++) bucket.tryConsume()
    expect(bucket.retryAfterSec()).toBe(1)
  })
})

describe('concurrency gate', () => {
  it('8 slots, 9th rejected, release frees', () => {
    const gate = createConcurrencyGate(8)
    for (let i = 0; i < 8; i++) expect(gate.acquire()).toBe(true)
    expect(gate.acquire()).toBe(false)
    gate.release()
    expect(gate.acquire()).toBe(true)
  })
})
