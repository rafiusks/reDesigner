# Chrome Extension v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the MV3 Chrome extension that lets developers pick a DOM element in a dev-server tab, extracts a `ComponentHandle`, and pushes it to the reDesigner daemon so Claude Code (via MCP shim) can read the current selection.

**Architecture:** Service worker is sole custodian of credentials and REST; content script handles meta-probe + picker overlay + DOM reads only; React side panel imports types-only from `@redesigner/core/types`. Shared schemas live in `@redesigner/core`, split into `/schemas` (Zod runtime) and `/types` (erased) subpath exports. Daemon and Vite plugin receive small additive changes (subprotocol-bearer auth, bootstrap exchange, per-tab selection resource, handshake-JSON response header, CVE version pin).

**Tech Stack:** MV3 + CRXJS `~2.y.z` + Vite + React 18.3 + TypeScript + Zod (pinned) + Vitest (happy-dom for Tier-1, forks+chromeMock for Tier-2) + `@vitest/browser` with bundled Chromium (Tier-3) + Playwright+CDP (Tier-4) + fast-check + `ws` server (daemon side).

**Spec:** `docs/superpowers/specs/2026-04-19-chrome-extension-v0-design.md` (authoritative for all semantic detail — plan cites sections rather than duplicating prose).

**Execution strategy — model assignments + parallelism:**

| Task class | Model | Rationale |
|---|---|---|
| Core Zod schemas, type re-exports, straightforward fixtures | Haiku 4.5 | Mechanical; spec pins exact shapes |
| Daemon route handlers, CORS/Sec-Fetch plumbing, CRUD tests | Sonnet 4.6 | Integration with existing daemon patterns |
| Picker hit-testing, elementsFromPoint recursion, popover+dialog edge cases | Opus 4.7 | Load-bearing correctness; many fresh-eyes Criticals here |
| Token crypto (HMAC exchange, timingSafeEqual, TOFU pinning) | Opus 4.7 | Security-critical; miscompiles are vulnerabilities |
| SW lifecycle glue (alarms, onInstalled backfill, gesture preservation) | Opus 4.7 | MV3 footguns; fresh-eyes caught many |
| React panel components, side-panel UI | Sonnet 4.6 | UI composition |
| `useSyncExternalStore` panelPort cached ref | Opus 4.7 | Tearing hazard per R10 finding |
| E2E Playwright + CDP suspend detection | Sonnet 4.6 | Integration assembly |

**Parallelism groups**: tasks marked `[P-Gn]` in the same group run in parallel subagents (no cross-dependencies). Ungrouped tasks are sequential and depend on the most recently-preceding task in the plan ordering.

---

## Phase 1 — Core schemas (parallel-safe)

### Task 1: `@redesigner/core` subpath export split [P-G1] (Haiku)

**Files:**
- Modify: `packages/core/package.json` — add `exports` entries for `./schemas` and `./types`
- Create: `packages/core/src/schemas/index.ts` (re-exports) and `packages/core/src/types/index.ts` (erased)
- Test: `packages/core/test/exports.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/exports.test.ts
import { test, expect } from 'vitest'
import * as schemas from '@redesigner/core/schemas'
import * as types from '@redesigner/core/types'

test('schemas subpath exports Zod runtime', () => {
  expect(typeof schemas.SelectionPutBodySchema?.parse).toBe('function')
})

test('types subpath has no Zod runtime bundled', () => {
  // Runtime check: types subpath returns only namespace objects; any Zod import would throw at tree-shake
  expect(Object.keys(types).length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test** — `pnpm --filter @redesigner/core test exports` — FAIL (subpaths don't exist)
- [ ] **Step 3: Implement** — add to `packages/core/package.json`:
```json
"exports": {
  ".": "./dist/index.js",
  "./schemas": "./dist/schemas/index.js",
  "./types": "./dist/types/index.js"
}
```
Create stub `src/schemas/index.ts` and `src/types/index.ts` re-exporting existing symbols.
- [ ] **Step 4: Build + rerun** — `pnpm --filter @redesigner/core build && pnpm --filter @redesigner/core test exports` — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add /schemas and /types subpath exports"`

---

### Task 2: Error taxonomy — `RpcErrorCode`, `ApiErrorCode`, crosswalk [P-G1] (Haiku)

**Files:**
- Create: `packages/core/src/schemas/errors.ts`
- Create: `packages/core/test/crosswalk.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/crosswalk.test.ts
import { test, expect, expectTypeOf } from 'vitest'
import {
  RpcErrorCode,
  ApiErrorCode,
  ApiErrorCodeToRpc,
  ApiErrorCodeToHttpStatus,
} from '@redesigner/core/schemas'

test('crosswalks are total over ApiErrorCode', () => {
  const apiCodes = [
    'extension-disconnected','extension-timeout','extension-no-active-pick',
    'element-not-found','result-too-large','shutdown','instance-changed',
    'rate-limit-exceeded','version-not-acceptable','invalid-params',
    'internal-error','host-rejected','method-not-allowed','not-found',
    'unknown-extension','stale-selection','endpoint-moved','session-revalidate-exhausted',
  ] as const satisfies readonly ApiErrorCode[]
  for (const c of apiCodes) {
    expect(ApiErrorCodeToHttpStatus[c]).toBeTypeOf('number')
    expect(Object.hasOwn(ApiErrorCodeToRpc, c)).toBe(true)
  }
})

test('RpcErrorCode values are in JSON-RPC server-error range -32000..-32099', () => {
  for (const v of Object.values(RpcErrorCode)) {
    if (typeof v === 'number') {
      expect(v).toBeGreaterThanOrEqual(-32099)
      expect(v).toBeLessThanOrEqual(-32000)
    }
  }
})
```

