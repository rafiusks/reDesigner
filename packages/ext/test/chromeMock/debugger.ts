/**
 * chromeMock — debugger namespace.
 * Covers: attach, detach, sendCommand, onEvent.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeDebuggerMock(recorder: SideEffectRecorder) {
  const onEventListeners: ((
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => void)[] = []

  return {
    attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void> {
      recorder.record({ type: 'debugger.attach', args: { target, requiredVersion } })
      return Promise.resolve()
    },

    detach(target: chrome.debugger.Debuggee): Promise<void> {
      recorder.record({ type: 'debugger.detach', args: target })
      return Promise.resolve()
    },

    sendCommand(
      target: chrome.debugger.Debuggee,
      method: string,
      commandParams?: object,
    ): Promise<object> {
      recorder.record({ type: 'debugger.sendCommand', args: { target, method, commandParams } })
      return Promise.resolve({})
    },

    onEvent: {
      addListener(fn: (source: chrome.debugger.Debuggee, method: string, params?: object) => void) {
        onEventListeners.push(fn)
      },
      removeListener(
        fn: (source: chrome.debugger.Debuggee, method: string, params?: object) => void,
      ) {
        const i = onEventListeners.indexOf(fn)
        if (i >= 0) onEventListeners.splice(i, 1)
      },
      hasListener(
        fn: (source: chrome.debugger.Debuggee, method: string, params?: object) => void,
      ): boolean {
        return onEventListeners.includes(fn)
      },
    },

    _getListeners(event: 'onEvent') {
      return onEventListeners
    },

    emit(event: 'onEvent', source: chrome.debugger.Debuggee, method: string, params?: object) {
      for (const fn of onEventListeners) fn(source, method, params)
    },
  }
}
