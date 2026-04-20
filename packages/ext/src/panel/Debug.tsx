/**
 * Debug — keyboard-shortcut wrapper. Renders nothing until Shift+Alt+D is
 * pressed; the drawer body is a lazy chunk (./DebugDrawer.tsx) so steady-state
 * panel bytes don't include the dialog/inline styles until first open.
 *
 * MUST NOT open if:
 *  - Only Shift+D (VoiceOver conflict)
 *  - Target is input, textarea, or [contenteditable]
 */

import { Suspense, lazy, useEffect, useState } from 'react'
import type { JSX } from 'react'

const DebugDrawer = lazy(() => import('./DebugDrawer.js'))

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

export function Debug(props: DebugProps): JSX.Element | null {
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

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <DebugDrawer tabId={props.tabId} windowId={props.windowId} version={props.version} />
    </Suspense>
  )
}