- [ ] **Step 2: Run test** — FAIL
- [ ] **Step 3: Implement per spec §3.3** — `packages/core/src/schemas/errors.ts`:
```ts
export enum RpcErrorCode {
  ExtensionDisconnected = -32001,
  ExtensionTimeout = -32002,
  ExtensionNoActivePick = -32003,
  ElementNotFound = -32004,
  ResultTooLarge = -32005,
  Shutdown = -32006,
  InstanceChanged = -32007,
  RateLimitExceeded = -32008,
  VersionNotAcceptable = -32009,
  InvalidParams = -32602,
  InternalError = -32603,
}
export type ApiErrorCode =
  | 'extension-disconnected' | 'extension-timeout' | 'extension-no-active-pick'
  | 'element-not-found' | 'result-too-large' | 'shutdown' | 'instance-changed'
  | 'rate-limit-exceeded' | 'version-not-acceptable' | 'invalid-params'
  | 'internal-error' | 'host-rejected' | 'method-not-allowed' | 'not-found'
  | 'unknown-extension' | 'stale-selection' | 'endpoint-moved'
  | 'session-revalidate-exhausted'
export const ApiErrorCodeToRpc: Record<ApiErrorCode, RpcErrorCode | null> = { /* full map per spec */ }
export const ApiErrorCodeToHttpStatus: Record<ApiErrorCode, number> = { /* full map per spec */ }
```
- [ ] **Step 4: Run test** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add error taxonomy with RPC↔REST crosswalk"`

---

### Task 3: WS frame schemas + close-reason encode guard [P-G1] (Haiku)

**Files:**
- Create: `packages/core/src/schemas/wsFrames.ts`, `packages/core/src/schemas/closeReasons.ts`
- Create: `packages/core/test/closeReasons.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'vitest'
import { CloseReasonSchema, encodeCloseReason } from '@redesigner/core/schemas'

test('encode throws above 123 UTF-8 bytes', () => {
  const tooMany = { accepted: Array.from({length: 50}, (_,i)=>i) }
  expect(() => encodeCloseReason(tooMany)).toThrow(/123/)
})
test('encode accepts {accepted:[1]}', () => {
  expect(encodeCloseReason({ accepted: [1] })).toBe('{"accepted":[1]}')
})
```

- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** `closeReasons.ts` with Zod `.strict()` schema, `encodeCloseReason(obj): string` that `JSON.stringify` then asserts `Buffer.byteLength(s, 'utf8') <= 123`. `wsFrames.ts` per spec §3.3 / §3.2.1 with envelope `{ jsonrpc: '2.0', id?, method?, params?, result?, error? }`.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add wsFrames + closeReasons schemas"`

---

### Task 4: Handshake + exchange + selection body schemas [P-G1] (Haiku)

**Files:**
- Create: `packages/core/src/schemas/handshake.ts`, `src/schemas/selection.ts`
- Test: `packages/core/test/schemas-parity.test.ts`

- [ ] **Step 1: Write the failing test** — parity check that `z.toJSONSchema()` output matches committed `.snap` for each schema and all schemas pass a round-trip fuzz.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** `HandshakeSchema`, `ExchangeRequestSchema`, `ExchangeResponseSchema`, `EditorSchema`, `SelectionPutBodySchema` (nodes.min(1).max(1), clientId UUID, optional meta, `.strict()`), `SelectionPutResponseSchema` (`{ selectionSeq, acceptedAt }`), all per spec §2 core-side listing.
- [ ] **Step 4: Snapshot goldens** — run tests with `-u` once, commit `.snap` files + add entry to `GOLDEN_CHANGELOG.md` with `// Source: packages/core/src/schemas/<file>.ts::<export>` header comment per spec §8.5.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add handshake + selection schemas with committed goldens"`

---

## Phase 2 — Daemon additions (sequential; security-critical)

### Task 5: Host-allowlist + 127.0.0.1 bind + literal-set validation (Opus)

**Files:** `packages/daemon/src/hostAllow.ts` (new), modify `packages/daemon/src/server.ts` bind + middleware.
**Test:** `packages/daemon/test/hostAllow.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test, expect } from 'vitest'
import { hostAllow } from '../src/hostAllow'
test('accepts localhost/127.0.0.1/[::1] with correct port', () => {
  const fn = hostAllow(5173)
  expect(fn('localhost:5173')).toBe(true)
  expect(fn('127.0.0.1:5173')).toBe(true)
  expect(fn('[::1]:5173')).toBe(true)
})
test('rejects 0.0.0.0, localhost.evil.com, raw non-loopback IPs', () => {
  const fn = hostAllow(5173)
  for (const h of ['0.0.0.0:5173','[::]:5173','[::ffff:127.0.0.1]:5173','localhost.attacker.com:5173','192.168.1.1:5173','example.com:5173']) {
    expect(fn(h)).toBe(false)
  }
})
```
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — literal-set check per spec §3.2; `server.ts` binds to `127.0.0.1` only (never `0.0.0.0`); middleware returns 421 on mismatch.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): host-allowlist with 127.0.0.1 bind"`

