import { ComponentHandleSchema } from '@redesigner/core'
import { ensureSession } from './ensureSession.js'
import type { TabHandshake, TabSession } from './messageRouter.js'
import { putSelection } from './rest.js'

// Re-export so persistSelection.test.ts can import the types from this module
// without depending on messageRouter internals directly.
export type { TabHandshake, TabSession }

export interface PersistSelectionDeps {
  tabHandshakes: Map<number, TabHandshake>
  tabSessions: Map<number, TabSession>
  extId: string // chrome.runtime.id — injected once at deps construction
}

// Monotonic dispatch counter, SW-local. Seeded from Date.now() low 24 bits so
// cold-start restarts don't collide in logs. Purpose is log correlation, not
// uniqueness.
let pickSeq: number = Date.now() & 0xffffff

const PUT_TIMEOUT_MS = 2000
const COLD_RACE_WINDOW_MS = 100

export async function persistSelection(
  tabId: number,
  rawHandle: unknown,
  deps: PersistSelectionDeps,
): Promise<void> {
  const localPickSeq = ++pickSeq
  const startMs = Date.now()

  const hs = deps.tabHandshakes.get(tabId)
  if (hs === undefined) {
    console.warn('[redesigner:sw] persistSelection: no handshake for tab', { tabId })
    // Pick arrived before register — instrumentation for cold-start races.
    console.warn('[redesigner:race] pick arrived before register', { tabId })
    return
  }

  // Cold-start race: register JUST landed (<100ms ago) and we already got a pick.
  // Use Date.now() — survives SW wakes, unlike performance.now() which resets.
  const deltaMs = Date.now() - hs.registeredAtEpochMs
  if (deltaMs < COLD_RACE_WINDOW_MS) {
    console.warn('[redesigner:race] pick within 100ms of register', { tabId, deltaMs })
  }

  const parsed = ComponentHandleSchema.safeParse(rawHandle)
  if (!parsed.success) {
    console.warn('[redesigner:sw] persistSelection: handle schema mismatch', {
      tabId,
      issues: parsed.error.issues,
    })
    return
  }
  const handle = parsed.data

  let cold = false
  try {
    const cached = deps.tabSessions.get(tabId)
    let sessionToken: string
    if (cached !== undefined && cached.exp - Date.now() > 60_000) {
      sessionToken = cached.sessionToken
    } else {
      cold = true
      sessionToken = await ensureSession(tabId, hs, deps)
    }

    await putSelection({
      httpUrl: hs.httpUrl,
      tabId,
      sessionToken,
      extId: deps.extId,
      body: { nodes: [handle] },
      timeoutMs: PUT_TIMEOUT_MS,
    })

    const elapsedMs = Date.now() - startMs
    console.log('[redesigner:perf] persistSelection', {
      tabId,
      pickSeq: localPickSeq,
      elapsedMs,
      kind: 'ok',
      cold,
    })
  } catch (err) {
    const elapsedMs = Date.now() - startMs
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[redesigner:sw] persistSelection: PUT failed', { tabId, message })
    console.log('[redesigner:perf] persistSelection', {
      tabId,
      pickSeq: localPickSeq,
      elapsedMs,
      kind: 'fail',
      cold,
    })
    // NEVER rethrow — the caller (routeMessage) finishes sendResponse unconditionally.
  }
}
