# Selection Pipeline Stage 1 — SW→Daemon PUT + MCP Roundtrip

**Status:** Design
**Date:** 2026-04-20
**Scope:** Stage 1 of a two-stage effort. Stage 2 (computed-styles + DOM-subtree routes + SW↔content DOM-harvest bridge) gets its own spec after Stage 1 lands and is dogfood-verified.

## Goal

When a user commits a selection via the picker overlay, the selection must persist to the daemon and be readable via MCP `get_current_selection` — end-to-end. Close the one missing wire in the otherwise complete selection pipeline.

## Current State

Verified by code inspection on branch `fix/daemon-vite-token-sync` (2026-04-20):

| Segment | Status |
|---|---|
| Content script → SW `{type:'selection', handle}` | Works (packages/ext/src/content/index.ts:40) |
| SW `selection` handler → panel push | Works (packages/ext/src/sw/messageRouter.ts:144-152) |
| **SW → daemon `PUT /tabs/{tabId}/selection`** | **Missing — gap this spec closes** |
| Daemon `PUT /tabs/{tabId}/selection` route | Works (packages/daemon/src/routes/selection.ts) |
| Daemon `selectionState` storage + WS broadcast | Works |
| Daemon `GET /selection` + `GET /selection/recent` | Works |
| MCP `get_current_selection` + `list_recent_selections` | Works, but returns empty because nothing writes |
| MCP roundtrip integration test | Missing |

`packages/ext/src/sw/rest.ts` already exports `putSelection(args)` with the correct shape. It is untested end-to-end and unused by any caller.

## Non-Goals

- `get_computed_styles` / `get_dom_subtree` routes on daemon (Stage 2).
- SW↔content DOM-harvest bridge (Stage 2).
- SW consuming WS `selection.updated` to refresh panel (current direct panel push stays).
- Selection history de-dup beyond daemon's existing `selectionState.apply`.
- **Panel↔daemon ordering consistency under rapid concurrent picks.** If the user picks A then B within ~100ms, the panel shows B (synchronous push is dispatch-order-preserving) but the daemon may settle on A if PUT_A's network arrival lags PUT_B's. v0 accepts this UX footgun. Stage 2 will add a client-side `pickSeq` in `meta` plus daemon-side reject-out-of-order. See Slice B.2 and Risk #8.
- Multi-select (v0 schema is `min(1).max(1)`; unchanged).

## Architecture

Six slices: REST header plumbing, SW message-handler PUT (await-in-dispatcher), handle validation, integration test, core schema tweak, and a one-character regex correctness fix across the daemon.

### Slice A: REST header for extId

Chrome strips the `Origin` header on extension-SW REST calls that carry an `Authorization` header (privileged-context privacy mitigation; observed as `Sec-Fetch-Site: none`). The daemon's session-auth fallback accepts `X-Redesigner-Ext-Id: <chrome.runtime.id>` as a substitute extId source. The `/manifest` handler in `messageRouter.ts` already sends this header per-call (landed in commit e7bc4db).

**Change:** `putSelection` must send the same header. Add an optional `extId?: string` to `RestArgs`, and have `makeJsonHeaders(bearer, extId?)` inject the header when defined. Callers that need it pass `extId: chrome.runtime.id`. `rest.ts` must stay chrome-free (tested under node vitest without chrome globals).

**API commitment:** The explicit-threaded `extId?` arg is acceptable for this spec's two callers (`putSelection` + future helpers in Stage 2). **Factory-migration trigger (concrete):** when `rest.ts` exports more than 2 helpers taking `extId`, OR when any Stage 2 slice adds a new SW→daemon REST helper (e.g., `putDomSubtree`, `getComputedStyles`), the implementer **must** convert to a factory pattern — `createSwRestClient({ httpUrl, sessionToken, extId })` returning bound helpers — rather than threading the arg through every signature. The `/manifest` inline fetch in `messageRouter.ts` migrates to the factory at that point (not as part of this spec — YAGNI).

**Related consolidation:** `PersistSelectionDeps` (Slice B.1) is the fourth bag-of-maps deps object in `packages/ext/src/sw/`. At the same factory-migration step described above, consolidate `routeMessage` / `persistSelection` / `ensureSession` deps into a single `SwContext` type shared across the module — the two migrations happen together, not piecemeal.

**Header-family rename debt:** the `X-` prefix on `X-Redesigner-Ext-Id` is deprecated by RFC 6648 for new header registrations. It is retained here for consistency with other `X-Redesigner-*` headers already in the system. When any single future slice renames the family (e.g. `Redesigner-*`), pay the debt in full. To find every callsite across the monorepo (HTTP **and** WS paths): `grep -rn "X-Redesigner-" packages/`. Include daemon/src/ws/ in the audit — WS origin/auth checks may use separate code paths. Do not migrate incrementally — that leaves the system in a half-renamed state that's worse than either extreme.

**Wire contract (X-Redesigner-Ext-Id):**

| Property | Value |
|---|---|
| Header name (outgoing) | `X-Redesigner-Ext-Id` (literal case, for DevTools readability) |
| Header name (incoming, daemon side) | `x-redesigner-ext-id` (Node `http` lowercases all incoming header keys) |
| Note on RFC 6648 | `X-` prefix is deprecated by RFC 6648 for new headers. Retained here for consistency with other `X-Redesigner-*` headers in the system. If a broader header rename lands, this migrates too. |
| Value constraint | 32-character Chrome extension ID matching `/^[a-p]{32}$/`. Chrome derives ext IDs by mapping SHA-256 hex output (0-9a-f) to letters (a-p), so legitimate IDs never contain q-z. |
| When sent | On every SW→daemon REST call that carries a session `Authorization: Bearer <sessionToken>`. |
| When absent from request | Daemon falls back to `Origin` header (`chrome-extension://<extId>`) — the preferred source when available. |
| When present but value ≠ session's pinned extId | Daemon returns 401. `isSessionActive(extId, token)` requires strict TOFU match against the pinned extId from `/exchange`. |
| When present but malformed (not `[a-p]{32}`) | Daemon ignores the header, falls back to `Origin`; if that's also missing, final auth is 401. |
| Relationship to Bearer | Sent **in addition to** Bearer, not instead of. Bearer is required for auth. |
| When Bearer matches root authToken (not a session token) | Daemon short-circuits to "authed=true" before the extId fallback runs. `X-Redesigner-Ext-Id` is ignored for auth decisions — root authToken bypasses the TOFU model (it's the daemon's privileged key). **However:** if an `X-Redesigner-Ext-Id` header is present in such a request, daemon emits a debug-level log with Bearer fingerprint (first 8 chars) + extId fingerprint so a root-token compromise replayed with a mismatched extId leaves a forensic trail. Zero auth impact, but the audit signal matters. |
| When Bearer matches no known token | Daemon attempts the extId fallback. 401 if that also fails. |
| On 401 where auth fell through | Daemon emits a structured warn log with Bearer-token first-8-chars fingerprint + `origin` (or null) + `extId` (or null) to aid triage. No secret material in logs. |
| Success response shape (`PUT /tabs/{tabId}/selection`) | 200 with `{ selectionSeq: number, acceptedAt: number }` — per `SelectionPutResponseSchema` in `packages/core/src/schemas/selection.ts`. Shape is already in production (not aspirational). SW currently discards the response body; Stage 2 MCP integrations may read `selectionSeq` to reason about ordering. **`selectionSeq` semantics:** daemon-side monotonic per tab, assigned at `selectionState.apply` time, resets on daemon restart. `acceptedAt` is Unix-ms server clock at apply time. **Forward-evolution:** Slice E.1 loosens this schema from `.strict()` to `.catchall(z.unknown())` so Stage 2 can add response fields (e.g., server-echoed `pickSeq`) without a breaking bump. Clients must ignore unknown keys. |
| 401 body | `{error:'auth', reason:'extid-mismatch'|'token-unknown'|'token-tofu-fail'}`. See `errors.ts` schema sketch below. Machine-parseable for Stage 2 MCP error surfacing. Slice F adds tests pinning each reason. |
| 403 body | `{error:'cors', reason:'malformed-origin'|'missing-origin'}`. Split preserves the distinction between "present but bad shape" and "expected but absent" — two different daemon-side evaluation paths, two different client fix actions. |
| When Bearer matches root authToken AND Origin is present but malformed | Daemon returns 403 (CORS layer evaluates Origin shape pre-auth; root-authToken short-circuit does not bypass Origin rejection). Slice F pins this ordering with a test. |
| When Bearer matches root authToken AND Origin is absent | Daemon returns 200 — root authToken is a privileged out-of-browser path (CLI, daemon-internal), so missing Origin is normal. No 403 for root-auth path. |
| 401 vs 403 convention | 401 = post-auth identity failure ("token understood, but does not authorize this extId"). 403 = pre-auth shape rejection ("Origin / header doesn't match `[a-p]{32}`"). See Slice F for the regression test that pins this split. |

