# Daemon↔Vite Token Sync + Exchange Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v0.1 extension's `POST /__redesigner/exchange` → session-token path actually work at runtime. Today the daemon and Vite plugin each mint their own bootstrap tokens, nothing syncs them, and `POST /__redesigner/exchange` is coded but never mounted on the server router. First real dogfood attempt hit `401 Unauthorized` on the exchange call.

**Architecture:** Daemon becomes the authority for **all** token material — `rootToken`, `authToken` (existing), and `bootstrapToken` (new). Daemon writes `bootstrapToken` into the handoff file alongside `token`. Vite's plugin reads `bootstrapToken` from the handoff file on each handshake-JSON request (no local minting, no rotation logic), and injects it into the `<meta name="redesigner-daemon">` tag. `POST /__redesigner/exchange` and `POST /__redesigner/revalidate` are mounted in `packages/daemon/src/server.ts` with a pre-`compareToken` carve-out — those two paths have their own authentication (bootstrapToken in body, Origin gate, Sec-Fetch gates); the global Bearer check must not block them.

**Tech Stack:** Existing — Node 22+ ESM, Zod (pinned via `.zod-version`), Vitest (daemon uses `node` env, vite uses `happy-dom`-like). No new deps. HMAC session minting already implemented in `routes/exchange.ts`; this plan wires the infrastructure around it.

**Spec reference:** `docs/superpowers/specs/2026-04-19-chrome-extension-v0-design.md` §3.2 (authN/authZ), §4 (handoff shape). No spec amendment needed — the design assumed this wiring existed.

**Execution strategy — model assignments + parallelism:**

| Task class | Model | Rationale |
|---|---|---|
| Zod schema field addition | Haiku 4.5 | Mechanical; handoff schema is small |
| Daemon token plumbing (child.ts wiring, handoff build) | Sonnet 4.6 | Integration with existing patterns |
| Daemon server.ts pre-auth route carve-out | Opus 4.7 | Security-critical — a wrong pathname match lets attackers bypass Bearer auth on every route |
| Daemon exchange/revalidate integration tests | Sonnet 4.6 | HTTP roundtrip assembly |
| Vite bootstrap handoff-read + test | Sonnet 4.6 | Filesystem read + schema validation |
| End-to-end ext/daemon/vite smoke | Sonnet 4.6 | Orchestration |

**Parallelism groups** — tasks marked `[P-Gn]` run in parallel subagents. Ungrouped tasks are sequential.

- **P-G1** T1
- **P-G2** (after T1): T2 + T5
- **P-G3** (after P-G2): T3 + T6
- **P-G4** (after P-G3): T4 + T7
- **Sequential** (after P-G4): T8

---

## Task 1: Add `bootstrapToken` to `HandoffSchema` [P-G1] (Haiku)

**Files:**
- Modify: `packages/daemon/src/handoff.ts`
- Modify: `packages/daemon/test/handoff.test.ts` (or nearest existing test file)

The handoff schema currently carries `token` (the authToken). Add a new `bootstrapToken` field with the same length constraints (`min(32).max(128)`). Both are base64url-encoded 32-byte secrets on the wire; the schema doesn't know their roles, only their shape. Keep `.strict()` so older handoff files fail parse and force a rewrite (daemon's existing rotation logic already handles this via `HandoffSchema.parse` at read-time, which throws and triggers rewrite).

- [ ] **Step 1: Add the field**

```ts
// packages/daemon/src/handoff.ts
export const HandoffSchema = z
  .object({
    serverVersion: z.string().min(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    host: z.literal('127.0.0.1'),
    port: z.number().int().min(1).max(65535),
    token: z.string().min(32).max(128),
    bootstrapToken: z.string().min(32).max(128),
    projectRoot: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
  })
  .strict()
```

- [ ] **Step 2: Update `buildHandoff` signature**

```ts
export function buildHandoff(opts: {
  serverVersion: string
  pid: number
  port: number
  token: string
  bootstrapToken: string
  projectRoot: string
  instanceId?: string
}): Handoff {
  return {
    serverVersion: opts.serverVersion,
    instanceId: opts.instanceId ?? crypto.randomUUID(),
    pid: opts.pid,
    host: '127.0.0.1',
    port: opts.port,
    token: opts.token,
    bootstrapToken: opts.bootstrapToken,
    projectRoot: opts.projectRoot,
    startedAt: Date.now(),
  }
}
```

