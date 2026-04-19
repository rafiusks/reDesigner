# Daemon v0 — Design

**Status:** Approved for planning
**Date:** 2026-04-19
**Scope:** Piece #2 from `brief.md`. Ships `@redesigner/daemon` + `DaemonBackend` in `@redesigner/mcp`. Unblocks selection tools without a Chrome extension.
**Parent specs:**
- `2026-04-18-vite-plugin-and-playground-design.md` (v0 plugin)
- `2026-04-19-mcp-shim-v0-design.md` (shim v0 — frozen contracts referenced throughout)

## 1. Goal

Ship `@redesigner/daemon` — a per-project long-running Node child process forked by the existing `DaemonBridge` inside `@redesigner/vite`'s `configureServer` hook. The daemon owns in-memory selection state, watches `.redesigner/manifest.json` for plugin writes, and exposes a loopback HTTP API for the MCP shim plus a WS `/events` channel for the (later) Chrome extension.

Ship `DaemonBackend` in `@redesigner/mcp` as a composition over the shipped `FileBackend`: overrides only `getCurrentSelection`, `getRecentSelections`, `getComputedStyles`, `getDomSubtree`. `getManifest` and `getConfig` inherit from `FileBackend` unchanged — manifest is authored state on disk, daemon-independent.

No Chrome extension in this milestone. Browser-dependent tools (`getComputedStyles`/`getDomSubtree`) register real MCP schemas but return `McpError(InternalError)` with `"no browser extension connected"` while no ext is subscribed to `/events`. Dogfood verifies the shim↔daemon swap; hand-driven selection updates via `POST /selection` (curl or devtools REPL) replace hand-editing `.redesigner/selection.json`.

## 2. Non-goals for this iteration

- Chrome extension — separate milestone (picker UI, WS client, native-messaging token bootstrap).
- `@redesigner/cli` with `init` command — separate milestone.
- Multi-framework adapters (Vue/Svelte/Next) — brief pins React+Vite for v0.
- Real `getComputedStyles` / `getDomSubtree` implementations — land with extension.
- Multi-project multiplexing per MCP session — one daemon per project (per brief); shim resolves one handoff per session.
- Token rotation mid-session — daemon respawn rotates via new process; no in-process rotate API.
- Per-client rate limiting — global token-bucket only v0.
- `/internal/*` observability endpoints — no concrete caller; cut per speculative-surface rule.
- Persistence of selection history across daemon respawn — process-lifetime only.
- TLS for loopback — threat model excludes on-host network sniffers.
- IPv6 `::1` loopback binding — explicit `127.0.0.1` only.
- Origin-based WS auth gating — deferred until ext ships with stable `chrome-extension://{id}` origin.
- Shim-side crash-count state / permanent-unreachable-for-session — not introduced; shim relies on handoff re-read + pid-probe.
- `DELETE /selection` route + `selection.cleared` WS frame — no MCP tool ships a `clear_selection`; cut from v0 scope. Ext milestone re-introduces both together when ext has a concrete use case (tab-close / click-away).

## 3. Architectural invariants

1. **Data ownership split is the conceptual center.** Manifest is authored state: plugin produces on disk, durable, survives daemon restarts. Selection is session state: exists only while a browser tab is connected (or hand-driven via POST), meaningless without a live daemon. Each piece of state is served by whoever owns it — no fallback to a shared code path.
2. **DaemonBackend composes over FileBackend via inheritance.** Override-only on selection + browser-tool methods. `getManifest` / `getConfig` reach disk directly. Daemon-down has zero impact on manifest tools.
3. **Policy lives in the daemon; extension stays dumb.** Click semantics (dedupe, move-to-front, history cap, HMR-race tolerance) are daemon-owned so the ext can always send every click event without interpretation.
4. **Frozen MCP contracts unchanged.** Tool schemas + descriptions + resource URIs from shim v0 (`get_current_selection`, `list_recent_selections`, `get_computed_styles`, `get_dom_subtree`, `project://manifest`, `project://config`) are unchanged. Server version bumps MINOR when browser-tool behavior transitions from "always unavailable" to "works when ext connected" — schema-preserving.
5. **Error-message strings are advisory, not load-bearing.** `McpError.message` contents may change without SemVer impact. Callers branch on `ErrorCode` only. Pin documented in §13 migration.
6. **Validation errors surface as `McpError`.** Shim's `toMcpError` mapping extends with daemon-originated symbolic codes; environmental/transient failures map to `InternalError`, shape/validation failures map to `InvalidRequest`.
7. **Bounded everything.** Request body ≤64KB (≤16KB for `/selection` POST). WS frame ≤256KB. Manifest ≤10MB (pre-flight `stat.size`). ComponentHandle fields ≤4KB/≤256/≤16-elem caps. Ring buffer 256 frames. History cap 50. Global rate limits: 100/s / 20/s POST-selection / 5/s browser-tool-per-method. Per-ext 8 concurrent in-flight RPCs.
8. **Atomic writes, always.** Handoff file written via single `openSync(path, 'wx', 0o600) + writeSync + closeSync` — no tmp+rename window because the file is write-once-per-process-lifetime. Manifest writes (plugin side) already atomic via tmp+rename.
9. **Single event loop + synchronous bodies = no locking.** All state mutations (`SelectionState.apply/clear/rescan`, `ManifestWatcher` cache swap) are synchronous within a single handler; broadcast dispatches synchronously post-mutation, pre-HTTP-response. Seq minted after mutation, not during.
10. **Process isolation is the security boundary, not the wire.** Token + loopback + POSIX 0600 handoff. No TLS. No CORS. No Origin check. Any local process that reads the handoff file is already inside the trust boundary.

## 4. Handoff protocol

**Handoff path**: `{projectRoot}/node_modules/.cache/redesigner/daemon.json`.

`projectRoot` = vite's `config.root` (same one `ManifestWriter` uses). If `node_modules/.cache/redesigner/` is missing, daemon `mkdirSync({recursive: true})`. If dir can't be written, daemon exits 1 and bridge logs + operates in manifest-only mode.

**Shape** (stable wire contract):

```ts
interface Handoff {
  protocolVersion: 1           // handoff schema major; bumped on breaking changes
  serverVersion: string        // semver of @redesigner/daemon
  pid: number                  // daemon process id
  host: '127.0.0.1'            // always loopback
  port: number                 // OS-assigned
  token: string                // 32-byte crypto-random, base64url, ~43 chars
  projectRoot: string          // absolute, realpath'd; shim verifies match via GET /health
  startedAt: number            // epoch ms; informational
}
```

**Write path** (daemon startup, order-pinned):

