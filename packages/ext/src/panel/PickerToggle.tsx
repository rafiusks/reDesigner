/**
 * PickerToggle — arms or disarms the component picker via runtime message.
 */

import type { JSX } from 'react'

export interface PickerToggleProps {
  armed: boolean
}

export function PickerToggle(props: PickerToggleProps): JSX.Element {
  const handleToggle = (): void => {
    chrome.runtime.sendMessage({
      type: props.armed ? 'disarm-picker' : 'arm-picker',
    })
  }

  return (
    <button
      type="button"
      data-testid="picker-toggle"
      data-armed={props.armed ? 'true' : 'false'}
      onClick={handleToggle}
      style={{
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        background: props.armed ? '#e53935' : '#1565c0',
        color: '#fff',
        border: 'none',
        borderRadius: 4,
        fontWeight: 500,
      }}
    >
      {props.armed ? 'Stop picking' : 'Pick component'}
    </button>
  )
}