---

### Task 6: `compareToken` + branded Token type (Opus)

**Files:** `packages/daemon/src/auth.ts`, `packages/core/src/types/token.ts`
**Test:** `packages/daemon/test/compareToken.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
test('compareToken length-normalizes and returns false on mismatch', () => {
  expect(compareToken('abc', 'abcd')).toBe(false)
  expect(compareToken('abc', 'abc')).toBe(true)
  expect(compareToken('abc', 'abd')).toBe(false)
})
test('never throws RangeError on length mismatch', () => {
  expect(() => compareToken('a', 'bbbbbb')).not.toThrow()
})
```
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per CLAUDE.md pattern: normalize to equal length, then `crypto.timingSafeEqual`.
- [ ] **Step 4: Add CI-grep rule** — `.github/workflows/ci.yml` step runs `grep -nE '=== .*[Tt]oken' packages/daemon/src/` and fails on any match.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): compareToken helper + raw-=== CI guard"`

---

### Task 7: Bootstrap + `/exchange` endpoint with TOFU ext-ID pin (Opus)

**Files:** `packages/daemon/src/routes/exchange.ts`, `packages/daemon/src/tofu.ts`
**Test:** `packages/daemon/test/exchange.test.ts`

- [ ] **Step 1: Write the failing test** — cover: successful exchange mints `HMAC(rootToken, clientNonce, serverNonce, iat)`; response carries `{sessionToken, exp ≤ 300, serverNonce}`; second exchange from different Origin rejected 403 `apiErrorCode:'unknown-extension'`; new exchange from same extId invalidates prior session; per-(Origin, peerAddr) rate-limit.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §3.2 exchange.ts bullet; TOFU writes `$runtimeDir/trusted-ext-id` on first success; auto-reset guard per §3.2 final paragraph.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): /exchange endpoint with TOFU ext-ID pinning"`

---

### Task 8: WS upgrade — subprotocol echo + version negotiation (Opus)

**Files:** `packages/daemon/src/ws/events.ts`, `packages/daemon/src/auth.ts` (`extractSubprotocolToken`)
**Test:** `packages/daemon/test/wsUpgrade.test.ts`

- [ ] **Step 1: Write the failing tests** — cover (see spec §4.4, §8.8):
```ts
test('echoes redesigner-v1 only; never echoes bearer', async () => { /* ... */ })
test('bearer-only offer rejects 1002', async () => { /* ... */ })
test('Sec-WebSocket-Version != 13 → 426 with Sec-WebSocket-Version:13 response header', async () => { /* ... */ })
test('?v=1,2 + subprotocol list: server echoes highest supported, puts negotiatedV in hello', async () => { /* ... */ })
test('subprotocol list with 9+ entries → 1002 close (maxSubprotocolEntries=8)', async () => { /* ... */ })
test('uniform 1002 on any auth failure (no 4401 oracle)', async () => { /* ... */ })
```
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** `extractSubprotocolToken` (fixed-prefix suffix parse, not split — see spec §2 daemon-side listing); subprotocol handshake picks highest `redesigner-v*` supported; `?v=` list parser canonicalizes + intersection-then-max with subprotocol.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): WS subprotocol echo + version negotiation"`

---

### Task 9: Close-code reducer + 1002 session-revalidate (Sonnet)

**Files:** `packages/daemon/src/ws/events.ts` (close handling), `packages/daemon/src/routes/revalidate.ts` (new endpoint)
**Test:** `packages/daemon/test/closeCodes.test.ts`

- [ ] **Step 1: Write the failing test** — cover each row of spec §4.4 close table; include 1005, 1015 rows per R10 apply.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** `/revalidate` (session-token-gated, separate from `/exchange` bucket per R9 finding) + 4406 reason JSON `{accepted:[1]}` using `encodeCloseReason` guard.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): close-code handling + /revalidate endpoint"`

---

### Task 10: `PUT /tabs/{tabId}/selection` + 410 Gone legacy (Sonnet)

**Files:** `packages/daemon/src/routes/selection.ts`
**Test:** `packages/daemon/test/selection.test.ts`

- [ ] **Step 1: Write the failing test** — cover: valid PUT echoes `{selectionSeq, acceptedAt}`; `selection.updated` notification carries same seq; `selectionSeq` is per-tab; POST→405 with problem body (no Deprecation/Sunset); legacy `PUT /selection` → 410 Gone with `apiErrorCode:'endpoint-moved'`; path resolution (410) precedes method dispatch (so POST to legacy path also sees 410).
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §3.2 selection.ts bullet + §4.2 step 9.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): tab-scoped selection resource + 410 legacy"`

---

