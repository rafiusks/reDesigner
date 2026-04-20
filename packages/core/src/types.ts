export type SchemaVersion = '1.0'

export interface ComponentRecord {
  filePath: string
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  componentKey: string
  filePath: string
  componentName: string
}

export interface Manifest {
  schemaVersion: SchemaVersion
  framework: 'react'
  generatedAt: string
  contentHash: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentHandle {
  id: string
  componentName: string
  filePath: string
  lineRange: [number, number]
  domPath: string
  parentChain: string[]
  timestamp: number
}

export interface SelectionFile {
  current: ComponentHandle | null
  history: ComponentHandle[]
}