- [ ] **Step 3: Update existing handoff tests**

Fix any `buildHandoff(...)` call sites in `packages/daemon/test/**` to include a dummy `bootstrapToken` (32 bytes base64url). Fix any handoff-fixture JSON files in `packages/daemon/test/fixtures/**` to include the field. Run `pnpm --filter @redesigner/daemon test` — schema-parse tests that round-trip handoff must still pass.

- [ ] **Step 4: Update the ext-side re-export**

`packages/daemon/src/index.ts` re-exports `HandoffSchema` and `Handoff` for test harnesses. No code change needed (type/value both re-exported) but confirm `pnpm --filter @redesigner/ext test` still passes — any ext-side fixture handoff may need the field. Search with `grep -rn 'token:' packages/ext/test` for inline handoff objects.

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @redesigner/daemon build
pnpm -r run test
git add packages/daemon/src/handoff.ts packages/daemon/test/ packages/ext/test/
git commit -m "feat(daemon): add bootstrapToken to HandoffSchema"
```

---

## Task 2: Mint `bootstrapToken` in daemon child, thread to server + handoff [P-G2] (Sonnet)

**Files:**
- Modify: `packages/daemon/src/child.ts`
- Modify: `packages/daemon/src/server.ts` — `ServerOptions` type
- Modify: `packages/daemon/src/types.ts` (if `ServerOptions` defined there — verify first)

Currently `child.ts` line 74 mints a single `token`. Mint two: keep `token` as the long-lived authToken used for Bearer on regular routes, and add `bootstrapToken` used by `/exchange` body validation. Thread `bootstrapToken` through to both the server factory (so exchange handler can see it) and into `buildHandoff`.

- [ ] **Step 1: Mint separately in `child.ts`**

```ts
// packages/daemon/src/child.ts, near line 74
const token = crypto.randomBytes(32).toString('base64url')         // authToken (Bearer)
const bootstrapToken = crypto.randomBytes(32).toString('base64url') // exchange body secret
const rootToken = Buffer.from(crypto.randomBytes(32))               // HMAC key for session minting
const instanceId = crypto.randomUUID()
```

The `rootToken` is currently implicit (exchange factory generates its own fallback); make it explicit so the exchange handler mounted in Task 3 can be wired with the same rootToken across requests.

- [ ] **Step 2: Pass into server factory**

```ts
// still in child.ts
daemon = createDaemonServer({
  port,
  token: Buffer.from(token, 'utf8'),
  bootstrapToken: Buffer.from(bootstrapToken, 'utf8'),
  rootToken,
  ctx,
})
```

- [ ] **Step 3: Widen `ServerOptions`**

```ts
// packages/daemon/src/server.ts or types.ts
export interface ServerOptions {
  port: number
  token: Buffer
  bootstrapToken: Buffer
  rootToken: Buffer
  ctx: RouteContext
}
```

- [ ] **Step 4: Pass into handoff**

```ts
// child.ts where buildHandoff is called:
const handoff = buildHandoff({
  serverVersion,
  pid: process.pid,
  port,
  token,
  bootstrapToken,
  projectRoot,
  instanceId,
})
```

- [ ] **Step 5: Existing tests**

Anywhere tests call `createDaemonServer({...})` directly, pass `bootstrapToken` and `rootToken`. Grep: `grep -rn 'createDaemonServer' packages/daemon/test`. Use fresh `crypto.randomBytes(32)` per test fixture (don't share — nonce-replay DB is per-server, so cross-test bleed is impossible, but independence keeps intent clear).

- [ ] **Step 6: Build + commit**

```bash
pnpm --filter @redesigner/daemon build
pnpm --filter @redesigner/daemon test
git commit -m "feat(daemon): mint bootstrapToken + rootToken explicitly in child"
```

---

## Task 3: Mount `/__redesigner/exchange` and `/__redesigner/revalidate` in server.ts [P-G3] (Opus)

**Files:**
- Modify: `packages/daemon/src/server.ts`
- Modify: `packages/daemon/src/routes/cors.ts` (if CORS preflight matrix touches these — likely yes, see line 109 mention)

**Security constraint — load-bearing.** These two routes cannot go through the Bearer check at `server.ts:133`: they authenticate via `bootstrapToken` in the request body (plus Origin gate, plus per-(Origin, peerAddr) failed-exchange bucket). Introducing a pre-auth carve-out means a misaligned pathname string = auth bypass for every route. Exact-match only, POST-only, and fall through to the regular 404/405 paths otherwise.

- [ ] **Step 1: Construct handler + state once per server instance**

Just above `http.createServer(...)` in `createDaemonServer`:

```ts
import { createExchangeHandler } from './routes/exchange.js'
import { createRevalidateHandler } from './routes/revalidate.js'

