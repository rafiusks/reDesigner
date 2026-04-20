import type { ComponentRecord, LocRecord } from './types-public'

export interface PerFileBatch {
  filePath: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface Logger {
  info(m: string): void
  warn(m: string): void
  error(m: string): void
  debug?(m: string): void
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}