1. `openSync(handoffPath, 'wx', 0o600)` — EEXIST → `process.exit(1)` (bridge runs manifest-only). POSIX mode set at creation; Windows ignores the mode arg (no-op).
2. `server.listen('127.0.0.1', 0, cb)` — in `cb`, assert `server.address() === { address: '127.0.0.1', family: 'IPv4', port: <number> }`; otherwise `process.exit(1)` (defends against DNS-level `127.0.0.1` weirdness or a shimmed `net` module).
3. Generate token: `crypto.randomBytes(32).toString('base64url')`.
4. `await manifestWatcher.start()` — resolves only after first validate attempt completes (cache warmed if manifest existed).
5. `writeSync(fd, JSON.stringify(handoff)); closeSync(fd)`.
6. Emit `{"type":"ready","port":<n>}\n` on stdout. Bridge's readiness barrier now means "handoff written + manifest cache warmed."

**Read path** (shim `DaemonBackend`, lazy on first selection call):

1. Resolve project root: if `REDESIGNER_PROJECT_ROOT` env set, use it; else walk up from `process.cwd()` finding the nearest `package.json` whose `dependencies` or `devDependencies` contains `@redesigner/vite`. HOME ceiling (reuse `resolveConfig` logic). Cache the resolved handoff *path* for the session; cwd + env can't change mid-process.
2. `safeJsonParse` + `HandoffSchema.safeParse`.
3. `protocolVersion !== 1` → permanent-unreachable for session (cannot trust parse semantics); log + serve manifest-only.
4. `semver.major(serverVersion) !== semver.major(shim.package.version)` → permanent-unreachable; log + manifest-only.
5. `process.kill(pid, 0)`:
   - ESRCH → log (info-level on first session verdict; warn thereafter) `[shim] daemon handoff stale (pid N dead)`; enter 1s unreachable TTL.
   - EPERM → log `[shim] handoff refers to process owned by another user`; permanent-unreachable. Never signal strangers.
   - Success → cache parsed handoff in memory alongside the path.
6. On HTTP error (ECONNREFUSED, ETIMEDOUT, fetch AbortError): invalidate cached *parsed* handoff (path retained), re-read from disk once, retry request once. Still failing → enter unreachable; return null/[]/McpError depending on method.
7. On 401: sleep 100ms (absorbs sub-ms handoff-write window from the `wx` single-syscall path), invalidate parsed handoff, re-read, retry. Persistent → unreachable.

**Lifecycle sequences**

*Fresh start*:
```
bridge: configureServer → child_process.fork(daemon/dist/child.js, { stdio:['pipe','pipe','pipe','ipc'] })
daemon: openSync('wx', 0600) handoff → bind 127.0.0.1:0 → assert address → generate token →
        await manifestWatcher.start() → writeSync handoff → closeSync → emit ready
bridge: reads ready line (2s timeout) → resolves configureServer
daemon: logs resolved handoff path + realpath at startup (monorepo debuggability)
```

*Stale handoff reclaim (daemon pid dead)*:
```
bridge probes kill(pid,0) → ESRCH → unlinkSync handoff → fork fresh
```

*Alive orphan (reuse forbidden per Q7)*:
```
bridge probes kill(pid,0) → alive
  → GET /health (500ms timeout, Authorization header from handoff): must return 200 + projectRoot match
  → success: SIGTERM → 2s grace → SIGKILL → unlink handoff → fork fresh
  → failure (timeout, 401, wrong projectRoot, wrong shape): unlink handoff → fork fresh (no signal; treat as pid-recycled or zombie)
  → EPERM on kill(pid,0): unlink handoff → fork fresh (no signal; different uid)
```

*Parent disconnect*:
```
daemon: process.on('disconnect') → shutdown sequence (POSIX + Windows)
fallback 1s poll (POSIX only): if process.ppid === 1 → shutdown (orphaned)
```

*Shutdown*:
```
bridge: SIGTERM (POSIX) or stdin '{"op":"shutdown"}\n' (Windows)
daemon: stop accepting new HTTP + WS connections
      → drain in-flight HTTP ≤500ms (in-flight browser-tool RPCs respond McpError(Shutdown), not hang)
      → broadcast WS 1001 "daemon shutting down" + `shutdown` frame (ext distinguishes from net failure, suppresses reconnect)
      → await watcher.close() (Promise-typed defensive; Node 20+ sync)
      → unlinkSync handoff
      → exit 0
      (Windows: write "{\"ack\":true}\n" to stdout *after* unlink, *before* exit — bridge's read on ack is a reliable "handoff is gone" signal)
```

*Crash mid-session*: bridge registers `child.on('exit', code => { if (code !== 0) respawnOnce(); })`. One respawn attempt with 250ms → 1s backoff. After that one attempt fails, bridge stops respawning for the session; shim observes via handoff re-read + ESRCH → manifest-only.

## 5. HTTP API

All routes loopback-only. `Authorization: Bearer {token}` required on every route including `/health` (identification gate for reclaim SIGTERM path). Token comparison uses `crypto.timingSafeEqual` with length-normalization:

```ts
if (providedBuf.length !== expectedBuf.length) {
  crypto.timingSafeEqual(expectedBuf, expectedBuf)  // burn same cycles
  return 401
}
return crypto.timingSafeEqual(providedBuf, expectedBuf) ? ok : 401
```

Unauthorized → `401` with empty body (no `X-Redesigner-Auth-Failure` header; 401 + empty is fully diagnostic shim-side, and a header would enable route enumeration). Unknown route → `404 NotFound`. Method mismatch → `405`. Request bodies JSON via `safeJsonParse` + Zod, size-capped at middleware: `≤64KB` general, `≤16KB` for `/selection` POST. Over-cap → `413 PayloadTooLarge` (streaming cap — no full-body allocation before rejection).

**Shim consumers (selection)**:

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `200 {projectRoot, serverVersion, protocolVersion, uptimeMs}` |
| GET | `/selection` | `200 {current: ComponentHandle \| null}` (provenance stripped at wire) |
| GET | `/selection/recent?n=<1..50>` | `200 {items: ComponentHandle[]}` (`n` clamped; invalid → 400) |
| POST | `/selection` | `204` — body `ComponentHandle`, Zod strict (reject unknown fields), applies A-semantics (move-to-front dedupe on id; cap 50). Broadcasts `selection.updated` if not no-op. |

**Manifest (ext only; shim reads disk directly)**:

| Method | Path | Response |
|---|---|---|
| GET | `/manifest` | `200 Manifest` — last successfully-validated daemon copy. Returns `503 NotReady` until first successful watch-validate completes. |

**Browser-tool proxy (shim → daemon → ext WS RPC)**:

| Method | Path | Response |
|---|---|---|
| POST | `/computed_styles` | `200 {styles}` / `503 ExtensionUnavailable` / `504 ExtensionTimeout` |
| POST | `/dom_subtree` | `200 {tree}` / `503` / `504` |

