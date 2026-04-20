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

import { hydrate } from './hydrate.js'

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

chrome.runtime.onMessage.addListener((_msg, _sender, sendResponse) => {
  readyPromise
    .then(() => {
      // Dispatch stub — actual message routing lands in Task 24+.
      // Respond with an empty ack so tests that don't care about the payload
      // see a well-formed response object.
      sendResponse({ ok: true })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      sendResponse({ error: message })
    })
  // Keep message channel open for async sendResponse.
  return true
})

chrome.runtime.onConnect.addListener((_port) => {
  // Stub — panel + CS RPC port wiring lands in later tasks.
})

chrome.action.onClicked.addListener((_tab) => {
  // Stub — Task 28 fleshes this out.
})

chrome.commands.onCommand.addListener((_command) => {
  // Stub — Task 28.
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