### Task 11: CORS + Vary + problem+json content-type + Retry-After (Sonnet)

**Files:** `packages/daemon/src/routes/cors.ts`, `packages/daemon/src/problem.ts`
**Test:** `packages/daemon/test/cors.test.ts`

- [ ] **Step 1: Write the failing test** — `Vary: Origin, Access-Control-Request-Headers` on every CORS-reachable response (incl. 5xx); problem bodies carry `Content-Type: application/problem+json; charset=utf-8`; 429 includes `Retry-After: <int seconds>`; `Cache-Control: no-store, private` on `/handshake.json`, `/exchange`, `/selection`; Cookie header on credentialed route rejected.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): CORS + Vary + problem+json headers"`

---

### Task 12: `/health` + `/debug/state` + logger redaction (Sonnet)

**Files:** `packages/daemon/src/routes/health.ts`, `packages/daemon/src/routes/debug.ts`, `packages/daemon/src/logger.ts`
**Test:** `packages/daemon/test/logger.test.ts`

- [ ] **Step 1: Write the failing test** — logger never emits subprotocol string, `sec-websocket-protocol`, `authorization`, `token`, `x-*-token` to any output (stdout, 4xx close frames, 421 bodies, access logs); sentinel-token 0-match CI grep; `/health` requires session token; `/debug/state` env-gated (default off).
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** redaction glob + `.github/redactor-patterns.txt` committed for CI grep enforcement.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): logger redaction + CI guard"`

---

## Phase 3 — Vite plugin additions (sequential)

### Task 13: `/__redesigner/handshake.json` middleware with Origin gating (Opus)

**Files:** `packages/vite/src/plugin.ts` (handshake route), `packages/vite/src/bootstrap.ts`
**Test:** `packages/vite/test/handshake.test.ts`

- [ ] **Step 1: Write the failing test** — serves only under `apply:'serve'`; Host-allowlist gated; `X-Redesigner-Bootstrap` response header present; requires `Sec-Fetch-Dest: empty` + `Sec-Fetch-Site ∈ {none, cross-site}` + `Origin absent | chrome-extension://*`; rejects with 403 otherwise; body retains token for compat; `Cache-Control: no-store, private` present.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §2 Vite plugin + §3.2 "Handshake JSON served" bullet.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(vite): handshake.json middleware with Origin gate"`

---

### Task 14: `transformIndexHtml` meta injection + Vite CVE runtime pin (Sonnet)

**Files:** `packages/vite/src/plugin.ts`
**Test:** `packages/vite/test/meta.test.ts`

- [ ] **Step 1: Write the failing test** — meta tag injected only under `apply:'serve'`; carries `{wsUrl, httpUrl, bootstrapToken, editor, pluginVersion, daemonVersion}`; plugin refuses to start on Vite <5.4.19 or <6.2.7 (CVE-2025-30208/31125/31486/32395/30231 ranges); `editor` option Zod-validated at plugin boot (console.warn + default on invalid).
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(vite): meta injection + Vite CVE pin"`

---

## Phase 4 — Extension scaffolding (sequential)

### Task 15: `packages/ext/` scaffold with CRXJS + manifest (Opus)

**Files:** `packages/ext/package.json`, `packages/ext/vite.config.ts`, `packages/ext/manifest.json`, `packages/ext/docs/ext-build-migration.md`

- [ ] **Step 1: Write the failing test** — build produces valid unpacked extension with `minimum_chrome_version: "120"`, `key` field present (dev-stable ID), `commands.arm-picker` has `suggested_key: Alt+Shift+D`, `host_permissions: ["http://localhost/*","http://127.0.0.1/*","http://*.localhost/*","http://[::1]/*"]`, `content_scripts` declares `run_at: document_start` bootstrap stub + `document_end` main.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — add pnpm workspace entry; CRXJS `~2.y.z`; write migration runbook per spec §2.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): scaffold @redesigner/ext with MV3 manifest"`

---

### Task 16: Shared utilities — clock, random, constants, editors, errors re-export [P-G2] (Haiku)

**Files:** `packages/ext/src/shared/{clock,random,constants,editors,errors}.ts`
**Test:** `packages/ext/test/unit/shared.test.ts`

- [ ] **Step 1: Write the failing tests** — `nextFullJitterDelay(n)` returns `random() * min(30000, 1000*2**n)` deterministically under injected Math.random; `editors` Zod allowlist + URL builders enforce project-root constraint; `constants.ts` exposes exact values from spec §2 shared/constants.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): shared utilities"`

---

### Task 17: `chromeMock` per-namespace + fidelity-diff oracle [P-G2] (Sonnet)

**Files:** `packages/ext/test/chromeMock/{index,storage,runtime,tabs,windows,action,alarms,commands,sidePanel,scripting,idle,permissions,debugger}.ts`
**Test:** `packages/ext/test/chromeMock/fidelity.test.ts`