Security: `isSessionActive(extId, token)` enforces strict TOFU match against the pinned extId from `/exchange`, so a forged `X-Redesigner-Ext-Id` can't impersonate a different extension.

**`errors.ts` schema sketch:**

```ts
// packages/core/src/schemas/errors.ts
import { z } from 'zod'

// Forward-compatible reason: known values get enum-level safety, unknown values
// fall through to a string and get logged rather than crashing parse. Error codes
// are the single most-likely-to-grow surface in a daemon, so asymmetry with the
// (.strict()) response schema would be a mistake we'd walk back on the first
// Stage 2 new reason-code. Tests pin the currently-known values.
export const AuthErrorSchema = z.object({
  error: z.literal('auth'),
  reason: z.enum(['extid-mismatch', 'token-unknown', 'token-tofu-fail']).or(z.string()),
}).catchall(z.unknown())

export const CorsErrorSchema = z.object({
  error: z.literal('cors'),
  reason: z.enum(['malformed-origin', 'missing-origin']).or(z.string()),
}).catchall(z.unknown())

export const ApiErrorSchema = z.discriminatedUnion('error', [AuthErrorSchema, CorsErrorSchema])
export type ApiError = z.infer<typeof ApiErrorSchema>
```

`reason` is **required** (not optional). Both shapes use `.catchall(z.unknown())` on the outer and `z.enum(...).or(z.string())` on `reason` — unknown reason codes parse successfully as a fallback, tests pin the currently-known enum values, and Stage 2 can add new reason codes without a coordinated client upgrade. This preserves the liberal-in-what-you-accept principle symmetric with `SelectionPutResponseSchema`. Consumed by daemon (producer) and MCP + ext rest.ts (consumers).

### Slice B: SW selection handler — await PUT inside the async dispatcher

**Important context on the MV3 onMessage pattern already in place:** the top-level listener in `packages/ext/src/sw/index.ts` is intentionally non-async and synchronously returns `true`. It delegates to `routeMessage` (already declared `async function` in `packages/ext/src/sw/messageRouter.ts`) via `readyPromise.then(() => routeMessage(...))`. The listener returning `true` keeps the message port open; the async dispatcher calls `sendResponse` when its work resolves. See sw/index.ts:66-75.

This spec does **not** modify the top-level listener shape. The `await persistSelection(...)` call below lives **inside** the existing `async function routeMessage(...)` — not inside the `chrome.runtime.onMessage.addListener` callback. Any implementer reading this section must preserve the non-async listener + `return true` contract; breaking it is a Chrome MV3 foot-gun (the listener returning a Promise gets coerced to `true` inconsistently across older Chrome versions, dropping responses).

**Chrome version note:** `packages/ext/manifest.json`'s `minimum_chrome_version` (if set) determines whether returning-a-Promise from an `onMessage` listener is reliable — Chrome 146+ handles this better. Even on Chrome 146+, this spec sticks with the non-async + `return true` pattern because (a) it works uniformly across all target versions, (b) the existing code already uses it and a cosmetic refactor risks introducing the exact bug this section warns about.

Full pattern (reference only — existing code, not to be changed):

```ts
// packages/ext/src/sw/index.ts — NOT MODIFIED BY THIS SPEC
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  readyPromise
    .then(() => routeMessage(msg, sender, sendResponse, deps))
    .catch((err) => sendResponse({ error: String(err) }))
  return true   // MUST be synchronous; keeps port open for async sendResponse
})
```

**Change (inside `routeMessage` in `messageRouter.ts`):** the `selection` branch pushes to the panel first (synchronous, wrapped in try/catch — panel can throw if the extension context is invalidated mid-session), then **awaits** the daemon PUT before calling `sendResponse`. Awaiting keeps the SW's outstanding-work tracker engaged through the fetch, preventing idle-timer termination during the Zod parse / `ensureSession` / PUT sequence.

```ts
// packages/ext/src/sw/messageRouter.ts — INSIDE async routeMessage(...)
if (type === 'selection') {
  const rawHandle = (msg as { handle?: unknown }).handle
  if (typeof tabId === 'number' && typeof windowId === 'number') {
    // Panel push: handles both sync-return (void) today and Promise-return if
    // ported later. Defensive against a future refactor making push async.
    // Use try/finally so `await persistSelection` ALWAYS runs, even if the
    // catch handler itself throws (e.g., a minified build where err.message
    // is a getter that throws). The PUT path must not depend on the panel
    // push logging cleanly.
    try {
      try {
        const maybePromise = deps.panelPort.push(windowId, tabId, { selection: rawHandle ?? null })
        Promise.resolve(maybePromise).catch((err: unknown) => {
          // Legitimate async rejection: "Extension context invalidated"
          // after an unpacked reload; panel port closed mid-push.
          console.warn('[redesigner:sw] panelPort.push rejected', {
            name: err instanceof Error ? err.name : 'unknown',
            message: err instanceof Error ? err.message : String(err),
          })
        })
      } catch (err) {
        // Synchronous throw path. A TypeError/RangeError here would indicate a
        // programming error in panelPort itself — we still swallow in v0.
        console.warn('[redesigner:sw] panelPort.push threw', {
          name: err instanceof Error ? err.name : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      // Persist PUT runs unconditionally — guaranteed by finally even if the
      // panel push AND its own catch handler both throw. See Risk #7.
    }
    // Persist PUT: awaited so the SW port stays open past the fetch dispatch.
    // persistSelection never throws; it logs and returns on any failure.
    //
    // INVARIANT: total async work in this branch must stay under Chrome's
    // 5-minute per-event hard cap. With ensureSession (5s max) + PUT (2s max)
    // = 7s worst case today, there's huge headroom. Any future retry loop or
    // queue wrapped around this await MUST enforce a cumulative ceiling well
    // below 5 min, or the SW tears down mid-work and sendResponse fails.
    await persistSelection(tabId, rawHandle, deps)
  }
  // Wrap sendResponse: if the SW idle-terminated during the await (possible on
  // cold paths near the 7s composite ceiling), the port reference may be
  // invalidated and sendResponse throws synchronously. Content-script caller
  // does not await the response, so swallowing is safe — but log it, because
  // sendResponse-throwing means the SW lost a real event mid-work. That's a
  // triage signal, not routine noise.
  try {
    sendResponse({ ok: true })
  } catch (err) {
    console.warn('[redesigner:sw] sendResponse threw (port likely closed)', {
      tabId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return
}
```

### Slice B.1: `persistSelection` helper (new file)

New file: `packages/ext/src/sw/persistSelection.ts`. Extracted from `messageRouter.ts` to keep the router dispatch table focused and to allow standalone unit testing.

Signature (takes `unknown`, validates inside; `extId` injected via deps so the module stays decoupled from the `chrome.runtime` global and is mockable under vitest without ambient globals):

```ts
export interface PersistSelectionDeps {
  tabHandshakes: Map<number, TabHandshake>
  tabSessions: Map<number, TabSession>
  extId: string   // chrome.runtime.id, passed in at call site (sw/index.ts → messageRouter → here)
}

export async function persistSelection(
  tabId: number,
  rawHandle: unknown,
  deps: PersistSelectionDeps,
): Promise<void>
```

