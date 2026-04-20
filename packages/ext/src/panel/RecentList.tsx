/**
 * RecentList — placeholder. Task 30 replaces with real visual component.
 */

import type { ComponentHandle } from '@redesigner/core/types'
import type { JSX } from 'react'

export interface RecentListProps {
  recent: readonly ComponentHandle[]
}

export function RecentList(props: RecentListProps): JSX.Element {
  return (
    <div data-testid="recent-list" data-count={props.recent.length}>
      {props.recent.length === 0 ? 'empty' : `${props.recent.length} recent`}
    </div>
  )
}