Body: `{handle: ComponentHandle, depth?: number}` (shim passes the raw handle it read; daemon re-matches by `handle.id` against current+history, rejects unknown with 404). Flow:

1. Daemon checks WS subscriber count on `/events`; 0 → `503 ExtensionUnavailable` immediately.
2. Daemon allocates `rpcId = crypto.randomBytes(16).toString('hex')`; stores `{resolve, reject, timer}` in a correlation map.
3. Daemon sends WS frame `{type:"rpc.request", seq, payload:{rpcId, method, handle, depth}}` to the single subscribed ext.
4. Ext replies with `{type:"rpc.response", inReplyTo, payload:{rpcId, ok, result|error}}`; daemon matches by `rpcId`.
5. Timeout: 5s for `computed_styles`, 10s for `dom_subtree`. On timeout → map entry cleaned, `504 ExtensionTimeout`.
6. Ext disconnects mid-flight → all pending rpcIds rejected with `503 ExtensionUnavailable` (single codepath).
7. Shutdown mid-flight → all pending rpcIds rejected with `503 ShuttingDown` before WS 1001 + `shutdown` frame.
8. Per-ext 8 concurrent in-flight cap; 9th → `429 TooManyInFlight` (short / no `Retry-After`; retry when slot frees — shim backoff 250ms).
9. Backpressure-driven ext disconnect (queue >1MB) walks correlation map, rejects pending as `503 ExtensionUnavailable` — same codepath as ext-disconnect.

**WS upgrade**:

| Method | Path | Response |
|---|---|---|
| GET | `/events` with `Upgrade: websocket` | `101 Switching Protocols` on success; `401 Unauthorized` + socket destroy before handshake on missing/invalid token; `400 BadRequest` pre-handshake on malformed `?since=`. |

Token validated inside `server.on('upgrade', ...)` handler before `handshake` accepts. Non-sensitive `?since=<seq>` in query string is fine (leaks to logs are informational).

**Error envelope** (all 4xx/5xx): `{error: {code: string, message: string, details?: object}}`. Code is symbolic (`Unauthorized`, `StaleSelection`, `ExtensionUnavailable`, `ExtensionTimeout`, `TooManyRequests`, `TooManyInFlight`, `PayloadTooLarge`, `NotReady`, `Shutdown`, …). Shim maps known codes to `McpError`: handle-shape issues → `InvalidRequest`; environmental transients (`ExtensionUnavailable`, `ExtensionTimeout`, `TooManyInFlight`, `Shutdown`, daemon-unreachable) → `InternalError` with descriptive message.

**Rate limits** (global token-bucket, per daemon process; per-client deferred): `/selection` POST 20/s, browser-tool proxy 5/s per method, everything else 100/s. Over-limit → `429 TooManyRequests` with `Retry-After` from bucket-refill. Distinct from `429 TooManyInFlight` (concurrent cap; no `Retry-After`; short backoff) — shim branches on symbolic code.

## 6. WS `/events` wire protocol

**Connection**: `GET /events` with `Upgrade: websocket` + `Authorization: Bearer {token}` (validated pre-handshake) + optional `?since=<seq>` for resync. Second concurrent subscriber → close 4409 + log. Text frames only, UTF-8 JSON.

**Envelope**:

```ts
interface DaemonFrame {
  type: string         // kebab.dot namespaced
  seq: number          // u53 monotonic from daemon
  payload: unknown
}

interface ExtFrame {
  type: string
  inReplyTo?: number   // seq of daemon frame being responded to
  // no daemon-counter seq; ext may include its own counter for debugging, daemon ignores it
  payload: unknown
}
```

Daemon counter is strictly monotonic on what ext tracks as "last seen"; ext-originated frames never advance it.

**Frame catalogue**

Daemon → ext:

| type | payload | notes |
|---|---|---|
| `hello` | `{serverVersion, protocolVersion, snapshotSeq, snapshot: {current: ComponentHandle \| null, recent: ComponentHandle[], manifestMeta: {contentHash, componentCount} \| null}}` | First frame after upgrade. Snapshot is *always current*. `snapshotSeq` is the watermark; any frame with `seq > snapshotSeq` received subsequently is a real delta. Recent capped at 10 in hello; ext GETs `/selection/recent?n=50` if it wants more. When non-null, `snapshot.current === snapshot.recent[0]` — ext must not double-render. When `manifestMeta === null`, ext retries manifest fetch on next `manifest.updated`, not by polling. |
| `selection.updated` | `{current: ComponentHandle, staleManifest: boolean}` | After POST /selection when apply-kind is `new` or `promoted`. `staleManifest` is the one provenance field crossing the wire (diagnostic UX for ext). |
| `manifest.updated` | `{contentHash, componentCount}` | After validated fs.watch re-read. `contentHash` is the canonical identity across sections (§7 + §8). Ext compares to `hello.snapshot.manifestMeta.contentHash` to decide if it already has this manifest. |
| `staleManifest.resolved` | `{count}` | Informational. Ext recovery path on receipt: refetch `GET /selection` + `GET /selection/recent?n=50`. |
| `rpc.request` | `{rpcId, method: "get_computed_styles" \| "get_dom_subtree", handle: ComponentHandle, depth?: number}` | Browser-tool proxy; ext responds with `rpc.response`. |
| `resync.gap` | `{droppedFrom, droppedTo}` | Sent after `hello` when `?since < currentSeq - 256`. Ext discards local event-derived state (catchup animations, toasts, flashes), rebuilds derived state from `hello.snapshot` + GET /manifest. |
| `shutdown` | `{reason}` | Sent before WS 1001 close frame so ext suppresses reconnect spam. |

Ext → daemon:

| type | payload | notes |
|---|---|---|
| `rpc.response` | `{rpcId, ok: true, result: unknown} \| {rpcId, ok: false, error: {code, message}}` | Correlation by `rpcId`. `inReplyTo` = seq of the `rpc.request` frame (debugging/logging; daemon ignores). |

Unknown frame types from ext → log + drop; never close over bad frames (ext version drift should be recoverable).

**Sequence numbers**: daemon mints one u53 counter at process start. Seq wraps only theoretically (u53 at 1000 events/sec = 285,000 years).

**Ring buffer** (gap signaling only): 256 most recent outbound frames retained in memory. On upgrade:

- `?since=N` absent → send `hello` only (current snapshot).
- `N >= currentSeq` → `hello` only (nothing missed).
- `currentSeq - 256 ≤ N < currentSeq` → `hello` only. **No replay.** Snapshot is always current; frames with `seq ≤ snapshotSeq` are already applied, replaying would double-apply.
- `N < currentSeq - 256` → `hello` then `resync.gap`. Ext knows to skip catchup animations and rebuild derived state from snapshot.
- `N` malformed → `400 BadRequest` pre-handshake (not 1008).