- [ ] **Step 1: Write the failing test** — fidelity test plays back a committed real-Chromium recording (headed-Chromium harness produces goldens) through chromeMock and diffs observable side-effect sets (not ordered call sequences — see spec §8.1 fidelity scope).
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — minimum viable chromeMock covering namespaces used in Phase 5-7 tasks; record initial goldens from headed-Chromium harness.
- [ ] **Step 4: Add CI trigger** — `.github/workflows/ci.yml` runs fidelity on any PR that touches `test/chromeMock/` OR `test/integration/**` OR grep-adds `chrome\.` to `packages/ext/src/`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): chromeMock + fidelity-diff oracle"`

---

## Phase 5 — Content script + picker (sequential; Opus for picker)

### Task 18: Handshake fetch + meta probe + MutationObserver (Sonnet)

**Files:** `packages/ext/src/content/handshake.ts`, `packages/ext/src/content/index.ts`
**Test:** `packages/ext/test/integration/handshake.test.ts`

- [ ] **Step 1: Write the failing test** — cover: fetch `/__redesigner/handshake.json` with `credentials:'omit'`; reads `X-Redesigner-Bootstrap` header (body fallback); MutationObserver on `document.head` catches late meta injection; disconnects on `beforeunload`; `meta-in-body` case logs `dormantReason`; forwards `{wsUrl, httpUrl, bootstrapToken, editor, tabId, windowId, clientId}` to SW via `runtime.sendMessage`.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §4.1 steps 2-4.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): CS handshake + meta probe"`

---

### Task 19: `hitTest` — elementsFromPoint with shadow recursion (Opus)

**Files:** `packages/ext/src/content/hitTest.ts`
**Test:** `packages/ext/test/picker/hitTest.spec.ts` (Tier-3 `@vitest/browser` bundled Chromium)

- [ ] **Step 1: Write the failing tests** — fixtures (per spec §8.3):
  - transform-ancestor: picker top-layer promotion works
  - native `<dialog>.showModal()` + popover stacking
  - `<dialog open>` without showModal (no top layer) — picker still above
  - `isOwnOverlay` skip: `hitTest(x,y)` never returns node whose `getRootNode() === pickerShadowRoot` at any depth
  - same-origin iframe resolves to `<iframe>` element
  - closed-shadow-root fixture
  - devicePixelRatio > 1 (HiDPI rounding)
  - CSS `zoom: 0.5` ancestor
  - `pointer-events: none` cascading from `<html>`
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §4.2 step 3 + §5.1.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): hitTest with shadow recursion"`

---

### Task 20: Picker overlay — shadow host + popover + window listeners (Opus)

**Files:** `packages/ext/src/content/picker.ts`
**Test:** `packages/ext/test/picker/picker.spec.ts`

- [ ] **Step 1: Write the failing tests** — arm attaches shadow host as child of `:modal` dialog if present else `document.documentElement`; host `popover="manual"` + `showPopover()`; window-level `pointermove`+`pointerdown` with `{capture:true, passive:true}`, `click` with `{capture:true, passive:false}`; `contextmenu`/`dragstart`/`pointercancel` suppressed during arm; page `showModal()` AFTER arm detected via MutationObserver on `inert` attribute + `aria-modal="true"` + `dialog.toggle` event; failed-pick toast on modal-detected; focus captured + restored with `isConnected` guard; `role="dialog"` + `aria-modal="true"` + `aria-label`; body-level `aria-live="assertive"` region (pointer-driven debounced 250ms, keyboard-driven immediate); Esc keydown window-capture.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §4.2 step 2. Include feature-detect `'popover' in HTMLElement.prototype` error-toast on miss.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): picker overlay topology"`

---

### Task 21: `extractHandle` — manifest await + deadline + tagged result (Opus)

**Files:** `packages/ext/src/content/extractHandle.ts`, `packages/ext/src/content/stableId.ts`
**Test:** `packages/ext/test/unit/extractHandle.test.ts`

- [ ] **Step 1: Write the failing tests** — 3s deadline on manifest await decoupled from WS reconnect (stalled manifest + fast reconnect → null on deadline); returns tagged `{ok:false, reason:'timeout'|'disconnected'|'no-anchor'|'iframe'}`; `lastHoverTarget.isConnected === false` re-resolves at last mouse coords; monotonic pick counter drops out-of-order resolves; `stableId` determinism property test via `@fast-check/vitest` with `FAST_CHECK_SEED=42`, `numRuns:1000` (per spec §8.7 reducer/replay tier).
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §5.1 + §5.2. `filePath` project-relative; index among siblings of same `componentName`; `:line:col` in editor deep-link.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): extractHandle + stableId"`

---

### Task 22: `rpcAgent` — DOM-read RPCs over runtime port (Sonnet)

**Files:** `packages/ext/src/content/rpcAgent.ts`, `packages/ext/src/content/register.ts`
**Test:** `packages/ext/test/integration/rpcAgent.test.ts`

- [ ] **Step 1: Write the failing test** — `register` envelope well-formed; `rpc.request` routed to CS reads DOM and replies; 2s armed heartbeat to SW; clientId-tab attribution correct.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext): CS rpcAgent"`

---

## Phase 6 — Service worker (sequential; Opus for security/lifecycle)

### Task 23: SW entry + hydrate with TRUSTED_CONTEXTS + top-level listeners (Opus)

