/**
 * ConnectionBadge — placeholder. Task 30 replaces with real visual component.
 */

import type { JSX } from 'react'

export interface ConnectionBadgeProps {
  status: string
}

export function ConnectionBadge(props: ConnectionBadgeProps): JSX.Element {
  return (
    <div data-testid="connection-badge" data-status={props.status}>
      {props.status}
    </div>
  )
}