Ring buffer's role is reduced to gap detection, not state reconstruction.

**Close codes**:

| code | meaning | ext action |
|---|---|---|
| 1000 | normal | don't reconnect |
| 1001 | daemon shutting down (paired with `shutdown` frame) | don't reconnect this daemon; poll handoff for new instance |
| 1008 | policy violation: auth revoked mid-session (daemon respawn with new token while ext holds old) | re-read handoff before reconnect (token may have rotated) |
| 4408 | keep-alive pong timeout | reconnect immediately |
| 4409 | already subscribed from another connection | surface "another tab is connected" |
| 4429 | backpressure: send queue exceeded 1MB or 512 frames | reconnect after 2s |

**Backpressure**: per-ext send queue; >1MB or >512 frames → close 4429. Ring buffer + `?since=` covers recovery. All pending rpcIds rejected with 503 at close time (§5 #9 unified codepath).

**Keep-alive**: ping/pong every 10s from daemon; ext must respond within 5s or close with 4408. Cheap on loopback; snappier laptop-sleep/wake recovery than TCP keepalive.

**Frame size**: 256KB per frame. `ws` configured with `maxPayload: 256 * 1024` so library cap matches spec cap. Oversize ext frame → close 1008.

## 7. Selection state model

Daemon-internal types (never cross wire except where noted):

```ts
interface SelectionProvenance {
  receivedAt: number                       // epoch ms of POST landing
  staleManifest: boolean                   // true if manifest lookup missed at intake
  manifestContentHashAtIntake?: string     // identity of validated manifest at intake
}

interface SelectionRecord {
  handle: ComponentHandle
  provenance: SelectionProvenance
}

class SelectionState {
  private current: SelectionRecord | null = null
  private history: SelectionRecord[] = []    // most-recent first; capped 50
  private readonly HISTORY_CAP = 50

  apply(incoming: SelectionRecord): ApplyResult
  rescan(manifest: Manifest): StaleResolution
  snapshot(): { current: ComponentHandle | null, recent: ComponentHandle[] }
}
```

**Invariants**:

- `current` is null, or a record also present at `history[0]`. Shared identity, not a copy.
- Dedupe spans `current + history`: incoming `handle.id` match → that record moves to position 0 and becomes `current`; no new entry created.
- All mutation through `apply` / `rescan`; direct field writes forbidden (TS private).
- No persistence. State dies with process. Selection history loss on respawn acceptable by design (Q3).

**`apply(incoming)` taxonomy** (broadcast keys on kind, not post-state inspection):

| kind | condition | result |
|---|---|---|
| `noop` | `incoming.handle.id === prior current.handle.id` | no state change, no broadcast |
| `promoted` | `incoming.handle.id` matches a history record that is *not* the current | move to position 0, set `current = history[0]`, broadcast `selection.updated` |
| `new` | no id match | unshift to history, drop tail if >50, set `current = history[0]`, broadcast `selection.updated` |

**Intake flow** (`apply`):

1. Zod `ComponentHandleSchema` strict (reject unknown fields) passed at HTTP layer. Size caps: `filePath ≤4KB`, `componentName ≤256`, `parentChain length ≤16`, each element `≤256`.
2. Manifest lookup: does `filePath` exist in `daemon.manifest.components`? Does any loc span overlap `lineRange`? Yes → `staleManifest = false`, `manifestContentHashAtIntake = manifest.contentHash`. No or manifest not loaded → `staleManifest = true`, rate-limited log (coalesced `"N selections referenced unknown components in last 10s"`).
3. Dedupe → determine kind → mutate → broadcast per table above.

**`rescan(manifest)`** (called from `ManifestWatcher.onValidated`):

1. Walk `[current, ...history.filter(r => r !== current)]` (avoid double-visit).
2. For each record with `provenance.staleManifest === true`, re-run manifest lookup. If now resolves: set `staleManifest = false`, `manifestContentHashAtIntake = manifest.contentHash`, increment `resolvedCount`.
3. If `resolvedCount > 0` → daemon broadcasts `staleManifest.resolved` with `{count}`.
4. Unidirectional: never re-resolves or mutates already-resolved entries against a newer manifest. Preserves "handle captures the click moment."
5. No eviction of still-stale entries — history cap does that.

**Handle identity grounding**: shipped `ComponentHandleSchema` constrains `id: string` via `SELECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/`. Daemon treats id as opaque dedupe key. Ext is responsible for per-brief stability across DOM rerenders. Shim treats `ComponentHandle` as opaque per frozen MCP schema — no client-side id computation.

**Broadcast dispatch timing**: synchronous within POST handler, post-mutation, pre-HTTP-response-write. Seq minted *after* mutation (not during). Zero `await` between mutation and emit — ordering guaranteed by event-loop sequencing, not convention.

**Concurrency**: HTTP handlers and manifest watcher both mutate state. Node single-threaded event loop + synchronous `apply`/`rescan` bodies = no locking needed.

**Wire shapes** (re-asserted):

- `GET /selection` → `{current: ComponentHandle | null}` (no provenance).
- `GET /selection/recent?n=N` → `{items: ComponentHandle[]}` (no provenance).
- `selection.updated` frame payload → `{current: ComponentHandle, staleManifest: boolean}` (staleManifest is the one provenance field on the wire; ext diagnostic UX; not exposed via shim).
- `staleManifest.resolved` frame payload → `{count: number}`.

## 8. Manifest watch pipeline

```ts
class ManifestWatcher {
  private cached: Manifest | null = null
  private cachedContentHash: string | null = null
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private inFlight: boolean = false
  private rereadPending: boolean = false
  private stats = { events: 0, validated: 0, rejected: 0 }

  constructor(
    private manifestPath: string,
    private onValidated: (m: Manifest) => void,
    private fsReadFile: typeof fs.promises.readFile,  // injectable for single-flight tests
    private logger: Logger,
  ) {}

  async start(): Promise<void>
  async stop(): Promise<void>
  getCached(): Manifest | null
}
```

**Start sequence** (cold path):

1. `watchDir = path.dirname(manifestPath)`, `basename = path.basename(manifestPath)`. Watch directory, not file — atomic rename replaces inode; file-level watchers die silently on some platforms.
2. `mkdirSync(watchDir, {recursive: true})`.
3. `stat(manifestPath)`: exists → `await reread()` before resolving `start()`. ENOENT → leave `cached = null`; GET /manifest returns 503 NotReady; `hello.snapshot.manifestMeta = null`.
4. `watcher = fs.watch(watchDir, {persistent: false})` — `persistent: false` so watcher doesn't keep event loop alive.
5. `watcher.on('change', (eventType, filename) => { if (filename === basename) scheduleReread() })`.
6. `watcher.on('error', err => { logger.error(err); attemptRestart() })` — restart once with 1s backoff; after successful re-registration always invoke `reread()` unconditionally (catches any write missed during close↔reopen gap). Second restart failure → stop; operate on stale cache; GET /manifest keeps serving last validated.

**`scheduleReread`**:

1. If `debounceTimer` set, clear it.
2. `debounceTimer = setTimeout(reread, 50)` — ~50ms coalesce platform event duplicates.

**`reread`** (single-flight enforced):

1. If `inFlight`, set `rereadPending = true` and return.
2. `inFlight = true`; clear `debounceTimer`; `stats.events++`.
3. Try:
   - `stat.size > 10MB` → log + rejected++ + return (matches FileBackend cap; stat-then-read is race-free for local file written atomically by sibling process; streaming cutoff fragments the valid-JSON-or-reject model).
   - `raw = await fsReadFile(manifestPath, 'utf8')`.
   - `parsed = safeJsonParse(raw)`.
   - `ManifestSchema.safeParse(parsed)`.
4. On any failure: `stats.rejected++`; rate-limited log (10/min) `"[daemon] manifest re-read rejected: ${reason}; keeping cached version"`. **Do not** clear cache, bump seq, or broadcast.
5. On success:
   - If `parsed.contentHash === cachedContentHash` → idempotent no-op (plugin wrote same content).
   - Else: atomic swap `cached = parsed; cachedContentHash = parsed.contentHash`; `stats.validated++`; invoke `onValidated(parsed)` which:
     1. `selectionState.rescan(parsed)` → may emit `staleManifest.resolved` frame.
     2. Broadcast `manifest.updated` frame `{contentHash, componentCount}`.
     - Order pinned: rescan before manifest.updated so `staleManifest.resolved` lands first (frame order reflects causal order).
6. Finally: `inFlight = false`. If `rereadPending`: `rereadPending = false`; re-invoke `reread()`. Classic single-flight pattern prevents concurrent readFile races.

**Invariants**:

- Seq increments only on successful validated re-read path. No events for rejected reads, no events for idempotent same-content re-writes.
- `cached` never downgrades to null after first success. Daemon serves last-known-good for process lifetime.
- `contentHash` is the canonical identity across §6+§7+§8. Cross-session ext compares `hello.snapshot.manifestMeta.contentHash` to decide "already have this manifest."

**Cold-start race** (plugin slower than daemon — common first-boot):

1. Daemon starts: `cached = null`, watcher active.
2. Plugin's ManifestWriter bootstrap atomic write fires.
3. `fs.watch` sees rename event; debounce; re-read; cache populated; broadcast `manifest.updated`.
4. First shim connection during this window: `GET /manifest` would return 503, but **shim reads disk directly via FileBackend inheritance** — it doesn't hit `GET /manifest`. Shim's own `readManifest` has retry (`maxRetries: 1, retryDelayMs: 50`). Daemon + shim reach healthy state independently.

**Shutdown** (`stop`):

1. Clear `debounceTimer`.
2. `await watcher.close()` — Promise-typed defensive; Node 20+ is synchronous. Called *before* HTTP drain so any racing GET /manifest gets 503 rather than stale-and-tearing-down state.
3. Drop cache reference.

**Observability**: `stats` populated for 60s summary log lines (`manifest watcher: N events, M validated, K rejected`). No `/internal/watcher-stats` endpoint (speculative surface).

## 9. DaemonBackend (shim-side)

```ts
export class DaemonBackend extends FileBackend {
  private handoff: { path: string, parsed: Handoff | null } | null = null
  private unreachableUntil = 0
  private unreachableReason: string | null = null
  private firstVerdictLogged = false
  private readonly UNREACHABLE_TTL_MS = 1000
  private readonly SELECTION_REQUEST_TIMEOUT_MS = 250
  private readonly COMPUTED_STYLES_TIMEOUT_MS = 6000   // server 5s + 1s slack
  private readonly DOM_SUBTREE_TIMEOUT_MS = 11000      // server 10s + 1s slack

  constructor(opts: FileBackendOptions) { super(opts) }

  override async getCurrentSelection(): Promise<ComponentHandle | null> { … }
  override async getRecentSelections(n: number): Promise<ComponentHandle[]> { … }
  override async getComputedStyles(handle: ComponentHandle): Promise<Record<string,string>> { … }
  override async getDomSubtree(handle: ComponentHandle, depth: number): Promise<unknown> { … }
  // getManifest, getConfig inherited — disk-backed, daemon-independent (§3 invariant 1+2)
}
```

**`cli.ts` instantiation**: unconditionally `new DaemonBackend(opts)`. No startup handoff probe. Handoff-absent handled internally by DaemonBackend's lazy first-call discovery returning null/[]/McpError. `FileBackend` retained in codebase for tests + future non-vite CLI paths via explicit opt-in (not the production path).

**Handoff discovery** (once per session, then path-cached):

1. If `REDESIGNER_PROJECT_ROOT` env set → `${envVar}/node_modules/.cache/redesigner/daemon.json`.
2. Else walk up from `process.cwd()`: nearest `package.json` with `@redesigner/vite` in `dependencies` or `devDependencies` (HOME ceiling).
3. Cache shape: `{path: string, parsed: Handoff | null}`. Invalidation drops `parsed` only; `path` survives (cwd + env stable within process).

**Unreachable state**:

```ts
private isUnreachable(): boolean { return Date.now() < this.unreachableUntil }
private markUnreachable(reason: string): void {
  this.unreachableUntil = Date.now() + this.UNREACHABLE_TTL_MS
  if (this.unreachableReason !== reason) {
    const level = this.firstVerdictLogged ? 'warn' : 'info'
    this.logger[level](`[shim] daemon unreachable: ${reason}`)
    this.unreachableReason = reason
    this.firstVerdictLogged = true
  }
}
private markReachable(): void {
  if (this.unreachableReason !== null) {
    this.logger.info('[shim] daemon reachable again')
  }
  this.unreachableUntil = 0
  this.unreachableReason = null
}
```

First verdict of session logs at `info` ("daemon not yet running" is common for user running shim before vite). Subsequent transitions at `warn`. Recovery transition logs `info`.

**`getCurrentSelection()`** → `ComponentHandle | null`:

1. `isUnreachable()` → return `null`.
2. Ensure handoff: if no cached `parsed`, run discovery; on any discovery failure (file missing, protocol mismatch, major-version mismatch, EPERM) → enter appropriate unreachable state; return `null`.
3. `try { const {current} = await httpGet('/selection'); markReachable(); return current }`.
4. On `ECONNREFUSED | ETIMEDOUT | fetch AbortError`: invalidate `parsed`, re-read handoff, retry once. Still failing → `markUnreachable('connection failed after handoff re-read')`; return `null`.
5. On `401`: sleep 100ms → invalidate `parsed` → re-read → retry. Persistent → `markUnreachable('auth failed')`; return `null`.
6. On `503 NotReady` (cold start): return `null` without marking unreachable (daemon healthy, selection empty).
7. On any other non-2xx → mark unreachable with symbolic code; return `null`.

**`getRecentSelections(n)`** → `ComponentHandle[]`:
Same flow; unreachable → `[]`. Pass-through `?n=${n}` (already Zod-validated at MCP tool layer).

**`getComputedStyles(handle)`** (throws):

1. `isUnreachable()` → `throw McpError(InternalError, 'daemon unreachable')`.
2. `httpPost('/computed_styles', {handle}, 6000)`.
3. `503 ExtensionUnavailable` → `throw McpError(InternalError, 'no browser extension connected')`.
4. `504 ExtensionTimeout` → `throw McpError(InternalError, 'extension did not respond in time')`.
5. `429 TooManyInFlight` → retry once after 250ms; persistent → `throw McpError(InternalError, 'too many in-flight requests')`.
6. `429 TooManyRequests` → honor `Retry-After`; retry once; persistent → throw.
7. Connection error → invalidate handoff + re-read + retry; persistent → throw.
8. `400 StaleSelection` or handle-shape failures → `throw McpError(InvalidRequest, <message from server>)`.

**`getDomSubtree(handle, depth)`**: same pattern, 11000ms timeout.

**`httpRequest(path, init, timeoutMs = SELECTION_REQUEST_TIMEOUT_MS)`**:

```ts
async httpRequest(path: string, init: RequestInit, timeoutMs = SELECTION_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`http://${this.handoff!.parsed!.host}:${this.handoff!.parsed!.port}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.handoff!.parsed!.token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    })
  } finally { clearTimeout(timer) }
}
```

Node 22+ built-in `fetch`. No external HTTP dep.

## 10. Security model

**Token**: 32 bytes `crypto.randomBytes` → base64url (~43 chars). Process-lifetime, never rotated, never persisted. Comparison via `crypto.timingSafeEqual` with length-normalization (§5). Transmitted only as `Authorization: Bearer` header on HTTP and WS upgrade — never in query strings (query strings leak to logs, process listings, browser history). `?since=<seq>` in WS upgrade URL is fine because seq is non-sensitive.

**Network binding**: `server.listen('127.0.0.1', 0, cb)` — in `cb`, assert `server.address() === { address: '127.0.0.1', family: 'IPv4', port: <n> }`, otherwise `process.exit(1)`. Defends against DNS-level 127.0.0.1 resolution oddities or shimmed `net` modules. WS shares port via HTTP upgrade. No IPv6 `::1` v0.

**Handoff file permissions**: `openSync(path, 'wx', 0o600) + writeSync + closeSync` — mode set at creation, no TOCTOU window. Windows ignores mode arg (documented no-op; NTFS ACLs inherit from project dir). Primary isolation is `node_modules` being under HOME; 0600 is belt-and-suspenders for permissive-umask systems.

**Auth timing**: HTTP token check before body parse; 401 + empty body. No `X-Redesigner-Auth-Failure` header (enables route enumeration). WS upgrade: token checked in `server.on('upgrade')` handler before `handshake` accepts; failure → `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()` — no 101 response.

**Origin**: v0 no Origin check on WS upgrade. Token + loopback + 0600 handoff are the isolation layer; any process that reads the handoff is already inside the trust boundary. Origin logged for debugging, not validated. Revisit when ext ships with stable `chrome-extension://{id}`.

