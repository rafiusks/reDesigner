// @vitest-environment happy-dom

/**
 * Task 26 — alarms controller integration tests.
 *
 * Covers:
 *  1. `reconnect-tick` registered at 30s cadence during the first 2 min of
 *     backoff; decays to 60s after 120s.
 *  2. `clearReconnectTick` clears the alarm + resets tier state.
 *  3. Cleared on successful hello (consumer invokes clearReconnectTick).
 *  4. `welcome-probe-tick` at 60s cadence, 20-attempt cap.
 *  5. Probes only open-tab origins matching http://localhost/* + http://127.0.0.1/*,
 *     via tokenless HEAD /__redesigner/handshake.json (credentials:'omit').
 *  6. On first 200 → onHandshakeDetected(origin) + alarm cleared.
 *  7. "Resume probing" button (resumeWelcomeProbeAfterCap) re-arms + resets attempts.
 *  8. onBackoffResume (browser startup / idle active / tabs.onActivated localhost /
 *     panel retry) fires the reconnect-tick handler immediately.
 *  9. fetch uses AbortSignal.timeout (never new AbortController + setTimeout).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlarmsController } from '../../src/sw/alarms.js'
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
// Helpers: drive the alarms.onAlarm listener exactly as Chrome would.
// The controller exposes `handleAlarm(name)` which `sw/index.ts` will wire;
// we call it directly here to keep the test focused on the controller.
// ---------------------------------------------------------------------------

function makeOkHeadResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => Promise.resolve(''),
    json: () => Promise.resolve(null),
  } as unknown as Response
}

function makeFailResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(''),
    json: () => Promise.resolve(null),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let chromeMock: ChromeMock
let restoreChrome: () => void
let nowMs: number

beforeEach(() => {
  chromeMock = makeChromeMock()
  restoreChrome = installChrome(chromeMock)
  nowMs = 1_000_000
  vi.useFakeTimers()
})

afterEach(() => {
  restoreChrome()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// reconnect-tick
// ---------------------------------------------------------------------------

describe('alarmsController — reconnect-tick', () => {
  it('(1) armReconnectTick creates chrome.alarms with name reconnect-tick at 30s delay', async () => {
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })

    ctrl.armReconnectTick({ startAtMs: nowMs })

    const alarm = await chromeMock.alarms.get('reconnect-tick')
    expect(alarm).toBeDefined()
    // The mock records delayInMinutes and converts to absolute time; verify
    // that the create call used delayInMinutes=0.5 (30s).
    const createCalls = chromeMock._recorder.snapshot().filter((e) => e.type === 'alarms.create')
    expect(createCalls.length).toBe(1)
    const first = createCalls[0]
    expect(
      (first?.args as { alarmInfo: chrome.alarms.AlarmCreateInfo }).alarmInfo.delayInMinutes,
    ).toBeCloseTo(30 / 60)
  })

  it('(2) reconnect-tick tier decay: 30s cadence before 2 min, 60s after', async () => {
    const armReconnect = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      armReconnect,
      chromeAlarms: chromeMock.alarms,
    })

    // t=0 — arm.
    ctrl.armReconnectTick({ startAtMs: nowMs })

    // Clear previous recorder entries before advancing so we count only the
    // re-arm from handleAlarm.
    chromeMock._recorder.clear()

    // t=30s — fake fire. Elapsed=30s (< 120s) → re-arm at 30s.
    nowMs += 30_000
    await ctrl.handleAlarm('reconnect-tick')

    let recs = chromeMock._recorder.snapshot().filter((e) => e.type === 'alarms.create')
    expect(recs.length).toBe(1)
    expect(
      (recs[0]?.args as { alarmInfo: chrome.alarms.AlarmCreateInfo }).alarmInfo.delayInMinutes,
    ).toBeCloseTo(30 / 60)
    expect(armReconnect).toHaveBeenCalledTimes(1)

    chromeMock._recorder.clear()

    // t=90s — fire again. Elapsed=90s (< 120s) → still 30s cadence.
    nowMs += 60_000
    await ctrl.handleAlarm('reconnect-tick')
    recs = chromeMock._recorder.snapshot().filter((e) => e.type === 'alarms.create')
    expect(recs.length).toBe(1)
    expect(
      (recs[0]?.args as { alarmInfo: chrome.alarms.AlarmCreateInfo }).alarmInfo.delayInMinutes,
    ).toBeCloseTo(30 / 60)

    chromeMock._recorder.clear()

    // Advance past 120s total — fire at t=150s (elapsed=150s ≥ 120s) → decay to 60s.
    nowMs += 60_000
    await ctrl.handleAlarm('reconnect-tick')
    recs = chromeMock._recorder.snapshot().filter((e) => e.type === 'alarms.create')
    expect(recs.length).toBe(1)
    expect(
      (recs[0]?.args as { alarmInfo: chrome.alarms.AlarmCreateInfo }).alarmInfo.delayInMinutes,
    ).toBeCloseTo(60 / 60)
  })

  it('(3) clearReconnectTick removes the alarm and resets tier state', async () => {
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })

    ctrl.armReconnectTick({ startAtMs: nowMs })
    expect(ctrl.state().reconnectArmedAt).toBe(nowMs)
    await ctrl.clearReconnectTick()

    const alarm = await chromeMock.alarms.get('reconnect-tick')
    expect(alarm).toBeUndefined()
    expect(ctrl.state().reconnectArmedAt).toBeNull()
  })

  it('(4) handleAlarm("reconnect-tick") is a no-op when not armed', async () => {
    const armReconnect = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      armReconnect,
      chromeAlarms: chromeMock.alarms,
    })

    await ctrl.handleAlarm('reconnect-tick')
    expect(armReconnect).not.toHaveBeenCalled()
    const createCalls = chromeMock._recorder.snapshot().filter((e) => e.type === 'alarms.create')
    expect(createCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// welcome-probe-tick
// ---------------------------------------------------------------------------

describe('alarmsController — welcome-probe-tick', () => {
  it('(5) armWelcomeProbeTick creates alarm at 60s cadence + resets attempts', async () => {
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })
    ctrl.armWelcomeProbeTick()
    const alarm = await chromeMock.alarms.get('welcome-probe-tick')
    expect(alarm).toBeDefined()
    const createCalls = chromeMock._recorder
      .snapshot()
      .filter(
        (e) =>
          e.type === 'alarms.create' && (e.args as { name: string }).name === 'welcome-probe-tick',
      )
    expect(createCalls.length).toBe(1)
    expect(
      (createCalls[0]?.args as { alarmInfo: chrome.alarms.AlarmCreateInfo }).alarmInfo
        .delayInMinutes,
    ).toBeCloseTo(60 / 60)
    expect(ctrl.state().welcomeProbeAttempts).toBe(0)
  })

  it('(6) probes only http://localhost/* and http://127.0.0.1/* tabs', async () => {
    chromeMock.tabs._addTab({ id: 1, url: 'http://localhost:5173/app', active: true })
    chromeMock.tabs._addTab({ id: 2, url: 'https://example.com/', active: false })
    chromeMock.tabs._addTab({ id: 3, url: 'http://127.0.0.1:8080/x', active: false })

    const fetchSpy = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(makeFailResponse(404))
    vi.stubGlobal('fetch', fetchSpy)

    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })
    ctrl.armWelcomeProbeTick()

    await ctrl.handleAlarm('welcome-probe-tick')

    // tabs.query should have been called with both localhost + 127.0.0.1.
    const queryCall = chromeMock._recorder.snapshot().find((e) => e.type === 'tabs.query')
    expect(queryCall).toBeDefined()
    const qArgs = queryCall?.args as chrome.tabs.QueryInfo
    const urls = Array.isArray(qArgs.url) ? qArgs.url : [qArgs.url]
    expect(urls).toEqual(expect.arrayContaining(['http://localhost/*', 'http://127.0.0.1/*']))

    // fetch should be called for both matching tabs' origins.
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(calledUrls).toEqual(
      expect.arrayContaining([
        'http://localhost:5173/__redesigner/handshake.json',
        'http://127.0.0.1:8080/__redesigner/handshake.json',
      ]),
    )
    // HEAD, credentials omit, AbortSignal.timeout used.
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.method).toBe('HEAD')
      expect(init?.credentials).toBe('omit')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('(7) onHandshakeDetected called on first 200, alarm cleared', async () => {
    chromeMock.tabs._addTab({ id: 1, url: 'http://localhost:5173/foo', active: true })

    const fetchSpy = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(makeOkHeadResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const onHandshakeDetected = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })
    ctrl.armWelcomeProbeTick({ onHandshakeDetected })

    await ctrl.handleAlarm('welcome-probe-tick')

    expect(onHandshakeDetected).toHaveBeenCalledWith('http://localhost:5173')
    const alarm = await chromeMock.alarms.get('welcome-probe-tick')
    expect(alarm).toBeUndefined()
  })

  it('(8) attempts increment, cap at 20 clears alarm and fires cap-reached', async () => {
    chromeMock.tabs._addTab({ id: 1, url: 'http://localhost:5173/x', active: true })

    const fetchSpy = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(makeFailResponse(404))
    vi.stubGlobal('fetch', fetchSpy)

    const onCapReached = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
      onCapReached,
    })
    ctrl.armWelcomeProbeTick()

    for (let i = 0; i < 20; i += 1) {
      await ctrl.handleAlarm('welcome-probe-tick')
    }

    expect(ctrl.state().welcomeProbeAttempts).toBe(20)
    expect(onCapReached).toHaveBeenCalledOnce()
    const alarm = await chromeMock.alarms.get('welcome-probe-tick')
    expect(alarm).toBeUndefined()
  })

  it('(9) resumeWelcomeProbeAfterCap re-arms + resets attempts', async () => {
    chromeMock.tabs._addTab({ id: 1, url: 'http://localhost:5173/x', active: true })
    vi.stubGlobal(
      'fetch',
      vi
        .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValue(makeFailResponse(404)),
    )

    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
      welcomeProbeMaxAttempts: 3,
    })
    ctrl.armWelcomeProbeTick()
    await ctrl.handleAlarm('welcome-probe-tick')
    await ctrl.handleAlarm('welcome-probe-tick')
    await ctrl.handleAlarm('welcome-probe-tick')
    expect(ctrl.state().welcomeProbeAttempts).toBe(3)

    // Cap reached — alarm cleared.
    expect(await chromeMock.alarms.get('welcome-probe-tick')).toBeUndefined()

    ctrl.resumeWelcomeProbeAfterCap()
    expect(ctrl.state().welcomeProbeAttempts).toBe(0)
    expect(await chromeMock.alarms.get('welcome-probe-tick')).toBeDefined()
  })

  it('(10) handleAlarm("welcome-probe-tick") is no-op when not armed', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })
    await ctrl.handleAlarm('welcome-probe-tick')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('(11) ignores unknown alarm names', async () => {
    const ctrl = createAlarmsController({
      now: () => nowMs,
      chromeAlarms: chromeMock.alarms,
    })
    await expect(ctrl.handleAlarm('some-other-alarm')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onBackoffResume — user-action-driven wake paths
// ---------------------------------------------------------------------------

describe('alarmsController — onBackoffResume', () => {
  it('(12) calls handleAlarm("reconnect-tick") when reconnect is armed', async () => {
    const armReconnect = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      armReconnect,
      chromeAlarms: chromeMock.alarms,
    })
    ctrl.armReconnectTick({ startAtMs: nowMs })

    nowMs += 10_000
    await ctrl.onBackoffResume()

    expect(armReconnect).toHaveBeenCalledTimes(1)
  })

  it('(13) no-op when not in backoff', async () => {
    const armReconnect = vi.fn()
    const ctrl = createAlarmsController({
      now: () => nowMs,
      armReconnect,
      chromeAlarms: chromeMock.alarms,
    })
    await ctrl.onBackoffResume()
    expect(armReconnect).not.toHaveBeenCalled()
  })
})
