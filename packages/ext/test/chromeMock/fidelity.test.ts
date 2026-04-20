/**
 * Task 17 — chromeMock fidelity-diff oracle.
 *
 * TODO(follow-up): Replace hand-crafted goldens with recordings produced by the
 * headed-Chromium harness (Phase 8 / Tier-4 E2E task). The harness runs real
 * extension code in a headed Chromium instance, captures the observable
 * side-effect set via a CDP hook, and writes the JSON files under goldens/.
 * Until that harness exists, the golden fixtures are hand-crafted based on
 * the spec's described behaviour for v0 Phase 5-7 scenarios.
 *
 * Fidelity contract (spec §8.1):
 *   - Diff is MULTISET-aware (unordered; counts matter).
 *   - `ts` field is excluded from comparison.
 *   - Passes when actual multiset equals golden expected multiset.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { makeChromeMock } from './index.js'
import type { SideEffect } from './recorder.js'

// ---------------------------------------------------------------------------
// Multiset diff utility
// ---------------------------------------------------------------------------

type ComparableSideEffect = Omit<SideEffect, 'ts'>

function normalize(effects: readonly SideEffect[]): ComparableSideEffect[] {
  return [...effects]
    .map(({ type, args }) => ({ type, args }))
    .sort((a, b) => {
      const ka = JSON.stringify(a.type) + JSON.stringify(a.args)
      const kb = JSON.stringify(b.type) + JSON.stringify(b.args)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
}

function loadGolden(name: string): ComparableSideEffect[] {
  const p = resolve(import.meta.dirname, 'goldens', `${name}.json`)
  const raw = readFileSync(p, 'utf8')
  const data = JSON.parse(raw) as { expected: ComparableSideEffect[] }
  return data.expected.sort((a, b) => {
    const ka = JSON.stringify(a.type) + JSON.stringify(a.args)
    const kb = JSON.stringify(b.type) + JSON.stringify(b.args)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// Scenario: selection-round-trip
// CS sends register → SW opens WS → daemon pushes hello → SW responds.
// Expected side-effects (hand-crafted from spec Phase 5-7 behaviour):
//   - storage.session.set  (session token stored)
//   - action.setIcon       (icon updated to connected state)
//   - runtime.sendMessage  (SW→CS hello ack)
// ---------------------------------------------------------------------------

function runSelectionRoundTrip(chrome: ReturnType<typeof makeChromeMock>): void {
  const sessionToken = 'tok-test-1234'
  const iconPath = 'icons/connected.png'

  // 1. SW stores session token
  chrome.storage.session.set({ sessionToken })

  // 2. SW updates action icon to reflect connected state
  chrome.action.setIcon({ path: iconPath })

  // 3. SW sends hello-ack back to CS via runtime.sendMessage
  chrome.runtime.sendMessage({ type: 'hello-ack', token: sessionToken })
}

// ---------------------------------------------------------------------------
// Scenario: manifest-cache
// SW fetches manifest on first extract-handle call.
// Expected side-effects:
//   - storage.local.set    (manifest written to local cache)
//   - storage.session.set  (cache-hit timestamp stored)
// ---------------------------------------------------------------------------

function runManifestCache(chrome: ReturnType<typeof makeChromeMock>): void {
  const manifest = { version: '1.0.0', components: ['Button', 'Input'] }
  const fetchedAt = 1_700_000_000_000

  // SW writes manifest to local cache
  chrome.storage.local.set({ manifest: JSON.stringify(manifest) })

  // SW records cache-hit timestamp in session storage
  chrome.storage.session.set({ manifestCacheAt: fetchedAt })
}

// ---------------------------------------------------------------------------
// Scenario: welcome-alarm
// Welcome alarm fires → updates discovery state.
// Expected side-effects:
//   - alarms.create        (welcome alarm scheduled)
//   - storage.local.set    (discovery state updated after alarm fires)
//   - action.setTitle      (title updated to reflect discovery)
// ---------------------------------------------------------------------------

function runWelcomeAlarm(chrome: ReturnType<typeof makeChromeMock>): void {
  // 1. SW schedules the welcome alarm
  chrome.alarms.create('welcome', { delayInMinutes: 0.1 })

  // 2. Simulate alarm firing — listener updates discovery state
  const listeners = chrome.alarms._getListeners('onAlarm')
  for (const fn of listeners) {
    fn({ name: 'welcome', scheduledTime: Date.now() })
  }

  // 3. Handler stores updated discovery state
  chrome.storage.local.set({ discoveryState: 'welcomed' })

  // 4. Handler updates tooltip
  chrome.action.setTitle({ title: 'reDesigner — connected' })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chromeMock fidelity-diff oracle', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
  })

  it('selection-round-trip matches golden', () => {
    // Register a dummy onAlarm listener so welcome-alarm scenario works when
    // this scenario runs in isolation too.
    chrome.alarms.onAlarm.addListener(() => {})

    runSelectionRoundTrip(chrome)
    const actual = normalize(chrome._recorder.snapshot())
    const expected = loadGolden('selection-round-trip')
    expect(actual).toEqual(expected)
  })

  it('manifest-cache matches golden', () => {
    runManifestCache(chrome)
    const actual = normalize(chrome._recorder.snapshot())
    const expected = loadGolden('manifest-cache')
    expect(actual).toEqual(expected)
  })

  it('welcome-alarm matches golden', () => {
    // Register an alarm listener so runWelcomeAlarm has something to fire.
    chrome.alarms.onAlarm.addListener((_alarm) => {
      // side-effect already recorded by runWelcomeAlarm
    })

    runWelcomeAlarm(chrome)
    const actual = normalize(chrome._recorder.snapshot())
    const expected = loadGolden('welcome-alarm')
    expect(actual).toEqual(expected)
  })
})