**CORS**: not enabled. No `Access-Control-*` headers. Browsers don't cross-origin-fetch loopback without opt-in; shim is Node (no CORS); ext uses WS (no preflight). `*` would invite drive-by fetches from any browser tab — token blocks access but token could be sniffed via attacker-controlled ext scripts if CORS is wide-open.

**Input validation**: length caps + Zod structural checks only. No user-provided-string regex matching. Shipped `SELECTION_ID_RE` is simple char class + length — linear and ReDoS-safe. Stated as explicit v0 boundary so future regex adds get scrutiny.

**Secret hygiene in logs**: token never logged — not full, not prefixed (no `token.slice(0, 4)` either; preempts incident-triage temptation). `token.length` is loggable (confirms expected size). Handoff `{path, pid, port, serverVersion}` loggable; token field explicitly excluded.

**Rate limits** (recap from §5): global token-bucket, per-daemon-process. Per-client deferred.

**Input bounds** (recap): request body ≤64KB general / ≤16KB POST /selection; WS frame ≤256KB; manifest ≤10MB pre-parse; ComponentHandle field caps enforced pre-Zod (filePath ≤4KB, componentName ≤256, parentChain ≤16 × ≤256).

**Explicitly NOT addressed in v0 (threat model boundary)**:

- Multi-user shared dev machine attack — users with same-HOME access can read each other's handoffs.
- Malicious VS Code extension or npm postinstall with code-exec as the user — can read `.cache/redesigner/daemon.json` and drive daemon. v0 assumes user trusts their own local toolchain (same boundary as running `vite dev`).
- TLS for loopback — threat model excludes on-host network sniffers.
- Token rotation mid-session — daemon respawn rotates (new process, new token).
- ReDoS via pathological regex input — no user-provided-string regex matching in v0; adding one later requires audit.

