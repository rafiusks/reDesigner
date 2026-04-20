/**
 * SelectionCard — placeholder. Task 30 replaces with real visual component.
 */

import type { ComponentHandle } from '@redesigner/core/types'
import type { JSX } from 'react'

export interface SelectionCardProps {
  selection: ComponentHandle | null
}

export function SelectionCard(props: SelectionCardProps): JSX.Element {
  return (
    <div data-testid="selection-card" data-has-selection={props.selection ? 'true' : 'false'}>
      {props.selection ? props.selection.componentName : 'no selection'}
    </div>
  )
}
