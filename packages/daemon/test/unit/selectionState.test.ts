import type { ComponentHandle, Manifest } from '@redesigner/core'
import { describe, expect, it } from 'vitest'
import { type SelectionRecord, SelectionState } from '../../src/state/selectionState.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkHandle = (
  id: string,
  filePath = '/app/Foo.tsx',
  lineRange: [number, number] = [10, 20],
): ComponentHandle => ({
  id,
  componentName: id,
  filePath,
  lineRange,
  domPath: `#${id}`,
  parentChain: [],
  timestamp: 0,
})

const mkRecord = (
  id: string,
  stale = false,
  filePath = '/app/Foo.tsx',
  lineRange: [number, number] = [10, 20],
): SelectionRecord => ({
  handle: mkHandle(id, filePath, lineRange),
  provenance: { receivedAt: Date.now(), staleManifest: stale },
})

const mkManifest = (components: Manifest['components'] = {}, contentHash = 'hash-1'): Manifest => ({
  schemaVersion: '1.0',
  framework: 'react',
  generatedAt: new Date().toISOString(),
  contentHash,
  components,
  locs: {},
})

// ---------------------------------------------------------------------------
// apply — taxonomy (noop / promoted / new)
// ---------------------------------------------------------------------------

describe('SelectionState.apply — taxonomy', () => {
  it('returns kind=new and sets current when handle is unseen', () => {
    const s = new SelectionState()
    const result = s.apply(mkRecord('alpha'))
    expect(result.kind).toBe('new')
    expect(result.current?.id).toBe('alpha')
    expect(s.snapshot().current?.id).toBe('alpha')
  })

  it('returns kind=noop when called with the id matching current', () => {
    const s = new SelectionState()
    s.apply(mkRecord('alpha'))
    const result = s.apply(mkRecord('alpha'))
    expect(result.kind).toBe('noop')
    expect(result.current?.id).toBe('alpha')
  })

  it('returns kind=promoted when id exists in history but is not current', () => {
    const s = new SelectionState()
    s.apply(mkRecord('alpha'))
    s.apply(mkRecord('beta'))
    // alpha is now in history, not current
    const result = s.apply(mkRecord('alpha'))
    expect(result.kind).toBe('promoted')
    expect(result.current?.id).toBe('alpha')
    expect(s.snapshot().current?.id).toBe('alpha')
  })

  it('promoted moves the entry to the front of history', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a'))
    s.apply(mkRecord('b'))
    s.apply(mkRecord('c'))
    // history is [c, b, a]; current=c. Re-select a.
    s.apply(mkRecord('a'))
    const { recent } = s.snapshot()
    expect(recent[0]?.id).toBe('a')
  })

  it('new adds a fresh handle with no prior history', () => {
    const s = new SelectionState()
    s.apply(mkRecord('x'))
    s.apply(mkRecord('y'))
    // z is completely new
    const result = s.apply(mkRecord('z'))
    expect(result.kind).toBe('new')
    expect(s.snapshot().recent.map((h) => h.id)).toContain('z')
  })

  it('apply result.current matches snapshot.current after every transition', () => {
    const s = new SelectionState()
    const r1 = s.apply(mkRecord('p'))
    expect(r1.current?.id).toBe(s.snapshot().current?.id)
    const r2 = s.apply(mkRecord('q'))
    expect(r2.current?.id).toBe(s.snapshot().current?.id)
    const r3 = s.apply(mkRecord('p'))
    expect(r3.current?.id).toBe(s.snapshot().current?.id)
  })
})

// ---------------------------------------------------------------------------
// 50-cap history — eviction order
// ---------------------------------------------------------------------------

