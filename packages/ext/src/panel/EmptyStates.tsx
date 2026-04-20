/**
 * EmptyStates — placeholder. Task 30 replaces with real visual component.
 */

import type { JSX } from 'react'

export interface EmptyStatesProps {
  reason: 'no-selection' | 'mcp-missing' | 'disconnected'
}

export function EmptyStates(props: EmptyStatesProps): JSX.Element {
  return (
    <div data-testid="empty-state" data-reason={props.reason}>
      {props.reason}
    </div>
  )
}
