/**
 * Debug — placeholder. Task 30 replaces with real visual component.
 */

import type { JSX } from 'react'

export interface DebugProps {
  tabId: number
  windowId: number
  version: number
}

export function Debug(props: DebugProps): JSX.Element {
  return (
    <div
      data-testid="debug"
      data-tabid={props.tabId}
      data-windowid={props.windowId}
      data-version={props.version}
    />
  )
}
