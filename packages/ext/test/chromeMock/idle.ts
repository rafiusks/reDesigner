/**
 * chromeMock — idle namespace.
 * Covers: queryState, onStateChanged.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeIdleMock(recorder: SideEffectRecorder) {
  let _state: chrome.idle.IdleState = 'active'
  const onStateChangedListeners: ((state: chrome.idle.IdleState) => void)[] = []

  return {
    queryState(detectionIntervalInSeconds: number): Promise<chrome.idle.IdleState> {
      recorder.record({ type: 'idle.queryState', args: detectionIntervalInSeconds })
      return Promise.resolve(_state)
    },

    onStateChanged: {
      addListener(fn: (state: chrome.idle.IdleState) => void) {
        onStateChangedListeners.push(fn)
      },
      removeListener(fn: (state: chrome.idle.IdleState) => void) {
        const i = onStateChangedListeners.indexOf(fn)
        if (i >= 0) onStateChangedListeners.splice(i, 1)
      },
      hasListener(fn: (state: chrome.idle.IdleState) => void): boolean {
        return onStateChangedListeners.includes(fn)
      },
    },

    _getListeners(event: 'onStateChanged') {
      return onStateChangedListeners
    },

    _setState(state: chrome.idle.IdleState) {
      _state = state
    },

    emit(event: 'onStateChanged', state: chrome.idle.IdleState) {
      _state = state
      for (const fn of onStateChangedListeners) fn(state)
    },
  }
}
