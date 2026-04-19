# Chrome Extension v0 — Design Spec

**Goal:** Ship the fourth piece of reDesigner v0 per `brief.md` §4 — a Chrome MV3 extension that lets developers pick a DOM element in a running dev build, extracts a `ComponentHandle`, and pushes it to the project's daemon so Claude Code (via the MCP shim) can read the current selection.

**Status:** Design approved 2026-04-19. Implementation plan to follow.

**Architecture summary:** MV3 service worker owns one WebSocket per daemon, keyed by `wsUrl`; content script runs on `http://localhost/*` variants, probes for a handshake `<meta>` tag injected by the Vite plugin, and hosts the picker overlay + RPC DOM-reader; side panel renders state (`React`); shared schemas live in `@redesigner/core`. Daemon and Vite plugin receive small, tightly-scoped additions.

---

## 1. Scope

**In scope:**

- MV3 extension at `packages/ext/` (pnpm workspace package).
- Element picker overlay with hover-highlight and click-to-pin.
- Single-select only in v0. Wire payload shaped as `{ nodes: ComponentHandle[] }` from day one so multi-select is UI-only later.
- WebSocket subscriber that relays `selection.updated`, receives `rpc.request`, answers with DOM reads.
- Side panel with connection state, current selection, recent list (≤10), "Pick element" toggle, open-in-editor deeplink.
- Handshake discovery via `<meta name="redesigner-daemon">` injected by the Vite plugin during `serve`.
- Daemon-side changes: subprotocol-bearer WS auth, CORS for dev-server origins, per-origin upgrade rate-limit (special-cased for extension origin), app-level ping every 15 s, `POST /selection` body `{nodes: ComponentHandle[]}`, handshake-route serve-only assertion, 4401 close on upgrade auth failure, token charset pinned to base64url no-padding.
- Vite plugin additions: `/__redesigner/handshake.json` middleware (`apply: 'serve'`), `transformIndexHtml` meta-tag injection, `editor?:` plugin option with Zod allowlist.
- WS frame envelope schemas move from `packages/daemon/src/ws/frames.ts` to `@redesigner/core` so extension and daemon share one source of truth.

**Out of scope for v0 (tracked for v0.1+):**

- Shift-click multi-select pinning.
- Cross-origin iframes (`all_frames: false`). Would require `frameId` in the handle schema and frame-aware SW routing.
- HTTPS localhost. Both content-script `matches` and daemon CORS regex are http-only. `vite dev --https` / mkcert users must wait.
- Pinning daemon WS origin to the published extension ID. Unpacked dev builds have different IDs; deferred behind a future flag.
- DevTools panel variant, extension-owned chat UI, SPA re-check on History API nav within the same tab (handled by off-allowlist navigation triggers instead; in-allowlist SPA routing needs no re-check).

---

## 2. File structure

```
packages/ext/
├── package.json                       # @redesigner/ext, workspace:* deps on core
├── vite.config.ts                     # crxjs/vite-plugin config, MV3 manifest
├── manifest.json                      # MV3 manifest (base; crxjs composes final)
├── src/
│   ├── sw/
│   │   ├── index.ts                   # SW entry; top-level hydrate + handler gating
│   │   ├── connPool.ts                # Map<wsUrl, ConnState>; refcount, backoff
│   │   ├── wsClient.ts                # single WebSocket lifecycle per wsUrl
│   │   ├── rpc.ts                     # inflight map, 5s timeout, synth-error path
│   │   ├── panelPort.ts               # runtime.Port fan-out to panels
│   │   └── hydrate.ts                 # storage.session ↔ in-memory state
│   ├── content/
│   │   ├── index.ts                   # CS entry (document_end)
│   │   ├── handshake.ts               # meta-tag parse + Zod validate
│   │   ├── register.ts                # register/unregister envelope to SW
│   │   ├── picker.ts                  # shadow-DOM overlay, hover, click
│   │   ├── extractHandle.ts           # ComponentHandle construction
│   │   ├── stableId.ts                # deterministic id hashing
│   │   └── rpcAgent.ts                # handle rpc.request → DOM read → reply
│   ├── panel/
│   │   ├── index.tsx                  # React entry
│   │   ├── App.tsx                    # layout
│   │   ├── ConnectionBadge.tsx
│   │   ├── SelectionCard.tsx
│   │   ├── RecentList.tsx
│   │   ├── PickerToggle.tsx
│   │   └── hooks/usePanelPort.ts      # port reconnect-on-disconnect
│   └── shared/
│       ├── messages.ts                # SW↔CS↔panel envelope types (Zod)
│       ├── editors.ts                 # allowlist + URL builders
│       └── constants.ts               # ping interval, backoff, caps
├── test/
│   ├── unit/                          # Vitest, happy-dom
│   ├── integration/                   # Vitest + sinon-chrome + mock-socket
│   └── e2e/                           # Playwright (nightly)
└── playwright.config.ts
```

