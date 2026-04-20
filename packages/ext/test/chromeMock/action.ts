/**
 * chromeMock — action namespace.
 * Covers: setIcon, setTitle, onClicked.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeActionMock(recorder: SideEffectRecorder) {
  const onClickedListeners: ((tab: chrome.tabs.Tab) => void)[] = []

  return {
    setIcon(details: chrome.action.TabIconDetails): Promise<void> {
      recorder.record({ type: 'action.setIcon', args: details })
      return Promise.resolve()
    },

    setTitle(details: chrome.action.TitleDetails): Promise<void> {
      recorder.record({ type: 'action.setTitle', args: details })
      return Promise.resolve()
    },

    onClicked: {
      addListener(fn: (tab: chrome.tabs.Tab) => void) {
        onClickedListeners.push(fn)
      },
      removeListener(fn: (tab: chrome.tabs.Tab) => void) {
        const i = onClickedListeners.indexOf(fn)
        if (i >= 0) onClickedListeners.splice(i, 1)
      },
      hasListener(fn: (tab: chrome.tabs.Tab) => void): boolean {
        return onClickedListeners.includes(fn)
      },
    },

    _getListeners(event: 'onClicked') {
      return onClickedListeners
    },

    emit(event: 'onClicked', tab: chrome.tabs.Tab) {
      for (const fn of onClickedListeners) fn(tab)
    },
  }
}
