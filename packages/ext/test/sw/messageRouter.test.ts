// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { routeMessage } from '../../src/sw/messageRouter.js'
import type { MessageRouterDeps } from '../../src/sw/messageRouter.js'
import * as persistSelectionModule from '../../src/sw/persistSelection.js'

const VALID_HANDLE = {
  id: 'test-id-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: 1_700_000_000_000,
}

function makeDeps(overrides: Partial<MessageRouterDeps> = {}): MessageRouterDeps {
  const panelPort = { push: vi.fn(), ...(overrides as { panelPort?: { push: unknown } }).panelPort }
  return {
    panelPort: panelPort as unknown as MessageRouterDeps['panelPort'],
    tabHandshakes: overrides.tabHandshakes ?? new Map(),
    tabSessions: overrides.tabSessions ?? new Map(),
    extId: overrides.extId ?? 'abcdefghijklmnopabcdefghijklmnop',
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('routeMessage selection branch', () => {
  test('awaits persistSelection before sendResponse returns', async () => {
    let persistResolved = false
    vi.spyOn(persistSelectionModule, 'persistSelection').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      persistResolved = true
    })
    const sendResponse = vi.fn(() => {
      // sendResponse must be called AFTER persist resolves
      expect(persistResolved).toBe(true)
    })
    const deps = makeDeps({
      tabHandshakes: new Map([
        [
          1,
          {
            wsUrl: 'ws://x',
            httpUrl: 'http://x',
            bootstrapToken: 't',
            editor: 'vscode',
            registeredAtEpochMs: Date.now(),
          },
        ],
      ]),
    })
    await routeMessage(
      { type: 'selection', handle: VALID_HANDLE },
      { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender,
      sendResponse,
      deps,
    )
    expect(persistResolved).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true })
  })

  test('register handler stamps registeredAtEpochMs', async () => {
    const before = Date.now()
    const deps = makeDeps()
    await routeMessage(
      {
        type: 'register',
        wsUrl: 'ws://x',
        httpUrl: 'http://x',
        bootstrapToken: 'btok',
        editor: 'vscode',
      },
      { tab: { id: 7, windowId: 1, url: 'http://example.com' } } as chrome.runtime.MessageSender,
      vi.fn(),
      deps,
    )
    const hs = deps.tabHandshakes.get(7)
    expect(hs).toBeDefined()
    expect(hs?.registeredAtEpochMs).toBeGreaterThanOrEqual(before)
    expect(hs?.registeredAtEpochMs).toBeLessThanOrEqual(Date.now())
  })

  test('throwing panelPort.push does NOT suppress persistSelection', async () => {
    const persistSpy = vi.spyOn(persistSelectionModule, 'persistSelection').mockResolvedValue()
    const deps = makeDeps({
      tabHandshakes: new Map([
        [
          1,
          {
            wsUrl: 'ws://x',
            httpUrl: 'http://x',
            bootstrapToken: 't',
            editor: 'vscode',
            registeredAtEpochMs: Date.now(),
          },
        ],
      ]),
    })
    deps.panelPort.push = vi.fn(() => {
      throw new Error('panel exploded')
    }) as unknown as typeof deps.panelPort.push
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await routeMessage(
      { type: 'selection', handle: VALID_HANDLE },
      { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender,
      vi.fn(),
      deps,
    )
    expect(persistSpy).toHaveBeenCalledTimes(1)
  })
})