Daemon side (additions only):

- `packages/daemon/src/auth.ts` — `extractSubprotocolToken(req)` helper.
- `packages/daemon/src/ws/events.ts` — switch to subprotocol auth, replace pre-upgrade HTTP 401 with post-handshake 4401 close, per-origin rate-limit keyed by `origin.startsWith('chrome-extension://') ? wsUrl : origin`, app-level ping interval.
- `packages/daemon/src/routes/selection.ts` — body schema change to `{nodes: ComponentHandle[]}` (max 10); take `nodes[0]` in v0.
- `packages/daemon/src/routes/cors.ts` (new) — OPTIONS handler + `Access-Control-Allow-*` header injection, origin allowlist regex.
- `packages/daemon/src/server.ts` — route OPTIONS before auth; CORS headers on 2xx/4xx responses for allowed origins.
- WS frame schemas move to `packages/core/src/wsFrames.ts`. Daemon imports from core.

Vite-plugin side (additions only):

- `packages/vite/src/handshakeMiddleware.ts` (new) — serves `/__redesigner/handshake.json`.
- `packages/vite/src/plugin.ts` — adds `configureServer` middleware wiring (serve-only), `transformIndexHtml` hook, `editor` option Zod schema.

Core side:

- `packages/core/src/wsFrames.ts` (new) — Zod schemas for `hello`, `selection.updated`, `manifest.updated`, `staleManifest.resolved`, `resync.gap`, `ping`, `rpc.request`, `rpc.response`. Exports types.
- `packages/core/src/handshake.ts` (new) — `HandshakeSchema`, `EditorSchema` ("vscode" | "cursor" | "zed" | "fleet").
- `packages/core/src/schema.ts` — `SelectionPostBodySchema = z.object({ nodes: z.array(ComponentHandleSchema).min(1).max(10) })`.

---

## 3. Architecture

### 3.1 Boundaries

Four extension units with well-defined interfaces:

| Unit | Owns | Does not own |
|---|---|---|
| Service worker (`sw/`) | WebSocket pool, reconnect/backoff, rpc.request in-flight map, state persistence | DOM access, UI rendering |
| Content script (`content/`) | Meta-tag parse, handshake registration, picker overlay, handle extraction, rpc DOM reads | WebSocket, state across navigations |
| Side panel (`panel/`) | UI rendering, user input to SW | Network I/O, DOM of target page |
| Shared (`shared/` + `@redesigner/core`) | Message envelopes, handshake/frame Zod schemas, editor allowlist | Runtime state |

No unit reaches across a boundary: panel never calls `fetch`, SW never touches the page DOM, CS never opens a WebSocket.

### 3.2 Daemon and Vite-plugin additions

Small, explicit changes in scope:

- **Daemon `POST /selection` body** changes from `ComponentHandle` to `{ nodes: ComponentHandle[] }` (1..10). Daemon takes `nodes[0]`. Breaking change to a freshly-shipped surface; no external consumers yet (MCP shim reads, does not post).
- **Daemon WS auth** moves from `Authorization: Bearer` header to subprotocol (`Sec-WebSocket-Protocol: redesigner-v1, bearer.<token>`). HTTP routes keep `Authorization` header. Auth-fail at upgrade closes with 4401 (not HTTP 401), so the extension can distinguish auth failure from network error.
- **Daemon CORS.** New `OPTIONS` branch before auth. Response headers when origin matches `^http://(localhost|127\.0\.0\.1|\[::1\]):\d+$`:
  - `Access-Control-Allow-Origin: <echo>`
  - `Access-Control-Allow-Methods: POST, GET`
  - `Access-Control-Allow-Headers: authorization, content-type`
  - `Access-Control-Max-Age: 600`

  Non-matching origins receive no ACAO header (browser blocks). Responses to actual POSTs from allowed origins include the same ACAO echo.