## 11. Package layout + deps

**New workspace package**: `packages/daemon/` — `@redesigner/daemon`.

```
packages/
├── core/                 unchanged
├── vite/                 DaemonBridge signature updated: startDaemon({manifestPath}) — port param removed
├── mcp/                  DaemonBackend added; FileBackend retained for tests; cli.ts unconditionally uses DaemonBackend
└── daemon/               NEW
    ├── package.json      @redesigner/daemon; deps: zod, ws, @redesigner/core (workspace:*)
    ├── tsconfig.json     extends root; lib: ["ES2023"]; no DOM
    ├── tsup.config.ts    esm only; two entries: src/index.ts (parent), src/child.ts (fork target)
    ├── src/
    │   ├── index.ts              export { startDaemon }; parent-facing API; fork child, return DaemonHandle
    │   ├── child.ts              child entry: boot sequence + signal handlers + ready line + lifecycle
    │   ├── handoff.ts            Handoff type + Zod + write (wx + 0600) + discover + realpath logging
    │   ├── server.ts             http.createServer + route table + WS upgrade wire-up
    │   ├── routes/
    │   │   ├── selection.ts      GET/POST /selection + GET /selection/recent (no DELETE; cut from v0)
    │   │   ├── manifest.ts       GET /manifest
    │   │   ├── browserTools.ts   POST /computed_styles, /dom_subtree (RPC proxy)
    │   │   └── health.ts         GET /health (auth-required)
    │   ├── auth.ts               timingSafeEqual + length-normalize + 401 empty body
    │   ├── rateLimit.ts          token-bucket + in-flight cap
    │   ├── state/
    │   │   ├── selectionState.ts SelectionState (§7)
    │   │   ├── manifestWatcher.ts ManifestWatcher (§8)
    │   │   └── eventBus.ts       seq counter + ring buffer (256) + subscribers
    │   ├── ws/
    │   │   ├── events.ts         /events upgrade handler; subscriber lifecycle
    │   │   ├── frames.ts         Frame Zod schemas (all daemon↔ext types)
    │   │   └── rpcCorrelation.ts correlation map
    │   ├── lifecycle.ts          shutdown orchestration (drain → WS 1001 → unlink → exit)
    │   ├── logger.ts             structured JSON-per-line; rolling 10MB file
    │   └── types.ts              internal types
    └── test/
        ├── unit/
        │   ├── selectionState.test.ts
        │   ├── manifestWatcher.test.ts
        │   ├── eventBus.test.ts
        │   ├── handoff.test.ts
        │   ├── auth.test.ts
        │   ├── rpcCorrelation.test.ts
        │   └── rateLimit.test.ts
        └── integration/
            ├── endToEnd.test.ts
            ├── manifestHmr.test.ts
            ├── browserToolProxy.test.ts
            ├── lifecycle.test.ts
            ├── daemonRespawn.test.ts
            └── resync.test.ts
```

