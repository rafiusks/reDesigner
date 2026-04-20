/**
 * ErrorBanners — shown when the extension is trying to reconnect to the
 * dev server.
 *
 * - Reload-tab button visible from t=0
 * - Give-up copy: after 30s (pre-first-pick) or 180s (if user has picked before)
 * - Pick-count flag persisted in chrome.storage.local under 'panel.hasPicked'
 * - Resets on chrome.idle.onStateChanged('active') after >5 min idle
 */

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

export interface ErrorBannersProps {
  reconnecting: boolean
  onReloadTab: () => void
}

const HAS_PICKED_KEY = 'panel.hasPicked'
const GIVE_UP_DELAY_INITIAL = 30_000
const GIVE_UP_DELAY_HAS_PICKED = 180_000

export function ErrorBanners(props: ErrorBannersProps): JSX.Element | null {
  const { reconnecting, onReloadTab } = props
  const [showGiveUp, setShowGiveUp] = useState(false)
  const [hasPicked, setHasPicked] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startTimeRef = useRef<number>(Date.now())

  // Load hasPicked from storage on mount
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return
    chrome.storage.local.get([HAS_PICKED_KEY], (result) => {
      if (result[HAS_PICKED_KEY] === true) {
        setHasPicked(true)
      }
    })
  }, [])

  // Reset on idle→active after 5+ min
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.idle) return
    const handler = (state: string): void => {
      if (state === 'active') {
        setShowGiveUp(false)
        startTimeRef.current = Date.now()
      }
    }
    chrome.idle.onStateChanged.addListener(handler)
    return () => {
      chrome.idle.onStateChanged.removeListener(handler)
    }
  }, [])

  // Set give-up timer when reconnecting starts
  useEffect(() => {
    if (!reconnecting) {
      setShowGiveUp(false)
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    startTimeRef.current = Date.now()
    const delay = hasPicked ? GIVE_UP_DELAY_HAS_PICKED : GIVE_UP_DELAY_INITIAL

    timerRef.current = setTimeout(() => {
      setShowGiveUp(true)
    }, delay)

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [reconnecting, hasPicked])

  if (!reconnecting) return null

  return (
    <div
      data-testid="error-banner"
      role="alert"
      style={{ padding: '8px 12px', background: '#fff3e0', borderLeft: '4px solid #f5a623' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span data-testid="reconnecting-text" style={{ flex: 1 }}>
          Reloading dev server…
        </span>
        <button
          type="button"
          data-testid="reload-tab"
          onClick={onReloadTab}
          style={{ fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}
        >
          Reload tab
        </button>
      </div>

      {showGiveUp && (
        <div data-testid="give-up" style={{ marginTop: 6, fontSize: 11, color: '#b71c1c' }}>
          {hasPicked
            ? 'Dev server may be down. Try reloading the tab or restarting the dev server.'
            : 'Cannot connect to dev server. Make sure it is running and refresh.'}
        </div>
      )}
    </div>
  )
}
