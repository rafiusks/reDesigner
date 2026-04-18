/** @see §6.6 of the design spec; @redesigner/vite/reader implements the algorithm. */
export type SchemaVersion = `${number}.${number}`

export interface Manifest {
  schemaVersion: SchemaVersion
  /**
   * Framework identifier. Today: 'react'. Additive new values are a MINOR bump and
   * require accompanying framework-specific record fields (today's are React-shaped).
   */
  framework: string
  /** Human-readable wall clock. Consumers wanting change-detection use contentHash. */
  generatedAt: string
  /**
   * sha256 over the serialized `{components, locs}` subset (excluding generatedAt + contentHash).
   * Canonical: UTF-8, sorted keys at every level, `','` + `':'` separators, no whitespace, no trailing newline.
   */
  contentHash: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  /** Stable join key. Format `<filePath>::<componentName>`. componentName may NOT contain `::`. */
  componentKey: string
  filePath: string
  componentName: string
}

export interface DaemonOptions {
  mode?: 'auto' | 'required' | 'off'
  port?: number
}

export interface RedesignerOptions {
  manifestPath?: string
  include?: string[]
  exclude?: string[]
  enabled?: boolean
  daemon?: DaemonOptions | 'auto' | 'required' | 'off'
}
