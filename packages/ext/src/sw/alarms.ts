/**
 * Alarms controller — Task 26 (spec §4.4 + §11 Welcome panel).
 *
 * Two independent alarms:
 *
 *   reconnect-tick
 *     Tiered wake cadence while the wsClient is in backoff. First 2 minutes
 *     at 30s cadence; decays to 60s thereafter. Cleared by the consumer on
 *     successful hello (via clearReconnectTick) or terminal give-up. Each
 *     fire invokes `armReconnect()` so wsClient re-attempts immediately —
 *     the alarm is the keep-alive signal that survives SW suspension, not
 *     the reconnect schedule itself (that's still jittered timers inside
 *     wsClient).
 *
 *   welcome-probe-tick
 *     When no daemon has ever been seen for this browser profile, probe
 *     open localhost tabs every 60s for `HEAD /__redesigner/handshake.json`.
 *     Caps at 20 attempts. On first 200 → onHandshakeDetected(origin) +
 *     clear. On cap → clear + onCapReached; the Welcome side-panel shows a
 *     "Resume probing" button that calls resumeWelcomeProbeAfterCap().
 *
 * onBackoffResume() is the user-action-driven wake path — call when:
 *   - chrome.runtime.onStartup fires,
 *   - chrome.idle.onStateChanged('active') fires,
 *   - chrome.tabs.onActivated activates a localhost tab,
 *   - the panel's retry button is clicked.
 * It fires the reconnect-tick handler immediately so we don't wait for the
 * next alarm boundary.
 *
 * CLAUDE.md invariants honoured:
 *   - fetch uses AbortSignal.timeout(ms). Never new AbortController + setTimeout.
 *   - Never AbortSignal.any([...]).
 *   - No module-level timers; no process listeners.
 *
 * This module has zero side effects at import time — the consumer wires
 * chrome.alarms.onAlarm + chrome.runtime.onStartup + chrome.idle.onStateChanged
 * + chrome.tabs.onActivated inside sw/index.ts (intentionally out of scope
 * for Task 26; see Phase-6 integration task).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALARM_RECONNECT = 'reconnect-tick'
const ALARM_WELCOME_PROBE = 'welcome-probe-tick'

/** Fast-tier cadence (seconds) for the first 2 minutes of backoff. */
const RECONNECT_FAST_CADENCE_S = 30
/** Slow-tier cadence (seconds) after 2 minutes. */
const RECONNECT_SLOW_CADENCE_S = 60
/** Threshold where fast → slow decay triggers. */
const RECONNECT_DECAY_THRESHOLD_MS = 120_000

/** Welcome probe cadence (seconds). */
const WELCOME_PROBE_CADENCE_S = 60
/** Default cap for welcome probes before surfacing "Resume probing". */
const DEFAULT_WELCOME_PROBE_MAX_ATTEMPTS = 20
/** HEAD /__redesigner/handshake.json timeout. */
const WELCOME_PROBE_TIMEOUT_MS = 5_000
/** URL patterns for localhost tabs. Keep in sync with tabs.query below. */
const LOCALHOST_URL_PATTERNS: readonly string[] = ['http://localhost/*', 'http://127.0.0.1/*']

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AlarmsControllerState {
  readonly reconnectArmedAt: number | null
  readonly welcomeProbeAttempts: number
}

export interface ArmReconnectTickOpts {
  /**
   * Wall-clock ms for when backoff started. Used to decide the 30s vs 60s
   * tier on each tick. Defaults to now().
   */
  readonly startAtMs?: number
}

export interface ArmWelcomeProbeTickOpts {
  /**
   * Called with the matching origin (e.g. 'http://localhost:5173') when a
   * probe sees HTTP 200. The caller is expected to clear the welcome state
   * + trigger the normal exchange flow.
   */
  readonly onHandshakeDetected?: (origin: string) => void
}

export interface AlarmsController {
  armReconnectTick(opts?: ArmReconnectTickOpts): void
  clearReconnectTick(): Promise<void>
  armWelcomeProbeTick(opts?: ArmWelcomeProbeTickOpts): void
  resumeWelcomeProbeAfterCap(): void
  handleAlarm(name: string): Promise<void>
  onBackoffResume(): Promise<void>
  state(): AlarmsControllerState
}

export interface CreateAlarmsControllerOpts {
  /**
   * Called on every reconnect-tick fire. Consumer asks wsClient / connPool
   * to reattempt. Defaults to a no-op (the SW index wires this in).
   */
  readonly armReconnect?: () => void
  /**
   * Injected for tests — not used by the default probe flow (tests can
   * still stub globalThis.fetch for the HEAD call).
   */
  readonly checkHealth?: (origin: string) => Promise<boolean>
  /** Injectable clock. Defaults to Date.now. */
  readonly now?: () => number
  /** Override the 20-attempt cap (tests use a smaller value). */
  readonly welcomeProbeMaxAttempts?: number
  /** chrome.alarms surface — narrowed to the methods we actually use so that
   * tests can supply a minimal mock without having to satisfy every overload. */
  readonly chromeAlarms?: AlarmsApi
  /** Fires when welcome probe hits its cap — panel shows Resume button. */
  readonly onCapReached?: () => void
}

/** Narrowed subset of chrome.alarms used by the controller. */
export interface AlarmsApi {
  create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): Promise<void>
  clear(name: string): Promise<boolean>
  get(name: string): Promise<chrome.alarms.Alarm | undefined>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesFromSeconds(seconds: number): number {
  return seconds / 60
}

