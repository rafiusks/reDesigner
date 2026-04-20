/**
 * Panel entry — mounts the React root into #root.
 *
 * windowId / tabId resolution:
 *  - First consult `?windowId=&tabId=` in the URL. The SW opens the side panel
 *    via `chrome.sidePanel.open({windowId})`, but Chrome does not propagate a
 *    tabId into the panel URL; we fall back to `chrome.tabs.query` below.
 *  - If either id is missing, pass `WINDOW_ID_NONE` so usePanelPort skips the
 *    connect() and renders the skeleton. A follow-up microtask resolves the
 *    ids and re-renders with the real values.
 *
 * Note: `chrome.tabs.query` + `chrome.windows.getCurrent` can return undefined
 * in the sidepanel context during tests (no chrome namespace) or while the SW
 * is still waking. Defensive guards keep the entry pure-function on error.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { WINDOW_ID_NONE } from './hooks/usePanelPort.js'

interface InitialIds {
  windowId: number
  tabId: number
}

function parseUrlIds(): InitialIds {
  try {
    const params = new URL(location.href).searchParams
    const w = Number(params.get('windowId'))
    const t = Number(params.get('tabId'))
    if (Number.isInteger(w) && Number.isInteger(t) && w > 0 && t >= 0) {
      return { windowId: w, tabId: t }
    }
  } catch {
    // no-op — falls through to WINDOW_ID_NONE.
  }
  return { windowId: WINDOW_ID_NONE, tabId: -1 }
}

async function resolveIds(): Promise<InitialIds> {
  const fromUrl = parseUrlIds()
  if (fromUrl.windowId !== WINDOW_ID_NONE) return fromUrl

  if (typeof chrome === 'undefined' || !chrome.windows || !chrome.tabs) {
    return { windowId: WINDOW_ID_NONE, tabId: -1 }
  }
  try {
    const win = await chrome.windows.getCurrent()
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
    if (win.id !== undefined && tab?.id !== undefined) {
      return { windowId: win.id, tabId: tab.id }
    }
  } catch {
    // fall through
  }
  return { windowId: WINDOW_ID_NONE, tabId: -1 }
}

function render(container: HTMLElement, ids: InitialIds): void {
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <App windowId={ids.windowId} tabId={ids.tabId} />
    </StrictMode>,
  )
}

function main(): void {
  const container = document.getElementById('root')
  if (!container) return
  const initial = parseUrlIds()
  render(container, initial)

  if (initial.windowId === WINDOW_ID_NONE) {
    // Best-effort late resolve; remount with the actual ids once chrome APIs
    // return. `createRoot().render` is idempotent for the same container.
    void resolveIds().then((ids) => {
      if (ids.windowId === WINDOW_ID_NONE) return
      render(container, ids)
    })
  }
}

main()
