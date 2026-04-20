/**
 * WebSocket client for a single wsUrl (spec §4.2, §4.4).
 *
 * Responsibilities:
 *  - Build WS URL with `?v=<n>&since=<seq>&instance=<id>` query.
 *  - Pass subprotocols
 *    `['redesigner-v1', 'base64url.bearer.authorization.redesigner.dev.<token>']`.
 *  - Dispatch first `hello` frame to `onHello` and reset the close-code reducer.
 *  - Route close codes through `closeReducer.nextState` and schedule reconnects.
 *
 * Pool ownership is external — `connPool` manages refcount + eviction. This
 * module is the per-connection state machine.
 *
 * Concurrency invariants:
 *  - At most one WebSocket instance is live at a time.
 *  - Reconnect scheduling is idempotent: if `close()` is called while a
 *    reconnect timer is pending, the timer is cancelled.
 *  - `onSessionRevalidate` awaits before the next WS is opened (so the caller
 *    has time to re-run `exchange` and rotate the token via `getSessionToken`).
 *
 * NOTE: the spec plan mentions `ws.protocol` assertion "on open" — this is
 * checked synchronously inside the `onopen` handler. If the mismatch is seen,
 * we `close(1002)` ourselves and let the subsequent `onclose` drive the
 * reducer (treated as 1002 → session-revalidate).
 */

import type { ReducerAction, ReducerState } from './closeReducer.js'
import { initialReducerState, nextState, resetOnHello } from './closeReducer.js'

// ---------------------------------------------------------------------------
// WebSocket constructor shape — matches the DOM `WebSocket` ctor.
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  readonly protocol: string
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type FakeWebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike

// ---------------------------------------------------------------------------
// Options + public interface
// ---------------------------------------------------------------------------

export interface WsClientOpts {
  wsUrl: string
  getSessionToken: () => Promise<string>
  sinceSeq?: number
  instanceId?: string
  versionsSupported?: readonly number[]
  onHello: (frame: unknown) => void
  onFrame: (frame: unknown) => void
  onClose: (code: number, reason: string) => void
  onReconnectScheduled: (delayMs: number) => void
  onGiveUp: () => void
  /**
   * Invoked on 1002 close. Caller is expected to re-exchange (drop the
   * session token, fetch a new one); when it resolves, the client calls
   * `getSessionToken` again and opens a fresh WS.
   */
  onSessionRevalidate: () => Promise<void>
  /**
   * Invoked on 1002 cap-exhaust (spec §4.4). Caller is expected to signal
   * the CS to re-fetch `handshake.json` and re-exchange. This client then
   * reopens with the next token from `getSessionToken`.
   */
  onCsHandshakeRefetch: () => void
  webSocketCtor?: FakeWebSocketCtor
}

