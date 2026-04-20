/**
 * ShortcutsFooter — shows the arm-picker shortcut, read live from
 * chrome.commands.getAll() via useLiveChord(). No hardcoded chord literals.
 */

import type { JSX } from 'react'
import { useLiveChord } from './hooks/useLiveChord.js'

export function ShortcutsFooter(): JSX.Element {
  const chord = useLiveChord('arm-picker')

  return (
    <div
      data-testid="shortcuts-footer"
      style={{ fontSize: 11, color: '#888', padding: '4px 8px', borderTop: '1px solid #eee' }}
    >
      {chord ? (
        <span>Press {chord} to pick</span>
      ) : (
        <span>
          <a
            href="chrome://extensions/shortcuts"
            target="_blank"
            rel="noreferrer"
            style={{ color: '#1565c0' }}
          >
            Set a shortcut to pick
          </a>
        </span>
      )}
    </div>
  )
}