function toOrigin(url: string | undefined): string | null {
  if (url === undefined || url === '') return null
  try {
    const u = new URL(url)
    // Only http is valid for the localhost handshake.
    if (u.protocol !== 'http:') return null
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
    return u.origin
  } catch {
    return null
  }
}

async function probeOrigin(origin: string): Promise<boolean> {
  const url = new URL('/__redesigner/handshake.json', origin).toString()
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      credentials: 'omit',
      cache: 'no-store',
      // CLAUDE.md: AbortSignal.timeout — never new AbortController + setTimeout.
      signal: AbortSignal.timeout(WELCOME_PROBE_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createAlarmsController(opts: CreateAlarmsControllerOpts = {}): AlarmsController {
  const now = opts.now ?? (() => Date.now())
  const alarmsApi = opts.chromeAlarms ?? chrome.alarms
  const welcomeCap = opts.welcomeProbeMaxAttempts ?? DEFAULT_WELCOME_PROBE_MAX_ATTEMPTS

  // --- reconnect-tick state ------------------------------------------------
  let reconnectStartAtMs: number | null = null

  // --- welcome-probe-tick state -------------------------------------------
  let welcomeAttempts = 0
  let welcomeOnDetected: ((origin: string) => void) | undefined

  function reconnectCadenceSeconds(startAtMs: number): number {
    return now() - startAtMs < RECONNECT_DECAY_THRESHOLD_MS
      ? RECONNECT_FAST_CADENCE_S
      : RECONNECT_SLOW_CADENCE_S
  }

  function scheduleReconnectTick(cadenceSec: number): void {
    void alarmsApi.create(ALARM_RECONNECT, {
      delayInMinutes: minutesFromSeconds(cadenceSec),
    })
  }

  function scheduleWelcomeProbeTick(): void {
    void alarmsApi.create(ALARM_WELCOME_PROBE, {
      delayInMinutes: minutesFromSeconds(WELCOME_PROBE_CADENCE_S),
    })
  }

  // --- reconnect-tick handler ---------------------------------------------
  async function handleReconnectTick(): Promise<void> {
    if (reconnectStartAtMs === null) return
    try {
      opts.armReconnect?.()
    } catch {
      // Consumer errors must not prevent the next re-arm.
    }
    scheduleReconnectTick(reconnectCadenceSeconds(reconnectStartAtMs))
  }

  // --- welcome-probe-tick handler -----------------------------------------
  async function handleWelcomeProbeTick(): Promise<void> {
    // Query open localhost tabs.
    let tabs: chrome.tabs.Tab[] = []
    try {
      tabs = await chrome.tabs.query({ url: [...LOCALHOST_URL_PATTERNS] })
    } catch {
      tabs = []
    }

    // Dedupe origins — a single daemon can back many tabs.
    const origins = new Set<string>()
    for (const tab of tabs) {
      const origin = toOrigin(tab.url)
      if (origin !== null) origins.add(origin)
    }

    // Probe each origin concurrently. First 200 wins.
    let detected: string | null = null
    await Promise.all(
      [...origins].map(async (origin) => {
        if (detected !== null) return
        const ok = opts.checkHealth ? await opts.checkHealth(origin) : await probeOrigin(origin)
        if (ok && detected === null) {
          detected = origin
        }
      }),
    )

    if (detected !== null) {
      welcomeAttempts = 0
      await alarmsApi.clear(ALARM_WELCOME_PROBE)
      try {
        welcomeOnDetected?.(detected)
      } catch {
        // ignore
      }
      return
    }

    welcomeAttempts += 1
    if (welcomeAttempts >= welcomeCap) {
      await alarmsApi.clear(ALARM_WELCOME_PROBE)
      try {
        opts.onCapReached?.()
      } catch {
        // ignore
      }
      return
    }
    scheduleWelcomeProbeTick()
  }

  // --- public surface ------------------------------------------------------

  function armReconnectTick(o: ArmReconnectTickOpts = {}): void {
    reconnectStartAtMs = o.startAtMs ?? now()
    scheduleReconnectTick(RECONNECT_FAST_CADENCE_S)
  }

  async function clearReconnectTick(): Promise<void> {
    reconnectStartAtMs = null
    await alarmsApi.clear(ALARM_RECONNECT)
  }

  function armWelcomeProbeTick(o: ArmWelcomeProbeTickOpts = {}): void {
    welcomeAttempts = 0
    welcomeOnDetected = o.onHandshakeDetected
    scheduleWelcomeProbeTick()
  }

  function resumeWelcomeProbeAfterCap(): void {
    welcomeAttempts = 0
    scheduleWelcomeProbeTick()
  }

  async function handleAlarm(name: string): Promise<void> {
    if (name === ALARM_RECONNECT) {
      await handleReconnectTick()
      return
    }
    if (name === ALARM_WELCOME_PROBE) {
      await handleWelcomeProbeTick()
      return
    }
    // Unknown alarms — ignored. Consumer can add its own names later.
  }

  async function onBackoffResume(): Promise<void> {
    // Only meaningful when reconnect-tick is armed — otherwise there's
    // nothing to resume.
    if (reconnectStartAtMs === null) return
    await handleReconnectTick()
  }

  function state(): AlarmsControllerState {
    return {
      reconnectArmedAt: reconnectStartAtMs,
      welcomeProbeAttempts: welcomeAttempts,
    }
  }

  return {
    armReconnectTick,
    clearReconnectTick,
    armWelcomeProbeTick,
    resumeWelcomeProbeAfterCap,
    handleAlarm,
    onBackoffResume,
    state,
  }
}
