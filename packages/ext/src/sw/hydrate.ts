/**
 * Service worker state hydration.
 *
 * Per spec §1:
 *  - Session token + fast-path keys persist in chrome.storage.session at
 *    TRUSTED_CONTEXTS access-level. CS cannot read.
 *  - Session key name is opaque: `s_<crypto.randomUUID()>` chosen per boot
 *    and cached on globalThis.__sessionKey so wake-ups reuse the same key
 *    for the lifetime of the installed extension process tree.
 *  - Fast-path persisted keys are stored inside the session record:
 *      tabs, activePickClientId, activePickCounter, lastSeq, instanceId,
 *      bootstrapToken, sessionToken, sessionExp.
 *  - Slow-path persisted keys (recent, manifestCache.seq, backoff.*,
 *    dormantReason) live in chrome.storage.local — non-sensitive,
 *    1-second debounced write cadence handled elsewhere.
 *
 * On failure (setAccessLevel throw, storage read throw, Zod parse fail):
 *  - setAccessLevel throw: swallow and continue (older Chrome fallback).
 *  - Storage read throw or Zod parse fail: best-effort clear the corrupted
 *    session entry, mark failed:true, return empty HydratedState so handlers
 *    still serve reduced-functionality responses.
 */

import { z } from 'zod'

export const SESSION_KEY_PREFIX = 's_'

export interface HydratedState {
  readonly instanceId: string | null
  readonly bootstrapToken: string | null
  readonly sessionToken: string | null
  readonly sessionExp: number | null
  // Placeholder shape — actual tabs state arrives in later SW tasks.
  readonly tabs: Record<string, unknown>
  readonly activePickClientId: string | null
  readonly activePickCounter: number
  readonly lastSeq: number
  readonly recent: readonly unknown[]
  readonly dormantReason: string | null
}

export interface HydrateResult {
  readonly state: HydratedState
  readonly sessionKey: string
  /** true when storage read threw or payload failed Zod parse. */
  readonly failed: boolean
}

/** Opaque per-boot session key. Callers should usually use hydrate() instead. */
export function makeSessionKey(): string {
  return `${SESSION_KEY_PREFIX}${crypto.randomUUID()}`
}

function emptyState(): HydratedState {
  return {
    instanceId: null,
    bootstrapToken: null,
    sessionToken: null,
    sessionExp: null,
    tabs: {},
    activePickClientId: null,
    activePickCounter: 0,
    lastSeq: 0,
    recent: [],
    dormantReason: null,
  }
}

// Zod schemas — module top-level per CLAUDE.md (in-handler z.object is a 100x v4 regression).
const SessionPayloadSchema = z
  .object({
    instanceId: z.string().nullable().optional(),
    bootstrapToken: z.string().nullable().optional(),
    sessionToken: z.string().nullable().optional(),
    sessionExp: z.number().nullable().optional(),
    tabs: z.record(z.string(), z.unknown()).optional(),
    activePickClientId: z.string().nullable().optional(),
    activePickCounter: z.number().int().nonnegative().optional(),
    lastSeq: z.number().int().nonnegative().optional(),
  })
  .passthrough()

const LocalPayloadSchema = z
  .object({
    recent: z.array(z.unknown()).optional(),
    dormantReason: z.string().nullable().optional(),
  })
  .passthrough()

interface GlobalWithSessionKey {
  __sessionKey?: string
}

function resolveSessionKey(): string {
  const g = globalThis as unknown as GlobalWithSessionKey
  if (typeof g.__sessionKey === 'string' && g.__sessionKey.startsWith(SESSION_KEY_PREFIX)) {
    return g.__sessionKey
  }
  const key = makeSessionKey()
  g.__sessionKey = key
  return key
}

/**
 * Hydrate SW state from chrome.storage.session (fast-path) + chrome.storage.local (slow-path).
 * Swallows setAccessLevel errors for older Chrome. On unrecoverable read/parse errors,
 * clears the poisoned session entry best-effort and returns empty state with failed:true.
 */
export async function hydrate(): Promise<HydrateResult> {
  // (1) Explicit access-level escalation. Chrome 120+ stable; wrap for older.
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    // Older Chrome: continue with SW-module-scope memory + re-exchange on wake.
  }

  const sessionKey = resolveSessionKey()

  let sessionRaw: unknown
  try {
    const result = await chrome.storage.session.get([sessionKey])
    sessionRaw = (result as Record<string, unknown>)[sessionKey]
  } catch (err) {
    // Storage unavailable: try to clear (best-effort). If clear also fails,
    // propagate so handlers surface the error via sendResponse({error}).
    try {
      await chrome.storage.session.remove(sessionKey)
      return { state: emptyState(), sessionKey, failed: true }
    } catch {
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  let localRaw: Record<string, unknown> = {}
  try {
    localRaw = await chrome.storage.local.get(['recent', 'dormantReason'])
  } catch {
    // Non-fatal — slow-path keys are all nullable.
    localRaw = {}
  }

  let session: z.infer<typeof SessionPayloadSchema> | undefined
  if (sessionRaw !== undefined) {
    const parsed = SessionPayloadSchema.safeParse(sessionRaw)
    if (!parsed.success) {
      // Poisoned payload: best-effort clear + empty fallback.
      await chrome.storage.session.remove(sessionKey).catch(() => undefined)
      return { state: emptyState(), sessionKey, failed: true }
    }
    session = parsed.data
  }

  const localParsed = LocalPayloadSchema.safeParse(localRaw)
  const local = localParsed.success ? localParsed.data : {}

  const state: HydratedState = {
    instanceId: session?.instanceId ?? null,
    bootstrapToken: session?.bootstrapToken ?? null,
    sessionToken: session?.sessionToken ?? null,
    sessionExp: session?.sessionExp ?? null,
    tabs: (session?.tabs ?? {}) as Record<string, unknown>,
    activePickClientId: session?.activePickClientId ?? null,
    activePickCounter: session?.activePickCounter ?? 0,
    lastSeq: session?.lastSeq ?? 0,
    recent: local.recent ?? [],
    dormantReason: local.dormantReason ?? null,
  }

  return { state, sessionKey, failed: false }
}