describe('SelectionState — 50-entry history cap', () => {
  it('history never exceeds 50 entries after many applies', () => {
    const s = new SelectionState()
    for (let i = 0; i < 70; i++) {
      s.apply(mkRecord(`id${i}`))
    }
    expect(s.snapshot().recent.length).toBe(50)
  })

  it('evicts oldest entries first (head is most-recent)', () => {
    const s = new SelectionState()
    for (let i = 0; i < 55; i++) {
      s.apply(mkRecord(`id${i}`))
    }
    const { recent } = s.snapshot()
    // Most recent push is id54, which should be at index 0
    expect(recent[0]?.id).toBe('id54')
    // id0..id4 are the 5 oldest — they should have been evicted
    const ids = recent.map((h) => h.id)
    for (let i = 0; i < 5; i++) {
      expect(ids).not.toContain(`id${i}`)
    }
    // id5..id54 — the 50 most-recent — should all be present
    for (let i = 5; i < 55; i++) {
      expect(ids).toContain(`id${i}`)
    }
  })

  it('history at exactly 50 entries does not evict', () => {
    const s = new SelectionState()
    for (let i = 0; i < 50; i++) {
      s.apply(mkRecord(`id${i}`))
    }
    expect(s.snapshot().recent.length).toBe(50)
    // All 50 should be present
    const ids = s.snapshot().recent.map((h) => h.id)
    for (let i = 0; i < 50; i++) {
      expect(ids).toContain(`id${i}`)
    }
  })

  it('pushing the 51st entry evicts only the oldest (id0)', () => {
    const s = new SelectionState()
    for (let i = 0; i < 51; i++) {
      s.apply(mkRecord(`id${i}`))
    }
    const ids = s.snapshot().recent.map((h) => h.id)
    expect(ids).not.toContain('id0')
    expect(ids).toContain('id1')
    expect(ids).toContain('id50')
    expect(ids.length).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// reclick-current-is-noop — no state churn
// ---------------------------------------------------------------------------

describe('SelectionState.apply — reclick current is noop, no state churn', () => {
  it('noop does not mutate current reference', () => {
    const s = new SelectionState()
    s.apply(mkRecord('alpha'))
    const before = s.snapshot().current
    s.apply(mkRecord('alpha'))
    const after = s.snapshot().current
    // The handle object returned should be the same (same reference or same id)
    expect(after?.id).toBe(before?.id)
  })

  it('noop result.current is the already-stored handle, not the incoming one', () => {
    const s = new SelectionState()
    const first = mkRecord('alpha')
    s.apply(first)
    // Pass a different object with same id (e.g. newer timestamp)
    const second = mkRecord('alpha')
    second.handle = { ...first.handle, timestamp: 999 }
    const result = s.apply(second)
    expect(result.kind).toBe('noop')
    // The returned current should carry the original timestamp (0), not 999
    expect(result.current?.timestamp).toBe(0)
  })

  it('multiple noops in a row all return kind=noop', () => {
    const s = new SelectionState()
    s.apply(mkRecord('x'))
    for (let i = 0; i < 5; i++) {
      expect(s.apply(mkRecord('x')).kind).toBe('noop')
    }
  })

  it('history length is unchanged after a noop', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a'))
    s.apply(mkRecord('b'))
    const lenBefore = s.snapshot().recent.length
    s.apply(mkRecord('b'))
    expect(s.snapshot().recent.length).toBe(lenBefore)
  })
})

// ---------------------------------------------------------------------------
// rescan — resolves stale entries that match manifest; never adds
// ---------------------------------------------------------------------------
//
// NOTE: The task description says rescan "removes" stale entries. The actual
// implementation instead *resolves* them: entries whose filePath+lineRange are
// found in the manifest have staleManifest set to false. Entries that remain
// unmatched are NOT removed — they stay in history with staleManifest=true.
// Tests here reflect the actual source behaviour.

describe('SelectionState.rescan — stale resolution', () => {
  it('returns resolvedCount=0 when no entries are stale', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a', false))
    const result = s.rescan(mkManifest())
    expect(result.resolvedCount).toBe(0)
  })

  it('resolves stale entries whose filePath+lineRange appear in manifest', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a', true, '/app/Foo.tsx', [10, 20]))
    const manifest = mkManifest({
      'Foo-1': {
        filePath: '/app/Foo.tsx',
        exportKind: 'named',
        lineRange: [10, 20],
        displayName: 'Foo',
      },
    })
    const result = s.rescan(manifest)
    expect(result.resolvedCount).toBe(1)
  })

  it('does not resolve entries whose filePath does not match', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a', true, '/app/Bar.tsx', [10, 20]))
    const manifest = mkManifest({
      'Foo-1': {
        filePath: '/app/Foo.tsx',
        exportKind: 'named',
        lineRange: [10, 20],
        displayName: 'Foo',
      },
    })
    const result = s.rescan(manifest)
    expect(result.resolvedCount).toBe(0)
  })

  it('does not resolve entries whose lineRange falls outside the component range', () => {
    const s = new SelectionState()
    // handle lineRange [5, 25] vs component [10, 20] — handle[0]=5 < component[0]=10 so no match
    s.apply(mkRecord('a', true, '/app/Foo.tsx', [5, 25]))
    const manifest = mkManifest({
      'Foo-1': {
        filePath: '/app/Foo.tsx',
        exportKind: 'named',
        lineRange: [10, 20],
        displayName: 'Foo',
      },
    })
    const result = s.rescan(manifest)
    expect(result.resolvedCount).toBe(0)
  })

  it('unmatched stale entries remain in history after rescan (not removed)', () => {
    const s = new SelectionState()
    s.apply(mkRecord('stale-a', true, '/app/Gone.tsx', [1, 5]))
    s.apply(mkRecord('fresh-b', false, '/app/Bar.tsx', [1, 5]))
    const manifest = mkManifest({
      'Bar-1': {
        filePath: '/app/Bar.tsx',
        exportKind: 'named',
        lineRange: [1, 5],
        displayName: 'Bar',
      },
    })
    s.rescan(manifest)
    const { recent } = s.snapshot()
    expect(recent.map((h) => h.id)).toContain('stale-a')
  })

  it('rescan never adds entries to history', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a', false))
    const lenBefore = s.snapshot().recent.length
    const manifest = mkManifest({
      'New-1': {
        filePath: '/app/New.tsx',
        exportKind: 'named',
        lineRange: [1, 10],
        displayName: 'New',
      },
    })
    s.rescan(manifest)
    expect(s.snapshot().recent.length).toBe(lenBefore)
  })

  it('resolves multiple stale entries in one pass', () => {
    const s = new SelectionState()
    s.apply(mkRecord('a', true, '/app/Foo.tsx', [10, 20]))
    s.apply(mkRecord('b', true, '/app/Bar.tsx', [1, 5]))
    const manifest = mkManifest({
      'Foo-1': {
        filePath: '/app/Foo.tsx',
        exportKind: 'named',
        lineRange: [10, 20],
        displayName: 'Foo',
      },
      'Bar-1': {
        filePath: '/app/Bar.tsx',
        exportKind: 'named',
        lineRange: [1, 5],
        displayName: 'Bar',
      },
    })
    const result = s.rescan(manifest)
    expect(result.resolvedCount).toBe(2)
  })

  it('updates manifestContentHashAtIntake on resolved entry', () => {
    const s = new SelectionState()
    const rec = mkRecord('a', true, '/app/Foo.tsx', [10, 20])
    s.apply(rec)
    const manifest = mkManifest(
      {
        'Foo-1': {
          filePath: '/app/Foo.tsx',
          exportKind: 'named',
          lineRange: [10, 20],
          displayName: 'Foo',
        },
      },
      'hash-xyz',
    )
    s.rescan(manifest)
    // provenance on the record is mutated in place
    expect(rec.provenance.staleManifest).toBe(false)
    expect(rec.provenance.manifestContentHashAtIntake).toBe('hash-xyz')
  })

  it('rescan on empty state returns resolvedCount=0', () => {
    const s = new SelectionState()
    const result = s.rescan(mkManifest())
    expect(result.resolvedCount).toBe(0)
  })

  it('lineRange inside component bounds resolves correctly', () => {
    // component spans [1, 30]; handle lineRange [10, 20] — should match
    const s = new SelectionState()
    s.apply(mkRecord('a', true, '/app/Foo.tsx', [10, 20]))
    const manifest = mkManifest({
      'Foo-1': {
        filePath: '/app/Foo.tsx',
        exportKind: 'named',
        lineRange: [1, 30],
        displayName: 'Foo',
      },
    })
    const result = s.rescan(manifest)
    expect(result.resolvedCount).toBe(1)
  })
})
