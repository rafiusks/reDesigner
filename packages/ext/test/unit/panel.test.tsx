/**
 * Task 29 — Panel shell + usePanelPort unit tests.
 *
 * Scope: React 19 hooks, useSyncExternalStore identity contract, port lifecycle
 * (connect/disconnect/reconnect), and the `WINDOW_ID_NONE` guard that prevents
 * opening a port before the panel knows its target tab.
 *
 * @vitest-environment happy-dom
 */

// Must be set before react-dom is imported — see
// https://react.dev/reference/react/act#implementing-act-for-a-custom-renderer
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/panel/App'
import {
  WINDOW_ID_NONE,
  __resetPanelStoreForTests,
  getPanelSnapshot,
  usePanelPort,
} from '../../src/panel/hooks/usePanelPort'

// ---------------------------------------------------------------------------
// Minimal chrome.runtime.Port fake. Only what the hook touches: name, sender,
// onMessage, onDisconnect, postMessage, disconnect. Each test constructs fresh
// ports so there's no cross-test listener bleed.
// ---------------------------------------------------------------------------

interface FakePort extends chrome.runtime.Port {
  _emitMessage(msg: unknown): void
  _emitDisconnect(): void
}

function makeFakePort(name = 'panel'): FakePort {
  const messageListeners = new Set<(msg: unknown, port: chrome.runtime.Port) => void>()
  const disconnectListeners = new Set<(port: chrome.runtime.Port) => void>()
  const port: Partial<FakePort> = {
    name,
    sender: undefined,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      for (const fn of disconnectListeners) fn(port as FakePort)
    }),
  }
  port.onMessage = {
    addListener: (fn) => {
      messageListeners.add(fn as (msg: unknown, p: chrome.runtime.Port) => void)
    },
    removeListener: (fn) => {
      messageListeners.delete(fn as (msg: unknown, p: chrome.runtime.Port) => void)
    },
    hasListener: (fn) => messageListeners.has(fn as (msg: unknown, p: chrome.runtime.Port) => void),
  } as chrome.runtime.Port['onMessage']
  port.onDisconnect = {
    addListener: (fn) => {
      disconnectListeners.add(fn as (p: chrome.runtime.Port) => void)
    },
    removeListener: (fn) => {
      disconnectListeners.delete(fn as (p: chrome.runtime.Port) => void)
    },
    hasListener: (fn) => disconnectListeners.has(fn as (p: chrome.runtime.Port) => void),
  } as chrome.runtime.Port['onDisconnect']
  port._emitMessage = (msg: unknown) => {
    for (const fn of messageListeners) fn(msg, port as FakePort)
  }
  port._emitDisconnect = () => {
    for (const fn of disconnectListeners) fn(port as FakePort)
  }
  return port as FakePort
}

// Tiny container + root helper — kept local so we don't bring in
// @testing-library/react (not in the lockfile).
function mount(element: React.ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return { root, container }
}

const mountedRoots: Root[] = []
const mountedContainers: HTMLElement[] = []

function mountTracked(element: React.ReactElement): {
  root: Root
  container: HTMLElement
} {
  const m = mount(element)
  mountedRoots.push(m.root)
  mountedContainers.push(m.container)
  return m
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetPanelStoreForTests()
})

afterEach(() => {
  while (mountedRoots.length > 0) {
    const r = mountedRoots.pop()
    act(() => {
      r?.unmount()
    })
  }
  while (mountedContainers.length > 0) {
    const c = mountedContainers.pop()
    c?.remove()
  }
})

describe('usePanelPort — store identity', () => {
  it('getSnapshot returns Object.is-identical refs across many reads with no mutation', () => {
    const first = getPanelSnapshot(1, 10)
    for (let i = 0; i < 1000; i++) {
      expect(Object.is(getPanelSnapshot(1, 10), first)).toBe(true)
    }
  })

  it('WINDOW_ID_NONE renders skeleton and does not call connect()', () => {
    const connect = vi.fn()
    const { container } = mountTracked(
      <App windowId={WINDOW_ID_NONE} tabId={-1} connect={connect} />,
    )
    expect(connect).not.toHaveBeenCalled()
    const root = container.querySelector('[data-testid="panel-root"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-status')).toBe('hydrating')
  })

  it('usePanelPort export is present', () => {
    // The hook is referenced by App; keep the import alive so ToJS tools don't
    // tree-shake the test out and so accidental rename is caught.
    expect(typeof usePanelPort).toBe('function')
  })
})

