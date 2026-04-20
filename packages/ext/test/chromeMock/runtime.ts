/**
 * chromeMock — runtime namespace.
 * Covers: onInstalled, onStartup, onMessage, onConnect, sendMessage, connect,
 *         lastError getter, id prop.
 */

import type { SideEffectRecorder } from './recorder.js'

export type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined

export type ConnectListener = (port: chrome.runtime.Port) => void

function makeEventWithListeners<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = []
  return {
    addListener(fn: T) {
      if (!listeners.includes(fn)) listeners.push(fn)
    },
    removeListener(fn: T) {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    hasListener(fn: T): boolean {
      return listeners.includes(fn)
    },
    _listeners: listeners,
  }
}

function makePort(name: string, recorder: SideEffectRecorder): chrome.runtime.Port {
  const messageListeners: ((msg: unknown) => void)[] = []
  const disconnectListeners: (() => void)[] = []
  return {
    name,
    onMessage: {
      addListener(fn: (msg: unknown) => void) {
        if (!messageListeners.includes(fn)) messageListeners.push(fn)
      },
      removeListener(fn: (msg: unknown) => void) {
        const i = messageListeners.indexOf(fn)
        if (i >= 0) messageListeners.splice(i, 1)
      },
      hasListener(fn: (msg: unknown) => void): boolean {
        return messageListeners.includes(fn)
      },
      _listeners: messageListeners,
      _emit(msg: unknown) {
        for (const fn of messageListeners) fn(msg)
      },
    } as unknown as chrome.events.Event<(message: unknown) => void>,
    onDisconnect: {
      addListener(fn: () => void) {
        if (!disconnectListeners.includes(fn)) disconnectListeners.push(fn)
      },
      removeListener(fn: () => void) {
        const i = disconnectListeners.indexOf(fn)
        if (i >= 0) disconnectListeners.splice(i, 1)
      },
      hasListener(fn: () => void): boolean {
        return disconnectListeners.includes(fn)
      },
      _listeners: disconnectListeners,
      _emit() {
        for (const fn of disconnectListeners) fn()
      },
    } as unknown as chrome.events.Event<() => void>,
    postMessage(msg: unknown) {
      recorder.record({ type: 'runtime.port.postMessage', args: { name, msg } })
    },
    disconnect() {
      recorder.record({ type: 'runtime.port.disconnect', args: { name } })
      for (const fn of disconnectListeners) fn()
    },
    sender: undefined,
  } as unknown as chrome.runtime.Port
}

export function makeRuntimeMock(recorder: SideEffectRecorder) {
  let _lastError: chrome.runtime.LastError | undefined

  const onInstalled = makeEventWithListeners<(details: chrome.runtime.InstalledDetails) => void>()
  const onStartup = makeEventWithListeners<() => void>()
  const onMessage = makeEventWithListeners<MessageListener>()
  const onConnect = makeEventWithListeners<ConnectListener>()

  return {
    id: 'mock-extension-id',

    get lastError() {
      return _lastError
    },

    onInstalled,
    onStartup,
    onMessage,
    onConnect,

    sendMessage(message: unknown): Promise<unknown> {
      recorder.record({ type: 'runtime.sendMessage', args: message })
      // Deliver to registered onMessage listeners
      return new Promise((resolve) => {
        let responded = false
        for (const fn of onMessage._listeners) {
          fn(message, {} as chrome.runtime.MessageSender, (resp) => {
            if (!responded) {
              responded = true
              resolve(resp)
            }
          })
        }
        if (!responded) resolve(undefined)
      })
    },

    connect(connectInfo?: { name?: string }): chrome.runtime.Port {
      const name = connectInfo?.name ?? ''
      recorder.record({ type: 'runtime.connect', args: connectInfo ?? null })
      const port = makePort(name, recorder)
      for (const fn of onConnect._listeners) fn(port)
      return port
    },

    _setLastError(err: chrome.runtime.LastError | undefined) {
      _lastError = err
    },

    /** Trigger an event listener from test code */
    emit(event: 'onInstalled' | 'onStartup' | 'onMessage' | 'onConnect', ...args: unknown[]) {
      const ev = { onInstalled, onStartup, onMessage, onConnect }[event]
      for (const fn of ev._listeners) {
        ;(fn as (...a: unknown[]) => unknown)(...args)
      }
    },
  }
}
