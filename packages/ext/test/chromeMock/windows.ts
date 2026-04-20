/**
 * chromeMock — windows namespace.
 * Covers: onFocusChanged, getCurrent, getAll.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeWindowsMock(recorder: SideEffectRecorder) {
  const _windows: Map<number, chrome.windows.Window> = new Map([
    [
      1,
      {
        id: 1,
        focused: true,
        alwaysOnTop: false,
        incognito: false,
        state: 'normal',
        type: 'normal',
        tabs: [],
      },
    ],
  ])

  const onFocusChangedListeners: ((windowId: number) => void)[] = []

  return {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,

    getCurrent(getInfo?: {
      populate?: boolean
      windowTypes?: string[]
    }): Promise<chrome.windows.Window> {
      recorder.record({ type: 'windows.getCurrent', args: getInfo ?? null })
      const focused = [..._windows.values()].find((w) => w.focused)
      if (!focused) return Promise.reject(new Error('No focused window'))
      return Promise.resolve({ ...focused })
    },

    getAll(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<
      chrome.windows.Window[]
    > {
      recorder.record({ type: 'windows.getAll', args: getInfo ?? null })
      return Promise.resolve([..._windows.values()])
    },

    onFocusChanged: {
      addListener(fn: (windowId: number) => void) {
        onFocusChangedListeners.push(fn)
      },
      removeListener(fn: (windowId: number) => void) {
        const i = onFocusChangedListeners.indexOf(fn)
        if (i >= 0) onFocusChangedListeners.splice(i, 1)
      },
      hasListener(fn: (windowId: number) => void): boolean {
        return onFocusChangedListeners.includes(fn)
      },
    },

    _getListeners(event: 'onFocusChanged') {
      return onFocusChangedListeners
    },

    emit(event: 'onFocusChanged', windowId: number) {
      for (const fn of onFocusChangedListeners) fn(windowId)
    },
  }
}
