/**
 * PickerToggle — placeholder. Task 30 replaces with real visual component.
 */

import type { JSX } from 'react'

export interface PickerToggleProps {
  armed: boolean
}

export function PickerToggle(props: PickerToggleProps): JSX.Element {
  return (
    <div data-testid="picker-toggle" data-armed={props.armed ? 'true' : 'false'}>
      {props.armed ? 'picker: armed' : 'picker: off'}
    </div>
  )
}