- **Per-origin WS upgrade rate-limit.** Replace global bucket with `Map<key, TokenBucket>` where `key = origin.startsWith('chrome-extension://') ? wsUrl : origin`. Preserves the playground's per-origin quota and gives the extension a per-dev-server quota.
- **App-level ping.** Daemon sends `{type:'ping', t:<epoch_ms>}` every **15 s** directly on each subscriber WS. Ping does **not** consume a seq nor get recorded to the ring buffer — it bypasses `EventBus.broadcast`. Margin against MV3's 30 s idle timer. Extension ignores content; arrival counts as SW activity.
- **Accepted-origin log line.** `logger.info('[ws] accepted', { origin, wsUrl })` at upgrade success. Anomalies visible in `daemon.log`.
- **Token charset pinned** to base64url no-padding (`crypto.randomBytes(32).toString('base64url')`, already correct). Regex `^[A-Za-z0-9_-]+$` asserted in tests.

Vite plugin:

- **`editor` option.** Type `'vscode' | 'cursor' | 'zed' | 'fleet'`. Default `'vscode'`. Validated with Zod on plugin config.
- **`/__redesigner/handshake.json`** middleware. Mounted only in `configureServer` (serve-only). Response body: `{ wsUrl, httpUrl, token, editor }` — same JSON injected into the meta tag, served always-open during serve so the extension's refresh path works even when the page is stale.
- **`transformIndexHtml`** injects `<meta name="redesigner-daemon" content='<JSON>'>` into `<head>`. Serve-only via `apply: 'serve'` assertion in the plugin. Tests: `vite build` output contains no `/__redesigner/` path and no meta tag.

### 3.3 Chosen architectural approach

MV3 service worker + `Map<wsUrl, ConnState>` pool + content-script DOM agent + side panel. Alternatives ruled out:

- Per-tab CS-owned WebSocket: churns on tab switch, loses dedup, breaks side-panel-only interactions.
- Offscreen document hosting WS: unnecessary given MV3 SW keepalive via WS activity + 15 s app-level ping.
- Single global WS to a registry daemon: conflicts with brief's "one daemon per project, no global multiplexing".

---

## 4. Data flow

### 4.1 Cold boot

1. `vite dev` runs; Vite plugin forks the daemon; daemon writes handoff file; plugin reads `{port, token}`; plugin injects `<meta name="redesigner-daemon" content='{"wsUrl":"ws://127.0.0.1:PORT/events","httpUrl":"http://127.0.0.1:PORT","token":"...","editor":"vscode"}'>` into every HTML response during serve; plugin also mounts `/__redesigner/handshake.json`.
2. User opens `http://localhost:5173` in Chrome with extension installed.
3. Content script fires at `document_end`, runs `document.querySelector('meta[name="redesigner-daemon"]')`, parses the content, validates via `HandshakeSchema`. If invalid or missing → dormant, no further side effects.
4. CS generates `clientId = crypto.randomUUID()`, sends `{type:'register', wsUrl, httpUrl, token, editor, tabId, clientId}` to SW.
5. SW finds-or-creates `ConnState` in `Map<wsUrl, _>`. If new → opens `new WebSocket(wsUrl, ['redesigner-v1', 'bearer.' + token])`. Daemon validates subprotocol, accepts, echoes `redesigner-v1`.
6. Daemon emits `hello` frame with `{serverVersion, instanceId, snapshotSeq, snapshot: {current, recent, manifestMeta}}`. SW stores `lastSeq`, `instanceId`, updates panel ports.
7. Side panel opens → long-lived `runtime.Port('panel')` to SW → SW replies with snapshot for active tab's wsUrl.

