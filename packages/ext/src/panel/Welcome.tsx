/**
 * Welcome — first-run intro shown while waiting for the dev server to be
 * detected. Transitions to an "open?" prompt once a server is found.
 */

import type { JSX } from 'react'

export interface WelcomeProps {
  serverUrl?: string | null
}

export function Welcome(props: WelcomeProps = {}): JSX.Element {
  const { serverUrl } = props

  return (
    <div data-testid="welcome" style={{ padding: '12px', color: '#555' }}>
      {serverUrl ? (
        <span>
          Detected: {serverUrl} —{' '}
          <a href={serverUrl} target="_blank" rel="noreferrer" style={{ color: '#1565c0' }}>
            open?
          </a>
        </span>
      ) : (
        <span>Waiting for dev server…</span>
      )}
    </div>
  )
}