**Dependencies**:

- `zod` — `^3.25.0 || ^4.0.0` (aligned with core + mcp per CLAUDE.md).
- `ws` — `^8.18.0`, configured with `maxPayload: 256 * 1024` to match §6 spec cap. Audit on every version bump beyond Dependabot auto-approve (single non-core runtime dep, network edge).
- `@redesigner/core` — `workspace:*`.

**No** additional runtime deps: vanilla `http` (not express/fastify); no body-parser (vanilla stream + size cap); no structured-logger dep (in-process rotation: on reaching 10MB, `closeSync(handle); renameSync(daemon.log, daemon.log.1); openSync(daemon.log, 'w')`; writes are synchronous line-oriented so no buffer-on-rotation loss).

**devDependencies**: `vitest`, `tsup`, `typescript`, `@types/ws`, `fast-check` (§12 property-based testing).

**Parent-facing API**:

```ts
// packages/daemon/src/index.ts
export async function startDaemon(opts: { manifestPath: string }): Promise<DaemonHandle>
```

`DaemonHandle` shape already locked by existing `DaemonBridge` contract (`pid, shutdown, stdout, stdin, stderr`). Daemon process is a `child_process.fork` (for IPC disconnect event). Parent side wraps ChildProcess into DaemonHandle. Child side is the actual HTTP+WS server.

**Build outputs** (tsup):

```json
{
  "exports": {
    ".":      { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./child": { "import": "./dist/child.js" }
  },
  "files": ["dist"]
}
```

Child entry exported so parent resolves via `fileURLToPath(import.meta.resolve('@redesigner/daemon/child'))` — robust to bundling (vs fragile `new URL('./child.js', import.meta.url)`).

**Node target**: `>=22.0.0`.

**tsconfig**: `lib: ["ES2023"]`, `strict: true`, `moduleResolution: "bundler"`, no `DOM` (fetch global from `@types/node` recent enough). Verify in scaffolding commit; fallback is `undici` on shim side.

## 12. Testing strategy

Vitest harness. Follows repo pattern `vi.mock('node:fs', importOriginal)` (ESM namespaces frozen; `vi.spyOn` on `node:fs` throws — CLAUDE.md pin).

**Unit (in-process, no forks, no network)**:

| File | Covers |
|---|---|
| `selectionState.test.ts` | apply() taxonomy (noop/promoted/new), dedupe invariants across current+history, rescan unidirectional (stale→resolved only), 50-cap eviction, broadcast payload shapes |
| `manifestWatcher.test.ts` | debounce coalescing (fake timers), schema-fail-keep-cache, idempotent re-writes no-op, **single-flight via injectable `fsReadFile` returning deferred promises** (assert ≤1 outstanding call), content-hash swap semantics, `start()` resolves only after first validate attempt, rescan causal ordering (staleManifest.resolved before manifest.updated) |
| `eventBus.test.ts` | seq monotonicity, ring buffer 256 eviction, resync snapshot capture with `snapshotSeq`, gap-threshold branching, subscriber backpressure (>1MB → 4429), keep-alive 10s/5s timing |
| `handoff.test.ts` | `openSync('wx', 0o600)` mode correctness (POSIX; `describe.skipIf(process.platform === 'win32')`), wx EEXIST, Zod round-trip, protocolVersion gate, serverVersion major-mismatch |
| `auth.test.ts` | length-mismatch → no RangeError + 401 (timingSafeEqual burned cycles), equal-length compare, token never in response body/headers, no `X-Redesigner-Auth-Failure` header, no token in log output (prefix or full) |
| `rpcCorrelation.test.ts` | rpcId alloc + lookup + timeout cleanup + ext-disconnect rejection + shutdown rejection + 8-concurrent cap → 429 TooManyInFlight |
| `rateLimit.test.ts` | token-bucket math, distinct limits per route-class, `Retry-After` on `TooManyRequests` only, absence on `TooManyInFlight` |

Unit harness: daemon classes instantiable with injected `Clock` + `Logger` + `fsReadFile` (pattern already in shipped `ManifestWriter`). No forks. No sockets.

**Integration (real fork, real sockets)**:

