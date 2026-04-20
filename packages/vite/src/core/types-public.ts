/** @see §6.6 of the design spec; @redesigner/vite/reader implements the algorithm. */
// Plugin-specific types stay here.
// Shared types (Manifest, ComponentHandle, etc.) are re-exported from @redesigner/core.
export type {
  SchemaVersion,
  ComponentRecord,
  LocRecord,
  Manifest,
  ComponentHandle,
  SelectionFile,
} from '@redesigner/core'

import type { Editor } from '@redesigner/core/schemas'

export type { Editor }

export interface DaemonOptions {
  mode?: 'auto' | 'required' | 'off'
}

export interface RedesignerOptions {
  manifestPath?: string
  include?: string[]
  exclude?: string[]
  enabled?: boolean
  daemon?: DaemonOptions | 'auto' | 'required' | 'off'
  /**
   * Editor used by deep-link URL builders in the extension.
   * Validated at plugin boot; invalid values log a warning and default to 'vscode'.
   */
  editor?: Editor
}