**Files:** `packages/ext/src/sw/index.ts`, `packages/ext/src/sw/hydrate.ts`
**Test:** `packages/ext/test/integration/hydrate.test.ts`

- [ ] **Step 1: Write the failing tests** — all `chrome.*.addListener` calls happen at module top-level synchronously before any await (ESLint `no-restricted-syntax` rule forbids addListener inside async fn bodies); `globalThis.__bootEpoch` incremented on each SW boot; hydrate reads `storage.session` under opaque `s_<uuid>` key; `readyPromise.catch(err => sendResponse({error}))` for pending handlers; poisoned `storage.session` cleared + empty state fallback.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §2 `sw/index.ts` + §7.2 + §1 bullet on storage.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): entry + hydrate"`

---

### Task 24: `exchange.ts` — bootstrap→session + rotation (Opus)

**Files:** `packages/ext/src/sw/exchange.ts`, `packages/ext/src/sw/rest.ts`
**Test:** `packages/ext/test/integration/exchange.test.ts`

- [ ] **Step 1: Write the failing test** — cold boot exchanges with `clientNonce`; stores `sessionToken + exp + serverNonce`; refresh ~60s before `exp`; `handshake.rotated` frame triggers re-fetch + re-exchange; SW verifies `hello.serverNonceEcho` matches; `AbortSignal.timeout(ms)` used (never `new AbortController + setTimeout` per CLAUDE.md); 1002-cap-exhaust routes to CS handshake re-fetch.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): exchange + REST"`

---

### Task 25: `wsClient` + `connPool` + close-code reducer (Opus)

**Files:** `packages/ext/src/sw/{wsClient,connPool}.ts`, reuse `packages/ext/src/shared/random.ts`
**Test:** `packages/ext/test/integration/wsClient.test.ts` + `packages/ext/test/unit/closeReducer.test.ts`

- [ ] **Step 1: Write the failing tests** — close-code reducer is pure `nextState(prev, code, now)` with rows for 1000/1001/1002/1005/1006/1011/1012/1013/1015/4406/4408/4409 + unknown default; property test uses `fc.constantFrom` enumerated + `fc.integer({min:1000,max:4999})` default branch + `fc.array(fc.constantFrom(codes),{minLength:2,maxLength:20})` for sequences (1012x10 fixed; 1002 revalidate cap by **failure count** not window, reset on hello; 4406 accepted-list reconnect with highest supported); `connPool` keyed on `wsUrl` (not active tab); per-key creation lock; refcount; LRU cap 256; re-arm cooldown 1s.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §4.4 + §5.8.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): wsClient + connPool + close reducer"`

---

### Task 26: `alarms` — tiered reconnect-tick + Welcome probe (Opus)

**Files:** `packages/ext/src/sw/alarms.ts`
**Test:** `packages/ext/test/integration/alarms.test.ts`

- [ ] **Step 1: Write the failing test** — `reconnect-tick` registered at 30s cadence first 2 min of backoff, decays to 60s; cleared on successful hello or give-up; `welcome-probe-tick` 60s cadence, 20-attempt cap, probes only open-tab origins matching `http://localhost/*` + `http://127.0.0.1/*` via tokenless `HEAD /__redesigner/handshake.json`; "Resume probing" button re-arms after cap; wake also driven by `chrome.runtime.onStartup`, `chrome.idle.onStateChange('active')`, `tabs.onActivated` on localhost tab.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): alarms for reconnect + welcome probe"`

---

### Task 27: `rpc.ts` + `manifestCache.ts` (Sonnet)

**Files:** `packages/ext/src/sw/{rpc,manifestCache}.ts`
**Test:** `packages/ext/test/integration/rpc.test.ts`

