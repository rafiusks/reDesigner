/**
 * chromeMock — tabs namespace.
 * Covers: query, get, onActivated, onUpdated, onRemoved.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeTabsMock(recorder: SideEffectRecorder) {
  const _tabs: Map<number, chrome.tabs.Tab> = new Map()
  let _nextId = 1

  // Internal tab management helpers
  function addTab(tab: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
    const id = tab.id ?? _nextId++
    const full: chrome.tabs.Tab = {
      id,
      index: 0,
      pinned: false,
      highlighted: false,
      windowId: 1,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      ...tab,
    }
    _tabs.set(id, full)
    return full
  }

  const onActivatedListeners: ((info: chrome.tabs.TabActiveInfo) => void)[] = []
  const onUpdatedListeners: ((
    tabId: number,
    info: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void)[] = []
  const onRemovedListeners: ((tabId: number, info: chrome.tabs.TabRemoveInfo) => void)[] = []

  return {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
      recorder.record({ type: 'tabs.query', args: queryInfo })
      const results = [..._tabs.values()].filter((tab) => {
        if (queryInfo.active !== undefined && tab.active !== queryInfo.active) return false
        if (queryInfo.windowId !== undefined && tab.windowId !== queryInfo.windowId) return false
        if (queryInfo.url !== undefined) {
          const pattern = queryInfo.url as string
          if (!tab.url?.includes(pattern.replace(/\*/g, ''))) return false
        }
        return true
      })
      return Promise.resolve(results)
    },

    get(tabId: number): Promise<chrome.tabs.Tab> {
      recorder.record({ type: 'tabs.get', args: tabId })
      const tab = _tabs.get(tabId)
      if (!tab) return Promise.reject(new Error(`Tab ${tabId} not found`))
      return Promise.resolve(tab)
    },

    onActivated: {
      addListener(fn: (info: chrome.tabs.TabActiveInfo) => void) {
        onActivatedListeners.push(fn)
      },
      removeListener(fn: (info: chrome.tabs.TabActiveInfo) => void) {
        const i = onActivatedListeners.indexOf(fn)
        if (i >= 0) onActivatedListeners.splice(i, 1)
      },
      hasListener(fn: (info: chrome.tabs.TabActiveInfo) => void): boolean {
        return onActivatedListeners.includes(fn)
      },
    },

    onUpdated: {
      addListener(
        fn: (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void,
      ) {
        onUpdatedListeners.push(fn)
      },
      removeListener(
        fn: (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void,
      ) {
        const i = onUpdatedListeners.indexOf(fn)
        if (i >= 0) onUpdatedListeners.splice(i, 1)
      },
      hasListener(
        fn: (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void,
      ): boolean {
        return onUpdatedListeners.includes(fn)
      },
    },

    onRemoved: {
      addListener(fn: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void) {
        onRemovedListeners.push(fn)
      },
      removeListener(fn: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void) {
        const i = onRemovedListeners.indexOf(fn)
        if (i >= 0) onRemovedListeners.splice(i, 1)
      },
      hasListener(fn: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void): boolean {
        return onRemovedListeners.includes(fn)
      },
    },

    /** Internal helpers for test setup */
    _addTab: addTab,
    _getListeners(event: 'onActivated' | 'onUpdated' | 'onRemoved') {
      return event === 'onActivated'
        ? onActivatedListeners
        : event === 'onUpdated'
          ? onUpdatedListeners
          : onRemovedListeners
    },

    emit(event: 'onActivated' | 'onUpdated' | 'onRemoved', ...args: unknown[]) {
      if (event === 'onActivated') {
        for (const fn of onActivatedListeners) fn(args[0] as chrome.tabs.TabActiveInfo)
      } else if (event === 'onUpdated') {
        for (const fn of onUpdatedListeners) {
          fn(args[0] as number, args[1] as chrome.tabs.TabChangeInfo, args[2] as chrome.tabs.Tab)
        }
      } else if (event === 'onRemoved') {
        for (const fn of onRemovedListeners) {
          fn(args[0] as number, args[1] as chrome.tabs.TabRemoveInfo)
        }
      }
    },
  }
}