const exchangeRoute = createExchangeHandler({
  rootToken: opts.rootToken,
  bootstrapToken: opts.bootstrapToken,
  logger: opts.ctx.logger,
  // any other factory opts exchange.ts currently takes
})
const revalidateRoute = createRevalidateHandler({
  rootToken: opts.rootToken,
  bootstrapToken: opts.bootstrapToken,
  logger: opts.ctx.logger,
  exchange: exchangeRoute,  // shares consumed-nonce set per revalidate.ts line 50 import
})
```

Verify exact factory signatures before editing — `exchange.ts:127` says "Factory that returns an /exchange handler + in-memory state hooks"; `revalidate.ts:100` says "provided /exchange route instance". Match their current shape.

- [ ] **Step 2: Pre-auth route carve-out**

Insert this block in `handle()` **after** the OPTIONS short-circuit (line 129) and **before** the `compareToken` line (line 133):

```ts
// /__redesigner/* routes authenticate via request-body tokens + Origin gate
// (see routes/exchange.ts, routes/revalidate.ts). They must bypass the
// Bearer-token check above. EXACT pathname match, POST only. Anything that
// fails these predicates falls through to the normal auth path.
if (method === 'POST' && pathname === '/__redesigner/exchange') {
  if (!tryBucket(res, req, reqId, unauthBucket)) return  // share unauth bucket pre-handler
  applyCorsHeaders(res, req)
  await exchangeRoute.handle(req, res)
  return
}
if (method === 'POST' && pathname === '/__redesigner/revalidate') {
  if (!tryBucket(res, req, reqId, unauthBucket)) return
  applyCorsHeaders(res, req)
  await revalidateRoute.handle(req, res)
  return
}
```

Method gate: GET /__redesigner/exchange falls through to the regular auth path, which will 401 it — correct. The bucket choice (`unauthBucket`) keeps the rate-limit envelope consistent with how unauthed bootstrap attempts are already treated elsewhere.

- [ ] **Step 3: Update `OPTIONS_TABLE`**

Add preflight support so browsers can CORS-check these routes:

```ts
const OPTIONS_TABLE: readonly { path: string; methods: HttpMethod | HttpMethod[] }[] = [
  // ... existing entries ...
  { path: '/__redesigner/exchange', methods: 'POST' },
  { path: '/__redesigner/revalidate', methods: 'POST' },
]
```

Remove the stale comment at line 47 ("/__redesigner/* routes are handled by exchange/revalidate standalone factories and are not in this table") since that's no longer true.

- [ ] **Step 4: Update `isKnownPath` / `allowedMethodsFor`**

`isKnownPath(pathname)` is used at line 273 for 405 resolution on wrong-method-to-known-path. Extend it so `POST /__redesigner/exchange` with any other method returns 405 not 404.

- [ ] **Step 5: Update CORS matrix**

`packages/daemon/src/routes/cors.ts` line 109 already mentions `/__redesigner/exchange` in a comment. Confirm the matrix actually allows POST from `chrome-extension://*` to these paths; add entries if missing.

- [ ] **Step 6: Smoke run**

```bash
pnpm --filter @redesigner/daemon build
pnpm --filter @redesigner/daemon test  # existing tests must still pass
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(daemon): mount /__redesigner/exchange + /__redesigner/revalidate with pre-auth carve-out"
```

---

## Task 4: Daemon integration test — exchange + revalidate round-trip [P-G4] (Sonnet)

**Files:**
- Create: `packages/daemon/test/integration/exchange.test.ts`

Spin up a real `createDaemonServer` on an ephemeral port with known bootstrapToken + rootToken, issue `POST /__redesigner/exchange` with valid + invalid payloads, assert sessionToken + exp + serverNonce, then use sessionToken as Bearer for `GET /manifest` and assert 200. Also test revalidate re-mints without bootstrapToken rotation.