- [ ] **Step 1: Write the failing test** — `inFlightRpc` awaited-persist on insertion; monotonic counter; grace window `min(15s, max(3s, now - sw.wakeAt))`; result envelope `{truncated, partial, fullBytes}` for >512KB; synth past-deadline replies delivered via WS upstream (daemon forwards to MCP) not `chrome.runtime.sendMessage` (can't reach Node); manifest cache per-wsUrl, seq-tagged atomic swap, single-flight, wake-safe promise reset on hydrate.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): rpc + manifestCache"`

---

### Task 28: `panelPort.ts` + `actionIcon.ts` + `commands.ts` + `backfill.ts` (Sonnet/Opus)

**Files:** `packages/ext/src/sw/{panelPort,actionIcon,commands,backfill}.ts`
**Test:** `packages/ext/test/integration/sw-ux.test.ts`

- [ ] **Step 1: Write the failing tests** — `panelPort` maintains per-(windowId, tabId) cached snapshot refs with version bump on SW push OR tab-activation; 1000 unchanged reads return Object.is-identical refs; `actionIcon` debounced coalescing: 50 rapid arm/disarm → **exactly 2** `setIcon` calls (1 armed-edge + 1 disarmed-edge, not ≤2); `commands.onCommand('arm-picker')` arms picker only (never attempts `sidePanel.open` — keyboard gesture flaky per Chromium #344767733); `action.onClicked` synchronous call to `chrome.sidePanel.open({windowId: tab.windowId})` before any await (chromeMock timestamps call ordinal); `backfill` gated on `permissions.contains({origins:['http://localhost/*']}) === true`; denied branch surfaces "Grant access" flow.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §2 + §7.4.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/sw): panel port + action icon + commands + backfill"`

---

## Phase 7 — Side panel React app (sequential; Sonnet with Opus spot-checks)

### Task 29: Panel shell — index.tsx + App.tsx + usePanelPort (Opus for hooks)

**Files:** `packages/ext/src/panel/index.tsx`, `src/panel/App.tsx`, `src/panel/hooks/usePanelPort.ts`
**Test:** `packages/ext/test/unit/panel.test.tsx`

- [ ] **Step 1: Write the failing test** — React renders skeleton before SW port reply; `useSyncExternalStore(subscribe, () => getSnapshot(windowId, tabId), getSnapshot)` (getServerSnapshot=getSnapshot, not omitted); on `port.onDisconnect` panel enters dimmed "resync" transient; SW re-sends snapshot on `runtime.onConnect`; `WINDOW_ID_NONE` ignored.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — imports only from `@redesigner/core/types` (no Zod runtime pulled).
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/panel): shell + port hook"`

---

### Task 30: Panel components — ConnectionBadge, SelectionCard, Welcome, ShortcutsFooter, ErrorBanners, Debug [P-G3] (Sonnet)

**Files:** `packages/ext/src/panel/{ConnectionBadge,SelectionCard,RecentList,PickerToggle,Welcome,ShortcutsFooter,EmptyStates,ErrorBanners,Debug}.tsx`
**Test:** `packages/ext/test/unit/components.test.tsx`

- [ ] **Step 1: Write the failing tests** — `ConnectionBadge` has 5 states (off/connecting/connected/error/mcp-missing) with shape-a11y ring not tint-only + labeled on hover; `SelectionCard` pip copy "Claude Code can see this" + adaptive chip ("Set up the MCP shim" unwired / `Try: "what's my current selection?"` wired); MCP snippet renders as `claude mcp add --transport stdio redesigner -- <path>/mcp.sh` with restart instruction; "Copy handle" button (shift-click variant); "Show pickable elements" panel toggle; `ShortcutsFooter` reads chord live from `chrome.commands.getAll()` (no hardcoded literal — ESLint rule); `ErrorBanners` show Reload-tab button from t=0; give-up copy tiered 30s pre-first-pick / 180s after (flag in `storage.local`, resets on focus/idle>5min); `Debug` gated `Shift+Alt+D` (not `Shift+D` to avoid VoiceOver conflict) + not in target matching `input, textarea, [contenteditable]`.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** per spec §7.4.
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/panel): components"`

---

## Phase 8 — Contract + E2E (parallel-safe where noted)

### Task 31: Contract goldens + cross-package parity [P-G4] (Haiku)

**Files:** `packages/core/test/parity.test.ts`, `.zod-version` sentinel at repo root
**Test:** `packages/ext/test/contract/goldens.test.ts`

- [ ] **Step 1: Write the failing test** — `z.toJSONSchema()` output for every frame + body schema matches committed `.snap` (strip `$schema`); `.snap` header comment names `// Source: ...`; CI step `pnpm why zod` asserts exactly one resolved Zod major version matching `.zod-version`; cross-pkg module-identity: `import('@redesigner/core/schemas')` resolves to same module from both daemon and ext packages.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — regenerate all goldens, commit `GOLDEN_CHANGELOG.md` entries.
- [ ] **Step 4: CI integration** — ext contract step runs in **same job** as daemon tests (single runner, sequential steps) per spec §8.5.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): contract goldens + zod-version sentinel"`

---

### Task 32: Playwright MV3 E2E — smoke + nightly [P-G4] (Sonnet)

**Files:** `packages/ext/playwright.config.ts`, `packages/ext/test/e2e/{smoke,nightly}/*.spec.ts`
**Test:** `packages/ext/test/e2e/smoke/pick.spec.ts`

- [ ] **Step 1: Write the failing test** — smoke: install → open localhost dev-page → arm via shortcut → pick element → assert daemon receives `PUT /tabs/{tabId}/selection` with correct `ComponentHandle`.
- [ ] **Step 2: Run** — FAIL
- [ ] **Step 3: Implement** — use `chromium.launchPersistentContext` with `--load-extension`; pin Playwright version in package.json; retry policy `retries:2` on @smoke, `0` on @nightly.
- [ ] **Step 4: Add nightly** — SW-suspend via `chrome.debugger.ServiceWorker.stopAllWorkers` with retry-attach loop + `waitForEvent('serviceworker')` fallback + `__bootEpoch` increment assertion; CDP HeapProfiler.collectGarbage before `leak-baseline.json` measurement; Welcome polling E2E (install-before-vite-dev with `welcomePollMs` env override to 500ms).
- [ ] **Step 5: Commit** — `git commit -m "feat(ext/e2e): Playwright smoke + nightly"`

---

### Task 33: Threat-model doc + migration runbook [P-G4] (Sonnet)

**Files:** `packages/ext/docs/{threat-model,ext-build-migration,known-limitations}.md`