export interface WsClient {
  open(): void
  close(): void
  send(frame: unknown): void
  state(): ReducerState
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_VERSIONS: readonly number[] = [1]

function pickHighestSupported(
  accepted: readonly number[] | null,
  local: readonly number[],
): number | null {
  const candidates = accepted === null ? local : accepted.filter((v) => local.includes(v))
  if (candidates.length === 0) return null
  return candidates.reduce((acc, v) => (v > acc ? v : acc), candidates[0] ?? 0)
}

function buildUrl(args: {
  wsUrl: string
  version: number
  sinceSeq: number | undefined
  instanceId: string | undefined
}): string {
  const u = new URL(args.wsUrl)
  u.searchParams.set('v', String(args.version))
  if (args.sinceSeq !== undefined) u.searchParams.set('since', String(args.sinceSeq))
  if (args.instanceId !== undefined) u.searchParams.set('instance', args.instanceId)
  return u.toString()
}

export function createWsClient(opts: WsClientOpts): WsClient {
  const localVersions = opts.versionsSupported ?? DEFAULT_VERSIONS
  const WSCtor: FakeWebSocketCtor =
    opts.webSocketCtor ?? (globalThis as unknown as { WebSocket: FakeWebSocketCtor }).WebSocket
  if (WSCtor === undefined) {
    throw new Error('wsClient: no WebSocket constructor available')
  }

  let reducer: ReducerState = initialReducerState()
  let active: WebSocketLike | null = null
  // Active connection version (bumped on 4406 rekey).
  let currentVersion: number = localVersions.reduce(
    (acc, v) => (v > acc ? v : acc),
    localVersions[0] ?? 1,
  )
  // If true, the caller has requested the client stop. New sockets must not
  // be opened; pending reconnect timers are cleared.
  let disposed = false
  // If true, the client is already inside a connect attempt (async token
  // fetch in flight). Guards against duplicate opens.
  let connecting = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Last hello observed on the *current* socket. Drives the onclose reducer
  // decision whether to resetOnHello was already applied.
  // (Reducer holds the truth; this is just bookkeeping.)

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  async function connect(): Promise<void> {
    if (disposed) return
    if (connecting) return
    connecting = true
    try {
      const token = await opts.getSessionToken()
      if (disposed) return
      const url = buildUrl({
        wsUrl: opts.wsUrl,
        version: currentVersion,
        sinceSeq: opts.sinceSeq,
        instanceId: opts.instanceId,
      })
      const subprotocols: string[] = [
        `redesigner-v${currentVersion}`,
        `base64url.bearer.authorization.redesigner.dev.${token}`,
      ]
      const ws = new WSCtor(url, subprotocols)
      active = ws
      ws.onopen = () => {
        // Subprotocol mismatch → close ourselves with 1002. The onclose
        // handler routes through the reducer (1002 → session-revalidate).
        if (ws.protocol !== `redesigner-v${currentVersion}`) {
          try {
            ws.close(1002, 'subprotocol-mismatch')
          } catch {
            // close() throws on some stacks when already closed; ignore.
          }
        }
      }
      ws.onmessage = (ev) => {
        let frame: unknown
        try {
          frame = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
        } catch {
          // Malformed JSON — ignore. The daemon should not send non-JSON.
          return
        }
        if (
          frame !== null &&
          typeof frame === 'object' &&
          (frame as { type?: unknown }).type === 'hello'
        ) {
          reducer = resetOnHello(reducer)
          try {
            opts.onHello(frame)
          } catch {
            // Listener errors do not affect the WS state machine.
          }
          return
        }
        try {
          opts.onFrame(frame)
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        // Per spec §4.2: swallow error events; `onclose` fires afterwards
        // and drives state transitions.
      }
      ws.onclose = (ev) => {
        const code = ev.code
        const reason = ev.reason
        active = null
        connecting = false
        try {
          opts.onClose(code, reason)
        } catch {
          // ignore
        }
        if (disposed) return
        scheduleFromClose(code, reason)
      }
    } catch {
      // Token fetch or ctor failure — treat as a 1006-equivalent and back
      // off. This keeps the client alive in the face of transient exchange
      // errors.
      active = null
      connecting = false
      scheduleFromClose(1006, 'connect-failed')
    } finally {
      // `connecting` remains true until the socket either opens (onmessage
      // hello) or closes (onclose). The finally here only fires the
      // *outer* try; onclose flips it above.
    }
  }

  function scheduleFromClose(code: number, reason: string): void {
    if (disposed) return
    const result = nextState({
      prev: reducer,
      code,
      now: Date.now(),
      closeReason: reason,
    })
    reducer = result.next
    dispatchAction(result.action)
  }

  function dispatchAction(action: ReducerAction): void {
    switch (action.type) {
      case 'no-reconnect':
        return
      case 'give-up':
        try {
          opts.onGiveUp()
        } catch {
          // ignore
        }
        return
      case 'backoff':
      case 'fixed-delay': {
        const delayMs = action.delayMs
        try {
          opts.onReconnectScheduled(delayMs)
        } catch {
          // ignore
        }
        clearReconnectTimer()
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          void connect()
        }, delayMs)
        return
      }
      case 'session-revalidate': {
        // Kick off revalidate + reconnect once it resolves.
        ;(async () => {
          try {
            await opts.onSessionRevalidate()
          } catch {
            // If revalidation throws, fall back to backoff — treat like 1006.
            scheduleFromClose(1006, 'revalidate-failed')
            return
          }
          if (disposed) return
          await connect()
        })()
        return
      }
      case 'cs-handshake-refetch': {
        try {
          opts.onCsHandshakeRefetch()
        } catch {
          // ignore
        }
        // Caller re-primes the exchange; we then reopen.
        ;(async () => {
          if (disposed) return
          await connect()
        })()
        return
      }
      case 'reconnect-version': {
        const picked = pickHighestSupported(action.accepted, localVersions)
        if (picked === null) {
          try {
            opts.onGiveUp()
          } catch {
            // ignore
          }
          reducer = { ...reducer, giveUp: true }
          return
        }
        currentVersion = picked
        // Version negotiation is conditional budget per spec — reconnect
        // immediately without burning attempts.
        ;(async () => {
          if (disposed) return
          await connect()
        })()
        return
      }
    }
  }

  return {
    open(): void {
      if (disposed) return
      void connect()
    },
    close(): void {
      disposed = true
      clearReconnectTimer()
      if (active !== null) {
        try {
          active.close(1000, 'client-close')
        } catch {
          // ignore
        }
        active = null
      }
    },
    send(frame: unknown): void {
      if (active === null) return
      try {
        active.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
      } catch {
        // ignore — onclose will drive recovery
      }
    },
    state(): ReducerState {
      return reducer
    },
  }
}