Test cases to cover:
- Valid exchange with correct bootstrapToken + Origin → 200 + parseable `ExchangeResponseSchema`
- Invalid bootstrapToken → 401
- Missing Origin → 403
- clientNonce replay → 401
- sessionToken works on `GET /manifest` → 200
- `POST /__redesigner/exchange` with pre-existing rate-limit consumption behaves per spec
- `POST /__redesigner/revalidate` after successful exchange → new sessionToken, same-or-fresh serverNonce
- `GET /__redesigner/exchange` (wrong method) → 405 Allow: POST

Tip: reuse helpers from `packages/daemon/test/integration/server.test.ts` or the nearest existing server-integration test for boot/teardown plumbing. Use `fetch` (global) with explicit `Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef` header (32 lowercase letters).

- [ ] **Step 1: Write the suite**
- [ ] **Step 2: `pnpm --filter @redesigner/daemon test integration/exchange` — PASS**
- [ ] **Step 3: Commit**

```bash
git commit -m "test(daemon): exchange + revalidate HTTP roundtrip against live server"
```

---

## Task 5: Expose `readBootstrap()` on vite daemonBridge [P-G2] (Sonnet)

**Files:**
- Modify: `packages/vite/src/integration/daemonBridge.ts`

Today the bridge reads the handoff file on each shutdown call (line 283+) but only extracts `host/port/token/instanceId`. Add a `readBootstrap()` method that re-reads on every call (no caching) and returns `{ bootstrapToken, httpUrl } | null` — `null` when handoff is missing or schema-invalid. Matches the existing read-on-every-call pattern for staleness-safety.

- [ ] **Step 1: Add to the interface + class**

```ts
// inside the DaemonBridge class
readBootstrap(): { bootstrapToken: string; httpUrl: string } | null {
  if (!this.handle || !this.handoffPath) return null
  let raw: string
  try {
    raw = fs.readFileSync(this.handoffPath, 'utf8')
  } catch {
    return null
  }
  let parsed: Handoff
  try {
    parsed = JSON.parse(raw) as Handoff
    if (
      typeof parsed.bootstrapToken !== 'string' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number'
    ) {
      return null
    }
  } catch {
    return null
  }
  return {
    bootstrapToken: parsed.bootstrapToken,
    httpUrl: `http://${parsed.host}:${parsed.port}`,
  }
}
```

The inline `Handoff` interface at `daemonBridge.ts:59` needs the new field added. Keep the interface self-contained (comment at line 54 explains why).

- [ ] **Step 2: Type check + build**

```bash
pnpm --filter @redesigner/vite exec tsc --noEmit
pnpm --filter @redesigner/vite build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(vite): expose readBootstrap() on daemonBridge"
```

---

## Task 6: Replace vite `bootstrap.ts` `mint()` with handoff-read [P-G3] (Sonnet)

**Files:**
- Modify: `packages/vite/src/bootstrap.ts`
- Modify: `packages/vite/src/plugin.ts` (wiring)

Drop local `mint()` + `rotate()`. Replace with a reader that calls `daemonBridge.readBootstrap().bootstrapToken` on each handshake request. Keep the `BootstrapState` interface shape so call sites don't change. If the bridge returns null (daemon not yet started), the handshake middleware already returns 503 via the downstream `daemon` check at line 152 — route that through by returning a sentinel.

- [ ] **Step 1: Replace `createBootstrapState`**

```ts
// packages/vite/src/bootstrap.ts
export interface BootstrapState {
  current(): string | null
}