### 4.2 Pick an element

1. Panel "Pick" button → SW → CS → CS activates shadow-DOM overlay.
2. Hover → highlight nearest ancestor element bearing `[data-redesigner-loc]`. Label: `ComponentName · src/file.tsx:42`.
3. Click → CS computes `ComponentHandle` (see §5.1). Sets `activePickClientId` on SW via envelope. POSTs `{nodes: [handle], clientId}` to `httpUrl + '/selection'`, `Authorization: Bearer <token>`, `Content-Type: application/json`.
4. Browser fires CORS preflight. Daemon's OPTIONS handler returns allow headers because origin matches the dev-server allowlist regex. Preflight is unauthenticated and exempt from auth/rate-limit buckets (still Host-allowlist gated).
5. Real POST succeeds. Daemon updates `SelectionState` → broadcasts `{type:'selection.updated', payload:{current, staleManifest, clientId}}` on the bus → SW receives → panel update.

### 4.3 MCP `rpc.request` round-trip

1. MCP shim → daemon `POST /computed_styles` (or `/dom_subtree`) with handle.
2. Daemon `handleBrowserToolPost` broadcasts `{type:'rpc.request', payload:{jsonrpc:'2.0', id, method, params}}` to WS subscriber.
3. SW receives. Looks up `ConnState.activePickClientId`, finds the matching `{tabId}` in `ConnState.tabs`. If none → synth `{jsonrpc, id, error:{message:'ext disconnected: no active pick'}}` (contains `disconnected` so daemon's `browserTools.ts` matcher maps to 503 ExtensionDisconnected).
4. Otherwise, SW calls `chrome.tabs.sendMessage(tabId, envelope)`. If rejected (tab gone) → synth error.
5. SW starts 5 s timer. On timeout → synth `{error:{message:'ext rpc timeout'}}` → daemon 504 ExtensionTimeout.
6. CS `rpcAgent` receives, locates element (prefer `data-redesigner-loc` equality to handle's file:line:col; fall back to `domPath`), computes reply. Size cap 512 KB → returns `{truncated: true, partial: ...}` if over.
7. CS enforces concurrency cap of 4 parallel in-flight RPCs; excess queued FIFO.
8. CS → SW via `chrome.runtime.sendMessage`. SW sends `{type:'rpc.response', payload:{jsonrpc, id, result}}` over WS.
9. Daemon's `RpcCorrelation.resolve(id, result)` returns to the waiting HTTP handler → MCP shim gets JSON.

### 4.4 Reconnect and backoff

- Backoff: `delay_ms = min(1000 * 2^attempts, 30000) * (0.8 + Math.random() * 0.4)` (±20% jitter).
- Give-up: 5 consecutive failures OR any failure chain spanning >60 s, whichever first. Sets `ConnState.giveup = true`.
- Re-arm: `tabs.onActivated` for registered tab, panel retry button, `chrome.idle.onStateChange('active')`.
- On reconnect, SW passes `?since=<lastSeq>` as a WS upgrade query parameter. Daemon replays from its ring buffer (1024 entries) or emits a single `resync.gap` frame if `since < earliest`.
- Close-code buckets:

| Code | Meaning | Action |
|---|---|---|
| 1000 | clean close | no reconnect |
| 1001 | page/SW going away | no reconnect |
| 1006 | abnormal | normal backoff |
| 1011 | server error | normal backoff + "Daemon error" banner |
| 1012/1013 | restart / try-again hint | fixed 1 s delay, does not consume budget |
| 4401 | upgrade auth mismatch | trigger handshake refresh (bounded 3×) |
| 4408 | pong timeout | normal backoff |
| 4409 | concurrent second subscriber | error state, reload required |

### 4.5 Handshake refresh (daemon restart)

- Triggers: (a) 4401 close, or (b) 1006 close followed by `GET {httpUrl}/health` failing with ECONNREFUSED or a non-200 within 500 ms (strong signal daemon restarted on a new port).
- CS re-fetches `/__redesigner/handshake.json` live (works even with stale page because the route is always-open during serve).
- If `wsUrl` changed: CS `unregister(oldWsUrl)` + `register(newWsUrl, …)`. SW closes old ConnState when refcount=0, creates new.
- If only `token` changed: CS re-registers same `wsUrl` with new token. SW updates stored token, reopens WS.
- Bound: 3 consecutive refresh attempts → `handshakeGiveup: true`, distinct banner ("Handshake refresh failed — reload the page"). Re-arm on meta-tag change event (MutationObserver) or panel retry.

---

## 5. Algorithms

### 5.1 `ComponentHandle` extraction

Input: a clicked `Element`, a `Manifest` (from daemon's `hello.snapshot.manifestMeta` — but full manifest needed for lineRange lookup; SW fetches `GET /manifest` once and caches until `manifest.updated` broadcast invalidates).

```ts
async function extractHandle(el: Element, manifest: Manifest): Promise<ComponentHandle | null> {
  const locAttr = el.closest('[data-redesigner-loc]')?.getAttribute('data-redesigner-loc')
  if (!locAttr) return null                              // no instrumentation on this subtree
  const loc = manifest.locs[locAttr]                     // e.g. "src/Button.tsx:1:28"
  if (!loc) return null                                  // stale manifest; daemon will set staleManifest:true
  const componentName = loc.componentName
  const filePath = loc.filePath                          // already project-relative
  const component = manifest.components[loc.componentKey]
  const lineRange: [number, number] = component?.lineRange ?? [
    parseInt(locAttr.split(':')[1], 10),
    parseInt(locAttr.split(':')[1], 10),
  ]
  const domPath = computeDomPath(el)                     // max 8192 chars
  const parentChain = computeParentChain(el, manifest)   // ≤64 entries
  const id = await stableId({ filePath, lineStart: lineRange[0], parentChain, el })
  return { id, componentName, filePath, lineRange, domPath, parentChain, timestamp: Date.now() }
}
```

### 5.2 `stableId`

Deterministic so the same logical node across rerenders produces the same id. `crypto.subtle.digest` is async in content-script context, so `stableId` returns a Promise:

```ts
async function stableId(args: { filePath: string; lineStart: number; parentChain: string[]; el: Element }): Promise<string> {
  const sibIdx = indexAmongSiblingsOfSameComponentName(args.el)
  const input = `${args.filePath}:${args.lineStart}|${args.parentChain.join('>')}|${sibIdx}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  // first 16 bytes → 22-char base64url (no padding); fits SELECTION_ID_RE (1–128 chars, [A-Za-z0-9_-])
  return base64url(new Uint8Array(digest).slice(0, 16))
}
```

`indexAmongSiblingsOfSameComponentName` walks the parent's children filtering by same `data-redesigner-loc` componentKey. Survives Suspense boundaries and conditional siblings that aren't same-component.

### 5.3 `computeParentChain`

DOM-walk from the element to `document.body`. At each ancestor with `[data-redesigner-loc]`, look up `manifest.locs[loc].componentName`. Dedupe consecutive repeats. Truncate at 64.

### 5.4 `computeDomPath`

Simple nth-of-type chain from element to `body`. Capped at 8192 chars; if exceeded, keep the tail.

### 5.5 Origin allowlist regex (daemon CORS)

```
^http://(localhost|127\.0\.0\.1|\[::1\]):\d+$
```

Tested against: `http://localhost:5173` (✓), `http://127.0.0.1:3000` (✓), `http://[::1]:8080` (✓), `http://localhost.evil.com:8080` (✗), `http://127.0.0.1.evil.com` (✗), `http://localhost:80@evil.com` (✗), `https://localhost:5173` (✗ until explicit https support), `http://localhost:5173/path` (✗ — Origin header has no path).

---

## 6. Security

- **Token location.** Meta tag only. Never on `window`, never in `storage.local`, only `storage.session` (cleared on browser close). Read into SW memory once per register.
- **WS auth.** Subprotocol bearer; extension origin only accepted (`shouldRejectOrigin` unchanged). Rate-limit key special-cased so extension doesn't consume playground's quota.
- **REST auth.** `Authorization: Bearer`. CORS ACAO only echoed for dev-server allowlist.
- **Handshake route.** Serve-only. Plugin asserts `command === 'serve'` and refuses to register the middleware or inject meta otherwise. Test: `vite build` output contains no handshake artifacts.
- **Token charset.** base64url no-padding; conforms to RFC 6455 subprotocol token grammar.
- **Editor scheme allowlist.** Enforced by Zod on plugin option and at the panel "Open in editor" click handler. Unknown scheme → button hidden. Prevents `bash://`-style protocol handler abuse from a malicious meta tag.
- **CSP.** Content script runs in its own isolated world. Picker overlay uses shadow DOM — no style or event leak to the page. No `innerHTML`-driven construction; all DOM built via `document.createElement`.
- **Trust model.** Ext trusts: (a) handshake loaded over same-origin HTTP from the Vite dev server, (b) daemon identity vouched for by token. Ext does **not** trust: arbitrary pages, other localhost services, cross-origin iframes.

---

## 7. State model

### 7.1 `ConnState` (per wsUrl)

```ts
type ConnState = {
  wsUrl: string
  httpUrl: string
  editor: EditorScheme
  tabs: Array<{ tabId: number; clientId: string; frameId: 0 }>   // refcount = tabs.length
  activePickClientId: string | null
  lastSeq: number
  instanceId: string | null
  giveup: boolean
  handshakeGiveup: boolean
  backoff: { attempts: number; firstFailedAt: number | null; refreshes: number }   // refreshes = count of handshake-refresh attempts in this ConnState's lifetime; reset on successful register

  pickActive: boolean
  recent: ComponentHandle[]                // mirror of daemon's recent; replaced on hello
  // Not persisted to storage.session:
  ws: WebSocket | null
  inFlightRpc: Map<string, { replyTabId: number; timer: NodeJS.Timeout }>
}
```

### 7.2 Persistence

Persisted to `chrome.storage.session` on every mutation (debounced 100 ms): all of `ConnState` except `ws` and `inFlightRpc`.

Rehydrated at SW module top-level (not `runtime.onStartup`) — MV3 wakes a suspended worker by re-executing the script; `onStartup` only fires at browser launch:

```ts
// src/sw/index.ts
const ready = hydrate()                  // top-level await
await ready
chrome.runtime.onConnect.addListener(...) // all handlers registered after
```

All message handlers `await ready` before acting.

### 7.3 Lifecycle table

| Event | Handler | Effect |
|---|---|---|
| SW script execution (wake or install) | top-level | Rehydrate `Map<wsUrl, ConnState>` from `storage.session`; sockets null; no auto-reopen |
| CS `register{wsUrl, …, clientId}` | `onMessage` | Find-or-create ConnState; push `{tabId, clientId}`; open WS if null; broadcast snapshot to panel ports |
| CS `unregister{wsUrl, tabId}` | `onMessage` | Remove tab; refcount=0 → `ws.close(1000)`, delete row |
| CS `pickCompleted{clientId}` | `onMessage` | `activePickClientId = clientId` |
| `tabs.onRemoved` | listener | Treat as unregister for any ConnState referencing that tabId |
| `webNavigation.onCommitted` off-allowlist | listener | Unregister for that tab's wsUrl |
| `webNavigation.onHistoryStateUpdated` off-allowlist | listener | Same as above (covers SPA nav) |
| WS `ping` | frame handler | No-op (activity keeps SW alive) |
| WS `hello` | frame handler | Store `instanceId`, `lastSeq`, `recent`; if instanceId mismatch vs prior → clear `recent` |
| WS `selection.updated` | frame handler | Update `lastSeq`; prepend to `recent` (max 10); broadcast to panel ports |
| WS `manifest.updated` | frame handler | Invalidate cached manifest; refetch `GET /manifest` |
| WS `rpc.request` | frame handler | See §4.3 |
| WS `close` (any code) | listener | Dispatch per §4.4 |
| `chrome.idle.onStateChange('active')` | listener | For each ConnState with giveup → re-arm |
| `tabs.onActivated` | listener | If tab registered and ConnState giveup → re-arm; panel port snapshot refresh |

### 7.4 Panel UX

| Condition | Badge | Banner |
|---|---|---|
| No handshake meta tag | off | "No reDesigner dev build on this tab." |
| WS connecting | connecting | spinner |
| WS open | connected | — |
| WS closed, retrying | error | "Reconnecting… attempt N" |
| WS closed, giveup (1006/1011) | error | "Daemon unreachable. [Retry]" |
| WS closed, handshakeGiveup | error | "Handshake refresh failed — reload the page." |
| `staleManifest:true` on selection | connected + amber dot | "Source may have moved. HMR pending." |

Open-in-editor CTA stays enabled when staleManifest is true; shows an inline `(path may have moved)` caveat.

Recent-picks list: source of truth is daemon. SW holds per-wsUrl in-memory mirror (not persisted to storage.session — recovery via `?since=<lastSeq>` replay). Panel reads via port.

`chrome.tabs.query({active: true, currentWindow: true})` is used (not `{active:true}` alone) to avoid picking up active tabs from other windows.

---

## 8. Testing

Three tiers matching daemon and MCP v0 test structure.

### 8.1 Tier-1 — Unit (`test/unit/`)

Vitest + `happy-dom` + `sinon-chrome` + `mock-socket`. `vi.useFakeTimers()` for any test touching backoff, 5 s RPC timeout, or 15 s ping.

- Handle extraction for simple, Suspense-wrapped, un-instrumented, deeply-nested (parent chain truncation at 64) elements.
- `stableId` determinism: same element across two renders → same id; different DOM position → different id; different loc → different id.
- Meta-tag parser: valid JSON, malformed JSON, missing fields, unknown editor scheme (Zod reject), absent meta.
- Meta with wsUrl outside localhost allowlist → CS dormant (defense against injected meta).
- Backoff math: deterministic with seeded `Math.random`. Attempts 1–5 produce bounded ranges. Give-up fires exactly once on count=5 OR elapsed>60 s.
- WS frame envelope Zod: all frame types round-trip; malformed frame → drop with warn, no throw.
- Close-code bucket routing: 1000 / 1001 / 1006 / 1011 / 1012 / 1013 / 4401 / 4408 / 4409 each trigger the expected state transition.
- Daemon CORS origin regex (runs in daemon's own unit test dir): valid three-form × ports; spoofs `localhost.evil.com`, `127.0.0.1.evil.com`, `localhost:80@evil.com`; https reject; path suffix reject; userinfo hijack reject.

### 8.2 Tier-2 — Integration (`test/integration/`)

Vitest with `sinon-chrome` + `mock-socket`. Fake timers active. `poolMatchGlobs: [['test/integration/**', 'forks']]` + `forks.singleFork: true` (same pattern as daemon).

- Ready-promise gating: message arrives before hydration resolves → handler awaits.
- SW state machine: hydrate → register → open (mocked) WS → hello → broadcast to port → selection.updated → teardown on tab close → refcount=0 closes WS.
- Three unregister paths: `tabs.onRemoved`, `webNavigation.onCommitted` off-allowlist, `webNavigation.onHistoryStateUpdated` off-allowlist. Each decrements refcount and closes WS at zero.
- ClientId routing: tabs A and B registered on same wsUrl, pick in B (sets activePickClientId=B), inject rpc.request → assert `tabs.sendMessage` called with B's tabId only.
- RPC round-trip happy path + 5 s timeout → synth error + `tabs.sendMessage` rejection (tab gone) → synth error.
- CS concurrency cap: 5 parallel rpc.requests → 4 in-flight, 1 queued, all resolve FIFO.
- Handshake refresh: 4401 → CS refetches handshake → token changes → reconnect succeeds. Third consecutive 4401 → handshakeGiveup + distinct banner.
- `staleManifest:true` frame → panel push includes amber-dot state.
- `instanceId` mismatch on hello → `recent` cleared.

### 8.3 Tier-3 — E2E (`test/e2e/`, nightly)

Playwright + `chromium.launchPersistentContext({ args: ['--load-extension=packages/ext/dist'] })`. Real timers with 30 s waits on lifecycle assertions. Not gated on PR CI.

- Cold-boot: `vite dev` + `--load-extension` + open playground → badge connected → pick element → panel shows handle → `curl /selection` returns matching handle.
- Multi-tab same daemon: two tabs on same playground → single WS (assert via `[ws] subscriber count=1` in daemon.log); pick in tab B → `selection.updated.payload.clientId` matches tab B.
- Multi-dev-server: two independent Vite projects running simultaneously, two tabs → two daemons, two WS connections, isolated state.
- CORS preflight: synthetic request from dev-server origin → OPTIONS returns allow headers. Non-allowlisted origin → no ACAO header (browser blocks; assert absence).
- Daemon restart: kill daemon mid-session → badge error → restart → handshake refresh picks up new port+token → badge reconnects → pick still works.
- Give-up re-arm: disconnect network → wait for giveup banner → re-enable + focus tab → auto-reconnects.
- SW suspend survival: stop SW via `chrome.debugger` CDP `ServiceWorker.stopWorker` → SW restarts → panel port reconnects → state restored → WS reopens on next register.
- HMR + selection sync happy path: pick → edit source → HMR → selection still correct (same id).
- HMR + selection sync stale path: pick → manifest rebuild changes source line → panel shows amber "source may have moved" banner.
- Leak regression (nightly only): 500 picks in a loop → `chrome.storage.session` usage ≤5 MB (via `getBytesInUse`), SW heap ≤50 MB.

### 8.4 Tooling

- Vitest config at `packages/ext/vitest.config.ts`. Unit in threads, integration in forks (singleFork).
- Playwright config at `packages/ext/playwright.config.ts`. Tagged `@nightly`; CI selects by tag.
- Mocks pinned: `sinon-chrome`, `mock-socket`, `happy-dom`, `msw` if needed for outbound `fetch`.
- Fake timers policy: Tier-1+Tier-2 explicit `vi.useFakeTimers()` at suite level for time-sensitive cases. Tier-3 real timers.

### 8.5 Daemon and Vite-plugin test additions

Named explicitly so they don't fall off the implementation plan:

- Daemon: subprotocol auth happy + charset rejection + 4401 close on mismatch; CORS OPTIONS + actual POST ACAO echo; per-origin rate-limit key behavior for ext vs dev origin; `{nodes:[]}` body validation (1..10); 15 s ping interval; WS frame schema parity with core.
- Vite plugin: handshake middleware serves in `serve`, absent in `build`; meta-tag injection in serve, absent in build; `editor` option Zod enforcement; plugin refuses to run if `command !== 'serve'`.

---

## 9. Implementation order

Suggested build order for the plan:

1. **Core** — `wsFrames.ts`, `handshake.ts`, `SelectionPostBodySchema`. Pure types.
2. **Daemon prereqs** — subprotocol auth, 4401 close, CORS, per-origin rate-limit, 15 s ping, body shape, accepted-origin log. Tests alongside.
3. **Vite plugin** — handshake middleware + `transformIndexHtml` + `editor` option. Tests.
4. **Extension shared + content script** — schemas, messages, meta parse, extractHandle, stableId. Tier-1.
5. **Extension SW** — connPool, wsClient, hydrate, rpc, panelPort. Tier-2.
6. **Extension picker overlay** — shadow DOM, hover highlight, click pin. Tier-1 + Tier-2 integration with SW.
7. **Extension side panel** — React UI, port hook, badge, selection card, recent list, picker toggle, open-in-editor. Tier-2.
8. **Extension E2E** — Playwright scaffolding, cold-boot happy path. Remaining E2E scenarios iteratively.
9. **Playground dogfood** — exercise full loop end to end. Fold learnings.
10. **Doc + packaging** — README, install steps, unpacked-dev vs release.

---

## 10. Open questions (non-blocking)

- Chrome Web Store publishing: deferred to post-v0. v0 ships unpacked-dev instructions only.
- Firefox port: share 95% of the code, but requires MV3 compatibility shims. Tracked separately.
- Accessibility for the picker overlay: keyboard-driven picking (Alt+arrow to navigate, Enter to pin). v0 is mouse-only.