| File | Covers |
|---|---|
| `endToEnd.test.ts` | Full spawn: fork `dist/child.js`, await ready line, read + Zod-validate handoff. Round-trip POST/GET /selection + verify WS frame delivery. Teardown via SIGTERM. Happy-path smoke. |
| `manifestHmr.test.ts` | Sibling process writes manifest via atomic temp+rename. Assert: single `manifest.updated` per write, correct `contentHash`, burst of 20 writes within 30ms → ≤3 frames (debounce + idempotency). Malformed write → no frame, prior cache serves. |
| `browserToolProxy.test.ts` | No WS subscriber → POST /computed_styles → 503 ExtensionUnavailable. Mock ext connects, subscribes, receives rpc.request, responds → HTTP 200. Timeout: ext silent → 504. Ext disconnects mid-flight → 503 before timeout. Shutdown mid-flight → 503 ShuttingDown. 9th concurrent → 429 TooManyInFlight. |
| `lifecycle.test.ts` | Fresh start: ready line within 2s. Parent disconnect: child exits ≤1.5s (IPC or ppid=1 poll). SIGTERM drain + WS 1001 + unlink + exit 0. Stale handoff reclaim: plant dead pid → bridge unlinks + respawns. Alive orphan → /health identifies → SIGTERM → respawn. EPERM on kill(pid,0) → unlink without signal. **Windows**: `{op:"shutdown"}` stdin → ack `\n` arrives *after* handoff unlinked (ordering assertion, not just eventual presence). |
| `daemonRespawn.test.ts` | Start daemon → SIGKILL → bridge respawn-once-with-backoff (250ms, 1s) → shim next call: first request ECONNREFUSED → re-read handoff → retry succeeds. Token rotated → shim 401 → 100ms backoff → re-read → retry succeeds. Second respawn fails → bridge gives up; shim continues re-reading handoff, ESRCH → manifest-only (no new shim crash-count state). |
| `resync.test.ts` | Connect → disconnect at seq=N → reconnect `?since=N` in buffer → hello only (no replay). Disconnect → push 300 frames → reconnect `?since` too old → hello + `resync.gap`. Malformed `?since` → 400 pre-handshake (not 1008). Second concurrent subscriber → close 4409. **Snapshot consistency**: property test (fast-check) — random interleaving of selection updates + manifest updates + disconnect points; reconnect with `?since=<old seq>`; assert reconstructed state ≡ stayed-connected state. |

**MCP-layer E2E** (lives in `packages/mcp/test/integration/` — exercises shim↔daemon):

| File | Covers |
|---|---|
| `daemonBackend.e2e.test.ts` | Spawn daemon. Construct `@modelcontextprotocol/sdk` `Client`, connect shim over stdio with `DaemonBackend`. Seed manifest on disk. Drive tools, verify responses. Kill daemon mid-session → tools return null/[] from selection, `McpError(InternalError)` from browser tools. Restart daemon → verify recovery after unreachable TTL. |
| `daemonAbsent.e2e.test.ts` | No daemon. Handoff absent. Shim's `DaemonBackend` → first selection call logs at info → returns null. Manifest tools keep working via `FileBackend` inheritance. Validates graceful "standalone" path cli.ts commits to. |

**Cross-platform**: POSIX + Windows via GitHub Actions matrix (already configured). Specifics:

- `handoff.test.ts` skips chmod assertion on Windows (documented no-op).
- `lifecycle.test.ts` exercises `{op:"shutdown"}` stdin + ack-after-unlink ordering on Windows; SIGTERM on POSIX. `ppid===1` poll skipped on Windows.
- `manifestWatcher.test.ts` includes spurious-error + restart + reread scenario (macOS `fs.watch` flakiness).

**Fuzz / boundary**:

- `fast-check` with Zod schema-derived arbitraries for `ComponentHandleSchema`, `HandoffSchema`, `ManifestSchema`, wire-frame types. Property: `schema.safeParse(arbitrary)` → either `.success === true` or rejected with structured error; never throws.
- Mutation strategy: start from valid fixture, apply N field-type mutations per case, assert rejected. Complements property tests for boundary cases.
- Body size caps exercised: POST /selection with 17KB → 413 without allocating full body. WS frame ≥257KB → close 1008.

**Performance**: `pnpm --filter @redesigner/daemon run bench` exists locally; no CI gate; no numeric target pinned (fs-layer noise makes sustained-writes-per-second meaningless). If a number is needed later, pick one isolated from `fs.watch` (e.g., broadcast latency p99 given pre-validated manifests fed into pipeline).

**Coverage** (advisory, ungated): daemon 85% line / 80% branch; DaemonBackend override paths 90%. Vitest coverage-v8; GitHub Actions summary; no threshold gate (churn punishes velocity for marginal signal).

**Fixture pattern**: existing `packages/vite/test/fixtures/` convention + pre-commit hook + `FIXTURE_CHANGELOG.md` apply automatically to daemon fixtures via globbed hook paths.

## 13. Migration + follow-ups

**Migration from shim v0 (FileBackend-only)**:

- MCP shim already uses Backend abstraction (shim v0 §3 invariant 1). Zero tool-schema changes.
- `packages/mcp/src/cli.ts` switches to `new DaemonBackend(opts)` unconditionally. `FileBackend` remains importable for test opt-in.
- Playground `.mcp.json` unchanged — same `packages/mcp/dist/cli.js` target. After rebuild, shim auto-discovers daemon via handoff.
- `.redesigner/selection.json` no longer the selection source when daemon runs, but `FileBackend` still reads it in standalone/test contexts. Leave file in repo `.gitignore`.
- Existing `DaemonBridge` in vite plugin resolves to real `@redesigner/daemon/dist/index.js` once new package ships. Bridge signature updated to drop `port` param (update single call site in lockstep).
- Frozen MCP schemas unchanged. Server version bumps MINOR when daemon + ext both ship (behavior transitions from always-503 to works-when-connected).
- **Error-message strings are advisory, not load-bearing** — pin from §3 invariant 5. `McpError.message` content may change without SemVer impact. Callers branch on `ErrorCode` only. Relevant because post-ext shipment will stop emitting `"no browser extension connected"` on happy-path calls; any downstream caller pattern-matching on that string breaks without this pin.
- **Upgrade `@redesigner/mcp` and `@redesigner/vite` in lockstep**. Mismatched `semver.major` of `serverVersion` across the handoff → shim falls back to manifest-only with a diagnostic log (per §4 read path step 4). Preempts confused bug reports from users who do partial `pnpm up`.

**Deferred follow-ups** (captured so they don't drift):

- `@redesigner/cli init` command — scaffold `.mcp.json` + vite config snippet + ensure `node_modules/.gitignore` (defensive handoff privacy).
- Chrome extension milestone inherits daemon-ready state: picker UI, WS client with `?since=` resync, close-code handling (1001 vs 4408), browser-tool RPC handler. Zero daemon changes.
- `redesigner daemon status` CLI subcommand — print resolved handoff path + parsed fields (token redacted). Useful when monorepo discovery goes sideways.
- Multi-ext support (post-4409 → broadcast-to-many) — requires resolving "which tab answers rpc.request." Non-trivial; don't pre-design.
- Persisted selection history — deferred per Q3; only reopen if dogfood reveals genuine pain.
- Observability endpoints (`/internal/*`) — add on-demand with concrete caller.

**Open questions intentionally left unresolved**: none at design level. Q1–Q7 + 13 sections fully resolved. Remaining latitude is in implementation values (debounce intervals, retry backoff constants, buffer sizes, log-rotation thresholds) which the daemon's config module exposes for tuning without spec change.
