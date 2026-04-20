import type { ComponentHandle, Manifest } from '@redesigner/core'

export interface SelectionProvenance {
  receivedAt: number
  staleManifest: boolean
  manifestContentHashAtIntake?: string
}

export interface SelectionRecord {
  handle: ComponentHandle
  provenance: SelectionProvenance
}

export type ApplyKind = 'noop' | 'promoted' | 'new'

export interface ApplyResult {
  kind: ApplyKind
  current: ComponentHandle | null
  selectionSeq: number
}

export interface StaleResolution {
  resolvedCount: number
}

function getSelectionId(r: SelectionRecord): string {
  return r.handle.id
}

export const TAB_SEQ_MAP_CAP = 256

export class SelectionState {
  private current: SelectionRecord | null = null
  private history: SelectionRecord[] = []
  private readonly HISTORY_CAP = 50
  /** Per-tab monotonic sequence counter. Keyed by tabId (positive integer). */
  private readonly tabSeqMap = new Map<number, number>()

  /** Number of entries currently in tabSeqMap (for test visibility). */
  tabSeqMapSize(): number {
    return this.tabSeqMap.size
  }

  /** Increment and return the per-tab seq for the given tabId. */
  nextTabSeq(tabId: number): number {
    const prev = this.tabSeqMap.get(tabId) ?? 0
    const next = prev + 1
    if (this.tabSeqMap.has(tabId)) {
      // LRU touch: delete then re-insert moves to Map insertion-order tail.
      this.tabSeqMap.delete(tabId)
    } else if (this.tabSeqMap.size >= TAB_SEQ_MAP_CAP) {
      // Evict the oldest (insertion-order head).
      const oldest = this.tabSeqMap.keys().next().value as number
      this.tabSeqMap.delete(oldest)
    }
    this.tabSeqMap.set(tabId, next)
    return next
  }

  apply(incoming: SelectionRecord, tabId?: number): ApplyResult {
    const id = getSelectionId(incoming)
    const selectionSeq = tabId !== undefined ? this.nextTabSeq(tabId) : 0
    if (this.current && getSelectionId(this.current) === id) {
      return { kind: 'noop', current: this.current.handle, selectionSeq }
    }
    const idx = this.history.findIndex((r) => getSelectionId(r) === id)
    if (idx >= 0) {
      const existing = this.history.splice(idx, 1)[0]
      if (existing === undefined)
        return { kind: 'new', current: this.current?.handle ?? null, selectionSeq }
      this.history.unshift(existing)
      this.current = existing
      return { kind: 'promoted', current: existing.handle, selectionSeq }
    }
    this.history.unshift(incoming)
    if (this.history.length > this.HISTORY_CAP) this.history.length = this.HISTORY_CAP
    const head = this.history[0]
    if (head === undefined) return { kind: 'new', current: null, selectionSeq }
    this.current = head
    return { kind: 'new', current: this.current.handle, selectionSeq }
  }

  rescan(manifest: Manifest): StaleResolution {
    let resolvedCount = 0
    const visited = new Set<SelectionRecord>()
    const records = this.current
      ? [this.current, ...this.history.filter((r) => r !== this.current)]
      : [...this.history]
    for (const r of records) {
      if (visited.has(r)) continue
      visited.add(r)
      if (!r.provenance.staleManifest) continue
      const match = Object.values(manifest.components).some(
        (c) =>
          c.filePath === r.handle.filePath &&
          c.lineRange[0] <= r.handle.lineRange[0] &&
          c.lineRange[1] >= r.handle.lineRange[1],
      )
      if (match) {
        r.provenance.staleManifest = false
        r.provenance.manifestContentHashAtIntake = manifest.contentHash
        resolvedCount++
      }
    }
    return { resolvedCount }
  }

  snapshot(): { current: ComponentHandle | null; recent: ComponentHandle[] } {
    return {
      current: this.current?.handle ?? null,
      recent: this.history.map((r) => r.handle),
    }
  }
}
