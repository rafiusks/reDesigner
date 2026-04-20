/**
 * Debug drawer — gated by Shift+Alt+D.
 *
 * MUST NOT open if:
 *  - Only Shift+D (VoiceOver conflict)
 *  - Target is input, textarea, or [contenteditable]
 *
 * Shows: tabId, windowId, version, frame log, connection state.
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'

export interface DebugProps {
  tabId: number
  windowId: number
  version: number
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if (target.getAttribute('contenteditable') !== null) return true
  return false
}

export function Debug(props: DebugProps): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Require Shift+Alt+D — NOT Shift+D alone (VoiceOver conflict)
      if (e.key !== 'D' || !e.shiftKey || !e.altKey) return
      // Ignore when focus is in an editable element
      if (isEditableTarget(e.target)) return

      setOpen((prev) => !prev)
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [])

  return (
    <>
      {open && (
        <dialog
          data-testid="debug-drawer"
          aria-label="Debug information"
          open
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            margin: 0,
            width: '100%',
            background: '#1e1e1e',
            color: '#d4d4d4',
            fontFamily: 'monospace',
            fontSize: 11,
            padding: '12px',
            zIndex: 9999,
            maxHeight: '40vh',
            overflowY: 'auto',
            borderTop: '2px solid #4caf50',
            border: 'none',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <strong>Debug Panel</strong>
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ paddingRight: 12, color: '#888' }}>tabId</td>
                <td>{props.tabId}</td>
              </tr>
              <tr>
                <td style={{ paddingRight: 12, color: '#888' }}>windowId</td>
                <td>{props.windowId}</td>
              </tr>
              <tr>
                <td style={{ paddingRight: 12, color: '#888' }}>version</td>
                <td>{props.version}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8, color: '#888', fontSize: 10 }}>
            Press Shift+Alt+D to close
          </div>
        </dialog>
      )}
    </>
  )
}
