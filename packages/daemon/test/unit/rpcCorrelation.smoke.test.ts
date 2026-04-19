import { describe, expect, it, vi } from 'vitest'
import { RpcCorrelation } from '../../src/ws/rpcCorrelation.js'

describe('RpcCorrelation smoke', () => {
  it('register + resolve matches by id', async () => {
    const r = new RpcCorrelation(8)
    const p = r.register('id-1', 5000)
    r.resolve('id-1', { styles: {} })
    await expect(p).resolves.toEqual({ styles: {} })
  })
  it('timeout rejects pending and frees slot before reject resolves', async () => {
    vi.useFakeTimers()
    const r = new RpcCorrelation(1)
    const p = r.register('id-1', 100)
    expect(r.tryAcquire()).toBe(false) // slot occupied
    vi.advanceTimersByTime(150)
    await expect(p).rejects.toThrow(/timeout/)
    expect(r.tryAcquire()).toBe(true) // freed before reject resolved
    vi.useRealTimers()
  })
})