export function createBootstrapState(opts: {
  readBootstrap: () => { bootstrapToken: string } | null
}): BootstrapState {
  return {
    current: () => opts.readBootstrap()?.bootstrapToken ?? null,
  }
}
```

- [ ] **Step 2: Handle null in the handshake middleware**

At `bootstrap.ts:171` `const token = opts.bootstrap.current()` — if null, return the same 503 response the middleware already uses when `opts.getDaemonInfo()` returns null. Reuse that branch.

- [ ] **Step 3: Wire in plugin.ts**

At `plugin.ts` where `createBootstrapState(...)` is called, pass `readBootstrap: () => daemonBridge.readBootstrap()`. The bridge instance is already available there (used for shutdown).

- [ ] **Step 4: Drop the `X-Redesigner-Bootstrap` header if daemon is null**

`bootstrap.ts:200` sets `res.setHeader('X-Redesigner-Bootstrap', token)`. Guard: only set when token is non-null (we'll have returned 503 before reaching this on null, but defensive).

- [ ] **Step 5: Delete dead code**

The local `mint()` function, any `rotate()` method, and their tests become dead. Delete them — don't leave for "later".

- [ ] **Step 6: Build + commit**

```bash
pnpm --filter @redesigner/vite build
git commit -m "feat(vite): read bootstrapToken from daemon handoff, drop local mint"
```

---

## Task 7: Vite bootstrap handoff-read test [P-G4] (Sonnet)

**Files:**
- Modify or create: `packages/vite/test/bootstrap.test.ts`

Write a unit test that stubs `readBootstrap` (injectable) and asserts the middleware returns the injected token in the JSON body + in `X-Redesigner-Bootstrap`. Second test: `readBootstrap` returns null → middleware returns 503. These are bootstrap-state unit tests, not full vite-middleware roundtrips — those are already covered elsewhere.

If the existing test used mocks of the removed `mint()`/`rotate()`, update them to match the new shape.

- [ ] **Step 1: Write test**
- [ ] **Step 2: `pnpm --filter @redesigner/vite test bootstrap` — PASS**
- [ ] **Step 3: Commit**

```bash
git commit -m "test(vite): bootstrap reads from injected handoff reader"
```

---

## Task 8: End-to-end verification — ext picks → daemon /manifest via exchange (Sonnet, sequential)

**Files:**
- Possibly new: `packages/ext/test/e2e/nightly/exchange-live.spec.ts` (post-v0 harness, `PW_FULL_HARNESS=1` gated per CLAUDE.md)
- Manual verification checklist appended to: `packages/ext/docs/EXT_DOGFOOD.md` (or equivalent — check which doc PR #17 updated)

Automated Playwright test runs end-to-end: start daemon, start vite with the plugin loaded, load the ext unpacked, open playground, arm picker (⌥⇧D), click a component, assert the panel SelectionCard renders. Gate behind `PW_FULL_HARNESS=1` per CLAUDE.md invariant.

Manual verification steps to append to EXT_DOGFOOD.md:
1. `pnpm --filter @redesigner/vite dev` (starts daemon automatically via plugin)
2. Load `packages/ext/dist` unpacked at `chrome://extensions`
3. Open `http://localhost:5173/`
4. Open side panel — Welcome should read "Detected: http://localhost:5173 — open?"
5. Press ⌥⇧D, hover, click
6. SelectionCard appears with `src/components/PricingCard.tsx:3`
7. SW console shows `[redesigner:sw] selection pushed` with no 401
8. DevTools Network tab shows `POST /__redesigner/exchange` → 200 and `GET /manifest` → 200

- [ ] **Step 1: Write the Playwright spec**
- [ ] **Step 2: Run manually with `PW_FULL_HARNESS=1 pnpm --filter @redesigner/ext test:e2e`**
- [ ] **Step 3: Append manual verification steps to EXT_DOGFOOD.md**
- [ ] **Step 4: Commit**

```bash
git commit -m "test(ext): e2e exchange + pick via real daemon (PW_FULL_HARNESS)"
```

---

## Rotation semantics (informational — no task, already works)

Daemon restart → new bootstrapToken → new handoff written atomically. Vite re-reads on every handshake-JSON call (no cache). CS observes `<meta name="redesigner-daemon">` via MutationObserver (already wired in `content/index.ts:86`), re-runs `performHandshake()`, sends a fresh `register` message. SW stores the new bootstrapToken per-tab. Next `get-manifest` triggers a fresh exchange with the new token. No additional code needed.

## Out of scope

- WS subprotocol bearer wiring (ext→daemon WS path). Existing wsClient.ts handles this; Task 8 verifies only the REST path works.
- MCP shim reading selection from daemon `/tabs/{tabId}/selection`. Selection PUT from SW is its own follow-up task.
- Extension-id TOFU rotation after ext reload — covered by daemon's existing auto-reset window in `routes/exchange.ts`.

## Self-review

- [x] Every task has exact file paths
- [x] Security-critical carve-out (T3) calls out the bypass risk in plain language
- [x] Rotation story explicit (handoff re-read every request)
- [x] No task depends on a type/method defined in a later task
- [x] Model assignments justified per task class
- [x] Parallelism groups have no cross-dependencies