Threading `extId` through `deps` rather than reading `chrome.runtime.id` inside the function means `persistSelection.test.ts` does not need to set up `globalThis.chrome`. `messageRouter.ts` reads `chrome.runtime.id` once when building `deps` for `routeMessage`.

Responsibilities, in order:

1. Look up `deps.tabHandshakes.get(tabId)`. If missing, `console.warn('[redesigner:sw] persistSelection: no handshake for tab', {tabId})` and return.
2. Validate `rawHandle` with `ComponentHandleSchema.safeParse(rawHandle)`. On invalid: `console.warn('[redesigner:sw] persistSelection: handle schema mismatch', {issues: parsed.error.issues, tabId})` and return. Structured field ensures `extractHandle` ↔ schema drift is debuggable from user DevTools without enabling verbose logging.
3. Call `ensureSession(tabId, hs, deps)` for a session token. See **Session contract** below.
4. Call `putSelection({ httpUrl: hs.httpUrl, tabId, sessionToken, extId: deps.extId, body: { nodes: [handle] }, timeoutMs: 2000 })`. See **Timeout & ordering** below.
5. Wrap steps 3–4 in a single try/catch. On any thrown error: `console.warn('[redesigner:sw] persistSelection: PUT failed', {message, tabId})`. **Never rethrow** — panel UX already completed in Slice B.

