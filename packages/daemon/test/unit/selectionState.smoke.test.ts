import type { ComponentHandle } from '@redesigner/core'
import { describe, expect, it } from 'vitest'
import { SelectionState } from '../../src/state/selectionState.js'

const mkHandle = (id: string): ComponentHandle => ({
  id,
  componentName: 'C',
  filePath: '/x.tsx',
  lineRange: [1, 2],
  domPath: '#x',
  parentChain: [],
  timestamp: 0,
})

describe('SelectionState smoke', () => {
  it('empty state: snapshot current is null', () => {
    const s = new SelectionState()
    expect(s.snapshot().current).toBe(null)
  })
  it('applies new -> kind=new + current updated', () => {
    const s = new SelectionState()
    const res = s.apply({
      handle: mkHandle('abc'),
      provenance: { receivedAt: 0, staleManifest: false },
    })
    expect(res.kind).toBe('new')
    expect(s.snapshot().current?.id).toBe('abc')
  })
  it('same id twice -> kind=noop no broadcast', () => {
    const s = new SelectionState()
    s.apply({ handle: mkHandle('abc'), provenance: { receivedAt: 0, staleManifest: false } })
    const res = s.apply({
      handle: mkHandle('abc'),
      provenance: { receivedAt: 1, staleManifest: false },
    })
    expect(res.kind).toBe('noop')
  })
  it('history entry re-clicked -> kind=promoted', () => {
    const s = new SelectionState()
    s.apply({ handle: mkHandle('a'), provenance: { receivedAt: 0, staleManifest: false } })
    s.apply({ handle: mkHandle('b'), provenance: { receivedAt: 1, staleManifest: false } })
    const res = s.apply({
      handle: mkHandle('a'),
      provenance: { receivedAt: 2, staleManifest: false },
    })
    expect(res.kind).toBe('promoted')
    expect(s.snapshot().current?.id).toBe('a')
  })
  it('history capped at 50', () => {
    const s = new SelectionState()
    for (let i = 0; i < 60; i++) {
      s.apply({ handle: mkHandle(`id${i}`), provenance: { receivedAt: i, staleManifest: false } })
    }
    expect(s.snapshot().recent.length).toBe(50)
  })
})