describe('usePanelPort — lifecycle', () => {
  it('renders skeleton before the service worker sends a snapshot', () => {
    const port = makeFakePort()
    const connect = vi.fn(() => port)
    const { container } = mountTracked(<App windowId={1} tabId={10} connect={connect} />)
    expect(connect).toHaveBeenCalledTimes(1)
    const root = container.querySelector('[data-testid="panel-root"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-status')).toBe('hydrating')
    expect(container.querySelector('[data-testid="panel-skeleton"]')).not.toBeNull()
  })

  it('applies snapshot pushed over the port', () => {
    const port = makeFakePort()
    const connect = vi.fn(() => port)
    const { container } = mountTracked(<App windowId={1} tabId={10} connect={connect} />)

    act(() => {
      port._emitMessage({
        type: 'snapshot',
        snapshot: {
          status: 'connected',
          tabId: 10,
          windowId: 1,
          selection: null,
          pickerArmed: false,
          recent: [],
          version: 1,
        },
      })
    })

    const root = container.querySelector('[data-testid="panel-root"]')
    expect(root?.getAttribute('data-status')).toBe('connected')
    expect(container.querySelector('[data-testid="panel-skeleton"]')).toBeNull()
  })

  it('enters dimmed "resync" transient on port.onDisconnect', () => {
    const port = makeFakePort()
    const connect = vi.fn(() => port)
    const { container } = mountTracked(<App windowId={1} tabId={10} connect={connect} />)

    act(() => {
      port._emitMessage({
        type: 'snapshot',
        snapshot: {
          status: 'connected',
          tabId: 10,
          windowId: 1,
          selection: null,
          pickerArmed: false,
          recent: [],
          version: 1,
        },
      })
    })

    act(() => {
      port._emitDisconnect()
    })

    const root = container.querySelector('[data-testid="panel-root"]')
    expect(root?.getAttribute('data-status')).toBe('resync')
    expect(root?.getAttribute('data-resync')).toBe('true')
  })

  it('SW re-sends snapshot on runtime.onConnect and status returns to connected', async () => {
    let nextPort = makeFakePort()
    const connect = vi.fn(() => nextPort)
    const { container } = mountTracked(<App windowId={1} tabId={10} connect={connect} />)

    const firstPort = nextPort

    act(() => {
      firstPort._emitMessage({
        type: 'snapshot',
        snapshot: {
          status: 'connected',
          tabId: 10,
          windowId: 1,
          selection: null,
          pickerArmed: false,
          recent: [],
          version: 1,
        },
      })
    })

    const secondPort = makeFakePort()
    nextPort = secondPort
    await act(async () => {
      firstPort._emitDisconnect()
    })
    expect(container.querySelector('[data-testid="panel-root"]')?.getAttribute('data-status')).toBe(
      'resync',
    )
    // After the microtask that reopens the port runs, connect should have
    // fired a second time.
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2)

    await act(async () => {
      secondPort._emitMessage({
        type: 'snapshot',
        snapshot: {
          status: 'connected',
          tabId: 10,
          windowId: 1,
          selection: null,
          pickerArmed: false,
          recent: [],
          version: 2,
        },
      })
    })

    expect(container.querySelector('[data-testid="panel-root"]')?.getAttribute('data-status')).toBe(
      'connected',
    )
  })

  it('ignores snapshot for a different (windowId, tabId) key', () => {
    const port = makeFakePort()
    const connect = vi.fn(() => port)
    const { container } = mountTracked(<App windowId={1} tabId={10} connect={connect} />)

    act(() => {
      port._emitMessage({
        type: 'snapshot',
        snapshot: {
          status: 'connected',
          tabId: 99,
          windowId: 7,
          selection: null,
          pickerArmed: false,
          recent: [],
          version: 5,
        },
      })
    })

    expect(container.querySelector('[data-testid="panel-root"]')?.getAttribute('data-status')).toBe(
      'hydrating',
    )
  })
})

describe('useSyncExternalStore contract', () => {
  it('App renders via renderToString (confirms getServerSnapshot is provided)', () => {
    const html = renderToString(<App windowId={WINDOW_ID_NONE} tabId={-1} />)
    expect(html).toContain('data-testid="panel-root"')
    expect(html).toContain('data-status="hydrating"')
  })
})
