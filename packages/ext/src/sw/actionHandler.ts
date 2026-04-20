/**
 * actionHandler — handles chrome.action.onClicked.
 *
 * chrome.sidePanel.open MUST be called synchronously (before any await) when
 * handling a user gesture. The click event IS a user gesture, so open() works
 * here. Do not add any await before the sidePanel.open call.
 *
 * Contrast: commands ('arm-picker') are keyboard gestures, NOT user gestures
 * per Chromium #344767733, so sidePanel.open is NOT called there.
 */

export function handleActionClicked(tab: chrome.tabs.Tab): void {
  // MUST be synchronous — no await before this call.
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId })
  }
  // Post-open async work may go here in future tasks.
}
