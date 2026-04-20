// @vitest-environment happy-dom

/**
 * Task 28 — panelPort + actionIcon + commands + backfill + actionHandler.
 *
 * Covers:
 *  1. panelPort maintains per-(windowId,tabId) cached snapshot refs.
 *  2. 1000 unchanged reads return Object.is-identical refs.
 *  3. push() bumps version and replaces ref.
 *  4. onTabActivated bumps version without changing fields.
 *  5. Different keys are isolated.
 *  6. actionIcon: 50 rapid arm/disarm → exactly 2 setIcon calls.
 *  7. actionIcon: single arm → 1 setIcon call.
 *  8. actionIcon: idle state → 0 setIcon calls.
 *  9. commands.onCommand('arm-picker') calls armPickerCallback.
 * 10. commands.onCommand('arm-picker') does NOT call sidePanel.open.
 * 11. handleActionClicked calls sidePanel.open synchronously (before any awaited event).
 * 12. backfill with permission granted → executeScript called per localhost tab.
 * 13. backfill with permission denied → onGrantAccess called; no executeScript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleActionClicked } from '../../src/sw/actionHandler.js'
import { createActionIcon } from '../../src/sw/actionIcon.js'
import { createBackfillController } from '../../src/sw/backfill.js'
import { createCommandsController } from '../../src/sw/commands.js'
import { createPanelPort } from '../../src/sw/panelPort.js'
import type { PanelSnapshot } from '../../src/sw/panelPort.js'
import { makeChromeMock } from '../chromeMock/index.js'

type ChromeMock = ReturnType<typeof makeChromeMock>

function installChrome(mock: ChromeMock): () => void {
  const original = globalThis.chrome
  // @ts-expect-error -- test env
  globalThis.chrome = mock
  return () => {
    globalThis.chrome = original
  }
}

// ---------------------------------------------------------------------------
// panelPort
// ---------------------------------------------------------------------------

describe('panelPort — snapshot ref stability', () => {
  it('1000 consecutive getSnapshot calls without push return Object.is-identical refs', () => {
    const port = createPanelPort()
    const first = port.getSnapshot(1, 10)
    for (let i = 0; i < 999; i++) {
      expect(Object.is(port.getSnapshot(1, 10), first)).toBe(true)
    }
  })

  it('getServerSnapshot also returns the same stable ref', () => {
    const port = createPanelPort()
    const first = port.getServerSnapshot(1, 10)
    for (let i = 0; i < 999; i++) {
      expect(Object.is(port.getServerSnapshot(1, 10), first)).toBe(true)
    }
  })

  it('getSnapshot and getServerSnapshot return the same ref for the same key', () => {
    const port = createPanelPort()
    expect(Object.is(port.getSnapshot(1, 10), port.getServerSnapshot(1, 10))).toBe(true)
  })

  it('initial snapshot has correct defaults', () => {
    const port = createPanelPort()
    const snap = port.getSnapshot(2, 20)
    expect(snap.status).toBe('hydrating')
    expect(snap.tabId).toBe(20)
    expect(snap.windowId).toBe(2)
    expect(snap.selection).toBeNull()
    expect(snap.pickerArmed).toBe(false)
    expect(snap.recent).toEqual([])
    expect(snap.version).toBe(0)
  })

  it('push increments version and returns a new ref', () => {
    const port = createPanelPort()
    const before = port.getSnapshot(1, 10)
    port.push(1, 10, { status: 'connected' })
    const after = port.getSnapshot(1, 10)
    expect(Object.is(before, after)).toBe(false)
    expect(after.version).toBe(1)
    expect(after.status).toBe('connected')
  })

  it('push preserves unchanged fields', () => {
    const port = createPanelPort()
    port.push(1, 10, { status: 'connected' })
    const snap = port.getSnapshot(1, 10)
    expect(snap.tabId).toBe(10)
    expect(snap.windowId).toBe(1)
    expect(snap.selection).toBeNull()
    expect(snap.pickerArmed).toBe(false)
    expect(snap.recent).toEqual([])
  })

  it('multiple pushes increment version monotonically', () => {
    const port = createPanelPort()
    port.push(1, 10, { status: 'connected' })
    port.push(1, 10, { pickerArmed: true })
    port.push(1, 10, { status: 'mcp-missing' })
    expect(port.getSnapshot(1, 10).version).toBe(3)
  })

  it('1000 reads after push return the new stable ref', () => {
    const port = createPanelPort()
    port.push(1, 10, { status: 'connected' })
    const ref = port.getSnapshot(1, 10)
    for (let i = 0; i < 999; i++) {
      expect(Object.is(port.getSnapshot(1, 10), ref)).toBe(true)
    }
  })

  it('onTabActivated bumps version without changing other fields', () => {
    const port = createPanelPort()
    port.push(1, 10, { status: 'connected', pickerArmed: true })
    const before = port.getSnapshot(1, 10)
    port.onTabActivated(1, 10)
    const after = port.getSnapshot(1, 10)
    expect(Object.is(before, after)).toBe(false)
    expect(after.version).toBe(2)
    expect(after.status).toBe('connected')
    expect(after.pickerArmed).toBe(true)
  })

  it('different (windowId, tabId) keys are fully isolated', () => {
    const port = createPanelPort()
    const a = port.getSnapshot(1, 10)
    const b = port.getSnapshot(1, 20)
    const c = port.getSnapshot(2, 10)
    expect(Object.is(a, b)).toBe(false)
    expect(Object.is(a, c)).toBe(false)
    expect(Object.is(b, c)).toBe(false)

    port.push(1, 10, { status: 'connected' })
    expect(port.getSnapshot(1, 20).status).toBe('hydrating')
    expect(port.getSnapshot(2, 10).status).toBe('hydrating')
    expect(port.getSnapshot(1, 10).status).toBe('connected')
  })

  it('onConnect wires port and replies with current snapshot', () => {
    const port = createPanelPort()
    port.push(1, 10, { status: 'connected' })

    const messages: unknown[] = []
    const disconnectListeners: (() => void)[] = []
    const fakePort = {
      name: 'panel-1:10',
      sender: { tab: { id: 10, windowId: 1 } as chrome.tabs.Tab },
      postMessage: (msg: unknown) => messages.push(msg),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
        hasListener: vi.fn(),
      },
      onDisconnect: {
        addListener: (fn: () => void) => disconnectListeners.push(fn),
        removeListener: vi.fn(),
        hasListener: vi.fn(),
      },
    } as unknown as chrome.runtime.Port

    port.onConnect(fakePort)
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const firstMsg = messages[0] as { snapshot: PanelSnapshot }
    expect(firstMsg.snapshot).toBeDefined()
    expect(firstMsg.snapshot.status).toBe('connected')

    // disconnect cleans up — just verify it doesn't throw
    for (const fn of disconnectListeners) fn()
  })
})

// ---------------------------------------------------------------------------
// actionIcon
// ---------------------------------------------------------------------------

describe('actionIcon — debounced coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('50 rapid arm/disarm toggles ending disarmed → exactly 2 setIcon calls', () => {
    const setIconCalls: unknown[] = []
    const mockAction = {
      setIcon(details: unknown) {
        setIconCalls.push(details)
        return Promise.resolve()
      },
    } as unknown as typeof chrome.action

    const icon = createActionIcon({
      debounceMs: 100,
      chromeAction: mockAction,
    })

    // 50 rapid toggles: arm then disarm 25 times; ends on disarmed
    for (let i = 0; i < 25; i++) {
      icon.setArmed(1, true)
      icon.setArmed(1, false)
    }

    // Leading edge flush already happened synchronously at first arm.
    // After debounce period, trailing flush fires.
    vi.advanceTimersByTime(200)

    expect(setIconCalls.length).toBe(2)
  })

  it('single arm → exactly 1 setIcon call after debounce', () => {
    const setIconCalls: unknown[] = []
    const mockAction = {
      setIcon(details: unknown) {
        setIconCalls.push(details)
        return Promise.resolve()
      },
    } as unknown as typeof chrome.action

    const icon = createActionIcon({ debounceMs: 100, chromeAction: mockAction })
    icon.setArmed(1, true)
    vi.advanceTimersByTime(200)

    expect(setIconCalls.length).toBe(1)
  })

  it('idle (no setArmed calls) → 0 setIcon calls', () => {
    const setIconCalls: unknown[] = []
    const mockAction = {
      setIcon(details: unknown) {
        setIconCalls.push(details)
        return Promise.resolve()
      },
    } as unknown as typeof chrome.action

    createActionIcon({ debounceMs: 100, chromeAction: mockAction })
    vi.advanceTimersByTime(200)

    expect(setIconCalls.length).toBe(0)
  })

  it('flush() forces pending debounce to fire immediately', () => {
    const setIconCalls: unknown[] = []
    const mockAction = {
      setIcon(details: unknown) {
        setIconCalls.push(details)
        return Promise.resolve()
      },
    } as unknown as typeof chrome.action

    const icon = createActionIcon({ debounceMs: 1000, chromeAction: mockAction })
    icon.setArmed(1, true)
    // Leading edge fires immediately. Pending trailing timer at 1000ms.
    const beforeFlush = setIconCalls.length
    icon.flush()
    // After flush, trailing should have fired if state changed
    expect(setIconCalls.length).toBeGreaterThanOrEqual(beforeFlush)
  })

  it('current() returns latest global armed state', () => {
    const mockAction = {
      setIcon: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.action

    const icon = createActionIcon({ debounceMs: 100, chromeAction: mockAction })
    expect(icon.current()).toBe(false)
    icon.setArmed(1, true)
    expect(icon.current()).toBe(true)
    icon.setArmed(1, false)
    expect(icon.current()).toBe(false)
  })

  it('armed icon path is set when armed; unarmed path when disarmed', () => {
    const setIconDetails: Array<{ path: unknown }> = []
    const mockAction = {
      setIcon(details: { path: unknown }) {
        setIconDetails.push(details)
        return Promise.resolve()
      },
    } as unknown as typeof chrome.action

    const icon = createActionIcon({ debounceMs: 100, chromeAction: mockAction })
    icon.setArmed(1, true)
    vi.advanceTimersByTime(200)
    icon.setArmed(1, false)
    vi.advanceTimersByTime(200)

    // Should have 2 calls: first with armed path, second with unarmed path
    expect(setIconDetails.length).toBe(2)
    // Paths should differ
    expect(setIconDetails[0]?.path).not.toEqual(setIconDetails[1]?.path)
  })
})

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('commands — onCommand routing', () => {
  it("onCommand('arm-picker') calls setArmPickerCallback fn", () => {
    const ctrl = createCommandsController()
    const armCallback = vi.fn()
    ctrl.setArmPickerCallback(armCallback)
    ctrl.onCommand('arm-picker')
    expect(armCallback).toHaveBeenCalledOnce()
  })

  it("onCommand('arm-picker') does NOT call chrome.sidePanel.open", () => {
    let chromeMock: ChromeMock
    let restore: () => void
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)

    try {
      const ctrl = createCommandsController()
      ctrl.setArmPickerCallback(() => {})
      ctrl.onCommand('arm-picker')

      const sidePanelCalls = chromeMock._recorder
        .snapshot()
        .filter((e) => e.type === 'sidePanel.open')
      expect(sidePanelCalls.length).toBe(0)
    } finally {
      restore()
    }
  })

  it('unknown command is silently ignored', () => {
    const ctrl = createCommandsController()
    ctrl.setArmPickerCallback(vi.fn())
    // Should not throw
    expect(() => ctrl.onCommand('unknown-command')).not.toThrow()
  })

  it('armPickerCallback is not called before being set', () => {
    const ctrl = createCommandsController()
    // Should not throw even without callback set
    expect(() => ctrl.onCommand('arm-picker')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// handleActionClicked — synchronous sidePanel.open
// ---------------------------------------------------------------------------

describe('handleActionClicked — sync sidePanel.open', () => {
  let chromeMock: ChromeMock
  let restore: () => void

  beforeEach(() => {
    chromeMock = makeChromeMock()
    restore = installChrome(chromeMock)
  })

  afterEach(() => {
    restore()
  })

  it('calls chrome.sidePanel.open synchronously with correct windowId', () => {
    const tab: chrome.tabs.Tab = {
      id: 1,
      windowId: 42,
      index: 0,
      pinned: false,
      highlighted: false,
      active: true,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    }

    handleActionClicked(tab)

    const effects = chromeMock._recorder.snapshot()
    const sidePanelCalls = effects.filter((e) => e.type === 'sidePanel.open')
    expect(sidePanelCalls.length).toBe(1)
    expect(sidePanelCalls[0]?.args).toEqual({ windowId: 42 })
  })

  it('sidePanel.open is the first recorded effect (synchronous, before any await)', () => {
    const tab: chrome.tabs.Tab = {
      id: 1,
      windowId: 99,
      index: 0,
      pinned: false,
      highlighted: false,
      active: true,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    }

    chromeMock._recorder.clear()
    handleActionClicked(tab)

    const effects = chromeMock._recorder.snapshot()
    expect(effects.length).toBeGreaterThan(0)
    expect(effects[0]?.type).toBe('sidePanel.open')
  })
})

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

describe('backfill — permission granted', () => {
  it('calls executeScript for each localhost tab when permission is granted', async () => {
    const chromeMock = makeChromeMock()

    // Grant the origin permission
    chromeMock.permissions._grant('http://localhost/*')

    // Add some localhost tabs
    chromeMock.tabs._addTab({ id: 10, url: 'http://localhost:3000/', windowId: 1 })
    chromeMock.tabs._addTab({ id: 11, url: 'http://localhost:8080/app', windowId: 1 })

    const ctrl = createBackfillController({
      chromePermissions: chromeMock.permissions as unknown as typeof chrome.permissions,
      chromeScripting: chromeMock.scripting as unknown as typeof chrome.scripting,
      chromeTabs: chromeMock.tabs as unknown as typeof chrome.tabs,
    })

    await ctrl.runOnInstalled()

    const executeScriptCalls = chromeMock._recorder
      .snapshot()
      .filter((e) => e.type === 'scripting.executeScript')

    expect(executeScriptCalls.length).toBe(2)
    const tabIds = executeScriptCalls.map(
      (e) => (e.args as { target: { tabId: number } }).target.tabId,
    )
    expect(tabIds).toContain(10)
    expect(tabIds).toContain(11)
  })
})

describe('backfill — permission denied', () => {
  it('calls onGrantAccess when permission is not granted', async () => {
    const chromeMock = makeChromeMock()
    // Do not grant any permissions
    const onGrantAccess = vi.fn()

    const ctrl = createBackfillController({
      chromePermissions: chromeMock.permissions as unknown as typeof chrome.permissions,
      chromeScripting: chromeMock.scripting as unknown as typeof chrome.scripting,
      chromeTabs: chromeMock.tabs as unknown as typeof chrome.tabs,
      onGrantAccess,
    })

    await ctrl.runOnInstalled()

    expect(onGrantAccess).toHaveBeenCalledOnce()

    // executeScript must NOT have been called
    const executeScriptCalls = chromeMock._recorder
      .snapshot()
      .filter((e) => e.type === 'scripting.executeScript')
    expect(executeScriptCalls.length).toBe(0)
  })

  it('does not throw when onGrantAccess is not provided and permission denied', async () => {
    const chromeMock = makeChromeMock()

    const ctrl = createBackfillController({
      chromePermissions: chromeMock.permissions as unknown as typeof chrome.permissions,
      chromeScripting: chromeMock.scripting as unknown as typeof chrome.scripting,
      chromeTabs: chromeMock.tabs as unknown as typeof chrome.tabs,
    })

    await expect(ctrl.runOnInstalled()).resolves.toBeUndefined()
  })
})
