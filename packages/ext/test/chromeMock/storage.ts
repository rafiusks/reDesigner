/**
 * chromeMock — storage namespace (local + session).
 * Covers: get, set, remove, getBytesInUse, onChanged, setAccessLevel (session).
 */

import type { SideEffectRecorder } from './recorder.js'

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>
type OnChangedCallback = (changes: StorageChanges, areaName: string) => void

function makeStorageArea(
  areaName: string,
  recorder: SideEffectRecorder,
  onChangedListeners: OnChangedCallback[],
) {
  const store: Record<string, unknown> = {}

  function fireOnChanged(changes: StorageChanges) {
    for (const fn of onChangedListeners) {
      fn(changes, areaName)
    }
  }

  return {
    get(
      keys?: string | string[] | Record<string, unknown> | null,
    ): Promise<Record<string, unknown>> {
      recorder.record({ type: `storage.${areaName}.get`, args: keys ?? null })
      if (keys == null) return Promise.resolve({ ...store })
      const ks = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)
      const result: Record<string, unknown> = {}
      for (const k of ks) {
        if (k in store) result[k] = store[k]
        else if (typeof keys === 'object' && !Array.isArray(keys)) {
          result[k] = (keys as Record<string, unknown>)[k]
        }
      }
      return Promise.resolve(result)
    },

    set(items: Record<string, unknown>): Promise<void> {
      recorder.record({ type: `storage.${areaName}.set`, args: items })
      const changes: StorageChanges = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = k in store ? { oldValue: store[k], newValue: v } : { newValue: v }
        store[k] = v
      }
      fireOnChanged(changes)
      return Promise.resolve()
    },

    remove(keys: string | string[]): Promise<void> {
      recorder.record({ type: `storage.${areaName}.remove`, args: keys })
      const ks = Array.isArray(keys) ? keys : [keys]
      const changes: StorageChanges = {}
      for (const k of ks) {
        if (k in store) {
          changes[k] = { oldValue: store[k], newValue: undefined }
          delete store[k]
        }
      }
      if (Object.keys(changes).length > 0) fireOnChanged(changes)
      return Promise.resolve()
    },

    getBytesInUse(keys?: string | string[] | null): Promise<number> {
      recorder.record({ type: `storage.${areaName}.getBytesInUse`, args: keys ?? null })
      const ks = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]
      const bytes = ks.reduce((acc, k) => {
        if (k in store) return acc + JSON.stringify(store[k]).length
        return acc
      }, 0)
      return Promise.resolve(bytes)
    },
  }
}

export function makeStorageMock(recorder: SideEffectRecorder) {
  const onChangedListeners: OnChangedCallback[] = []

  const onChanged = {
    addListener(fn: OnChangedCallback) {
      if (!onChangedListeners.includes(fn)) onChangedListeners.push(fn)
    },
    removeListener(fn: OnChangedCallback) {
      const i = onChangedListeners.indexOf(fn)
      if (i >= 0) onChangedListeners.splice(i, 1)
    },
    hasListener(fn: OnChangedCallback): boolean {
      return onChangedListeners.includes(fn)
    },
  }

  const local = {
    ...makeStorageArea('local', recorder, onChangedListeners),
    QUOTA_BYTES: 10_485_760,
  }

  const session = {
    ...makeStorageArea('session', recorder, onChangedListeners),
    QUOTA_BYTES: 10_485_760,
    setAccessLevel(details: { accessLevel: string }): Promise<void> {
      recorder.record({ type: 'storage.session.setAccessLevel', args: details })
      return Promise.resolve()
    },
  }

  return { local, session, onChanged }
}
