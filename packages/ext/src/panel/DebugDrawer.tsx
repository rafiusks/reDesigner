/**
 * DebugDrawer — the actual dialog body of the debug panel. Lazy-loaded from
 * Debug.tsx so the <dialog> + inline styles only ship once a user opens it
 * via Shift+Alt+D. The keyboard-listener wrapper stays eagerly loaded to
 * register the shortcut at app start.
 */

import type { JSX } from 'react'

export interface DebugDrawerProps {
  tabId: number
  windowId: number
  version: number
}

export function DebugDrawer(props: DebugDrawerProps): JSX.Element {
  return (
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
      <div style={{ marginTop: 8, color: '#888', fontSize: 10 }}>Press Shift+Alt+D to close</div>
    </dialog>
  )
}

export default DebugDrawer
