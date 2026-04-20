/**
 * Service worker entry — Task 23.
 *
 * Invariants (spec §2, §7.2, §1):
 *  - All chrome.*.addListener calls MUST happen at module top-level
 *    synchronously BEFORE any `await`. Chrome MV3 wakes the SW by dispatching
 *    the triggering event; listeners added after an `await` have already
 *    missed the event that woke the worker. The static source regex guard in
 *    test/integration/hydrate.test.ts enforces this — keep all listener
 *    registration above the line comment marker `/* end top-level listeners *\/`.
 *  - globalThis.__bootEpoch is incremented at module load time to let tests
 *    detect SW resurrection.
 *  - hydrate() runs eagerly; handlers await `readyPromise` and surface
 *    parse/read errors to pending sendResponse callers via .catch().
 */

import { handleActionClicked } from './actionHandler.js'
import { hydrate } from './hydrate.js'
import { routeMessage } from './messageRouter.js'
import type { TabHandshake } from './messageRouter.js'
import { createPanelPort } from './panelPort.js'

// Module-level panel-snapshot cache. One instance for the SW's lifetime; the
// cache survives across panel open/close cycles on the same SW generation.
const panelPort = createPanelPort()

// Per-tab handshake cache keyed by tabId. Populated by the content script's
// `register` message; consumed by `get-manifest` to hit the daemon's
// `GET /manifest` with the right Bearer token.
const tabHandshakes = new Map<number, TabHandshake>()
// Per-tab session cache, minted via POST /__redesigner/exchange on first
// daemon request and reused until near-expiry.
const tabSessions = new Map<number, { sessionToken: string; exp: number }>()

// ---------------------------------------------------------------------------
// Boot epoch — increment synchronously at module load. Type-guard the write.
// ---------------------------------------------------------------------------
;(globalThis as unknown as { __bootEpoch?: number }).__bootEpoch =
  ((globalThis as unknown as { __bootEpoch?: number }).__bootEpoch ?? 0) + 1

// ---------------------------------------------------------------------------
// Kick off hydrate synchronously. readyPromise is awaited inside handler
// bodies (where async is allowed) so the top-level stays await-free.
// ---------------------------------------------------------------------------
export const readyPromise = hydrate()

// Swallow the unhandled rejection at top-level — handlers surface the error
// via sendResponse. Without this, an unhandled rejection would log noise.
readyPromise.catch(() => {
  /* handlers surface the error via sendResponse; no-op here */
})

// ---------------------------------------------------------------------------
// Top-level listener registration. Everything below MUST be synchronous and
// must not contain `await` or `async function` / `async (...) =>`.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((_details) => {
  // Stub — full logic lands in later Phase 6 tasks.
})

chrome.runtime.onStartup.addListener(() => {
  // Stub — full logic lands in later Phase 6 tasks.
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  readyPromise
    .then(() =>
      routeMessage(msg, sender, sendResponse, {
        panelPort,
        tabHandshakes,
        tabSessions,
        extId: chrome.runtime.id,
      }),
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      sendResponse({ error: message })
    })
  // Keep message channel open for async sendResponse.
  return true
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'panel') {
    panelPort.onConnect(port)
    return
  }
  // Other port names (content-script RPC, etc.) land in later tasks.
})

chrome.action.onClicked.addListener((tab) => {
  // chrome.sidePanel.open MUST be synchronous within the user gesture; no
  // await before this call. handleActionClicked is also synchronous.
  handleActionClicked(tab)
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'arm-picker') return
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs[0]
    const tabId = tab?.id
    if (typeof tabId !== 'number') {
      console.warn('[redesigner:sw] arm-picker: no active tab')
      return
    }
    chrome.tabs.sendMessage(tabId, { type: 'arm-picker' }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[redesigner:sw] arm-picker sendMessage failed', { tabId, message })
    })
  })
})

chrome.tabs.onActivated.addListener((_info) => {
  // Stub — Task 24+.
})

chrome.tabs.onRemoved.addListener((_tabId, _info) => {
  // Stub — Task 24+.
})

chrome.windows.onFocusChanged.addListener((_windowId) => {
  // Stub — Task 24+.
})

chrome.idle.onStateChanged.addListener((_state) => {
  // Stub — Task 26.
})

chrome.alarms.onAlarm.addListener((_alarm) => {
  // Stub — Task 26.
})

/* end top-level listeners */
