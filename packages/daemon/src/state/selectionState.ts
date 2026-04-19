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
}

export interface StaleResolution {
  resolvedCount: number
}

function getSelectionId(r: SelectionRecord): string {
  return r.handle.id
}

export class SelectionState {
  private current: SelectionRecord | null = null
  private history: SelectionRecord[] = []
  private readonly HISTORY_CAP = 50

  apply(incoming: SelectionRecord): ApplyResult {
    const id = getSelectionId(incoming)
    if (this.current && getSelectionId(this.current) === id) {
      return { kind: 'noop', current: this.current.handle }
    }
    const idx = this.history.findIndex((r) => getSelectionId(r) === id)
    if (idx >= 0) {
      const existing = this.history.splice(idx, 1)[0]
      if (existing === undefined) return { kind: 'new', current: this.current?.handle ?? null }
      this.history.unshift(existing)
      this.current = existing
      return { kind: 'promoted', current: existing.handle }
    }
    this.history.unshift(incoming)
    if (this.history.length > this.HISTORY_CAP) this.history.length = this.HISTORY_CAP
    const head = this.history[0]
    if (head === undefined) return { kind: 'new', current: null }
    this.current = head
    return { kind: 'new', current: this.current.handle }
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