**Session contract:**
- `ensureSession` inherits the existing 60-second refresh lead and `AbortSignal.timeout(5000)` from `postExchange`.
- If `ensureSession` throws (network down, daemon 5xx, bootstrap token invalid), `persistSelection` catches it, logs, and returns — same handling as a thrown `putSelection`.
- `tabSessions` is in-memory (dies with SW). After SW wake, the first `persistSelection` call pays an `/exchange` round-trip. Cold-path budget in the Performance Budget section accounts for this.
- Cold-start handshake race: if the first user pick lands while `tabHandshakes` is still unpopulated (content-script `register` message hasn't fired yet — see packages/ext/src/content/index.ts which sends `register` on every injection, not only first), step 1 bails with a warn. Acceptable — the next pick re-registers and succeeds. Do **not** add a queue/retry.
- **Cold-start race instrumentation:** compute the delta between `Date.now()` at `persistSelection` entry and `hs.registeredAtEpochMs` (stored at register time). Both use wall-clock milliseconds so the delta is meaningful across SW wakes (`performance.now()` resets its origin on wake, which would yield nonsense deltas). **Emit the `[redesigner:race]` warn log only when** both conditions hold — (a) delta < 100ms, (b) `tabHandshakes.get(tabId)` returned undefined. The instrumentation is happy-path-silent; only a suspected race produces output. This saves DevTools-console-serialization cost on every warm pick and prevents false positives on normal re-injection (e.g., page navigation re-registers with a fresh `registeredAtPerfNow` — which would spuriously match "cold-register" criteria on the next pick). **Race-suspicion gate must distinguish cold-register (brand new tabId) from re-register (existing tabId re-injecting after SPA nav):** only suspect a race for the cold-register path. A `Set<number>` of "tabIds we've seen register for" is sufficient.
- **Register-arrival timestamp capture (required for the above):** extend `TabHandshake` itself with a `registeredAtEpochMs: number` field, captured via `Date.now()` at the `register` handler's entry. **Use `Date.now()` not `performance.now()`** — `performance.now()` resets to a new time origin on SW wake, so a capture-then-read across a wake event produces negative or huge deltas and triggers the race log spuriously. `Date.now()` is wall-clock and survives SW wakes. Sub-millisecond precision loss is irrelevant for a 100ms race-detection threshold. In-struct over parallel Map: tests only assert one data shape, cleanup (on tab close) already removes the struct, one-fewer data structure to reason about. `persistSelection` reads `hs.registeredAtEpochMs`. Without this capture site, the cold-start race instrumentation is unimplementable.

### Slice B.2: Timeout and ordering

**Per-PUT timeout:** `putSelection` accepts `timeoutMs` via `RestArgs`; `persistSelection` passes `2000`. Breakdown of that 2000ms envelope: <1ms loopback TCP on macOS (typical 0.2-0.5ms), ~1ms `selectionState.apply` (memory write), the rest is slack for SW JIT cold-spin and the occasional daemon GC pause. Dogfood observation should find typical wall-clock <50ms; anything near the 2000ms ceiling indicates a daemon bug or a paused SW, not normal operation. Without this cap, a wedged daemon would block the SW handler on the default 5s timeout and every subsequent user pick queues behind it.

**Note on end-to-end budget:** `persistSelection` also runs `ensureSession` (existing timeout: 5000ms) before the PUT. The 2000ms timeout applies **only to the PUT itself**, not the ensureSession+PUT composite. A cold path where `/exchange` takes near 5s plus a 2s PUT could reach 7s worst case. The Performance Budget (below) reflects observed medians on warm+cold paths, not these theoretical worst cases. Composing a total-budget timeout is deferred (would need `AbortSignal.any(...)` which is forbidden by CLAUDE.md under node#57736; alternatives like a wrapper `setTimeout+racing` add complexity). For v0 the budget is observational, not enforced.

**Ordering across rapid picks (UX footgun — acknowledged Non-Goal):** Chrome dispatches `onMessage` callbacks concurrently. If the user picks A, then B within ~100ms, two `routeMessage` invocations run in parallel. Panel pushes happen in dispatch-receipt order (synchronous), so the panel ends up showing B. PUTs are awaited within each dispatcher but independent across dispatchers. If PUT_A is slow and PUT_B is fast, PUT_B lands at the daemon first; then PUT_A lands and `selectionState.apply` (last-write-wins on arrival) overwrites it. Final state: **panel = B, daemon = A**. An MCP `get_current_selection` call at that moment returns A, disagreeing with what the user sees.

This is real but rare at typical user click rates (<1 Hz). v0 accepts the inconsistency. Stage 2 resolves it properly by adding a client-side monotonically-increasing `pickSeq` in body `meta` plus daemon-side reject-out-of-order semantics. Any v0 bug report about "daemon shows stale selection" should be triaged against this known limitation first. Documented in `packages/ext/CLAUDE.md` under a "Known quirks" heading on landing.

**Unit test required:** `persistSelection.test.ts` includes a case that dispatches two `persistSelection` calls back-to-back where the first stalls until the second resolves. Assertions: (a) both calls resolve without throw, (b) each call emits its own `[redesigner:perf]` log entry with a distinct `pickSeq` value, (c) `elapsedMs` is measured per-call (i.e., the second call's elapsedMs reflects only its own work, not its wait-for-first). This catches a real regression: a future refactor that accidentally serializes PUTs via a module-level lock would make (b) and (c) fail. The test **does not** assert daemon-side ordering correctness — that's Stage 2. Daemon-side seq/last-write mechanics are covered by existing `selectionState.test.ts`.

**Performance instrumentation:** `persistSelection` logs `performance.now()` at entry and after `putSelection` resolves (or catches). Prefix `[redesigner:perf]` for greppability. Log as a JSON-serializable object (second arg to `console.log`) — Chrome DevTools renders it as an expandable tree, much easier to diff during dogfood than comma-separated strings. Fields:

```ts
console.log('[redesigner:perf] persistSelection', {
  tabId,
  pickSeq,       // SW-local monotonic counter, incremented per dispatch
  elapsedMs,
  kind: 'ok' | 'fail',
  cold,          // boolean: true if this dispatch ran ensureSession
})
```

`pickSeq` makes log correlation across concurrent dispatchers trivial (see ordering discussion above). `cold` distinguishes warm vs cold-path entries in the Performance Budget table.

**`pickSeq` seeding:** at module load, seed `pickSeq = Date.now() & 0xFFFFFF` (low 24 bits of millisecond clock). Rationale: the purpose is log-correlation across SW generations, not uniqueness — two SW generations that start in the same millisecond would collide, but in practice they don't. No CSPRNG needed; JS numbers safely represent integers up to 2^53 so no overflow concerns at realistic dispatch counts; no signed-int-coercion cargo-culting. Simpler than `crypto.getRandomValues` and strictly better for the stated requirement.

See **Performance Budget** for how these feed the dogfood acceptance gate.

### Slice C: Handle validation at the boundary

Handled inline in `persistSelection.ts` step 2. The schema validation is intentionally duplicated: once here on `rawHandle`, then again inside `putSelection` when it runs `SelectionPutBodySchema.safeParse` on the wrapped body. The double-parse is accepted v0 waste — even during rapid keyboard-traversal bursts of 5-10 picks/sec, two Zod parses per pick is <1ms of hot-path cost, far below the measurable threshold. The explicit early check ensures we fail closed with a structured log before reaching the rest.ts layer.

The existing panel push in Slice B passes `rawHandle` through without validation; this is unchanged because the panel must render whatever the user picked. Panel-side type hardening is a Stage 2 concern.

### Slice D: MCP roundtrip integration test

New file: `packages/mcp/test/integration/selection-roundtrip.test.ts`.

**Setup strategy:** Use `createDaemonServer` directly (same pattern as `packages/daemon/test/integration/exchange.test.ts`) plus a hand-written handoff file. Do not fork via `child.ts` — that's covered by daemon's own tests and adds 1-3s startup plus teardown complexity. This test's job is MCP↔daemon, not daemon bootstrap.

**Token strategy:** PUT the selection to daemon using the root `authToken` directly (same bearer MCP uses), skipping the `/exchange` flow. The SW→daemon PUT path is exercised in Slice B's unit tests; this integration test's job is the MCP roundtrip, not the SW auth path.

**Project discovery:** MCP walks up from cwd looking for `.redesigner/manifest.json`. The daemon handoff file path is hash-derived from `projectRoot` (see `packages/mcp/src/daemonBackend.ts` `resolveHandoffPath`). Both the fake daemon's handoff write and the MCP `--project` arg must use the same `projectRoot` for discovery to converge.

Structure (pseudocode — Vitest option shapes shown):

```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
// ... plus MCP SDK imports
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Anchor paths to the test file's own location rather than cwd. `pnpm -r test`
// runs from the repo root; `pnpm --filter @redesigner/mcp test` runs from the
// package root. `import.meta.dirname` is resolved at module load — stable.
const DIST_CLI = resolve(import.meta.dirname, '../../dist/cli.js')

describe('mcp selection roundtrip', () => {
  // File-level timeout set via vi.setConfig. Vitest does NOT support
  // describe.timeout(N); use options-object or vi.setConfig.
  //
  // SPAWN/TRANSPORT NOTE: StdioClientTransport can take a `command + args` pair
  // and spawn internally, but that hides the child handle (pid only) and offers
  // no `detached: true` option. Instead, spawn ourselves with `{detached: true}`
  // so we control the process group, then construct the transport from the
  // stdio streams of the child. This gives us `childProc` to `once(childProc, 'exit')`
  // on AND a child pid we can kill via process group.
  let childPid: number | null = null
  let childProc: ReturnType<typeof spawn> | null = null   // hoisted so guards can once(childProc, 'exit')
  let tmpdir: string | null = null

  beforeAll(() => {
    vi.setConfig({ testTimeout: 20_000 })
    // Build prerequisite check: existsSync(DIST_CLI).
    // If missing AND REDESIGNER_MCP_BUILD_IN_TEST === '1', invoke
    // `child_process.spawnSync('pnpm', ['--filter', '@redesigner/mcp', 'build'])`
    // (never use exec with string interpolation). Otherwise leave it for ctx.skip().
  })

  // Dual cleanup: `exit` is the actual safety net (fires on worker-crash, vitest
  // SIGTERM, and graceful idle), while `beforeExit` runs earlier on clean idle
  // exits so async-friendly cleanup can still happen. `exit` is sync-only —
  // only synchronous kill signals allowed. vitest-dev/vitest#3077 documents
  // that tinypool force-termination does NOT fire beforeExit reliably.
  //
  // PID-reuse guard: `finally` already reaps the child and nulls childPid; the
  // guards are last-chance. Before sending SIGKILL, probe `process.kill(-pid, 0)`
  // (signal 0 is "test, don't deliver"). If that throws ESRCH, the child is
  // already gone — and worse, that pid may have been reassigned to an unrelated
  // process by the OS. Never signal a pid we aren't sure is still ours.
  const killGuard = () => {
    if (childPid === null) return
    try {
      process.kill(-childPid, 0)   // liveness probe; throws ESRCH if reaped
      process.kill(-childPid, 'SIGKILL')
    } catch {
      /* ESRCH — child already reaped by SDK close or finally block. Skip. */
    }
    childPid = null
  }
  beforeAll(() => {
    process.on('beforeExit', killGuard)
    process.on('exit', killGuard)
  })
  afterAll(() => {
    process.off('beforeExit', killGuard)
    process.off('exit', killGuard)
  })

  // Per-test timeout wins; vi.setConfig is a no-op here but remains as a
  // default for any future tests added to this file.
  test('get_current_selection returns handle written via daemon PUT',
    { timeout: 20_000 },
    async (ctx) => {
      if (!existsSync(DIST_CLI)) {
        ctx.skip('run pnpm --filter @redesigner/mcp build first, ' +
                 'or set REDESIGNER_MCP_BUILD_IN_TEST=1')
      }
      try {
        // 1. mkdtemp a fake projectRoot with package.json + .redesigner/manifest.json
        //    (stub manifest includes the component we'll select, staleManifest=false).
        // 2. Start createDaemonServer on ephemeral port with a fresh authToken.
        // 3. Write the handoff file at the hash-derived path (match resolveHandoffPath)
        //    with {serverVersion, pid, host, port, token, projectRoot, instanceId}.
        // 4. PUT {nodes:[handle]} to /tabs/1/selection with Bearer authToken.
        // 5. Spawn packages/mcp/dist/cli.js OURSELVES (not via StdioClientTransport's
        //    internal spawn helper — that offers no `detached` option and hides
        //    the child handle). Pseudocode:
        //      childProc = spawn('node', [DIST_CLI, '--project', tmpdir],
        //                         { detached: true, stdio: ['pipe','pipe','inherit'] })
        //      childPid = childProc.pid ?? null
        //      const transport = new StdioClientTransport({
        //        input: childProc.stdout!, output: childProc.stdin!
        //      })
        //      client = new Client({...}); await client.connect(transport)
        //    Both childProc AND childPid are populated so the finally block
        //    can `once(childProc, 'exit')` and the guards can `process.kill(-childPid, ...)`.
        // 6. Call tool get_current_selection; parse; assert id/componentName/filePath.
        // 7. Call list_recent_selections {n:10}; assert array has ≥1 matching entry.
        //    Note: collect both assertions into a single assert block (softAssert
        //    style) so a get_current_selection failure doesn't mask
        //    list_recent_selections output — both results are useful for debug.
      } finally {
        // SDK close sends SIGTERM. Then wait briefly for the child to actually
        // exit — this reaps the pid within our process tree and avoids PID-reuse
        // hazard in the exit guards. 1s ceiling; if it doesn't exit by then,
        // force-kill and null out.
        try { await client?.close() } catch { /* SIGTERM via SDK, may fail silently */ }
        if (childPid !== null && childProc) {
          const reaped = await Promise.race([
            once(childProc, 'exit').then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
          ])
          if (!reaped) {
            try { process.kill(-childPid, 'SIGKILL') } catch { /* ESRCH ok */ }
          }
          childPid = null   // null BEFORE guard listeners can re-fire
        }
        try { daemon?.close() } catch { /* ignore */ }
        if (tmpdir) await rm(tmpdir, { recursive: true, force: true })
      }
    })
})
```

**Build prerequisite:** `@redesigner/mcp` must have a built artifact at `packages/mcp/dist/cli.js` **before** the test runs. The test **does not** shell out to build inside `beforeAll` by default — that couples the test to the build pipeline, slows the inner loop by 3-5s on every run, and invites worker contention on `dist/`.

Instead:
- `beforeAll` checks `fs.existsSync('packages/mcp/dist/cli.js')`. If missing, the test calls `ctx.skip()` with message pointing at `pnpm --filter @redesigner/mcp build` or `REDESIGNER_MCP_BUILD_IN_TEST=1`.
- Opt-in escape hatch: if `process.env.REDESIGNER_MCP_BUILD_IN_TEST === '1'`, run the build in `beforeAll` (via `child_process.spawnSync` with argv array — never `exec` with a string).
- CI contract: CI pipeline must run `pnpm -r build` before `pnpm -r test`. Document in `packages/mcp/CLAUDE.md` as part of landing this slice.

**Process cleanup contract:**

`StdioClientTransport#close()` in `@modelcontextprotocol/sdk@1.29.0` only sends `SIGTERM` without escalating to `SIGKILL` or reaping the process group (upstream issue #579). A test abort mid-stdio-handshake will leak the mcp child. Rules:

1. Spawn with `{ detached: true }` so the child owns a process group; capture pid into a file-level `childPid` variable.
2. Wrap the test body in `try/finally`. In `finally`: SDK `close()` (SIGTERM), then `process.kill(-childPid, 'SIGKILL')` wrapped in try/catch (swallow `ESRCH` from already-reaped pid), then set `childPid = null` BEFORE the guard handlers can re-fire.
3. Register **both** `exit` AND `beforeExit` listeners at file-level `beforeAll` (NOT inside the test body — prevents listener accumulation). Remove both in `afterAll`. Each listener checks `childPid !== null` and wraps the signal in try/catch to swallow `ESRCH`. The dual registration is load-bearing: `beforeExit` fires on graceful idle exits (allowing last-chance async work, though we don't use that capability here), but does **not** fire under Vitest tinypool force-termination (vitest#3077), uncaught fatal errors, or `SIGTERM` from CI timeout. `exit` fires in all those cases, but is synchronous-only — no awaitable cleanup. Using both covers all paths.

The `detached: true` spawn is **load-bearing** — without it, `process.kill(-pid, ...)` has no process group to target.

**Test file metadata:**
- Timeout: 20_000ms at both file (`vi.setConfig({ testTimeout: 20_000 })`) and test (`{ timeout: 20_000 }` options) levels. 15s is too tight given SIGTERM-only close path; teardown SIGKILL fallback adds up to 2s on slow runners. Slow-CI escape hatch: `REDESIGNER_CI_SLOW=1` widens timeout only (not the performance budget) to 40_000ms.
- Single `describe` block with one `test` — intentionally monolithic (one daemon spawn, N assertions) to avoid per-assertion spawn cost.
- Dependency: `@modelcontextprotocol/sdk/client/stdio` (in the SDK version pinned).

**Vitest API note:** Use the options-object form `test('name', { timeout: N }, async () => {...})` and `vi.setConfig({ testTimeout: N })`. `describe.timeout(N)` and `test.concurrent.for(...).extend(...)` are **not** valid Vitest config shapes — an earlier draft used these; corrected here.

### Slice E: Drop `clientId` from `SelectionPutBodySchema`

The current `SelectionPutBodySchema` requires `clientId: z.string().regex(UUID_V4_RE, ...)`. The daemon accepts it, validates it, and discards it (grep-confirmed: no reader in `packages/daemon/src`). Keeping it required-looking while semantically dead is the worst of both worlds.

**Change:** In `packages/core/src/schemas/selection.ts`, make `clientId` optional:

```ts
export const SelectionPutBodySchema = z
  .object({
    nodes: z.array(ComponentHandleSchema).min(1).max(1),
    clientId: z.string().regex(UUID_V4_RE, '...').optional(),
    meta: z.object({
      source: z.enum(['picker']),   // enum, not free-form — keeps dogfood logs triageable
    }).catchall(z.unknown()).optional(),   // catchall for Stage 2 additive fields (e.g. pickSeq)
  })
  .strict()
```

`meta.source` is constrained to an enum (v0: just `'picker'`) so we don't end up with `'picker-v2'` vs `'pickerv2'` in production logs. Enum grows by adding new values in a minor bump; `catchall(z.unknown())` lets Stage 2 slip `pickSeq` or similar into `meta` without a schema bump.

**Compatibility tests (required — must land with this slice):**

Add to `packages/core/test/schemas/selection.test.ts` (create if missing):

- Body WITH `clientId` (UUIDv4) validates, PUT integration roundtrip succeeds.
- Body WITHOUT `clientId` validates, PUT integration roundtrip succeeds.
- Body WITH `clientId` AND a foreign field (`{..., foo: 1}`) is rejected by `.strict()` — assert `safeParse(...).success === false` AND `parsed.error.issues[0].code === 'unrecognized_keys'` (pinning the error code guards against a future Zod major silently changing the code; ties into the `.zod-version` sentinel).
- Body with `clientId` present but malformed (not UUIDv4) is rejected.

These guard against a future refactor silently dropping `.strict()` or changing dedup semantics.

**Daemon integration test update:** `packages/daemon/test/integration/selection.test.ts` (or equivalent) gets two cases added — PUT with and without `clientId`, both returning 200. The existing test with `clientId` stays unchanged.

**Rationale:** YAGNI. The original body-field location was never a correct home for idempotency; per IETF `Idempotency-Key` header work (settled practice in HTTP API design), the canonical location is a **request header**. This rationale holds regardless of IETF draft revision state because the *location* argument is settled; only the exact header semantics are in flight.

**Forward commitment:** When idempotency lands (Stage 3 or later), the canonical contract is an `Idempotency-Key` request header on this route. Whether the body `clientId` is removed at that point is a decision Stage 3's spec should make with then-current migration cost in mind — not pre-committed here.

**Parity check:** Update `packages/core/test/schemas-parity.test.ts` if it asserts `clientId` is required. Update `packages/ext/test/contract/goldens.test.ts` if it pins the JSON Schema shape (the `.zod-version` CI guard expects goldens to match).

### Slice E.1: Forward-evolvable response + meta schemas

Two small follow-on changes to `packages/core/src/schemas/selection.ts` that buy Stage 2 headroom without affecting Stage 1 behavior:

1. **`SelectionPutResponseSchema`: `.strict()` → `.catchall(z.unknown())`.** Stage 2 will add fields (e.g., server-echoed `pickSeq`, or observability fields). Declaring them strict at the response locks us into a coordinated client+server upgrade on every field add. Response schemas should **always** be forward-compatible; request schemas stay `.strict()` (reject typos). Note on API choice: use `.catchall(z.unknown())` rather than `.passthrough()` — the latter is deprecated in Zod v4 per the migration guide; `.catchall()` is the idiomatic replacement and preserves the same "unknown keys allowed" behavior. Add a test: `{ selectionSeq: 1, acceptedAt: 1, futureField: 'x' }` validates, known fields parse correctly, AND `parsed.futureField === 'x'` (the value is preserved, not stripped — distinguishes catchall from strip at assertion level).

**Assertion audit list** (must run before landing Slice E.1): grep for `SelectionPutResponseSchema|selectionSeq.*acceptedAt` across the repo. Audit each hit for tests that assume unknown keys fail parse. Known hits to check: `packages/ext/test/sw/rest.test.ts`, `packages/daemon/test/integration/selection.test.ts`, `packages/core/test/schemas/selection.test.ts`. No existing test should assert that an extra response key causes parse failure — if any does, update it to assert the catchall semantics instead.

2. **`meta` on `SelectionPutBodySchema`: `.strict()` → `.catchall(z.unknown())`.** Stage 2 plans add `meta.pickSeq` for ordering. Retaining `.strict()` on the inner `meta` object means every new meta key requires a coordinated schema bump. `catchall(z.unknown())` keeps foreign-key rejection off the inner while the outer `.strict()` still rejects unknown top-level fields. Add a test: `{ nodes: [...], meta: { source: 'picker', pickSeq: 5 } }` validates.

**Rationale:** The top-level request body stays `.strict()` (reject typos in consumer code); only `meta` and the response loosen. This is the standard "be conservative in what you send, liberal in what you accept" asymmetry. Without this, every Stage 2 schema tweak is a breaking change and Stage 2 spec work stalls waiting for a coordinated version bump.

### Slice F: Chrome extension ID regex correctness fix

The daemon currently uses `/^[a-z]{32}$/` (or `/^chrome-extension:\/\/([a-z]{32})$/` for origins) in 6 code sites, plus 2 test files. Legitimate Chrome extension IDs use **only** the letters a-p (SHA-256 hex 0-9a-f remapped to a-p), so `[a-z]` over-permits: IDs containing q-z would pass the shape check while never matching any TOFU-pinned session.

**Real-world security impact: zero** — because `isSessionActive(extId, token)` does strict equality against the pinned extId, a forged q-z-containing header can never match a session. But the regex lies about what constitutes a valid ext ID and invites confused downstream consumers (future API clients, docs, admission logic). The wire contract in Slice A documents `[a-p]{32}`; the daemon must match.

**Change:** rename `EXT_ID_REGEX` constants to use `/^[a-p]{32}$/` and `/^chrome-extension:\/\/([a-p]{32})$/`. Sites:

- `packages/daemon/src/routes/exchange.ts:58,62` — `EXT_ID_REGEX`, `CHROME_EXT_ORIGIN_REGEX`
- `packages/daemon/src/routes/revalidate.ts:55,56` — `EXT_ID_REGEX`, `ORIGIN_REGEX`
- `packages/daemon/src/routes/cors.ts:24` — inline regex
- `packages/daemon/src/server.ts:197` — inline extId validator
- `packages/vite/src/bootstrap.ts:68` — `CHROME_EXT_ORIGIN_RE`
- `packages/daemon/test/closeCodes.test.ts:681` — test helper regex
- `packages/ext/test/e2e/nightly/exchange-live.spec.ts:38-40` — doc comment + `TEST_EXT_ORIGIN` constant on line 40

**Test:** add a daemon-side regression in `exchange.test.ts`:
- `Origin: chrome-extension://abcdefghijklmnopqrstuvwxyz123456` (contains q-z) → 403 (was 200-shape-check + downstream 401).
- `Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop` (all a-p) → passes shape check.

**Scope note:** the daemon nightly e2e test `packages/ext/test/e2e/nightly/exchange-live.spec.ts:40` uses `TEST_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef'`. The characters q-v in that string now fail the shape check. The fix replaces it with a valid a-p ID (e.g., `'chrome-extension://abcdefghijklmnopabcdefghijklmnop'`). The test helper `EXT_ID_A` in closeCodes.test.ts must be similarly audited.

**401 vs 403 disambiguation:** Slice A's wire contract documents **401** for extId mismatch (post-auth: "we understood your token but you're not authorized to impersonate this extId"). Slice F's new regression test asserts **403** for malformed-origin rejection (pre-auth: "your origin shape isn't even a valid ext ID so we're rejecting at the CORS layer before touching session state"). Both are by design; readers seeing different status codes across the two tests should understand they represent different stages of auth evaluation.

### File layout

```
packages/core/src/schemas/selection.ts   [MODIFY]  clientId .optional();
                                                   SelectionPutResponseSchema .strict() → .catchall(z.unknown());
                                                   meta inner schema .strict() → .catchall(z.unknown())
packages/core/src/schemas/errors.ts      [CREATE]   401/403 reason-code unions (extid-mismatch,
                                                   token-unknown, token-tofu-fail, malformed-origin)
packages/core/test/schemas/selection.test.ts
                                         [CREATE-OR-MODIFY]  with/without clientId + foreign-field rejection
packages/daemon/src/routes/exchange.ts   [MODIFY]  EXT_ID_REGEX [a-p], CHROME_EXT_ORIGIN_REGEX [a-p]
packages/daemon/src/routes/revalidate.ts [MODIFY]  EXT_ID_REGEX [a-p], ORIGIN_REGEX [a-p]
packages/daemon/src/routes/cors.ts       [MODIFY]  inline origin regex [a-p]
packages/daemon/src/server.ts            [MODIFY]  inline extId validator [a-p]
packages/daemon/test/closeCodes.test.ts  [MODIFY]  regex + EXT_ID_A fixtures to a-p
packages/daemon/test/integration/exchange.test.ts
                                         [MODIFY]  add q-z-Origin rejection test
packages/daemon/test/integration/selection.test.ts
                                         [CREATE-OR-MODIFY]  clientId optional round-trip cases
packages/vite/src/bootstrap.ts           [MODIFY]  CHROME_EXT_ORIGIN_RE [a-p]
packages/ext/src/sw/rest.ts              [MODIFY]  extId?: string on RestArgs + makeJsonHeaders
                                                   + per-call timeoutMs threading for putSelection
packages/ext/src/sw/messageRouter.ts     [MODIFY]  await persistSelection inside async routeMessage;
                                                   wrap panelPort.push in try/catch;
                                                   wrap sendResponse in try/catch;
                                                   build deps with extId: chrome.runtime.id;
                                                   stamp tabHandshakes entries with
                                                   registeredAtPerfNow for cold-start race logging
packages/ext/src/sw/persistSelection.ts  [CREATE]  helper (validate → ensureSession → PUT);
                                                   extId injected via deps; perf-instrumented logs
packages/ext/src/sw/index.ts             [MODIFY]  pass extId: chrome.runtime.id into deps
packages/ext/test/sw/rest.test.ts        [MODIFY]  X-Redesigner-Ext-Id header assertion
                                                   + absence-of-header when extId omitted
                                                   + timeoutMs wiring assertion
packages/ext/test/sw/persistSelection.test.ts
                                         [CREATE]  covers: handshake missing, schema mismatch,
                                                   ensureSession throws caught, putSelection throws caught,
                                                   happy path, panel-push-throw doesn't block PUT,
                                                   back-to-back concurrent PUTs both resolve,
                                                   no unhandled promise rejections across all paths,
                                                   auth-edge (daemon 401 on PUT) logs-and-returns
packages/ext/test/sw/messageRouter.test.ts
                                         [CREATE-OR-MODIFY]  assert handler awaits persistSelection
                                                   before sendResponse; sendResponse called once;
                                                   register handler stamps registeredAtPerfNow
packages/ext/test/sw/index-listener.test.ts
                                         [CREATE]  static/source guard: onMessage addListener
                                                   receives non-async fn with synchronous return true
packages/ext/test/e2e/nightly/exchange-live.spec.ts
                                         [MODIFY]  TEST_EXT_ORIGIN to all-a-p value
packages/mcp/test/integration/selection-roundtrip.test.ts
                                         [CREATE]  MCP end-to-end integration test
packages/mcp/CLAUDE.md                   [MODIFY]  document prebuild-before-test contract +
                                                   REDESIGNER_MCP_BUILD_IN_TEST escape hatch
packages/mcp/tsconfig.json               [VERIFY]  integration tests compile
packages/ext/scripts/dogfood-perf.ts     [CREATE]  read [redesigner:perf] JSON lines from stdin
                                                   (or chrome.storage.session dump), compute
                                                   median/max/p95/"at-most-K-of-N", exit non-zero
                                                   on budget breach
packages/ext/test/fixtures/dogfood-perf-sample.log
                                         [CREATE]  synthetic 20 cold + 30 warm entries matching
                                                   budget; consumed by CI gate on every PR
packages/ext/package.json                [MODIFY]  add `dogfood:perf` npm script
packages/daemon/src/routes/selection.ts  [VERIFY]  confirm route returns
                                                   {selectionSeq, acceptedAt}; add integration
                                                   test pinning it if absent
```

## Data Flow (Stage 1 complete)

```
[user click in page]
      │
      ▼
[content script picker] ─── {type:'selection', handle} ───▶ [SW: non-async listener, returns true]
                                                                   │
                                                                   ▼
                                                       [async routeMessage]
                                │                                  │
                                ▼                                  ▼
                    panelPort.push(selection:h)       await persistSelection(h)
                    (sync, try/catch)                            │
                                │                                  │
                                ▼                                  ▼
                          [side panel]              PUT /tabs/1/selection (2s timeout)
                                                                   │
                                                                   ▼
                                                       [daemon selectionState
                                                        — monotonic seq, last-write-wins]
                                                                   │
                                                                   ▼
                                                       GET /selection ◀── [mcp stdio]
                                                                   │
                                                                   ▼
                                                       Claude Code gets ComponentHandle
```

## Performance Budget

Locked targets for Stage 1 — regressions fail the dogfood acceptance gate. Measured via `[redesigner:perf]` log entries from Slice B.2 instrumentation; dogfood runs capture N=5 picks per scenario and report median + max.

| Hop | Budget (median) | Ceiling | Methodology |
|---|---|---|---|
| pick → panel render | < 16 ms (one frame) | — | Already met by synchronous `panelPort.push`. Visual verification only. |
| pick → daemon has selection (warm SW, session cached) | median < 150 ms | max < 500 ms (all N samples); reported p95 for regression tracking | `[redesigner:perf] persistSelection elapsedMs` + `cold:false`; **N=30** picks. The gate is median + max (both statistically stable at N=30); p95 is reported in the script output for regression tracking but is NOT a hard gate, because p95 at N=30 has a wide confidence interval (±one-third of true value). If dogfood grows to N=60+ in later stages, promote p95 to a gate. |
| pick → daemon has selection (cold SW, `/exchange` required) | median < 1200 ms | at-most-2-of-20 exceed 3000 ms | `cold:true` entries; **N=20** picks across SW wakes. "at-most-2-of-20" = 10% failure tolerance with better outlier-estimation stability than "at-most-1-of-10" at the same tolerance level. Hard theoretical ceiling is ensureSession 5000 + PUT 2000 = 7000 ms, but Chrome's SW 30s fetch-header rule is the actual physical ceiling if the daemon stalls while writing bytes slowly (bypasses AbortSignal). **Enforcement:** dogfood is not vibes-check. Add `pnpm --filter @redesigner/ext run dogfood:perf` (new npm script, backed by `packages/ext/scripts/dogfood-perf.ts`) that reads `[redesigner:perf]` JSON log lines **from stdin** (or a file path arg), computes median / p95 / max / "at-most-K-of-N exceed X" against the table above, and exits non-zero on breach.

**Capture path — `chrome.storage.session` is the load-bearing option** (inverted from the prior draft). Rationale: the cold-path dogfood loop involves triggering 20 SW stops via `chrome://serviceworker-internals`. Each SW stop wipes in-memory DevTools console state UNLESS the operator keeps a SW DevTools window attached through every stop — easy to forget, impossible to recover from. `chrome.storage.session` persists across SW generations within the same browser session, so the log entries survive the test methodology.

1. `persistSelection` writes each perf entry to `chrome.storage.session.get/set` under key `__redesigner_perfLog` (append to an array, trim to last 200 entries to bound memory) AND `console.log`s for live visibility.
2. After dogfood run, operator dumps the key via DevTools Application → Storage → Session Storage → copies the JSON array.
3. `pnpm --filter @redesigner/ext run dogfood:perf < dump.json` — script computes median/max/"at-most-K-of-N" against the budget and exits non-zero on breach.

**Console-only fallback** (if storage.session access is somehow blocked): `cat perf.log | grep '\[redesigner:perf\]' | pnpm --filter @redesigner/ext run dogfood:perf` — script extracts the JSON-object second arg from each DevTools-saved line. Requires DevTools to remain attached across all SW stops.

**CI-gate fixture:** commit `packages/ext/test/fixtures/dogfood-perf-sample.log` (20 cold + 30 warm synthetic entries matching budget) so the CI gate runs `dogfood:perf` against the fixture on every PR. Without a committed fixture, the script runs only on human-triggered dogfood and regressions sneak past CI.

Without this script the budget is documentation; with it, it's a gate.

**Operational definition of "cold":** fresh SW generation with no `tabSessions` entry for this tabId. Typical triggers: post-daemon-restart, first pick post-browser-launch. Note that an open daemon WS connection resets the SW idle timer, so "same-SW-generation plus healthy WS" is always **warm** — the daemon's WS broadcast activity keeps the session cache alive longer than SW lifetime alone would suggest. **Dogfood methodology for triggering 10 cold wakes:** use `chrome://serviceworker-internals/` → locate the redesigner SW → click Stop between each pick. Do NOT rely on idle-wait (30s+ between picks is both unreliable and 10× too slow for a dogfood loop). Do NOT use `chrome.runtime.reload()` — that changes ext state more broadly. The p95 budget is observational; the hard ceiling is what the composed timeouts physically guarantee. Regressions fail the gate if p95 breaches 3000ms even when the hard ceiling holds — the gate protects UX, not just correctness. |
| `get_current_selection` via MCP (daemon warm) | < 50 ms | 200 ms | Instrumented in integration test: time from tool-call send to response parse. |
| Integration test file total wall-clock (local dev) | < 8 s | 10 s | `pnpm --filter @redesigner/mcp test selection-roundtrip` wall-clock. 6s was too tight once teardown SIGKILL fallback (up to 2s) is accounted for. Test emits `[redesigner:perf:test]` entries at post-spawn, post-initialize, and post-tool-call so a regression in any one component is visible in the log rather than buried in the aggregate. |
| Integration test file total wall-clock (CI, `REDESIGNER_CI_SLOW=1`) | typical < 15 s (single run, not measured as median) | 40 s | CI timer; relaxed bound only — the perf budget rows above are NOT relaxed. CI runs the test once per job; no distribution to measure. |

Redundant Zod parses on the SW hot path (once in `persistSelection`, again in `putSelection`) are accepted v0 waste. Honest cost: Zod v4 steady-state `safeParse` on small object schemas is ~125µs p50 / ~230µs p99 per published benchmarks (deepwiki.com/colinhacks/zod). `SelectionPutBodySchema` is nested (wraps `ComponentHandleSchema` in an array) so each parse lands ~125-250µs. First call per module load may be 1-2× steady-state as V8 optimizes. **Per-pick hot-path cost:** up to 0.5ms added (two parses × ~250µs). Under keyboard-traversal bursts (5-10 picks/sec) this aggregates to at most 5ms/sec of Zod — imperceptible. Any dogfood reading showing >5ms Zod spike on a single pick is a real regression worth investigating. **Stage 2 candidate:** add `alreadyValidated: true` arg to `putSelection` so the inner parse can skip when the caller has already validated upstream; not worth the API-surface cost at Stage 1.

**Alternative considered:** `fetch(url, { keepalive: true })` inside `persistSelection` without awaiting would let the PUT survive SW termination, removing the need to await in `routeMessage`. Rejected for v0 because: (a) Chrome MV3 `keepalive` has documented edge cases with `Authorization` header (request may be downgraded), (b) keepalive caps request body at 64KB (fine for selection, but sets a ceiling that would bite Stage 2 DOM subtree), (c) awaiting is simpler and the observed pick→daemon latency is well within budget, (d) `keepalive: true` requests are fire-and-forget with no error-surfacing path — the "log on PUT fail" behavior that `persistSelection` currently provides would be impossible; browsers don't retry keepalive requests and the caller never sees the outcome. Revisit in Stage 2 if DOM-harvest PUT latency becomes a bottleneck.

**Alternative considered:** `AbortSignal.any([ensureSessionTimeout, putTimeout])` or a composite `AbortController` wrapping the whole `persistSelection` sequence to enforce a true end-to-end ceiling. Rejected because CLAUDE.md explicitly forbids `AbortSignal.any` (node#57736 — same EventTarget leak class as `new AbortController + setTimeout`), and alternatives (a userland `setTimeout` that calls `controller.abort()`, a racing `Promise.race([work, timeoutPromise])` that leaves the fetch running) all either reintroduce the leak or leave zombies. The two component timeouts (ensureSession 5s, PUT 2s) give a composed 7s ceiling that is measured by the `elapsedMs` field; the dogfood gate enforces the observed p95 rather than the physical ceiling. Revisit when Node ships a safe compositional abort primitive.

## Testing Strategy

- **Unit (modify):** `packages/ext/test/sw/rest.test.ts` — (i) header is sent when `extId` supplied; (ii) header is not sent when `extId` omitted; (iii) `timeoutMs` threads through to `AbortSignal.timeout`.
- **Unit (create):** `packages/ext/test/sw/persistSelection.test.ts` — covers: handshake-missing bail, schema-mismatch bail, `ensureSession` throw caught, `putSelection` throw caught, happy-path PUT shape, panelPort-push-throw does not block PUT, back-to-back dispatchers both resolve (Slice B.2 ordering), no unhandled-promise-rejection across all failure modes, daemon-401 on PUT logs-and-returns (auth-edge), **total-function fuzz** (throw from each internal callsite — `tabHandshakes.get` replaced with a throwing proxy, `safeParse` throwing, `ensureSession` throwing non-Error values like strings/undefined, `putSelection` throwing — asserting `await persistSelection(...)` resolves in every case AND that each thrown branch produces a `console.warn` call whose first argument starts with the literal prefix `[redesigner:sw]` AND whose second argument (structured payload) includes a `tabId` field). This pins log-format stability so dogfood grep-based triage doesn't silently break on a future refactor. **Schema-divergence gate** (`ComponentHandleSchema.safeParse(x).success ⇒ SelectionPutBodySchema.safeParse({nodes:[x]}).success` as a property assertion over a small generated set — also serves as the concrete mitigation for Risk #4 "Handle validation divergence," replacing the previous spot-check-only posture).
- **Unit (create-or-modify):** `packages/ext/test/sw/messageRouter.test.ts` — asserts `selection` handler `await`s `persistSelection` before calling `sendResponse`; asserts `sendResponse` is called exactly once; asserts a throwing `panelPort.push` does not suppress the PUT path; asserts `register` handler stamps `registeredAtPerfNow` for cold-start race instrumentation.
- **Unit (create):** `packages/ext/test/sw/index-listener.test.ts` — a lightweight source guard over `packages/ext/src/sw/index.ts` modeled on `packages/ext/test/integration/hydrate.test.ts`. Concrete regex: read the file as text, assert the substring `chrome.runtime.onMessage.addListener(` is present AND that within the 30 source lines following it the literal `return true` appears AND the addListener callback signature does NOT start with `async` (`/chrome\.runtime\.onMessage\.addListener\(\s*async/` must NOT match). Proportionate: catches the "someone cleaned up the .then/.catch" refactor that would break MV3 message routing.
- **Integration (existing, modify):** `packages/daemon/test/integration/exchange.test.ts` — already covers PUT /tabs/:tabId/selection with session bearer; add q-z-Origin rejection case (Slice F).
- **Integration (create-or-modify):** `packages/daemon/test/integration/selection.test.ts` — `clientId` optional roundtrip cases (Slice E).
- **Integration (new):** `packages/mcp/test/integration/selection-roundtrip.test.ts` — Slice D.
- **Schema (create-or-modify):** `packages/core/test/schemas/selection.test.ts` — with/without clientId, foreign-field `.strict()` rejection, malformed clientId rejection (Slice E).
- **Manual dogfood:** Run playground, pick PricingCard, run `redesigner-mcp` binary in a separate shell pointed at the same handoff file, call `get_current_selection` via JSON-RPC over stdio, see the handle. Collect `[redesigner:perf]` logs and verify Performance Budget medians.

## Risks

1. **`StdioClientTransport` close-only-SIGTERM (SDK issue #579)** — addressed by Slice D process-cleanup contract (detached spawn, process-group SIGKILL, `beforeExit` guard with `ESRCH` swallow + null-out).
2. **In-test build coupling** — deliberately not done; enforced via `existsSync` + `ctx.skip`, CI pipeline orders `pnpm -r build` before `pnpm -r test`, opt-in `REDESIGNER_MCP_BUILD_IN_TEST=1` (argv-array spawn only, never string `exec`).
3. **rest.ts under node vitest** — keeps chrome-free by passing `extId` via `RestArgs`; `persistSelection.ts` is likewise chrome-decoupled (extId via deps).
4. **Handle validation divergence** — `ComponentHandleSchema` may reject handles the content script produces. Mitigated by (a) structured logging on mismatch, (b) the schema-divergence property test in `persistSelection.test.ts` that pins `ComponentHandleSchema.safeParse(x).success ⇒ SelectionPutBodySchema.safeParse({nodes:[x]}).success` over a generated set. The property test replaces the spot-check-only posture used in earlier drafts.
5. **TOFU pin on reloaded unpacked ext** — `packages/ext/manifest.json` `key` stabilizes `chrome.runtime.id`. Auth-edge unit test documents this explicitly.
6. **SW termination mid-PUT** — addressed by Slice B's await-inside-dispatcher pattern. The outer listener still returns `true` synchronously; the dispatcher's await keeps the port open through the fetch.
7. **Extension context invalidated during selection** — `panelPort.push` wrapped in try/catch; a thrown panel push does not prevent the PUT.
8. **Panel↔daemon ordering inversion under rapid concurrent picks** — documented in Slice B.2 and as Non-Goal. Panel reflects dispatch order; daemon reflects network arrival order. Under rapid A→B picks, if PUT_A arrives after PUT_B, the daemon's "last-apply-wins" `selectionState.apply` settles on A while the panel shows B. Rare at typical click rates; triage-first for any "stale daemon selection" bug report. Stage 2 adds `pickSeq` + reject-out-of-order to close the gap. No ordering test in Stage 1 — the unit test asserts both dispatchers resolve, not that the daemon settles on B.
9. **Regex over-permissiveness [a-z] vs [a-p]** — fixed in Slice F. Security impact was zero (TOFU pin is the actual enforcement), correctness was wrong.
10. **PID reuse in test-cleanup guards** — `exit` / `beforeExit` guards reference a captured pid that may be reassigned after the child exits. Slice D mitigates via `finally`-block reap (wait-for-exit with 1s ceiling) + liveness probe (`process.kill(-pid, 0)`) before SIGKILL + null-out of `childPid` as soon as we know the child is reaped. Without this, a long-running vitest worker could send SIGKILL to an unrelated process.

## Open Questions

None remaining.

## Rollout

1. Land on a new branch off main **after** `fix/daemon-vite-token-sync` (PR #18) is merged.
2. PR title: `feat(ext+core+daemon+mcp): persist selection SW→daemon→MCP end-to-end`.
3. **CI-gate step:** all seven slices' tests green, including the new `dogfood:perf` fixture assertion against a committed sample log. This merges without requiring a live browser.
4. **Dogfood-verification step (separate commit, can iterate):** run the playground, capture live `[redesigner:perf]` logs, feed through `pnpm --filter @redesigner/ext run dogfood:perf`, verify medians and at-most-1-of-10 gates hold against the Performance Budget. If numbers drift, iterate on instrumentation without rebasing the merged work.

Splitting the CI-gate from the live-dogfood gate lets the branch land cleanly on green tests; dogfood validation is a follow-on commit on main (or a follow-on PR if tuning is needed).

## Success Criteria

- `pnpm -r run build && pnpm -r run test` green.
- `pnpm --filter @redesigner/mcp test` includes `selection-roundtrip` and it passes within the 20s file-level timeout.
- Manual dogfood: pick a component in playground → run `get_current_selection` via a spawned MCP stdio client → see the matching handle within the cold-SW performance budget (median <1200ms, at-most-2-of-20 exceed 3000ms) — numbers match the Performance Budget table exactly.
- No regressions in daemon/exchange/vite/ext test suites.
- `packages/mcp/CLAUDE.md` documents the prebuild-before-test contract.
- Slice F regex fix is green across daemon, vite, and ext test suites with the a-p alphabet enforced.
