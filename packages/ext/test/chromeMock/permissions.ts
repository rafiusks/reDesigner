/**
 * chromeMock — permissions namespace.
 * Covers: contains, onAdded, onRemoved.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makePermissionsMock(recorder: SideEffectRecorder) {
  const _granted = new Set<string>()
  const onAddedListeners: ((permissions: chrome.permissions.Permissions) => void)[] = []
  const onRemovedListeners: ((permissions: chrome.permissions.Permissions) => void)[] = []

  return {
    contains(permissions: chrome.permissions.Permissions): Promise<boolean> {
      recorder.record({ type: 'permissions.contains', args: permissions })
      const perms = permissions.permissions ?? []
      const origins = permissions.origins ?? []
      const hasAll = perms.every((p) => _granted.has(p)) && origins.every((o) => _granted.has(o))
      return Promise.resolve(hasAll)
    },

    onAdded: {
      addListener(fn: (permissions: chrome.permissions.Permissions) => void) {
        if (!onAddedListeners.includes(fn)) onAddedListeners.push(fn)
      },
      removeListener(fn: (permissions: chrome.permissions.Permissions) => void) {
        const i = onAddedListeners.indexOf(fn)
        if (i >= 0) onAddedListeners.splice(i, 1)
      },
      hasListener(fn: (permissions: chrome.permissions.Permissions) => void): boolean {
        return onAddedListeners.includes(fn)
      },
    },

    onRemoved: {
      addListener(fn: (permissions: chrome.permissions.Permissions) => void) {
        if (!onRemovedListeners.includes(fn)) onRemovedListeners.push(fn)
      },
      removeListener(fn: (permissions: chrome.permissions.Permissions) => void) {
        const i = onRemovedListeners.indexOf(fn)
        if (i >= 0) onRemovedListeners.splice(i, 1)
      },
      hasListener(fn: (permissions: chrome.permissions.Permissions) => void): boolean {
        return onRemovedListeners.includes(fn)
      },
    },

    _getListeners(event: 'onAdded' | 'onRemoved') {
      return event === 'onAdded' ? onAddedListeners : onRemovedListeners
    },

    _grant(...perms: string[]) {
      for (const p of perms) _granted.add(p)
    },

    emit(event: 'onAdded' | 'onRemoved', permissions: chrome.permissions.Permissions) {
      const listeners = event === 'onAdded' ? onAddedListeners : onRemovedListeners
      for (const fn of listeners) fn(permissions)
    },
  }
}
