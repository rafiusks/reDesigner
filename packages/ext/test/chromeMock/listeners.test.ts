/**
 * chromeMock — addListener deduplication contract.
 *
 * Asserts that calling addListener(fn) twice does not cause double dispatch
 * and that removeListener(fn) removes it entirely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChromeMock } from './index.js'

describe('chromeMock addListener deduplication', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
  })

  it('runtime.onMessage: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.runtime.onMessage.addListener(fn)
    chrome.runtime.onMessage.addListener(fn)
    chrome.runtime.emit('onMessage', { type: 'ping' }, {}, () => {})
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runtime.onMessage: removeListener once removes it', () => {
    const fn = vi.fn()
    chrome.runtime.onMessage.addListener(fn)
    chrome.runtime.onMessage.addListener(fn)
    chrome.runtime.onMessage.removeListener(fn)
    chrome.runtime.emit('onMessage', { type: 'ping' }, {}, () => {})
    expect(fn).not.toHaveBeenCalled()
  })

  it('alarms.onAlarm: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.alarms.onAlarm.addListener(fn)
    chrome.alarms.onAlarm.addListener(fn)
    chrome.alarms.emit('onAlarm', { name: 'test', scheduledTime: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('alarms.onAlarm: removeListener once removes it', () => {
    const fn = vi.fn()
    chrome.alarms.onAlarm.addListener(fn)
    chrome.alarms.onAlarm.addListener(fn)
    chrome.alarms.onAlarm.removeListener(fn)
    chrome.alarms.emit('onAlarm', { name: 'test', scheduledTime: 0 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('storage.onChanged: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.storage.onChanged.addListener(fn)
    chrome.storage.onChanged.addListener(fn)
    void chrome.storage.local.set({ x: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('storage.onChanged: removeListener once removes it', () => {
    const fn = vi.fn()
    chrome.storage.onChanged.addListener(fn)
    chrome.storage.onChanged.addListener(fn)
    chrome.storage.onChanged.removeListener(fn)
    void chrome.storage.local.set({ x: 1 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('tabs.onActivated: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.tabs.onActivated.addListener(fn)
    chrome.tabs.onActivated.addListener(fn)
    chrome.tabs.emit('onActivated', { tabId: 1, windowId: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('windows.onFocusChanged: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.windows.onFocusChanged.addListener(fn)
    chrome.windows.onFocusChanged.addListener(fn)
    chrome.windows.emit('onFocusChanged', 1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('idle.onStateChanged: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.idle.onStateChanged.addListener(fn)
    chrome.idle.onStateChanged.addListener(fn)
    chrome.idle.emit('onStateChanged', 'idle')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('permissions.onAdded: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.permissions.onAdded.addListener(fn)
    chrome.permissions.onAdded.addListener(fn)
    chrome.permissions.emit('onAdded', { permissions: ['storage'] })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('commands.onCommand: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.commands.onCommand.addListener(fn)
    chrome.commands.onCommand.addListener(fn)
    chrome.commands.emit('onCommand', 'toggle')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('action.onClicked: registering the same fn twice fires it once', () => {
    const fn = vi.fn()
    chrome.action.onClicked.addListener(fn)
    chrome.action.onClicked.addListener(fn)
    chrome.action.emit('onClicked', {} as chrome.tabs.Tab)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
