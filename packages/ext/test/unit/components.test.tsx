/**
 * Task 30 — Panel components unit tests.
 *
 * Covers: ConnectionBadge, SelectionCard, ShortcutsFooter, ErrorBanners, Debug
 *
 * @vitest-environment happy-dom
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { ComponentHandle } from '@redesigner/core/types'
import { act } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionBadge } from '../../src/panel/ConnectionBadge'
import { Debug } from '../../src/panel/Debug'
import { ErrorBanners } from '../../src/panel/ErrorBanners'
import { SelectionCard } from '../../src/panel/SelectionCard'
import { ShortcutsFooter } from '../../src/panel/ShortcutsFooter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mount(element: React.ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return { root, container }
}

async function flushLazy(): Promise<void> {
  // React.lazy resolves over several microtask/macrotask ticks when the
  // dynamic import completes and then Suspense re-renders. First-time chunk
  // resolution needs more turns than a warm cache — loop until the commit
  // settles (capped).
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0))
    })
  }
}

const mountedRoots: Root[] = []
const mountedContainers: HTMLElement[] = []

function mountTracked(element: React.ReactElement): { root: Root; container: HTMLElement } {
  const m = mount(element)
  mountedRoots.push(m.root)
  mountedContainers.push(m.container)
  return m
}

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
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Minimal ComponentHandle fixture
// ---------------------------------------------------------------------------

const fakeHandle: ComponentHandle = {
  id: 'abc123',
  componentName: 'Button',
  filePath: '/src/components/Button.tsx',
  lineRange: [10, 30],
  domPath: 'div > button',
  parentChain: ['App', 'Page'],
  timestamp: 1000,
}

// ---------------------------------------------------------------------------
// ConnectionBadge
// ---------------------------------------------------------------------------

describe('ConnectionBadge', () => {
  const states = ['off', 'connecting', 'connected', 'error', 'mcp-missing'] as const

  for (const status of states) {
    it(`renders state: ${status}`, () => {
      const { container } = mountTracked(<ConnectionBadge status={status} />)
      const el = container.querySelector('[data-shape]')
      expect(el).not.toBeNull()
      expect(el?.getAttribute('data-shape')).toBeTruthy()
    })
  }

  it('each state has a distinct data-shape attribute', () => {
    const shapes = states.map((status) => {
      const { container } = mount(<ConnectionBadge status={status} />)
      const el = container.querySelector('[data-shape]')
      const shape = el?.getAttribute('data-shape')
      act(() => {
        createRoot(container).unmount()
      })
      container.remove()
      return shape
    })
    // all 5 shapes are distinct
    const unique = new Set(shapes)
    expect(unique.size).toBe(5)
  })

  it('each state has a title attribute for a11y hover label', () => {
    for (const status of states) {
      const { container } = mount(<ConnectionBadge status={status} />)
      const el = container.querySelector('[title]')
      expect(el).not.toBeNull()
      expect(el?.getAttribute('title')?.length).toBeGreaterThan(0)
      act(() => {
        createRoot(container).unmount()
      })
      container.remove()
    }
  })

  it('"off" state uses an empty ring shape', () => {
    const { container } = mountTracked(<ConnectionBadge status="off" />)
    const el = container.querySelector('[data-shape]')
    expect(el?.getAttribute('data-shape')).toBe('empty-ring')
  })

  it('"connecting" state uses a dashed ring shape', () => {
    const { container } = mountTracked(<ConnectionBadge status="connecting" />)
    const el = container.querySelector('[data-shape]')
    expect(el?.getAttribute('data-shape')).toBe('dashed-ring')
  })

  it('"connected" state uses a filled circle shape', () => {
    const { container } = mountTracked(<ConnectionBadge status="connected" />)
    const el = container.querySelector('[data-shape]')
    expect(el?.getAttribute('data-shape')).toBe('filled-circle')
  })

  it('"error" state uses a cross/X shape', () => {
    const { container } = mountTracked(<ConnectionBadge status="error" />)
    const el = container.querySelector('[data-shape]')
    expect(el?.getAttribute('data-shape')).toBe('cross')
  })

  it('"mcp-missing" state uses a half-ring shape', () => {
    const { container } = mountTracked(<ConnectionBadge status="mcp-missing" />)
    const el = container.querySelector('[data-shape]')
    expect(el?.getAttribute('data-shape')).toBe('half-ring')
  })
})

// ---------------------------------------------------------------------------
// SelectionCard
// ---------------------------------------------------------------------------

describe('SelectionCard', () => {
  it('shows pip "Claude Code can see this" when selection exists', () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={true} />)
    expect(container.textContent).toContain('Claude Code can see this')
  })

  it('when mcpWired shows "current selection?" chip with copy button', () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={true} />)
    expect(container.textContent).toContain('current selection?')
  })

  it('when !mcpWired shows "Set up the MCP shim" chip', async () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={false} />)
    // Lazy-loaded McpSetupChip — flush dynamic-import + Suspense.
    await flushLazy()
    expect(container.textContent).toContain('Set up the MCP shim')
  })

  it('when !mcpWired shows the MCP snippet with correct command', async () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={false} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('claude mcp add')
    expect(container.textContent).toContain('--transport stdio')
    expect(container.textContent).toContain('redesigner')
    expect(container.textContent).toContain('packages/mcp/dist/cli.js')
  })

  it('when !mcpWired shows restart instruction', async () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={false} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent?.toLowerCase()).toContain('restart')
  })

  it('"Copy handle" button writes filePath:line:col to clipboard on regular click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    })

    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={true} />)

    const copyBtn = container.querySelector('[data-testid="copy-handle"]') as HTMLElement
    expect(copyBtn).not.toBeNull()

    await act(async () => {
      copyBtn.click()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const written = writeText.mock.calls[0]?.[0] as string
    expect(written).toContain(fakeHandle.filePath)
    expect(written).toContain(String(fakeHandle.lineRange[0]))
  })

  it('Shift-click on "Copy handle" writes full JSON to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    })

    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={true} />)

    const copyBtn = container.querySelector('[data-testid="copy-handle"]') as HTMLElement
    expect(copyBtn).not.toBeNull()

    await act(async () => {
      const shiftClick = new MouseEvent('click', { bubbles: true, shiftKey: true })
      copyBtn.dispatchEvent(shiftClick)
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const written = writeText.mock.calls[0]?.[0] as string
    // Should be JSON — parse to confirm
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed.id).toBe(fakeHandle.id)
    expect(parsed.componentName).toBe(fakeHandle.componentName)
  })

  it('"Show pickable elements" toggle is present', () => {
    const { container } = mountTracked(<SelectionCard selection={fakeHandle} mcpWired={true} />)
    const toggle = container.querySelector('[data-testid="show-pickable"]')
    expect(toggle).not.toBeNull()
  })

  it('returns null / no-card when selection is null', () => {
    const { container } = mountTracked(<SelectionCard selection={null} mcpWired={false} />)
    expect(container.querySelector('[data-testid="selection-card"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ShortcutsFooter
// ---------------------------------------------------------------------------

describe('ShortcutsFooter', () => {
  beforeEach(() => {
    // Reset chrome mock state between tests
    ;(globalThis as Record<string, unknown>).chrome = {
      commands: {
        getAll: vi.fn(),
      },
      windows: {
        onFocusChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    }
  })

  it('renders chord from chrome.commands.getAll() when shortcut is bound', async () => {
    const mockGetAll = (
      globalThis as unknown as { chrome: { commands: { getAll: ReturnType<typeof vi.fn> } } }
    ).chrome.commands.getAll
    mockGetAll.mockImplementation((cb: (cmds: chrome.commands.Command[]) => void) => {
      cb([{ name: 'arm-picker', shortcut: 'Ctrl+Shift+K', description: 'Arm picker' }])
    })

    const { container } = mountTracked(<ShortcutsFooter />)

    // Wait for the effect to run
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Ctrl+Shift+K')
    // Must NOT hardcode the chord literal in the component source
  })

  it('renders "Set a shortcut to pick" link when shortcut is null/unbound', async () => {
    const mockGetAll = (
      globalThis as unknown as { chrome: { commands: { getAll: ReturnType<typeof vi.fn> } } }
    ).chrome.commands.getAll
    mockGetAll.mockImplementation((cb: (cmds: chrome.commands.Command[]) => void) => {
      cb([{ name: 'arm-picker', shortcut: '', description: 'Arm picker' }])
    })

    const { container } = mountTracked(<ShortcutsFooter />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Set a shortcut to pick')
    const link = container.querySelector(
      'a[href*="chrome://extensions/shortcuts"]',
    ) as HTMLAnchorElement
    expect(link).not.toBeNull()
  })

  it('re-polls on windows.onFocusChanged', async () => {
    const addListenerMock = vi.fn()
    ;(globalThis as Record<string, unknown>).chrome = {
      commands: {
        getAll: vi.fn().mockImplementation((cb: (cmds: chrome.commands.Command[]) => void) => {
          cb([{ name: 'arm-picker', shortcut: 'Ctrl+Shift+K', description: '' }])
        }),
      },
      windows: {
        onFocusChanged: {
          addListener: addListenerMock,
          removeListener: vi.fn(),
        },
      },
    }

    mountTracked(<ShortcutsFooter />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(addListenerMock).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ErrorBanners
// ---------------------------------------------------------------------------

describe('ErrorBanners', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi
            .fn()
            .mockImplementation((_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
              cb({})
            }),
          set: vi.fn(),
        },
      },
      idle: {
        onStateChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders Reload-tab button immediately (t=0)', () => {
    const { container } = mountTracked(<ErrorBanners reconnecting={true} onReloadTab={() => {}} />)
    const reloadBtn = container.querySelector('[data-testid="reload-tab"]')
    expect(reloadBtn).not.toBeNull()
  })

  it('shows reconnecting spinner text', () => {
    const { container } = mountTracked(<ErrorBanners reconnecting={true} onReloadTab={() => {}} />)
    expect(container.textContent).toContain('Reload')
  })

  it('shows give-up copy after 30s (pre-first-pick)', async () => {
    const { container } = mountTracked(<ErrorBanners reconnecting={true} onReloadTab={() => {}} />)

    // No give-up copy initially
    expect(container.querySelector('[data-testid="give-up"]')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(container.querySelector('[data-testid="give-up"]')).not.toBeNull()
  })

  it('does not show give-up before 30s', async () => {
    const { container } = mountTracked(<ErrorBanners reconnecting={true} onReloadTab={() => {}} />)

    await act(async () => {
      vi.advanceTimersByTime(29_000)
    })

    expect(container.querySelector('[data-testid="give-up"]')).toBeNull()
  })

  it('shows give-up copy after 180s when hasPicked flag is set', async () => {
    // Override storage mock to return hasPicked = true
    ;(
      globalThis as unknown as {
        chrome: {
          storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } }
          idle: {
            onStateChanged: {
              addListener: ReturnType<typeof vi.fn>
              removeListener: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).chrome.storage.local.get.mockImplementation(
      (_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
        cb({ 'panel.hasPicked': true })
      },
    )

    const { container } = mountTracked(<ErrorBanners reconnecting={true} onReloadTab={() => {}} />)

    // Still no give-up at 30s when hasPicked
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(container.querySelector('[data-testid="give-up"]')).toBeNull()

    // Give-up appears at 180s
    await act(async () => {
      vi.advanceTimersByTime(150_000)
    })
    expect(container.querySelector('[data-testid="give-up"]')).not.toBeNull()
  })

  it('returns null when reconnecting is false', () => {
    const { container } = mountTracked(<ErrorBanners reconnecting={false} onReloadTab={() => {}} />)
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

describe('Debug', () => {
  it('drawer is hidden initially', () => {
    const { container } = mountTracked(<Debug tabId={1} windowId={2} version={3} />)
    const drawer = container.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).toBeNull()
  })

  it('Shift+Alt+D on window body opens drawer', async () => {
    mountTracked(<Debug tabId={1} windowId={2} version={3} />)

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: true,
        bubbles: true,
      })
      window.dispatchEvent(event)
    })
    // Lazy-loaded DebugDrawer — flush dynamic-import + Suspense.
    await flushLazy()

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).not.toBeNull()
  })

  it('Shift+Alt+D on an <input> is ignored — drawer stays closed', async () => {
    mountTracked(<Debug tabId={1} windowId={2} version={3} />)

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: true,
        bubbles: true,
      })
      input.dispatchEvent(event)
    })

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).toBeNull()
    input.remove()
  })

  it('Shift+Alt+D on a <textarea> is ignored', async () => {
    mountTracked(<Debug tabId={1} windowId={2} version={3} />)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: true,
        bubbles: true,
      })
      textarea.dispatchEvent(event)
    })

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).toBeNull()
    textarea.remove()
  })

  it('Shift+Alt+D on a [contenteditable] is ignored', async () => {
    mountTracked(<Debug tabId={1} windowId={2} version={3} />)

    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    div.focus()

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: true,
        bubbles: true,
      })
      div.dispatchEvent(event)
    })

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).toBeNull()
    div.remove()
  })

  it('Shift+D alone (without Alt) does NOT open drawer (VoiceOver guard)', async () => {
    mountTracked(<Debug tabId={1} windowId={2} version={3} />)

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: false,
        bubbles: true,
      })
      window.dispatchEvent(event)
    })

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).toBeNull()
  })

  it('drawer shows tabId, windowId, version', async () => {
    mountTracked(<Debug tabId={42} windowId={7} version={99} />)

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'D',
        shiftKey: true,
        altKey: true,
        bubbles: true,
      })
      window.dispatchEvent(event)
    })
    await flushLazy()

    const drawer = document.querySelector('[data-testid="debug-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain('42')
    expect(drawer?.textContent).toContain('7')
    expect(drawer?.textContent).toContain('99')
  })
})
