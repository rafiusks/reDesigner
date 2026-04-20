/**
 * EmptyStates — fallback copy when no selection exists or a blocking condition
 * prevents normal operation.
 */

import type { JSX } from 'react'

export interface EmptyStatesProps {
  reason: 'no-selection' | 'mcp-missing' | 'disconnected'
}

const COPY: Record<EmptyStatesProps['reason'], string> = {
  'no-selection': 'Click the picker button or use the shortcut to select a component.',
  'mcp-missing': 'MCP shim not configured — set it up to enable AI commands.',
  disconnected: 'Not connected to the dev server. Make sure it is running.',
}

export function EmptyStates(props: EmptyStatesProps): JSX.Element {
  return (
    <div
      data-testid="empty-state"
      data-reason={props.reason}
      style={{ padding: '16px', textAlign: 'center', color: '#888', fontSize: 13 }}
    >
      {COPY[props.reason]}
    </div>
  )
}
