import type { ComponentRecord, LocRecord } from './types-public'

export interface PerFileBatch {
  filePath: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface WriterState {
  byFile: Map<string, PerFileBatch>
}

export interface WriterInternals {
  /** Promise resolving once the given flush sequence has landed on disk. */
  onFlush(seq: number): Promise<void>
  /** Forces a flush and resolves after it lands. Decoupled from debounce timing. */
  quiesce(): Promise<void>
  /** Forces a flush ignoring debounce; test-only seam. */
  forceFlush(): Promise<void>
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}
