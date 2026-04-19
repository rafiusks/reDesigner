# Chrome Extension v0 — Design Spec

**Goal:** Ship the fourth piece of reDesigner v0 per `brief.md` §4 — a Chrome MV3 extension that lets developers pick a DOM element in a running dev build, extracts a `ComponentHandle`, and pushes it to the project's daemon so Claude Code (via the MCP shim) can read the current selection.

**Status:** Design approved 2026-04-19. Implementation plan to follow.

**Architecture summary:** MV3 service worker is the single custodian of credentials, WebSocket connections, REST calls, and manifest cache. Content script handles meta-tag probe, picker overlay, and DOM reads only — never holds tokens, never issues REST. Single global side panel renders per-tab state via React. Shared schemas live in `@redesigner/core`, split into `/schemas` (Zod runtime) and `/types` (erased) subpath exports so the panel can import types without pulling the Zod bundle. Daemon and Vite plugin receive small, tightly-scoped additions.

---

## 1. Scope

**In scope:**

- MV3 extension at `packages/ext/` (pnpm workspace package).
- Element picker overlay with hover-highlight, click-to-pin, **Esc to cancel**, **keyboard shortcut to arm** (manifest ships `arm-picker` with `suggested_key: { default: "Alt+Shift+D", mac: "Alt+Shift+D" }` — `Alt+Shift+D` ("D" for Designer) avoids the known collisions: Firefox Web Console (`Cmd/Ctrl+Shift+K`), Chromium tab-duplicate (`Ctrl+Shift+K` on Edge/Brave), Chrome's `Cmd+Shift+0` "Actual Size" zoom on macOS, and the macOS `Option+Shift+P` dead-key that inserts `∏` into text inputs. Collision detection via `chrome.commands.getAll()` runs on panel first open AND on every `chrome.windows.onFocusChanged` into the panel; if the `arm-picker` entry shows unbound (user or another extension claimed the chord post-install), panel footer + first-run toast surface a "Set your shortcut" link to `chrome://extensions/shortcuts`. All user-facing strings that mention the chord are read live from `chrome.commands.getAll()` — never hardcoded — so the toolbar tooltip, PickerToggle label, first-run toast, and ShortcutsFooter always match the actual bound chord. Day-1 bet: most users keep the default and get picker access in one chord; collision-affected users get explicit remediation. One-shot by default; `Alt+click` keeps pick mode armed. The extension toolbar icon switches to an "armed" variant via `chrome.action.setIcon` whenever any tab's picker is armed; hover tooltip reads "Picking… click to cancel" so the click-to-cancel affordance is discoverable. Unarmed icon tooltip: "reDesigner — click to open panel, Cmd+Shift+K to pick" (dynamic, collapses to "…set a shortcut to pick" when unbound).
- Single-select only in v0 — enforced at Zod with `nodes.min(1).max(1)`. Wire shape future-proofed by the `{ nodes: ComponentHandle[] }` envelope; `capabilities.multiSelect: false` in hello frame.
- **Service worker is the sole holder of credentials and the only party making REST calls** to the daemon. Content script never holds the session token and never issues `fetch` to the daemon. Session tokens are persisted to `chrome.storage.session`, which **defaults to `TRUSTED_CONTEXTS` access-level** — CS cannot `get()` them. The CS bundle **must not import `chrome.storage` at all** (ESLint `no-restricted-imports` rejects the import path in `src/content/**`; Tier-2 regression test asserts the CS bundle output contains no `chrome.storage` references). The `storage.onChanged` event-shape behaviour of `TRUSTED_CONTEXTS` is *fires in CS with `newValue === undefined`* (keys are observable, values are not) — the import ban is a **defense-in-depth style rule, not a security boundary**; the security control is the randomized opaque key name (`s_<crypto.randomUUID()>` per boot — see §6.4) that prevents key-name observation from revealing content presence or change frequency. With `minimum_chrome_version: "120"`, `setAccessLevel('TRUSTED_CONTEXTS')` is stable and the older-Chrome throw-and-fallback branch is removed as dead code. Bootstrap-to-session exchange only happens on cold boot or when `exp` approaches; post-wake recovery does NOT pay an extra exchange RTT under the happy path. **inFlightRpc persistence is awaited** (single `storage.session.set`) before the `onMessage` handler returns `true` / calls `sendResponse` — "synchronous" was misleading since `storage.session.set` is a Promise; spec convention is "awaited before commit." RPC replies for deadlines synthesized on SW wake are delivered **via the WebSocket return path** to the daemon (the daemon owns forwarding to the MCP caller — `chrome.runtime.sendMessage` cannot reach the MCP Node process); the hydrate pass iterates `inFlightRpc` older than `deadlineMs` and emits synthetic `extension-timeout` replies on the WS upstream, which the daemon routes back to the originating MCP request.
- Side panel with connection state, current selection, recent list (≤10), "Pick element" toggle, open-in-editor deeplink, **first-run welcome with pin-icon screenshot**, **per-tab state** (single global panel; re-renders per `tabs.onActivated` + `windows.onFocusChanged` via a single `useSyncExternalStore`), **shortcut cheat-sheet line** in panel footer, **debug drawer** (`Shift+D` panel-focused chord — footer label is scoped "Shift+D debug (panel)").
- Handshake discovery via `<meta name="redesigner-daemon">` injected by the Vite plugin during `serve`. Meta-tag token is a **one-shot bootstrap credential** that CS forwards to the SW; the SW exchanges it for a session token. Bootstrap rotates on a daemon-side timer (1 hour) and via `handshake.rotated` frame. Session token lives in SW's `TRUSTED_CONTEXTS` `storage.session`; never in the DOM, never in page-readable storage, never logged.
- Daemon-side changes: subprotocol-bearer WS auth with **k8s-accurate echo contract** (`base64url.bearer.authorization.redesigner.dev.<sessionTokenB64URL>`; server MUST echo `redesigner-v1` only — never the bearer; bearer-only offer rejects with 1002; case-insensitive subprotocol comparison). Transport **version negotiation via subprotocol list**: client offers `['redesigner-v2', 'redesigner-v1', 'bearer…']`, server echoes highest supported (v0 supports `redesigner-v1`). `?v=` kept as a **list** query param for defense-in-depth + audit; server picks highest. Version mismatch on both channels → 4406 close with `accepted: <list>` in close-reason JSON so client knows what to retry. **Host-header literal-set allowlist** on every HTTP + WS upgrade. **Uniform 1002** on any auth failure (no 4401 oracle). **CORS** for dev-server origins. **Per-(Origin, wsUrl) rate-limit** LRU 256. **App-level ping 20 s**. **`PUT /selection`** primary; `POST /selection` returns 405 with `Allow: PUT` and `problem+json` body carrying `apiErrorCode: 'method-not-allowed'` pointing at migration docs — no dual-verb trap. **`/__redesigner/exchange`** endpoint. **`/health`** session-token-gated only. `?since=0` valid and distinct from absent.
- Vite plugin additions: `/__redesigner/handshake.json` middleware (`apply: 'serve'`, Host-allowlist gated, response carries `bootstrapToken` as a **response header** in addition to JSON body so third-party same-origin scripts parsing the HTML don't see it from DOM alone — body is retained for compat; header is the canonical source CS reads), `transformIndexHtml` meta-tag injection (serve-only), `editor?:` plugin option with Zod allowlist, minimum Vite version pin **≥ 5.4.19 or ≥ 6.2.7** with runtime CVE-range refuse-to-start.
- WS frame schemas move to `@redesigner/core` with `/schemas` subpath export (Zod runtime) and `/types` subpath export (erased TS types). Side panel imports only from `/types`. `z.toJSONSchema()` output snapshotted to committed `.snap` files (discipline mirrors vite fixtures; `GOLDEN_CHANGELOG.md` gates golden edits).
- CRXJS **tilde-patch pin** (`~2.y.z`, patch range only) to ride patch releases from the now-active maintainer team; named **tripwire** (unresolved P1 bug >30 days or CSP-violation blocking panel load) triggers migration to WXT or hand-rolled Vite multi-entry. `docs/ext-build-migration.md` committed at project start.
- **Backfill on install**: `chrome.runtime.onInstalled` runs `chrome.scripting.executeScript` against all allow-listed tabs matching `http://localhost/*` to inject the content script into pre-existing dev-server tabs (MV3 CS does not auto-inject on install).

**Out of scope for v0 (tracked for v0.1+):**

- Shift-click multi-select pinning.
- Cross-origin iframes (`all_frames: false`). Requires `frameId` in the handle schema.
- HTTPS localhost.
- Ext-ID binding for Web-Store builds (`externally_connectable` + `chrome.management` detection of co-installed localhost-permissioned extensions for a panel warning).
- Keyboard-driven pick ancestor walk, JSON-RPC batching, SSE transport, short-interval session rotation, multi-project panel selector, CS-hosted in-page toolbar, `all_frames: true` + `frameId`.
- Stable docs URLs for `apiErrorCode` slugs (plan: `https://redesigner.dev/errors/{slug}` pages shipped concurrently with v0; RFC 9457 `type` URL uses these from day one even if a few 404 initially — doc pages auto-generated from the error enum).

---

## 2. File structure

```
packages/ext/
├── package.json                       # @redesigner/ext; core deps split: core/schemas (Zod) + core/types (erased)
├── vite.config.ts                     # crxjs/vite-plugin ~2.x
├── manifest.json                      # MV3; `minimum_chrome_version: "120"` (Popover top-layer+dialog regressions fixed ≤119; `chrome.alarms` 30s minimum; `storage.session.setAccessLevel` stable); commands entry with `suggested_key: Alt+Shift+D`; action icons; host_permissions for localhost
├── docs/ext-build-migration.md        # CRXJS→WXT/hand-rolled runbook
├── src/
│   ├── sw/
│   │   ├── index.ts                   # SW entry; ALL chrome.* .addListener calls at module top level, synchronously, before any await (ESLint rule `no-restricted-syntax` forbids addListener inside async fn bodies); hydrate failure path calls sendResponse with error
│   │   ├── hydrate.ts                 # storage.session w/ TRUSTED_CONTEXTS; readyPromise with .catch surfacing errors to pending handlers; split fast (no-debounce) / slow (1s)
│   │   ├── connPool.ts                # Map<wsUrl, ConnState>; per-key creation lock; refcount; LRU cap; re-arm cooldown
│   │   ├── wsClient.ts                # close-code reducer nextState() pure fn; 1002 triggers session-revalidate probe BEFORE burning attempts budget
│   │   ├── rpc.ts                     # inflight map; synchronous persist on insertion; monotonic counter; grace-window after SW wake before heartbeat-timeout decisions
│   │   ├── rest.ts                    # ALL daemon REST (PUT /selection, /exchange, /health probe, /manifest, proxies)
│   │   ├── exchange.ts                # bootstrap → session; handshake.rotated handler; sessionToken persisted TRUSTED_CONTEXTS
│   │   ├── manifestCache.ts           # per-wsUrl; seq-tagged atomic swap; single-flight with wake-safe reset on hydrate
│   │   ├── panelPort.ts               # runtime.Port fan-out with windowId; snapshot includes pickActive; disconnect-during-broadcast safe; maintains a **per-(windowId, tabId) cached snapshot ref map** (single-ref design would tear across tab switches); subscribe accepts `(windowId, tabId)` tuple; each entry initializes with sentinel `{status:'hydrating'}`; ref replaced only on explicit per-key `version:number` bump triggered by SW push OR `tabs.onActivated` / `windows.onFocusChanged` events; `getSnapshot(windowId, tabId)` returns the keyed cached ref directly, never recomputes, never throws; `getServerSnapshot = getSnapshot` (same function, same cached ref — stable under React 18.3+/19 dev warnings that require getServerSnapshot presence)
│   │   ├── actionIcon.ts              # coalesced debounced setter driven by tabs.some(t => pickerArmed); tooltip copy varies armed/unarmed/no-shortcut-bound
│   │   ├── commands.ts                # chrome.commands.onCommand + getAll() at panel mount for collision detection
│   │   ├── backfill.ts                # onInstalled executeScript into pre-existing localhost/* tabs
│   │   └── metrics.ts                 # /debug/state (env-gated)
│   ├── content/
│   │   ├── index.ts                   # CS entry (document_end + MutationObserver on <head>)
│   │   ├── handshake.ts               # fetches /__redesigner/handshake.json with credentials:omit — reads bootstrap from response header (body retained for compat); forwards to SW
│   │   ├── register.ts                # register envelope {wsUrl, httpUrl, bootstrapToken, editor, tabId, windowId, clientId}
│   │   ├── picker.ts                  # single shadow host with popover="manual" on host; host contains both capture layer AND highlight rect; capture layer pointer-events:auto, rect pointer-events:none
│   │   ├── hitTest.ts                 # document-rooted elementsFromPoint recursion; overlay-filter; closed-shadow bubble-OUT allowed, closed-in blocked
│   │   ├── extractHandle.ts           # async; awaits SW-forwarded manifest data; 3s deadline decoupled from reconnect; checks lastHoverTarget.isConnected
│   │   ├── stableId.ts                # deterministic id; monotonic pick counter drops out-of-order resolves
│   │   └── rpcAgent.ts                # rpc.request → DOM read → reply; 2s armed heartbeat to SW
│   ├── panel/
│   │   ├── index.tsx                  # React entry; skeleton UI before SW port reply; imports only from @redesigner/core/types
│   │   ├── App.tsx                    # useSyncExternalStore over (windowId, tabId)
│   │   ├── Welcome.tsx                # first-run: install snippet + port probe polling every 3-5s for ~2 min (not just a one-shot); pin-icon screenshot; auto-transitions to success when handshake appears
│   │   ├── ConnectionBadge.tsx        # 5 states (off / connecting / connected / error / mcp-missing); shape-a11y ring not tint-only; labeled on hover for low-vision users
│   │   ├── SelectionCard.tsx          # "Still reachable from Claude Code" pip
│   │   ├── RecentList.tsx             # code-split
│   │   ├── PickerToggle.tsx
│   │   ├── ShortcutsFooter.tsx        # cheat sheet; "Shift+D debug (panel)" scope marker; shortcut line reads live from chrome.commands.getAll()
│   │   ├── EmptyStates.tsx            # branched copy by location.origin
│   │   ├── ErrorBanners.tsx           # concise copy; no countdown in primary; spinner + "Reconnecting to dev server"; countdown only surfaced when budget expires
│   │   ├── Debug.tsx                  # Shift+D
│   │   └── hooks/usePanelPort.ts      # reconnect on disconnect; on port.onDisconnect panel enters dimmed "resync" transient until first TAB_STATE frame on new port; SW sends full snapshot on runtime.onConnect (handles SW-wake port churn)
│   └── shared/
│       ├── messages.ts                # Zod envelopes (separate namespace from wsFrames)
│       ├── editors.ts                 # allowlist + URL builders + project-root constraint
│       ├── random.ts                  # nextFullJitterDelay(attempts) — full jitter (random(0, min(cap, base*2^n))); swap from decorrelated
│       ├── clock.ts                   # now() injectable
│       ├── constants.ts               # ping=20s, pong-timeout=5s, manifestCacheDeadline=3000ms, backoffCapMs=30000, baseMs=1000, welcomePollMs=3000, welcomePollDurationMs=120000
│       └── errors.ts                  # re-export from @redesigner/core/schemas/errors
├── test/
│   ├── unit/                          # Vitest, happy-dom; fake-timer deny list covers ALL sync variants
│   ├── integration/                   # Vitest forks + isolate:true + chromeMock + real ws
│   ├── picker/                        # @vitest/browser real Chromium; channel pinned
│   ├── contract/                      # goldens committed; CI gate requires daemon test in same run
│   └── e2e/                           # Playwright + CDP; @smoke on PR, @nightly full
├── test/chromeMock/                   # per-namespace; fidelity test runs on PR touching chromeMock OR integration/**
└── playwright.config.ts
```

Daemon side (additions):

- `packages/daemon/src/auth.ts` — `extractSubprotocolToken(req)` fixed-prefix suffix parse (not split); redaction glob for `sec-websocket-protocol` (case-insensitive), `authorization`, `token`, `x-*-token`.
- `packages/daemon/src/hostAllow.ts` — literal-set match; 421 mismatch.
- `packages/daemon/src/ws/events.ts` — subprotocol auth k8s shape; **server echoes highest supported from `redesigner-v*` list**; echoes `redesigner-v1` only (never bearer); bearer-only offer → 1002; uniform 1002 on any auth failure. `?v=` is a list; server picks highest; mismatch → 4406 with close-reason JSON `{accepted:[1]}`. Per-(Origin, wsUrl) rate-limit LRU 256. 20 s app ping. 5 s pong-timeout → 4408.
- `packages/daemon/src/routes/selection.ts` — `PUT /tabs/{tabId}/selection` (resource URL — future-proofs `If-Match: <selectionSeq>` for v0.1 without a breaking rename). `selectionSeq` is **per-tab**, not global — prevents cross-tab writers from appearing as races on the monitored tab. Legacy `PUT /selection` returns **410 Gone** with problem body `apiErrorCode: 'endpoint-moved'` + `detail` naming the tab-scoped URL. 308 redirect was considered and rejected: CORS preflights cannot follow 308 cross-origin and `Authorization` is stripped on cross-origin redirect, so the redirect would fail silently — 410 forces a clean client bump. `POST` → 405 with `Allow: PUT`, problem body `apiErrorCode: 'method-not-allowed'`. `Deprecation`/`Sunset` headers **dropped** — `POST` was never supported, so RFC-9745 semantics do not apply.
- `packages/daemon/src/routes/exchange.ts` — gates: Host + `Sec-Fetch-Site ∈ {none, cross-site}` + `chrome-extension://*` Origin (literal-set per dev-mode rules above) + per-`(Origin, peerAddr)` failed-exchange bucket (NOT `clientNonce-prefix`, which is trivially evaded by iterating nonces). Request `{ clientNonce, bootstrapToken }`. Response `{ sessionToken, exp: <≤300s>, serverNonce }` (**short exp** limits residual mint window since co-ext attack cannot be structurally prevented in v0 without ext-ID binding). Session token = `HMAC(rootToken, clientNonce, serverNonce, iat)` base64url-no-pad; `serverNonce` is fresh-random per mint. SW verifies `serverNonce` is echoed by subsequent `hello` (as `hello.serverNonceEcho`) and aborts WS on mismatch — defense-in-depth against replayed exchange responses. Bootstrap + clientNonce one-shot. Bootstrap rotates every 1 hour + pushes `handshake.rotated` frame. **All token comparisons** (bootstrap/session in exchange.ts + auth.ts) route through `compareToken` (length-normalized `timingSafeEqual` helper) — CI grep rejects raw `===` against any identifier matching `*Token*` or `*token*`.
- `packages/daemon/src/routes/cors.ts` — OPTIONS; enumerated closed method set asserted by routed-verb test; `Vary: Origin, Access-Control-Request-Headers` on **every** CORS-reachable response (2xx/3xx/4xx/5xx, including preflights — browsers cache preflights keyed on request-header set); credentials false runtime-asserted + Cookie-on-credentialed-route rejected. Problem bodies carry `Content-Type: application/problem+json; charset=utf-8` explicitly per RFC 9457 §3.
- `packages/daemon/src/routes/debug.ts` — env-gated JSON.
- `packages/daemon/src/server.ts` — Host → OPTIONS → CORS → `Sec-Fetch-Site` compound predicate → auth. **Binds to `127.0.0.1` explicitly** (and `[::1]` when IPv6 is enabled); never `0.0.0.0` or `[::]`. **Host-header literal allowlist is enumerated**: `localhost:<port>`, `127.0.0.1:<port>`, `[::1]:<port>` only. Any other authority — raw non-loopback IP, `0.0.0.0`, `[::]`, `[::ffff:127.0.0.1]`, `localhost.<suffix>`, or any DNS-rebinding remnant — returns 421 Misdirected Request. **`Origin` header is literal-set validated** on every state-changing endpoint (exchange, PUT, debug) in addition to Host, because browsers put page origin in `Origin`, not `Host`. Non-authorized from non-allowlisted Origin → socket reset. **Version handshake**: WS upgrades require `Sec-WebSocket-Version: 13` (RFC 6455); any other value → 426 Upgrade Required with `Sec-WebSocket-Version: 13` response header. **Extension-origin TOFU pinning** (replaces earlier wildcard-accept): on first successful `/exchange`, daemon writes the extension ID to `$runtimeDir/trusted-ext-id`. Subsequent `/exchange` calls from a **different** `chrome-extension://` origin are rejected with **403 + `apiErrorCode: 'unknown-extension'`** and the unknown ID is pushed to the panel as a warning ("Unknown extension tried to connect: <id> — if this wasn't you, uninstall it"). **Unpacked-dev-reload handling**: unpacked extensions rotate their generated ID on each reload-from-disk unless the manifest declares a stable `"key"` field — `packages/ext/manifest.json` MUST include a `"key"` field for dev builds (CI-asserted). Additionally, TOFU auto-resets when all three conditions hold: no `trusted-ext-id` file exists, the daemon has just started, and only one `chrome-extension://` origin has connected within the first 10 s of boot. Explicit CLI `--extension-id <id>` + `--trust-any-extension` flag (default off) override TOFU. This is not full ext-ID binding (which needs Web-Store signed IDs) but closes the wildcard dev-mode hole.
- `packages/daemon/src/routes/browserTools.ts` — dispatch by JSON-RPC `error.code`; `apiErrorCode` slug on REST; crosswalk and reverse crosswalk `ApiErrorCodeToRpc` with type-level exhaustiveness.
- `packages/daemon/src/routes/health.ts` — session-token-gated only. Returns `{ ok: true }` JSON (no `X-Daemon-InstanceId` header — duplicated source of identity dropped; MCP / ext get instanceId from `hello`).
- Logger: structured redaction + CI grep 0-match (sentinel token AND fixture path fragments) + explicit test that 4xx close frames / 421 bodies / access logs never contain the subprotocol.
- Daemon IPC unref test (SIGTERM ≤ 200 ms).
- **DevTools-visibility docs**: threat-model doc explicitly lists `chrome://net-export`, SW DevTools Network panel, and reverse-proxy access logs as subprotocol-exposure surfaces.

Vite plugin:

- `editor` Zod at plugin boot; invalid → console.warn + default.
- `/__redesigner/handshake.json` always-open during serve; Host-gated; returns `bootstrapToken` **in a response header** `X-Redesigner-Bootstrap` (CS fetches with `credentials: 'omit'` and reads the header; body retains the token for backward debugging but CS prefers header) — reduces scrape surface from same-origin inline scripts.
- `transformIndexHtml` meta serve-only with `{ wsUrl, httpUrl, bootstrapToken, editor, pluginVersion, daemonVersion }`.
- Min Vite pin `>=5.4.19 || >=6.2.7`; runtime refuse-to-start on CVE-2025-30208/31125/31486/32395/30231 ranges.

Core side:

- `packages/core/src/schemas/wsFrames.ts` — envelope `{ type, seq?, payload }` (no `v`); envelope `.strict()` to force additive-only via new frame `type`s; payload `.strict()`. Snapshots per-frame `z.toJSONSchema()` → committed `.snap`.
- `packages/core/src/schemas/handshake.ts` — `HandshakeSchema`, `EditorSchema`, `ExchangeRequestSchema`, `ExchangeResponseSchema`.
- `packages/core/src/schemas/errors.ts` — `RpcErrorCode` (JSON-RPC numeric), `ApiErrorCode` (REST slug), `ErrorCrosswalk` + `ApiErrorCodeToRpc: Record<ApiErrorCode, RpcErrorCode | null>` + `ApiErrorCodeToHttpStatus`, `ProblemDetailSchema` with `apiErrorCode: string` extension and `type: https://redesigner.dev/errors/{apiErrorCode}` URI (not `about:blank`).
- `packages/core/src/types/*.ts` — erased TS types re-exported from schemas; panel-safe subpath.
- `packages/core/src/schema.ts` — `SelectionPutBodySchema`, `SelectionPutResponseSchema` (carries `{ selectionSeq, acceptedAt }`).
- `packages/core/src/types.test-d.ts` — `Expect<Equal>` + `expectTypeOf` per payload.
- `packages/core/test/parity.test.ts` — snapshots + cross-pkg module-identity assertion.

---

## 3. Architecture

### 3.1 Boundaries

Unchanged from prior revisions; clarifications:

- SW owns credentials, REST, WS, manifest cache.
- CS credential-free; owns DOM/picker only.
- Panel imports types only (no Zod runtime) from `@redesigner/core/types`.

### 3.2 Daemon and Vite-plugin additions

- **Subprotocol echo contract** (explicit):
  - Client offers `['redesigner-v2', 'redesigner-v1', 'base64url.bearer.authorization.redesigner.dev.<b64url(tokenBytes)>']` with the `redesigner-v*` versions in preference order. (v0 clients only offer `v1` — `v2` slot reserved for future.)
  - Server selects **highest supported `redesigner-v*`** it knows; echoes that single value in `Sec-WebSocket-Protocol`. **MUST NOT echo the bearer entry.**
  - If client offers only the bearer entry (no `redesigner-v*`) → server rejects with 1002 close (no valid app protocol to echo).
  - Client asserts `websocket.protocol === expected` after open, where `expected = highest redesigner-v* the client offered AND supports`. If server echoes a higher v* than the client supports (forward-compat upgrade path), client treats it as a version mismatch (closes 4406 locally and retries with `?v=<highest-supported>` only). Catches buggy proxies that strip the echo AND forward-compat server drift.
  - Comparison is case-insensitive on the `redesigner-v*` token per RFC 6455 token semantics; bearer slot is treated literally.
- **Version negotiation fallback**: both `?v=` (list) and subprotocol list are negotiated. Server picks highest it supports, echoes that in the protocol response AND in `hello.negotiatedV`. Mismatch: 4406 close, close-reason JSON `{accepted:[1]}` so a v2-only client can drop to v1 without page reload.
- **1002 close triggers session-revalidate probe** before burning the reconnect attempts budget. The reducer's 1002 branch first calls `sessionRevalidate()` (a fresh `/exchange` call using stored `bootstrapToken`); on success, next attempt uses the new session token (no budget burn). On failure, falls through to normal backoff + banner.
- `PUT /selection` only. `POST /selection` → 405 with `Allow: PUT` + problem body.
- Host-header allowlist, CORS, rate-limit, ping/pong, exchange endpoint, logger redaction, `/health`, debug endpoint: per prior revisions + bucket key fixes (**exchange bucket by `(Origin, peerAddr)`** — `clientNonce` is attacker-chosen and trivially evaded; `peerAddr` is the only attacker-unforgeable axis on localhost; ext-ID augments when available but peerAddr is the floor). Upgrade bucket by `(Origin, wsUrl)`.
- `Sec-Fetch-Site` on credentialed routes: `{ same-origin, none }`. `same-site` dropped.
- `/health` session-token-gated; no Origin-only code path; instanceId only via `hello` frame.

Vite plugin:

- Handshake JSON served with `X-Redesigner-Bootstrap` response header; CS prefers header to body. Route gated on: Host literal-set (prior), **and** `(Origin absent OR Origin ∈ chrome-extension://<allowlist>) AND Sec-Fetch-Site ∈ {none, cross-site} AND Sec-Fetch-Dest: empty` — without these, a page post-DNS-rebind can fetch and harvest the bootstrap from the response header. Reject any request that does not match with 403.
- `editor` Zod at plugin boot.
- Vite version pin + runtime CVE check.

### 3.2.1 JSON-RPC 2.0 envelope

WebSocket is JSON-RPC 2.0 over `redesigner-v1`. Server→client events are JSON-RPC *notifications* (no `id`); client→server `rpc.request` and server-initiated calls-needing-reply are JSON-RPC *requests* with `id`.

- `jsonrpc: "2.0"` is required on every frame.
- `id: string` (UUIDv4) on requests; **never numeric, never null** — nulls are reserved for "response to unknown id" which is not used here; numerics risk collisions on reconnect-resumed inflight.
- Notifications omit `id` entirely. Server MUST NOT reply.
- **Batching is not supported in v0.** Any array frame → reply with `{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request — batch not supported in v0" } }` on the same WS connection. **Do NOT close** after — per JSON-RPC spec, a single malformed frame produces an error response; connection survives. Closing 1002 would turn a spec-error into a DoS vector for a misbehaving or legacy client.
- Method registry (v1): `rpc.request` (request), `selection.updated` (notification), `handshake.rotated` (notification), `resync.instanceChanged` (notification), `resync.gap` (notification), `hello` (notification at connect), `ping` / `pong` (app-level notifications).
- `seq` lives inside the notification's `params` for replay coordination (not as a top-level envelope field — keeps JSON-RPC purity).
- `hello.params` carries `{ serverVersion, instanceId, snapshotSeq, negotiatedV, serverNonceEcho, capabilities: { multiSelect: false, supportedVersions: [1] } }`.

### 3.3 Cross-transport error taxonomy

```ts
// @redesigner/core/src/schemas/errors.ts

export enum RpcErrorCode { /* …as before, JSON-RPC numeric, -32000..-32099 */ }

export type ApiErrorCode =
  | 'extension-disconnected' | 'extension-timeout' | 'extension-no-active-pick'
  | 'element-not-found' | 'result-too-large' | 'shutdown' | 'instance-changed'
  | 'rate-limit-exceeded' | 'version-not-acceptable' | 'invalid-params'
  | 'internal-error' | 'host-rejected' | 'method-not-allowed' | 'not-found'

export const ErrorCrosswalk: Record<RpcErrorCode, ApiErrorCode> = { /* ... */ }
export const ApiErrorCodeToRpc: Record<ApiErrorCode, RpcErrorCode | null> = { /* null = REST-only */ }
export const ApiErrorCodeToHttpStatus: Record<ApiErrorCode, number> = { /* ... */ }
```

RFC 9457 problem body:

```json
{
  "type": "https://redesigner.dev/errors/extension-disconnected",
  "title": "Extension disconnected",
  "status": 503,
  "apiErrorCode": "extension-disconnected",
  "detail": "No active pick from a connected extension.",
  "instance": "/requests/abc123-4def-..."
}
```

`type` URL ships with v0 even if pages initially stub (auto-generated from the enum). Both `status` + `apiErrorCode` slug are populated on every error — per RFC 9457 §3, `type` is the primary human-readable discriminator + documentation link, and **`apiErrorCode` is the canonical machine-readable discriminator** clients must switch on. Slug enum retains `method-not-allowed` and `not-found` as first-class values. `ApiErrorCodeToRpc` and `ApiErrorCodeToHttpStatus` are **total** records keyed on every enum member — a type-level exhaustiveness test (`packages/core/test/crosswalk.test.ts`) asserts both `Object.keys` equality and `Record<ApiErrorCode, ...>` compile-time completeness. JSON-RPC error `code` values live in the reserved server-error range `-32000..-32099` per JSON-RPC 2.0 §5.1. Slugs stable. `instance` uses relative URI form (`/requests/<uuid>`) resolvable against the daemon base, not ad-hoc `urn:` (which is unregistered and non-resolving).

### 3.4 Chosen architectural approach

Unchanged.

---

## 4. Data flow

### 4.0 MCP shim setup (user flow, Day-1)

The extension ↔ daemon ↔ MCP chain is only user-visible at two points: installing the extension and wiring the MCP shim into Claude Code. Skipping the shim means picking elements works internally but Claude Code never sees the selection — the single loudest retention cliff (spec R-series reviews flagged it repeatedly as a silent churn driver). Welcome tab is therefore a **3-step** flow:

1. **Pin the toolbar icon** (animated GIF of the puzzle-piece → pin gesture).
2. **Wire the MCP shim** with a one-line copy-paste: `claude mcp add --transport stdio redesigner -- <daemon-runtime-path>/mcp.sh` (note the `--` separator — current `claude mcp` CLI treats `<path>` as an option arg without it). Snippet is generated at first successful handshake — the SW knows the daemon's runtime dir from the handoff file and renders the exact command, **contract-tested against `claude mcp --help`** to catch future CLI drift. Below the snippet: "Then restart Claude Code (`/exit` then reopen)" — MCP servers are loaded at session start, an already-running `claude` process won't pick up the new config. "Verify" button asks the daemon whether an MCP client has connected in the current session; failure copy reads "If Verify fails, restart Claude Code."
3. **Try it**: "Pick an element on your dev-server tab, then ask Claude 'what's my current selection?'"

ConnectionBadge carries a distinct fourth state for this: `mcp-missing` (daemon connected, no MCP client ever connected). Daemon surfaces MCP-client presence in `hello.capabilities.mcpWired` and in a dedicated `mcp.clientChanged` notification; panel reflects this in ConnectionBadge and in SelectionCard's chip (see §7.4).

### 4.1 Cold boot

1. `vite dev` starts, plugin mounts routes, injects meta.
2. User opens `http://localhost:5173`. CS at `document_end`. Reads meta for baseline fields; fetches `/__redesigner/handshake.json` with `credentials: 'omit'`; reads `X-Redesigner-Bootstrap` response header for the canonical bootstrap token (body used only as compatibility fallback). CS never exchanges; forwards bootstrap to SW.
3. MutationObserver(`document.head`, subtree+childList) catches meta mutations + late framework edits. Disconnected on `beforeunload`. If meta lands in `<body>` (framework quirk), CS logs "meta in `<body>` — silent drop case" with a dormantReason for debug visibility.
4. CS generates `clientId = crypto.randomUUID()`, sends `register` with `{wsUrl, httpUrl, bootstrapToken, editor, tabId, windowId, clientId}`.
5. SW checks `ConnState.sessionToken` (from TRUSTED_CONTEXTS `storage.session`). If missing or `exp <= now + 60s`, generates `clientNonce` and calls `POST /__redesigner/exchange`. Stores returned `sessionToken` + `exp` (≤ 300s TTL) in `storage.session` with `TRUSTED_CONTEXTS` access.
6. SW opens WS with subprotocol list `['redesigner-v1', 'base64url.bearer.authorization.redesigner.dev.<b64url(tokenBytes)>']` and `?v=1`. Server validates, echoes `redesigner-v1`. Client asserts `ws.protocol === 'redesigner-v1'` post-open.
7. Daemon emits `hello` with `{ serverVersion, instanceId, snapshotSeq, negotiatedV: 1, capabilities: { multiSelect: false }, snapshot }`.
8. **Panel auto-open path is gated on user gesture.** On `chrome.runtime.onInstalled`, the extension opens the **Welcome tab** (new tab = user gesture equivalent). Panel auto-open is moved to the first `chrome.action.onClicked` event (user gesture) if the active tab has a handshake; otherwise the toolbar click routes to Welcome. Welcome polls ports every 3 s for 2 min with a live "waiting for dev server…" state and auto-transitions to "Detected: localhost:5173 — open?" when a handshake appears.
9. First-handshake toast in panel (one-time per install): `Press <chord> anywhere to pick` where `<chord>` is read **live from `chrome.commands.getAll()`** — never hardcoded in source (ESLint `no-restricted-syntax` rejects the literal strings `Cmd+Shift+K`/`Ctrl+Shift+K`/`Alt+Shift+D` in `src/panel/**` and `src/sw/**` outside the chord-rendering helper). If `getAll()` reports the command unbound (user rebind / collision), toast becomes "Set a shortcut to pick" linking `chrome://extensions/shortcuts`.
10. **Backfill on install.** `chrome.runtime.onInstalled` also runs `chrome.scripting.executeScript` across all open tabs matching `http://localhost/*` + variants to inject CS into pre-existing dev-server tabs so users don't need to reload.

### 4.2 Pick an element

1. User: panel "Pick" button OR `Cmd+Shift+K`. SW arms active-tab CS. Toolbar icon → armed variant; hover tooltip "Picking… click to cancel".
2. **Picker topology** (explicit): **single shadow host** appended at arm-time. Attachment target depends on page modal state: if `document.querySelector(':modal')` returns an open modal dialog, the shadow host is appended as a child **of that dialog** (nesting inside the modal escapes its `inert` scope — native dialog inertness applies to everything *outside* the dialog subtree); otherwise, appended as a direct child of `document.documentElement`. This generalizes "not inside `document.body`" to "wherever the top-layer active modal lives, if any" and preserves pick functionality when debugging modal-heavy apps (Radix, HeadlessUI). **Inert detection is broader than `dialog[open]`**: a MutationObserver watches the `inert` attribute appearing on any ancestor chain up to `<html>`, any element gaining `aria-modal="true"`, AND listens for native `toggle` events on `<dialog>` (synchronous Chrome 120+ event — fires before the next microtask, beating MutationObserver's async delivery). Any of these signals aborts the active pick commit in the same tick with toast "Picker unavailable — close the modal dialog and retry." Tier-3 fixtures cover native `<dialog>`, `react-aria`/Radix/HeadlessUI `aria-modal` patterns (which don't use native dialog), and manually-applied `inert` attribute. Host has `popover="manual"` + `showPopover()` so the host is in the top layer (manifest `minimum_chrome_version: "120"` guarantees stable Popover+dialog behavior; arming feature-detects `'popover' in HTMLElement.prototype` with an error toast on miss). Inside the host's shadow tree: (a) highlight rectangle — absolutely positioned, `pointer-events: none; outline: 2px solid <state-color>`, (b) no capture layer. **Pointer events are bound at `window`** — `pointermove` and `pointerdown` with `{ capture: true, passive: true }` (RAF-coalesced hover, deduped by `pointerType` for pen/touch); `click` with `{ capture: true, passive: false }` (passive must be false because we call `preventDefault()` on commit). Window-level listeners are attached via a `content_scripts[].run_at: "document_start"` bootstrap stub so they register **before** any page library that uses `capture:true` + `stopImmediatePropagation()` (monaco, codemirror, react-dnd, tldraw); main picker logic still loads at `document_end`. This preserves native page scrolling and nested-scroller wheel/touchpan while armed, which a `pointer-events: auto` capture layer would break. Additional suppressions during arm: `contextmenu`, `dragstart`, `pointercancel` handler resets `lastHoverTarget` on orientation change / pen-lift. **Page opens `<dialog>.showModal()` *after* arm**: `showModal()` inerts everything outside the dialog subtree including our popover-even-though-in-top-layer; detected via `MutationObserver` watching for `dialog[open]` + `aria-modal` appearing, and the picker fails the active pick with toast "Picker unavailable — a modal dialog is open, close it and retry." (Tier-3 fixture covers both arm-while-dialog-open AND dialog-opens-while-armed cases.) Accessibility: on `showPopover()`, capture `document.activeElement`, move focus to the shadow host (`tabindex="-1"`), restore on dismiss with an `isConnected` guard (falls back to `document.body` focus when the original target was removed mid-pick); host carries `role="dialog"` + `aria-modal="true"` + `aria-label="Element picker active. Press Esc to cancel."` (standard pattern — screen readers default-handle Esc correctly). An `aria-live="assertive"` + `aria-atomic="true"` region is appended to `document.body` (NOT inside the shadow root — AT support for shadow-DOM live regions is inconsistent across NVDA/JAWS/VoiceOver); pointer-driven announcements debounce at 250 ms, keyboard-driven announcements are immediate (no debounce). Esc handling via `keydown` at window capture phase (escapes page focus traps). Covered in picker tests on transform-ancestor fixtures.
3. Hover: document-rooted `elementsFromPoint(x, y)` (NOT `event.target`; we don't have a capture layer). Per CSSOM-view retargeting, `document.elementsFromPoint` returns the picker's shadow **host** when the cursor is over picker shadow content — so the filter ordering is (a) reject `el === pickerShadowHost` **before any shadowRoot recursion** so we never re-enter our own shadow tree; (b) if `el.shadowRoot` is an open root, recurse via `shadowRoot.elementsFromPoint` and **re-apply the `getRootNode() === pickerShadowRoot` filter at every recursion level** (nested shadow retargeting only stops at entry points; deeper traversal through page-owned open shadows can return elements whose root chain walks through slot-projection into ours); closed roots are never entered by `elementsFromPoint` (retargeting stops at the host). Picker test fixture asserts `hitTest(x,y)` never returns a node whose `getRootNode() === pickerShadowRoot` at any depth. Innermost non-self resolved = hover target. Stored in `lastHoverTarget`. RAF-coalesced. Walk up via `parentElement`; when null, continue from `getRootNode().host` — this hop applies only when we explicitly recursed INTO an open shadow root, since closed roots were never entered.
4. Hover affordances: solid blue outline + cursor label when instrumented ancestor exists; dashed grey + `not-allowed` cursor when none. After **800 ms of continuous hover over an uninstrumented region**, a cursor-anchored tooltip shows "No source mapping here — hover a nearby component" — addresses the Day-1 silent-failure mode where users stare at a dashed grey outline thinking the extension is broken. A panel-level "Show pickable elements" toggle is first-class (not buried in a post-failure toast) and temporarily outlines every `[data-redesigner-loc]` element.
5. Click: commit `lastHoverTarget`. Check `lastHoverTarget.isConnected`; if false (HMR swapped subtree between hover and click), re-resolve via `elementsFromPoint` at last mouse coords; if still no instrumented ancestor → abandon pick with a toast "Component moved mid-pick — try again." Fallback to `composedPath()[0]` only for keyboard/touch activation paths.
6. `extractHandle(lastHoverTarget, manifestPromise)` with 3 s deadline on the manifest await **decoupled from any WS reconnect or backoff state** — the deadline fires purely on its own promise, never pulled in by connection retry. Monotonic pick counter drops out-of-order async resolves. Failure toasts are **reason-specific**, not generic: "Component moved mid-pick — try again" (isConnected false), "This element isn't traceable to source — try a nearby ancestor. (Portals, fragments, and dynamically-injected nodes aren't instrumented.)" with a **"Show pickable elements" toggle** that temporarily outlines all `[data-redesigner-loc]` in the page (copy softened from "check the Vite plugin is configured" which blames the user's setup unfairly), "Iframe contents not supported in v0" (hover target was an `<iframe>`), "Manifest taking too long — try again or reload" (3 s deadline). A known-limitations doc link is included in each toast.
7. CS: `pickCompleted{clientId, tabId, windowId, handle}` → SW sets tab's `activePickClientId` + monotonic counter (later pick clears earlier on same ConnState). Picker auto-disarms unless Alt held. SW's `actionIcon` coalesced debounced setter reads `tabs.some(t => t.pickerArmed)`.
8. **SW (not CS) issues `PUT /selection`** with `Authorization: Bearer <sessionToken>` + body per §4.2.1. Browser sets `Sec-Fetch-Site: cross-site` (SW origin `chrome-extension://<id>` → daemon origin `http://localhost:PORT` are cross-site). Daemon's acceptable `Sec-Fetch-Site` set for requests whose `Origin` is `chrome-extension://<allowed>` is `{ none, cross-site }`; page-initiated requests (future surface) keep `{ same-origin, none }`.
9. Daemon OPTIONS preflight allows the extension origin. The Sec-Fetch-Site gate is a **compound predicate**: `(Origin ∈ chrome-extension://<allowlist>) AND (Sec-Fetch-Site ∈ {none, cross-site})`. `cross-site` with any `http://` or `null` Origin is rejected. Real PUT broadcasts `selection.updated`; response body `{ selectionSeq, acceptedAt }` and the broadcast carries the same `selectionSeq` so concurrent-writer races (two Chrome windows PUT-ing the same tab) are observable client-side. Conditional-PUT via `If-Match: <selectionSeq>` + 409 `apiErrorCode: 'stale-selection'` is deferred to v0.1; the response fields ship now.

#### 4.2.1 `SelectionPutBodySchema`

Unchanged (`nodes.min(1).max(1)`, `clientId` UUID, optional `meta`, strict).

### 4.3 MCP `rpc.request` round-trip

Unchanged structure. Clarifications:

- `inFlightRpc` persisted **synchronously** on insertion (no debounce) AND synchronously cleared on resolve/deadline.
- **Grace window for SW wake vs heartbeat**: `pickerArmed` heartbeat absent-threshold is `max(3s, (now - sw.wakeAt))` — prevents false disarm during SW wake + exchange + WS reopen (which can exceed 3 s).
- `result: { truncated: true, partial, fullBytes }` for >512 KB (result-envelope signal, not an error).
- Error codes by structured `RpcErrorCode` mapping.

### 4.4 Reconnect and backoff

- **Full jitter** (replacing decorrelated to avoid saturation-clamping collapse): `delay = Math.random() * Math.min(30_000, 1_000 * 2^attempts)`. Deterministic under injected `Math.random` via `nextFullJitterDelay(attempts)`.
- **Reconnect-during-SW-suspend** wake path: while the WS is closed and the SW is eligible to suspend, the in-connection 20 s ping cannot keep it alive. A `chrome.alarms` entry `reconnect-tick` is created whenever a ConnState is in backoff. Cadence is **tiered**: 30 s (Chrome's alarms minimum) for the first 2 min of backoff (catches the common dev-server-restart case quickly), then decays to 60 s (battery-friendly for genuine outages). Alarm handler wakes SW, checks `(attempts < giveUpCap && now >= nextDelayAt)`, and reattempts. Alarm cleared on successful hello or entering give-up state. Additional wake sources (all wired to the same backoff-resume handler, not standalone): `chrome.runtime.onStartup` (browser launch), `chrome.idle.onStateChange('active')` (display-wake on macOS/Linux — alarm coalescing under App Nap may delay `reconnect-tick`), `tabs.onActivated` on a localhost tab, panel retry button, meta `MutationObserver`. SW suspension during backoff is **intentional** — alarms resume it.
- Give-up: 5 consecutive failures OR `firstFailedAt` + 60 s elapsed, whichever first. Reset on hello.
- **1002 close**: **session-revalidate probe first** (fresh `/exchange`); on success, re-open WS without burning budget. On failure → standard backoff + banner.
- Re-arm: `tabs.onActivated`, panel retry, `chrome.idle.onStateChange('active')`, meta `MutationObserver`. Per-ConnState 1 s cooldown.
- Retry button: reconnect + handshake refetch in parallel. Banner copy: "Reconnecting to dev server" + spinner. **No visible countdown** in primary banner (anxiety-reducing); countdown surfaces **only when budget expires** and a manual action is needed.
- On reconnect, upgrade uses `?v=1&since=<n>&instance=<id>`.
- Close-code reducer table (updated):

| Code | Action | Budget? |
|---|---|---|
| 1000 | no reconnect | n/a |
| 1001 | no reconnect | n/a |
| 1002 | session-revalidate first (capped at 2 revalidate **failures** — not a wall-clock window — to prevent infinite revalidate↔1002 loop on misconfigured daemon; counter resets on any successful `hello`); on success zero-cost; on cap-exhaust SW messages active CSes to re-fetch `/__redesigner/handshake.json` for a fresh bootstrap, then exchange again — rescues the case where bootstrap was rotated server-side between SW memory and now; final failure → backoff + banner | conditional |
| 1006 | backoff + branch-(b) health probe | yes |
| 1011 | backoff + "Daemon error" | yes |
| 1012/1013 | fixed 1 s + jitter | no |
| 4406 | distinct banner; close-reason JSON `{"accepted":[1]}` (16 bytes, well under RFC-6455 123-byte reason budget — `packages/core/src/schemas/closeReasons.ts` defines the schema with an `encode()` guard that throws on any serialization >123 bytes); reason is **best-effort**: intermediaries (reverse proxies, Cloudflare) can truncate or strip the CloseEvent.reason, so a parse-failure client falls back to "reconnect with highest `?v=` locally supported" and lets the `hello`/re-close arbitrate; if client supports one of the accepted → reconnect with that version (no budget burn); else giveup | conditional |
| 1005 | no status received; treat as 1006 equivalent (network-layer close) + branch-(b) health probe | yes |
| 1015 | TLS handshake failure; give-up — non-HTTPS localhost should never see this, surfacing = misconfig | n/a |
| 4408 | fixed 1 s + jitter | no |
| 4409 | error state, reload required | n/a |

### 4.5 Handshake refresh + rotation

Unchanged from R3: branch-(a) `handshake.rotated` frame; branch-(b) 1006 + health failure within 500 ms → refresh. Bound 3. SPA nav in-allowlist clears `activePickClientId` but keeps CS registered.

### 4.6 Replay semantics

Unchanged: `instance` mismatch → `resync.instanceChanged`; `since < earliest` → `resync.gap`; `since > snapshotSeq` → log at warn, fresh hello; `since=0` valid; hello `snapshotSeq` is high-water mark after replay; client dedup by `(id, seq)`.

### 4.7 Token lifecycle

- **Bootstrap.** 32-byte base64url; rotates every 1 hour + on daemon restart; one-shot per `clientNonce`. Delivered to CS via `/__redesigner/handshake.json` response header (preferred) or meta body (fallback).
- **Session.** `HMAC(rootToken, clientNonce, serverNonce, iat)`. `exp ≤ 300 s` — short to limit residual co-ext mint window. SW refreshes via a new exchange ~60 s before expiry. Each successful `/exchange` from the same extensionId invalidates the previous session — rotation per reconnect is automatic. Persisted in `storage.session` under an opaque per-boot randomized key name (`s_<crypto.randomUUID()>`) with `TRUSTED_CONTEXTS` access-level so it survives SW wake without an extra exchange RTT; CS cannot read, and `storage.onChanged` events that CS could observe carry no identifying key name.
- Not rotated within daemon lifetime by session-ID; rotation achieved via bootstrap rotation + exp-driven re-exchange.

---

## 5. Algorithms

### 5.1 `ComponentHandle` extraction

```ts
async function extractHandle(
  el: Element,
  manifestPromise: Promise<Manifest>,
  deadlineMs = 3000
): Promise<ComponentHandle | null> {
  const manifest = await withTimeout(manifestPromise, deadlineMs)
  if (!manifest) return null
  if (!el.isConnected) return null              // HMR race — node was swapped between hover and click
  const anchored = closestAcrossShadowDom(el, '[data-redesigner-loc]')
  if (!anchored) return null
  /* …rest unchanged… */
}
```

`closestAcrossShadowDom` semantics made explicit:

- Walks `parentElement`; when null, continues from `getRootNode().host` — this hop is only meaningful when we explicitly recursed INTO an open shadow root in hit-testing. For closed roots, `document.elementsFromPoint` retargeted to the host and we never entered them, so `parentElement` terminates at document naturally.
- Does NOT descend INTO closed shadow roots (it can't; `host.shadowRoot` is null).

Documented limitations (docs + panel tooltips + fixture tests):
- Closed shadow roots: instrumented ancestor must be in the light DOM — we cannot inspect inside them.
- React portals: portalled children with no light-DOM instrumented ancestor → null.
- Same-origin iframes: `document.elementsFromPoint` does not descend into iframe documents; hover over iframe content resolves to the `<iframe>` element itself. Panel toast on pick: "Iframe contents not supported in v0." (Fixture test in Tier-3.)

### 5.2 `stableId`

Unchanged. `FAST_CHECK_SEED=42` pinned via shared harness. Structural-invariant property tests + negative test for non-injected timestamps. Verbose shrink logs on failure.

### 5.3, 5.4, 5.5, 5.6, 5.7

Unchanged.

### 5.8 Close-code reducer

`nextState(prev, code, now): { action, next }`. Pure function. Property-tested across:

- `code: fc.constantFrom(1000,1001,1002,1006,1011,1012,1013,4406,4408,4409)` for enumerated cases.
- `code: fc.integer({ min: 1000, max: 4999 })` for unknown-code default branch (ensures graceful fallback on daemon adding new codes).

Regressions: rapid 1012 × 10 fixed delay; bounded 4401 × 3 (if still used anywhere); 4408 transient; 1002 triggers revalidate; 4406 with accepted versions → reconnect.

---

## 6. Security

### 6.1 Trust model

- **Trusts:** handshake header from Vite dev server; daemon identity via bootstrap-then-session exchange.
- **Does NOT trust:** arbitrary pages; co-installed extensions with `http://localhost/*` permission (explicitly named residual attacker); reverse proxies and upstream tooling; third-party scripts on dev build; **DevTools inspection** of the SW (token visible in DevTools Network WS headers — documented threat-model item).
- **Primary mitigation for co-extension risk (v0):** 1-hour bootstrap rotation + ≤5-min session `exp` + per-(Origin, wsUrl) exchange bucket. **Does not structurally prevent** a co-ext from minting a session; reduces residual window. Extended mitigation (v0.1): ext-ID binding via `externally_connectable` on Web-Store builds + `chrome.management` detection of localhost-permissioned extensions with a panel warning.

### 6.2 Token lifecycle

- Bootstrap: header-preferred delivery, 1-hour rotation, one-shot per clientNonce. The header vs body switch is a **marginal defense against naive DOM-parsing scripts only** — any script that can execute `fetch` on the same origin can re-request `/__redesigner/handshake.json` and read the header itself (including `window.fetch` monkey-patches and `PerformanceObserver` resource entries that expose response headers for same-origin requests). `credentials: 'omit'` + `Cache-Control: no-store, private` (normative) on all three token-adjacent endpoints. Third-party scripts and SW of co-installed extensions with localhost permission still have visibility; docs explicitly warn.
- Session: SW-only, `TRUSTED_CONTEXTS` access-level storage, ≤5 min exp, reissued before expiry. Never in CS/panel/page/logs.
- Subprotocol packing base64url encoded for k8s-compatible semantic.
- Logger redaction + CI grep 0-match + explicit test that 4xx close frames and access logs never contain the subprotocol.

### 6.3 Network defenses

Unchanged body. Updated statements:

- **Sec-Fetch-Site** is a CSRF-from-page defense only; it does NOT isolate extensions. §6.1 wording revised.
- **Host allowlist** literal-set matching; DNS rebinding mitigated.
- **Uniform 1002** (no 4401 oracle).
- Rate-limit keys: per-(Origin, wsUrl) for upgrade; **per-(Origin, peerAddr) for exchange** (attacker-forgeable nonces don't partition); per-tab bucket extension-side.
- Vite version pin + runtime refuse-to-start.
- `/health` session-token-gated (no Origin-only path); instanceId only via `hello`.

### 6.4 Extension defenses

Unchanged from R3; additional clarifications:

- SW owns REST; CS never holds credentials.
- Bootstrap delivered primarily via response header, not DOM.
- `storage.session` with `TRUSTED_CONTEXTS` access-level blocks CS/panel read; still not cross-extension isolation.

### 6.5 PII

- `filePath`/`domPath` only at `trace`; basename hash at higher levels.
- `detail` field of problem bodies never includes raw paths.
- CI grep 0-match for `/Users/`, `/home/`, `C:\`, sentinel token, subprotocol string.

---

## 7. State model

### 7.1 `ConnState`

Prior fields, plus:

- `sessionToken: string | null` — **persisted** in `TRUSTED_CONTEXTS` `storage.session`.
- `sessionExp: number | null` — persisted alongside.
- `negotiatedV: number` — from hello.

### 7.2 Persistence

- **Fast path (no debounce):** `tabs`, `activePickClientId`, `activePickCounter`, `lastSeq`, `instanceId`, `bootstrapToken`, `sessionToken`, `sessionExp`. `storage.session` default access-level is `TRUSTED_CONTEXTS` — we call `setAccessLevel('TRUSTED_CONTEXTS')` explicitly at boot as an assertion; older Chrome versions that throw on this call catch and continue (session-only persistence is best-effort — on throw we fall back to SW-module-scope memory + re-exchange on wake).
- **Slow path (1 s debounce):** `recent`, `manifestCache.seq`, `backoff.*`, `dormantReason`.
- `inFlightRpc`: sync persist on insertion; sync clear on resolve/deadline.
- NOT persisted: `ws`, `manifestCache.promise`, per-tab `pickerArmed`.
- Hydrate failure path: `readyPromise.catch(err => sendResponse({ error: err.message }))` for any pending `onMessage` handler; hydrate failure clears corrupted `storage.session` and continues with empty state. Never hangs the channel indefinitely.
- Quota guard reactive (on throw): trim `recent[]` first, then `inFlightRpc` stale entries, then `manifestCache` lazy-refetch; retry once.

### 7.3 Lifecycle

Prior table + clarifications:

- SW wake: re-arm triggers apply cooldown; any "heartbeat-absent-for-Ns" decisions use grace window `max(3s, now - sw.wakeAt)`.
- SW wake with in-flight RPCs: synth past-deadline on hydrate.
- 1002 close: revalidate first.
- 4406 close: check `accepted` list; reconnect with highest supported; else giveup.

### 7.4 Panel UX

Prior content + updates:

- **Welcome launch decision** is gated on already-existing dev-server tabs: on `onInstalled`, SW runs the backfill `executeScript` across open `http://localhost/*` + `http://127.0.0.1/*` tabs, awaits handshake detection for up to 2 s, and if any tab reports an active handshake **Welcome is skipped** — the toolbar badge dot + a one-time first-toolbar-click toast "Found your dev server on :<port> — click to open panel" handles discovery instead. Opening a redundant Welcome tab when the user already has a working setup is the single loudest Day-1 UX failure. If zero handshakes detected, Welcome opens.
- **Welcome polling loop** (when Welcome IS open): SW-owned via `chrome.alarms` `welcome-probe-tick` (60 s cadence, 20-attempt cap from install). Probe scope is **only the origins of currently-open tabs** matching `http://localhost/*` + `http://127.0.0.1/*` via a tokenless `HEAD /__redesigner/handshake.json` — no blind scanning of unrelated ports (a blind scan hits unrelated localhost services and generates noisy 404s). Alarm fires regardless of whether the Welcome tab is still open (panel-side `setInterval` dies on tab close; SW alarms survive). Welcome UI subscribes via `runtime.Port` and renders "Waiting for dev server…" → "Detected: localhost:<port>" when the SW pushes a discovery event. Success state primary action: **"Open the dev-server tab"** button that calls `chrome.tabs.update(devTabId, { active: true })`. After cap-exhaust, a "Resume probing" button manually restarts the alarm (re-arms for another 20 attempts) so users returning from lunch aren't stranded.
- **Toolbar icon tooltips AND badge text** — all chord references interpolate `<chord>` read live from `chrome.commands.getAll()`:
  - Unarmed, connected, shortcut bound: badge blank; tooltip `reDesigner — click to open panel, <chord> to pick`
  - Unarmed, connected, shortcut unbound: badge blank; tooltip "reDesigner — click to open panel, set a shortcut in chrome://extensions/shortcuts"
  - Unarmed, reconnecting >5 s: badge `!` (amber); tooltip "Reconnecting to dev server"
  - Unarmed, give-up: badge `OFF` (red); tooltip "Dev server stopped responding — click to open panel"
  - Armed: icon armed variant; tooltip "Picking… click to cancel"
- **Panel-open gesture model simplified** after R-series review of Chromium #344767733 flakiness: `chrome.commands.onCommand` handler for `arm-picker` **arms the picker only** — it does NOT attempt `sidePanel.open()` (keyboard gestures from `onCommand` are honored inconsistently across Chrome 120+ builds). Panel-open is driven exclusively by `chrome.action.onClicked` (toolbar-icon gesture is stable). When a user arms via shortcut and the panel is closed, arming still succeeds (picker overlay is visible in-page) and the armed badge variant on the toolbar provides discovery to the panel. Documenting this as a known v0 limitation is better than shipping a flaky gesture path.
- **Shortcut collision handling**: panel footer reads live from `chrome.commands.getAll()`; re-polled on `chrome.windows.onFocusChanged` to the side-panel window (covers user rebinding in `chrome://extensions/shortcuts` without panel reopen). If empty shortcut, cheat sheet shows "pick: set a shortcut" link; `PickerToggle` label updates.
- **Armed-picker hint strip**: fixed-position shadow-tree corner strip in the overlay shows "Esc to cancel · Alt+click to keep armed" until the user has successfully used Esc AND Alt+click at least once each (tracked in `storage.session`). 3-pick dismissal was too few — devs don't register affordances they see 3 times. Anchored bottom-left by default; auto-flips to bottom-right when the cursor enters a 120 px radius of the strip to avoid occluding pick targets.
- **Error banner copy** refined: "Reconnecting to dev server" (no countdown in primary). The **Reload tab** button is visible from t=0 (not t=8s) — Day-1 users without HMR context read a silent spinner as "broken" and churn. Give-up threshold is **tiered by first-successful-pick flag** (stored in `storage.local`, persists across sessions): **30 s before first successful pick ever** (Day-1 failure should not trap users in a 3-minute wait); **180 s after**, covering HMR restarts. The 180 s "first cycle" flag resets on tab focus OR `chrome.idle.onStateChange('active')` after >5 min idle. Give-up state shows one primary ("Reload page") + one secondary ("Retry connection").
- **Tab-switch greying** primary label: **host:port** (always unique and accurate on localhost) → doc title (often stale "Vite + React") → filePath basename.
- **`SelectionCard` pip copy** adapts based on whether an MCP client has connected to the daemon in this session (daemon reports this in hello + pushes updates): when MCP-shim is **unwired**, copy is "Claude Code can see this" with a visible chip **"Set up the MCP shim →"** linking to the setup docs — a fresh install that copies `/selection` into Claude Code and gets nothing will churn, so the prompt adapts; when MCP-shim is **wired**, chip becomes `Try: "what's my current selection?"` with a one-click copy button (visible, not hover-only — hover fails on touch + keyboard-only users). Either way, the chip is the proof-of-life affordance that closes the silent-selection-drop retention cliff.
- **Copy-handle affordance**: `SelectionCard` exposes a "Copy handle" button returning `filePath:line:col` and (shift-click) the full JSON handle — manual escape for blocked-editor users (Helix, terminal vim, any editor not in the allowlist).
- **Open-in-editor blocked tooltip**: "Can't open this file in your editor (path outside project root)."
- **Welcome port-probe list** rows labelled: "Detected: localhost:5173 — open in new tab" (explicit action).
- **Debug footer label**: "press Shift+D for debug (panel)" so scope is clear.

Single shadow host + popover API topology: single top-layer element, no stacking context split.

---

## 8. Testing

### 8.1 Tier-1 Unit

Vitest + happy-dom. `crypto.subtle` availability probe (explicit test, not just "canary") — gates happy-dom version pin to ≥ the release where `crypto.subtle.sign('HMAC', …)` is stable. Picker hit-testing is Tier-3.

**Fake-timer deny-list expanded** (ESLint rule + pre-commit grep 0-match outside `test/fixtures/`):
- `vi.advanceTimersByTime\(`
- `vi.runAllTimers\(`
- `vi.runOnlyPendingTimers\(`
- `vi.advanceTimersToNextTimer\(`
- `vi.setSystemTime\(`  (allowed only inside `test/fixtures/`)
- `afterEach` in shared harness asserts `vi.getTimerCount() === 0` (no leaked real timers across tests).
- `vi.runOnlyPendingTimers\(`
- `vi.advanceTimersToNextTimer\(`

All timer advances use `tick(ms)` helper (`advanceTimersByTimeAsync(ms)` + `flushPromises()`). `toFake` list excludes `requestAnimationFrame`/`cancelAnimationFrame`/`queueMicrotask` with rationale comments.

Rest of unit coverage unchanged from R3.

### 8.2 Tier-2 Integration

Vitest forks + `isolate: true` (accept 3-4× vs 2× estimate — document per-file budget). chromeMock + real `ws` server. Wake-race tests assert explicit invariants:
- `sendResponse` fires (or error-reply fires on hydrate failure).
- `runtime.lastError` path covered when port disconnects before `sendResponse`.
- Hydrate rejection path tested (poison `storage.session`, assert error reply, assert subsequent handlers recover with empty state).

**chromeMock fidelity diff runs on PRs** touching `chromeMock/` OR `test/integration/**` — NOT only nightly.

1002 session-revalidate path tested explicitly: simulate a 1002 on WS, assert `/exchange` fires, assert subsequent WS opens without attempts budget burn.

4406 with accepted-version list tested: daemon closes 4406 with `{accepted:[1]}`, client reconnects with v=1.

`lastHoverTarget.isConnected === false` mid-HMR test: hover → HMR swap → click → toast.

Manifest cache wake-safe: SW mid-retry suspend simulated → promise reset on hydrate → new caller triggers fresh fetch.

actionIcon debounced coalescing test: 50 rapid arm/disarm events → ≤2 `chrome.action.setIcon` calls.

### 8.3 Tier-3 Picker

`@vitest/browser` using **bundled Playwright Chromium** (omit `channel`) with a Playwright version pin — `chrome-stable` drifts with system Chrome and fails on CI agents without system Chrome; bundled Chromium loads MV3 fine. **Test isolation**: one test per file OR explicit `beforeEach` full-DOM reset (`document.body.replaceChildren(); document.documentElement.removeAttribute('style'); document.querySelectorAll('dialog[open]').forEach(d => d.close()); popovers.forEach(p => p.hidePopover?.())`); Vitest `--isolate` and `poolOptions.browser.isolate: true`. Covers recursive `elementsFromPoint`, popover top-layer promotion on transform-ancestor fixture (primary case), native page `<dialog>` + popover stacking fixture, `<dialog open>` (no showModal, no top layer — regression fixture that picker still sits above), `isOwnOverlay` ordering against picker's own shadow host, same-origin iframe resolve-to-iframe-element fixture, fallback path documentation test, closed-shadow-root fixture, single-shadow-host topology with window-level pointer listeners, **devicePixelRatio > 1 fixture** (HiDPI hit-test rounding), **CSS `zoom: 0.5` ancestor fixture** (distinct hit-test code path from transform), **`pointer-events: none` cascading from `<html>`** (framework route-transition pattern).

### 8.4 Tier-4 E2E

Playwright @smoke on main; @nightly full. **Real SW-suspend detection** — `Target.detachedFromTarget` fires on target removal, not on MV3 dormancy, and DevTools-attached SWs do not suspend. Force suspension via `chrome.debugger` DevTools-protocol `ServiceWorker.stopAllWorkers` (or unregister-then-wake, checking `globalThis.__bootEpoch` increment on the re-entered SW context) and confirm via a `storage.session.get()` post-hydrate sentinel. Recovery assertion via `/debug/state` + Debug drawer frame log (not badge alone).

Leak regression with `CDP HeapProfiler.collectGarbage` before measurement; `storage.session.getBytesInUse()` + SW heap; baseline committed to `leak-baseline.json` with sunset policy (6-month stale-baseline warning).

Welcome polling test: install extension before `vite dev`; assert Welcome opens, assert `"waiting"` state visible; start `vite dev`; assert auto-transition to "Detected" row.

Shortcut collision test: preload a colliding-command extension (fixture), install reDesigner, assert panel footer says "set a shortcut."

### 8.5 Tier-5 Contract

Goldens **committed** + `GOLDEN_CHANGELOG.md`. **CI workflow dependency**: ext contract step runs in the **same job** as daemon tests (single runner, sequential steps) — cross-job artifact hand-offs flake under GitHub Actions concurrency cancellation, so we don't use them. `workflow.test.yml` sanity check asserts the job graph shape. Zod version lockfile-enforced exact pin: schema-producing package resolves to a committed version, and a separate job asserts the resolved Zod major version matches a header comment in `.snap` files — cross-package schema-shape drift (v3 vs v4) shows up as a snapshot diff rather than silent divergence.

### 8.6 Cross-package parity

`packages/core/test/parity.test.ts` — snapshots `z.toJSONSchema()` to `.snap` (strip `$schema`). CI fails on diff without `-u`.

### 8.7 Tooling

Fast-check: `FAST_CHECK_SEED` pinned via shared harness; `verbose: 2`; `numRuns: 100` pinned.

Playwright: `trace: 'on-first-retry'`, `video: 'retain-on-failure'`. Chromium channel pinned.

### 8.8 Daemon + Vite-plugin named additions

Per R3 + updates:
- Subprotocol echo test: server echoes only `redesigner-v1`, rejects bearer-only, rejects echo-of-bearer.
- Version-negotiation test: client offers `['redesigner-v2','redesigner-v1',bearer]`; server echoes `redesigner-v1` (v0 doesn't support v2).
- 4406 with accepted-list close-reason JSON.
- `POST /selection` returns 405 with `Allow: PUT` + problem body (no `Deprecation`/`Sunset` — POST was never supported, so RFC 9745 does not apply).
- `?v=1,2` list parsing and highest-supported selection.
- Handshake JSON `X-Redesigner-Bootstrap` response header asserted.
- Logger forced-error paths assert 0-match for subprotocol string in all output channels.
- `chrome.scripting.executeScript` backfill on install (integration + E2E). **Permission-denied branch covered**: Tier-2 test with chromeMock returning `permissions.contains({origins:['http://localhost/*']}) === false` asserts the user-facing fallback ("Grant access in the site permissions popup, then reload the tab").
- Close-reason `encode()` guard rejects any proposed reason body that serializes to >123 UTF-8 bytes — property tests over arbitrary `accepted` arrays include explicit boundary arbitraries at 122/123/124 bytes AND multi-byte-UTF-8 sequences that push over after encode.
- Quota-guard reactive trim: Tier-2 test injects `QuotaExceededError` on `storage.local.set`, asserts trim order (`recent[]` → stale `inFlightRpc` → `manifestCache` lazy-refetch) and single retry; fast-check property over `(recentCount, inFlightCount, manifestCacheSize)` triples asserts convergence.
- Handshake refresh bound-3 anti-loop: Tier-2 test emits 4 rapid rotation signals, asserts exactly 3 refetches then error-state.
- `extractHandle` 3 s deadline decoupling: Tier-2 stalls manifest fetch >3 s while WS reconnect completes <1 s; asserts handle returns null on deadline independent of WS state.
- `setAccessLevel('TRUSTED_CONTEXTS')` throw fallback: Tier-2 makes `storage.session.setAccessLevel` throw; asserts session token never hits `storage.session` and post-wake path re-exchanges.
- Grace window property test: fast-check over `(wakeAt, now, heartbeatLastAt)` triples asserts no false disarm during `max(3s, now - wakeAt)` window.
- Welcome alarm survives tab close: Tier-2 opens Welcome, closes tab, advances alarm timer, asserts alarm handler ran and discovery state updated without UI.
- `sidePanel.open` gesture-ordinal assertion: chromeMock timestamps `sidePanel.open` call vs first await microtask in `commands.onCommand` handler; test fails if order regresses.
- `storage.session.onChanged` cross-context behaviour: **Tier-4 Playwright with real unpacked MV3 extension** asserts CS receives `onChanged` events but `newValue === undefined` for `TRUSTED_CONTEXTS` keys on current Chromium — chromeMock cannot prove Chromium semantics, so the chromeMock version is demoted to mock-fidelity regression only. Additionally: session token keys use opaque randomized names (`s_<crypto.randomUUID()>` chosen per boot) so even key-name observation yields no information about content.
- `.zod-version` sentinel file committed at repo root; CI step runs `pnpm why zod` and fails if more than one version is resolved OR if the resolved version does not exactly match `.zod-version` — catches hoisting skew that would silently shift `.snap` goldens across packages.
- Tier-4 SW-suspend reliability recipe: retry-attach loop around `context.serviceWorkers()` (known racy per Playwright #39075), `await page.waitForEvent('serviceworker')` fallback, `test.describe.configure({ retries: 2 })`, flake-rate tracked in CI — if >2% over 2 weeks, demote to a non-blocking nightly.
- Tier-3 `beforeEach` reset **ordering**: (1) remove the picker's `data-redesigner-picker-host` node from `documentElement`, (2) close open `<dialog>` elements, (3) `hidePopover()` any remaining popovers, (4) reset `documentElement`/`body`/fullscreen/pointer-capture. Order matters — hiding popovers before removing the picker leaves focus + inert state wedged.
- `.snap` header comment includes `// Source: packages/core/src/schemas/<file>.ts::<export>` so contract-break reviewers can jump straight to the driver without grep.
- fast-check per-`fc.assert` seed threading: each call passes `{ seed, numRuns, verbose: 2 }`; failure output logs the seed; CI preserves failing seed as an artifact for bisection. `numRuns: 1000` for reducer/replay; `numRuns: 100` cheap schema; nightly `numRuns: 10000` with random seed.
- actionIcon test asserts **exactly 2** `chrome.action.setIcon` calls (one armed-edge, one disarmed-edge) over 50 rapid arm/disarm events — `≤2` would let a trailing-edge-only bug pass.
- Close-code reducer regressions for RFC 6455 codes `1005` (no status received) and `1015` (TLS handshake failure) in addition to the existing enumerated set.
- Subprotocol DoS cap: 9+ `Sec-WebSocket-Protocol` entries → 1002 close (cap `maxSubprotocolEntries = 8`, fuzz-tested).
- Replay property test: fast-check over `(since, snapshotSeq, earliest)` triples asserts dispatched resync type.
- Rate-limit responses carry `Retry-After: <seconds>` alongside the problem body.
- `Vary: Origin` on **every** response reachable from a CORS-gated route, including 5xx (not only 2xx/4xx) — prevents shared-proxy cache poisoning.
- `Cache-Control: no-store, private` normative on `/__redesigner/handshake.json`, `/__redesigner/exchange`, `/selection`; `Pragma: no-cache` for HTTP/1.0 proxy compatibility.
- Token-refresh skew test: ±30 s clock skew injected; refresh still fires before daemon rejects.
- `sessionToken.exp` = HMAC over `(rootToken, clientNonce, serverNonce, iat)`; `serverNonce` generated fresh per mint and returned in the response so the SW can verify identity of issuer on the subsequent hello (defense in depth against replayed exchange responses).

---

## 9. Implementation order

1. **Core** — `schemas/` + `types/` split (+ parity snapshots), error taxonomy with reverse crosswalk, body schemas, types.test-d.ts.
2. **Daemon prereqs** — Host allowlist, subprotocol negotiation + echo contract + 1002/4406 semantics, CORS with closed-set methods, per-(Origin, wsUrl) + per-(Origin, clientNonce) buckets, 20 s ping, `PUT /selection` + 405 POST, `/__redesigner/exchange` with ≤5 min session exp + bootstrap rotation frame, RFC 9457 with live `type` URLs, `/health` token-only, debug, Sec-Fetch-Site, logger redaction + CI grep + subprotocol-in-logs assertion, IPC unref.
3. **Vite plugin** — handshake middleware serving `X-Redesigner-Bootstrap` header, meta injection, `editor` Zod at plugin boot, Vite CVE runtime check.
4. **Extension shared + content script** — chromeMock per-namespace with fidelity diff on PR, schemas, messages, errors (re-export), meta+header handshake, picker with single-shadow-host + popover + capture layer + isConnected check, hitTest, extractHandle, stableId (seed pinned).
5. **Extension SW** — hydrate w/ TRUSTED_CONTEXTS and failure-path sendResponse, commands + getAll collision detection, connPool (creation lock, LRU, re-arm cooldown, wake-grace), wsClient (1002 revalidate + 4406 version negotiate + pure `nextState`), rest.ts, exchange.ts, rpc (sync persist, wake grace, monotonic counter), manifestCache (seq + 3 s deadline + wake-safe promise reset), panelPort (windowId + snapshot includes transient flags), actionIcon (coalesced debounce), backfill (executeScript on install).
6. **Extension side panel** — React panel importing ONLY from `@redesigner/core/types`; size-limit budget enforced; collision-aware ShortcutsFooter; WelcomePage polling + auto-transition; Retry/Reload co-primary banners without anxiety countdown; tab-switch label with doc title preferred.
7. **Picker browser tests** — transform-ancestor + closed-shadow + single-shadow-host topology.
8. **E2E** — smoke + nightly, including real SW-suspend detection and shortcut-collision fixture.
9. **Playground dogfood**.
10. **Doc + packaging** — threat-model page calling out DevTools-inspection exposure + co-ext risk + third-party-inline-script warning; CRXJS migration runbook; known limitations.

---

## 10. Open questions (non-blocking)

Per R3 list + additions:
- Ext-ID binding on Web-Store builds + `chrome.management` detection of localhost-permissioned extensions for panel warning (v0.1).
- Stable docs pages per `apiErrorCode` slug (ship with v0; auto-generated from enum).
- Session-token rotation within daemon lifetime (deferred; currently bootstrap rotation + short exp).
- Panel warning UI for detected co-installed localhost extensions (requires `management` permission; v0.1).
- Content-script injection backfill strategy for tabs in incognito / private profile (may be blocked; documented).
