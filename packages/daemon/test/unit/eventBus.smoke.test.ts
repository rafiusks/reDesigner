import { describe, expect, it } from 'vitest'
import { EventBus } from '../../src/state/eventBus.js'

describe('EventBus smoke', () => {
  it('mints monotonic seq', () => {
    const b = new EventBus()
    const a = b.mintSeq()
    const c = b.mintSeq()
    expect(c).toBe(a + 1)
  })
  it('ring buffer retains metadata only (1024 entries)', () => {
    const b = new EventBus()
    for (let i = 0; i < 2000; i++) b.recordFrame({ type: 'test.frame', seq: b.mintSeq() })
    expect(b.ringSize()).toBe(1024)
    expect(b.earliestRetainedSeq()).toBeGreaterThan(0)
  })
  it('?since within buffer → hello only (no gap)', () => {
    const b = new EventBus()
    for (let i = 0; i < 50; i++) b.recordFrame({ type: 'x', seq: b.mintSeq() })
    const r = b.computeResync(25, b.currentSeq())
    expect(r.kind).toBe('hello-only')
  })
  it('?since older than buffer → hello + gap', () => {
    const b = new EventBus()
    for (let i = 0; i < 2000; i++) b.recordFrame({ type: 'x', seq: b.mintSeq() })
    const r = b.computeResync(5, b.currentSeq())
    expect(r.kind).toBe('hello-gap')
    if (r.kind === 'hello-gap') {
      expect(r.droppedFrom).toBe(6)
      expect(r.droppedTo).toBe(b.currentSeq() - 1024)
    }
  })
})