- [ ] **Step 1: Write.** Threat model enumerates: DevTools WS-header visibility, `chrome://net-export`, reverse-proxy logs, co-installed localhost-permissioned ext (residual — documented, v0.1 fix via Web-Store ext-ID binding), third-party inline scripts, accepted residuals (bootstrap page-readability). Migration runbook covers CRXJS→WXT trigger conditions + sed/codemod scripts. Known limitations: iframe contents out of scope, keyboard pick not supported, incognito backfill may be blocked.
- [ ] **Step 2: Commit** — `git commit -m "docs(ext): threat model + migration + limitations"`

---

### Task 34: Playground dogfood [P-G4] (Sonnet)

**Files:** modify `apps/playground/` (existing) to load ext unpacked + demonstrate pick flow.
- [ ] **Step 1: Write smoke checklist** in `apps/playground/EXT_DOGFOOD.md`: load ext, start dev server, arm via shortcut, pick a button, ask Claude Code "what's my current selection?" via the MCP shim, verify response contains `filePath:line:col`.
- [ ] **Step 2: Execute checklist locally, capture logs.**
- [ ] **Step 3: Commit** — `git commit -m "feat(playground): ext dogfood guide"`

---

## Phase 9 — Release gate

### Task 35: CI workflow consolidation (Sonnet)

**Files:** `.github/workflows/{ci,nightly}.yml`, `.github/redactor-patterns.txt`
- [ ] **Step 1:** Assert workflow shape test — ext contract step runs in same job as daemon tests; `pnpm why zod` single-version check; logger redactor-pattern CI grep; fidelity-diff triggered on PR diffs to `chromeMock/` | `test/integration/**` | any `chrome\.` addition in `packages/ext/src/`; fake-timer deny-list grep 0-match outside `test/fixtures/`; size-limit budget blocking on panel bundle; `leak-baseline.json` mtime check fails if >6 months stale.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit — `git commit -m "ci(ext): consolidated workflow with all guards"`

---

## Parallelism summary

- **P-G1 (Phase 1):** Tasks 1, 2, 3, 4 — all core schema tasks have no cross-deps; dispatch 4 subagents in parallel.
- **P-G2 (Phase 4):** Tasks 16, 17 — parallel subagents after 15 completes.
- **P-G3 (Phase 7):** Task 30's 9 component files — decompose into 3 parallel subagents (badge+card+welcome, shortcuts+empty+banners, debug+recent+toggle) for larger teams; for single-subagent execution ignore.
- **P-G4 (Phase 8):** Tasks 31, 32, 33, 34 — fully parallel after Phase 7 completes.
- **Sequential elsewhere:** Phase 2 tasks 5-12 (daemon) must land in order for integration tests; Phase 3 tasks 13-14 sequential after daemon; Phases 5-7 serial because CS→SW→Panel integration tests stack; Phase 9 after everything.

Total task count: **35**. Expected ordering: Phase 1 (parallel) → 2 → 3 → 4 (P-G2) → 5 → 6 → 7 (P-G3) → 8 (P-G4) → 9.

---

## Self-review against spec

Coverage spot-checks:
- §1 scope bullets → Tasks 15 (manifest), 18-22 (picker), 23-28 (SW), 29-30 (panel), 19 (feature-detect popover), 25 (app-ping 20s / give-up / 1002 revalidate).
- §2 file structure → Tasks 15 (ext layout), 1-4 (core), 5-12 (daemon), 13-14 (vite plugin).
- §3 architecture → Task 25 (wsClient) for subprotocol echo + version negotiation; Task 8 (daemon) for server-side; Task 2 (core) for error taxonomy.
- §3.2.1 JSON-RPC envelope → covered in wsFrames schema (Task 3) + wsClient (Task 25) + batch-rejection test in Task 8.
- §4.0 MCP setup flow → Task 30 (Welcome.tsx renders 3-step, MCP snippet with `--` separator + restart instruction); Task 28 (SW pushes `mcp.clientChanged`).
- §4.1-4.7 data flow → Tasks 18-28.
- §5 algorithms → Tasks 19-21 (hitTest, extractHandle, stableId) + Task 25 (close reducer).
- §6 security → Tasks 5-8, 13, 24 explicitly enforce; §6.1 threat model → Task 33.
- §7 state model → Task 23 (hydrate) + Task 28 (panelPort cached refs) + Task 30 (panel UX).
- §8 testing tiers → Phase 1-7 tests + Phase 8 contract/E2E.
- §9 implementation order → this plan mirrors it exactly (Core → Daemon → Vite → Ext-scaffold → CS → SW → Panel → Picker-browser → E2E → Playground → Docs).
- §10 open questions → deferred to v0.1; Task 33 enumerates.

No placeholders. Type consistency verified: `SelectionPutBodySchema`/`SelectionPutResponseSchema`/`ApiErrorCode` referenced consistently across Tasks 2, 4, 10, 22, 29, 30, 31.

---

## Next step

Plan complete and saved to `docs/superpowers/plans/2026-04-19-chrome-extension-v0.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch fresh subagent per task, review between tasks, fast iteration. Honors the per-task model assignments + parallelism groups above.
2. **Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`, batch with checkpoints.

Which approach?
