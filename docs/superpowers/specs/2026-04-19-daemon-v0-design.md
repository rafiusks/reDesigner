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
- Shim-side crash-count state / permanent-unreachable-for-session — not introduced; shim relies on handoff re-read + pid-probe.
- Same-uid local attacker protection — best-effort only. The daemon performs defense-in-depth (`lstat` + ownership + realpath checks on handoff dir/file, fd `fstat`/`ino` match after `openSync`). Against an attacker with the same uid and code-exec on the host, no local IPC scheme without OS-level sandboxing fully defends. Documented in §10.
- `DELETE /selection` route + `selection.cleared` WS frame — no MCP tool ships a `clear_selection`; cut from v0 scope. Ext milestone re-introduces both together when ext has a concrete use case (tab-close / click-away).

## 3. Architectural invariants

1. **Data ownership split is the conceptual center.** Manifest is authored state: plugin produces on disk, durable, survives daemon restarts. Selection is session state: exists only while a browser tab is connected (or hand-driven via POST), meaningless without a live daemon. Each piece of state is served by whoever owns it — no fallback to a shared code path.
2. **DaemonBackend composes over FileBackend via inheritance.** Override-only on selection + browser-tool methods. `getManifest` / `getConfig` reach disk directly. Daemon-down has zero impact on manifest tools.
3. **Policy lives in the daemon; extension stays dumb.** Click semantics (dedupe, move-to-front, history cap, HMR-race tolerance) are daemon-owned so the ext can always send every click event without interpretation.
4. **Frozen MCP contracts unchanged; server SemVer is the single version channel.** Tool schemas + descriptions + resource URIs from shim v0 (`get_current_selection`, `list_recent_selections`, `get_computed_styles`, `get_dom_subtree`, `project://manifest`, `project://config`) are unchanged. Server `serverVersion` (SemVer of `@redesigner/daemon`) is the only version dimension: MAJOR bumps on any breaking wire change (handoff shape, HTTP route signature, WS envelope). MINOR bumps on behavior changes (e.g., browser-tool transitions from "always unavailable" to "works when ext connected" — schema-preserving). Shim's major-equality gate against handoff covers all breaking changes; no separate `protocolVersion` integer.
5. **Error-message strings are advisory, not load-bearing.** `McpError.message` contents may change without SemVer impact. Callers branch on `ErrorCode` only. Pin documented in §13 migration.
6. **Validation errors surface as `McpError`.** Shim's `toMcpError` mapping extends with daemon-originated symbolic codes; environmental/transient failures map to `InternalError`, shape/validation failures map to `InvalidRequest`.
7. **Bounded everything.** Request body ≤64KB (≤16KB for `/selection` POST). WS frame ≤256KB. Manifest ≤2MB (reduced from 10MB per event-loop-stall concern — see §8). ComponentHandle fields ≤4KB/≤256/≤16-elem caps. Ring buffer **1024 frame-metadata entries** (≤100KB memory footprint at ~100B per entry; not ~64KB). History cap 50. Global authenticated rate limits: 100/s GET, 120/s `POST /selection` (burst 30), 5/s browser-tool-per-method. Per-ext 8 concurrent in-flight RPCs. All numeric values normative; any cross-section disagreement is a spec bug.
8. **Atomic writes, always.** Handoff file written via single `openSync(path, 'wx', 0o600) + writeSync + closeSync` — no tmp+rename window because the file is write-once-per-process-lifetime. Manifest writes (plugin side) already atomic via tmp+rename.
9. **Single event loop + synchronous bodies = no locking.** All state mutations (`SelectionState.apply/clear/rescan`, `ManifestWatcher` cache swap) are synchronous within a single handler; broadcast dispatches synchronously post-mutation, pre-HTTP-response. Seq minted after mutation, not during.
10. **Process isolation is the security boundary, defended in depth.** Primary isolation: loopback bind + bearer token + POSIX `0600` handoff written via `openSync('wx', 0o600)`. Layered defenses: `Host` header allowlist (blocks DNS rebinding), `Origin` header denylist on WS upgrade (blocks browser drive-by WS from untrusted pages), directory `lstat`/symlink/uid checks before handoff write (blocks symlink-plant TOCTOU from same-uid attacker), `fstat`/`ino` match after `openSync` (blocks post-unlink race), separate unauth rate-limit bucket + failed-auth lockout (blocks port-guess DoS). No TLS, no CORS. An attacker with same uid + local code-exec defeats all of these — documented as out-of-scope.

## 4. Handoff protocol

**Handoff path** — resolved in OS-appropriate runtime-dir, never under `node_modules/.cache/` (which is commonly cloud-synced by Spotlight/Dropbox/iCloud/Backblaze/Time Machine and readable by every user-level background agent):

```
Linux:   ${XDG_RUNTIME_DIR}/redesigner/{projectHash}/daemon-v1.json   (tmpfs, cleared at logout)
         (fallback if XDG_RUNTIME_DIR unset: ${os.tmpdir()}/redesigner-${uid}/{projectHash}/daemon-v1.json)
macOS:   ${os.tmpdir()}/com.redesigner.${uid}/{projectHash}/daemon-v1.json
         (TMPDIR under ~/Library/Caches/TemporaryItems/; periodically cleared; not Time Machine-backed)
Windows: ${process.env.LOCALAPPDATA}\\redesigner\\${uid}\\{projectHash}\\daemon-v1.json
         (not OneDrive-synced by default; per-user AppData\\Local)
```

Where:
- `projectHash = sha256(realpath(projectRoot)).slice(0, 16)` — deterministic so shim discovery reaches the same path without a pointer file.
- `uid = String(process.getuid?.() ?? 'w')` on POSIX; `process.env.USERNAME` on Windows.

Parent dir created via `mkdirSync(dir, { recursive: true, mode: 0o700 })` so no peer user or other user-installed daemon can enumerate paths. Versioned filename (`-v1`) lets a future breaking handoff-schema change ship old + new daemons coexisting during upgrade; shim reads the versioned constant matching its own expected schema.

**Rationale for the move off `node_modules/.cache/`**: secrets in project-tree paths routinely flow to indexers (Spotlight) and cloud sync (iCloud Documents if user enables Desktop/Documents sync; Dropbox if project is under a synced folder; Time Machine; corporate MDM backup agents). `node_modules` is user-writable so 0600 alone doesn't stop same-uid indexers. OS runtime dirs are the canonical place for per-session secrets and explicitly not synced. No pointer file in `node_modules/.cache/` — if a developer wants the path for debugging, `redesigner daemon status` CLI (deferred follow-up in §13) prints it.

If runtime dir can't be written, daemon exits 1 and bridge logs + operates in manifest-only mode.

**Shape** (stable wire contract; version channel is `serverVersion` SemVer — see §3 invariant 4):

```ts
interface Handoff {
  serverVersion: string        // semver of @redesigner/daemon; shim major-equality gate
  instanceId: string           // uuid v4 minted at daemon startup; distinguishes generations
  pid: number                  // daemon process id
  host: '127.0.0.1'            // always loopback
  port: number                 // OS-assigned
  token: string                // 32-byte crypto-random, base64url, ~43 chars
  projectRoot: string          // absolute, realpath'd; shim verifies match via GET /health
  startedAt: number            // epoch ms; informational
}
```

**Write path** (daemon startup, order-pinned; each step fails-closed on error unless stated):

1. **Runtime-dir creation + ancestor walk** — `mkdirSync(dir, { recursive: true, mode: 0o700 })` on the runtime-dir path (per OS mapping above). Note `recursive: true` applies `mode: 0o700` ONLY to directories it actually creates — pre-existing ancestors retain their original mode/ownership. So after creation, walk each ancestor from `dir` up to the first OS-guaranteed-safe root (`$XDG_RUNTIME_DIR`, `$TMPDIR`, or `$LOCALAPPDATA` per platform): `lstat` each; assert `!isSymbolicLink()` on all, `stat.uid === process.getuid()` on POSIX, `(stat.mode & 0o022) === 0` (no group/other write) on each ancestor the daemon created OR relies on. Catches a same-uid attacker pre-creating `/tmp/redesigner-${uid}/` with `0o755` mode and planting a symlink `{projectHash}` inside it. On final `dir` itself: additionally assert `(stat.mode & 0o077) === 0` (no group/other access at all). Fail → `process.exit(1)` with diagnostic identifying the failing ancestor.
2. `fd = openSync(handoffPath, 'wx', 0o600)` — POSIX mode set at creation (no post-open window). Windows ignores mode arg (no-op).
   - **EEXIST reclaim**: read existing handoff, parse, probe `kill(existing.pid, 0)`. ESRCH → `unlinkSync(handoffPath)` → retry `openSync('wx', 0o600)` once. Any other error or retry fails → `process.exit(1)` (bridge runs manifest-only).
3. **Post-open fd guard** — `fstat(fd)` on the open fd + `lstat(handoffPath)`; assert `fstat.ino === lstat.ino`, `fstat.dev === lstat.dev`, and on POSIX `(fstat.mode & 0o177) === 0` (no group/other bits — defends against kernel or FUSE filesystem that silently promotes permissions). Mismatch → `closeSync`, `process.exit(1)`.
4. `server.listen('127.0.0.1', 0, cb)` — in `cb`, assert `server.address().address === '127.0.0.1' && server.address().port > 0 && server.address().port < 65536`. `family` field normalization varies across Node versions (string `'IPv4'` vs numeric `4` depending on version + patches); don't deep-equal. Non-loopback address → `process.exit(1)`.
5. Generate token: `crypto.randomBytes(32).toString('base64url')`. Generate `instanceId: crypto.randomUUID()`.
6. `await manifestWatcher.start()` — resolves only after first validate attempt completes (cache warmed if manifest existed).
7. **Partial-write-safe write** (explicit loop, no ambiguity on Node API semantics): `const buf = Buffer.from(JSON.stringify(handoff), 'utf8'); let offset = 0; while (offset < buf.length) { offset += fs.writeSync(fd, buf, offset, buf.length - offset); }`. Pinned as explicit loop rather than trusting `fs.writeFileSync(fd, data)` internal behavior, which the Node 22 lib source handles via a loop but is undocumented-as-contract and has historically varied by position-semantics edge cases. Then `closeSync(fd)`. Failure (ENOSPC, EIO, signal) → `closeSync`, `unlinkSync(handoffPath)` (don't leave truncated-JSON bomb), `process.exit(1)`.
8. Register `process.on('disconnect', shutdown)` (IPC channel from parent fork). Then `process.channel?.unref()` so the IPC channel doesn't pin the event loop — disconnect event still fires, but shutdown completion no longer waits on channel ref. **Invariant**: no further `process.on('message', …)` listener anywhere in daemon code — a new message listener re-refs the channel, silently reverting this decision. Enforced by lint rule banning `process.on('message')` outside the single boot file.
9. Record `initialPpid = process.ppid`. On POSIX, register 1s-interval poll comparing `process.ppid !== initialPpid` → shutdown (handles subreaper / launchd reparenting where ppid becomes something other than 1). Poll is POSIX-only; on Windows the IPC disconnect is exclusive. Call `pollTimer.unref()` so the timer doesn't pin the event loop either.
10. **Partial-write-safe ready line**: explicit loop — `const rl = Buffer.from(\`{"type":"ready","port":${port},"instanceId":"${instanceId}"}\n\`); let o = 0; while (o < rl.length) { o += fs.writeSync(1, rl, o, rl.length - o); }`. Short-writes on stdout pipes under load are real. Bridge's readiness barrier means "handoff written + manifest cache warmed + IPC disconnect registered."
11. Log resolved handoff path + `realpath` at startup for monorepo debuggability. Logger guarantees no `token` key ever leaves the process (see §10).
12. **No redirects**: daemon never emits 3xx from any route. Invariant — redirects + `followRedirects` clients leak `Authorization` to target URL.

**Read path** (shim `DaemonBackend`, lazy on first selection call):

1. Resolve project root: if `REDESIGNER_PROJECT_ROOT` env set, use it; else walk up from `process.cwd()` finding the nearest `package.json` whose `dependencies` or `devDependencies` contains `@redesigner/vite`. HOME ceiling (reuse `resolveConfig` logic). Compute `projectHash = sha256(realpath(projectRoot)).slice(0, 16)`. Build handoff path using same OS runtime-dir rules daemon uses. Cache the resolved handoff *path* for the session; cwd + env can't change mid-process.
2. **File-ownership + symlink + mode guard** — `lstat(handoffPath)`; assert regular file (not symlink, not dir), on POSIX `stat.uid === process.getuid()` and `(stat.mode & 0o077) === 0`. Any failure → permanent-unreachable with log `[shim] handoff ownership/mode check failed`; never read the file.
3. `safeJsonParse` + `HandoffSchema.safeParse`. Parse failure → permanent-unreachable (cannot trust the file).
4. **Server version gate** — `semver.major(parsed.serverVersion) !== semver.major(shim.package.version)` → permanent-unreachable; log `[shim] daemon/shim version mismatch: daemon=${parsed.serverVersion} shim=${shim.version}; upgrade both in lockstep`. Periodic re-log every 5 minutes so tails see it.
5. `process.kill(pid, 0)`:
   - ESRCH → log (info-level on first session verdict; warn thereafter) `[shim] daemon handoff stale (pid N dead)`; enter 1s unreachable TTL.
   - EPERM → log `[shim] handoff refers to process owned by another user`; permanent-unreachable. Never signal strangers.
   - Success → cache parsed handoff in memory alongside the path; cache also records `parsed.instanceId` (used by reconnect dedup).
6. On HTTP error (ECONNREFUSED, ETIMEDOUT, fetch AbortError): invalidate cached *parsed* handoff (path retained), re-run steps 2–5 (full discovery including ownership + pid checks) — never skip to "retry with new token." Still failing → enter unreachable; return null/[]/McpError depending on method.
7. On `401`: sleep 100ms (absorbs sub-ms handoff-write window), **re-run full discovery** (steps 2–5 including ownership and pid checks) before issuing a retry with a new token. Never blind-retry against a socket whose pid ownership hasn't been re-verified this cycle. Persistent → unreachable.

**Lifecycle sequences**

*Fresh start*:
```
bridge: configureServer → child_process.fork(daemon/dist/child.js, { stdio:['pipe','pipe','pipe','ipc'] })
daemon: lstat+realpath watchDir → openSync('wx', 0600) handoff → fstat/ino guard → bind 127.0.0.1:0 →
        assert address → generate token + instanceId → await manifestWatcher.start() →
        writeSync handoff → closeSync → register disconnect + unref channel + ppid poll → emit ready
bridge: reads ready line (2s timeout) → resolves configureServer
daemon: logs resolved handoff path + realpath at startup (token key never serialized)
```

*Stale handoff reclaim (daemon pid dead)*:
```
bridge probes kill(pid,0) → ESRCH → unlinkSync handoff → fork fresh
```

*Alive orphan (reuse forbidden; prefer authenticated self-shutdown over pid-signal)*:
```
bridge probes kill(pid,0) → alive
  → GET /health (500ms timeout, Authorization header from handoff): must return 200 + projectRoot match + valid token roundtrip
  → success: POST /shutdown (authenticated) to daemon itself → wait 500ms for graceful exit
      → if child exits cleanly → unlink handoff → fork fresh
      → if /shutdown fails or child still alive after 500ms → re-probe kill(pid,0); if still alive, SIGTERM → 2s → SIGKILL
        → unlink handoff → fork fresh
  → failure (timeout, 401, wrong projectRoot, wrong shape): unlink handoff → fork fresh (no signal; pid-recycled or zombie)
  → EPERM on kill(pid,0): unlink handoff → fork fresh (no signal; different uid)
```

Prefers `POST /shutdown` over SIGTERM-by-pid to avoid signalling a pid that got recycled to an unrelated user process between `/health` success and signal delivery. Signal-by-pid is the last resort.

*Parent disconnect*:
```
daemon: process.on('disconnect') → shutdown sequence (primary on all platforms)
fallback 1s ppid-change poll (POSIX only): process.ppid !== initialPpid → shutdown
```

*Shutdown*:
```
bridge: SIGTERM (POSIX) or stdin '{"op":"shutdown"}\n' (Windows)
daemon: stop accepting new HTTP + WS connections (server.unref + remove listeners)
      → if shutdown was triggered by POST /shutdown, first write + flush the 200 response to that request
        (drain deadline starts AFTER /shutdown response flush, not at handler entry — prevents
         the /shutdown response itself from being counted against the 100ms budget)
      → drain in-flight HTTP ≤100ms (HTTP response flush is fast on loopback; in-flight browser-tool RPCs respond McpError(Shutdown), not hang)
      → broadcast WS `shutdown` frame then 1001 "daemon shutting down" (ext distinguishes from net failure, suppresses reconnect)
      → await watcher.close() (Promise-typed defensive; Node 20+ sync)
      → unlinkSync handoff (Windows: retry up to 3× on EPERM with 100ms backoff; AV lock is routine)
      → exit 0
      (Windows: write "{\"ack\":true}\n" to stdout *after* unlink success, *before* exit — bridge's read on ack is a reliable "handoff is gone" signal. On unlink failure after retries, write "{\"ack\":true,\"unlink\":\"failed\"}" and exit 0 anyway; bridge proceeds with reclaim path on next start.)
```

*Crash mid-session*: bridge registers `child.on('exit', code => { if (code !== 0) respawnOnce(); })`. One respawn attempt with 250ms → 1s backoff. After that one attempt fails, bridge stops respawning for the session; shim observes via handoff re-read + ESRCH → manifest-only.

**`GET /health` intent clarification**: `/health` is auth-required and serves both liveness probing and the alive-orphan identification gate. A 401 from `/health` during reclaim is *informative*, not an error: it means "either this isn't our daemon or it's a stale generation with a rotated token" — both resolve to "proceed with reclaim." Explicit so readers don't confuse it for a security gap.

## 5. HTTP API

**Middleware order** (pinned; regressions would break security + observability):

1. `Host` header allowlist — strict regex `/^127\.0\.0\.1:\d{1,5}$/` with **exact** port match. 400 `HostRejected` otherwise. Rejects: `localhost:<port>`, IP-literal variants (`127.000.000.001`, `127.1`, `0x7f000001`, `[::ffff:127.0.0.1]`), any host containing characters outside `[0-9.:]`. Error body `detail` field includes expected value: `"Host must be exactly 127.0.0.1:${port}; got ${received}"` for dev UX without info leak. **Blocks DNS-rebinding** (CVE-2025-66414 analog). Shim dials `http://127.0.0.1:${port}` directly. Applied before auth because it's cheaper and deflects browser-originated probes without burning token-compare cycles.
2. Body size cap → streaming cutoff at route limit → `413 PayloadTooLarge`. No full-body allocation before rejection.
3. Unauth rate-limit bucket (10/s global; **applies only to requests with missing or invalid `Authorization` header**; valid-token requests bypass this bucket entirely so a second concurrent MCP client doesn't trip it). Over-limit → `429 TooManyRequests` unauthenticated. Blunts port-guess DoS amplification. **No failed-auth lockout** — per-daemon lockout is a DoS weapon (any same-uid process sending 21 bad-token requests/sec would block the legitimate shim). Rate limit on the unauth bucket is the primary brake; shim-side circuit breaker (§9) prevents self-induced loops.
4. Auth: token header check (see snippet below). On 401, response includes `WWW-Authenticate: Bearer realm="redesigner"` (RFC 9110 MUST) — no info leak (realm is constant), makes some strict HTTP clients (undici strict mode) willing to retry.
5. Authenticated rate-limit bucket (per route class — see bottom).
6. Concurrent in-flight cap (per method, where applicable).
7. Route dispatch → `safeJsonParse` + Zod → handler.

**Response headers on every response**: `Server: @redesigner/daemon/{serverVersion}`. Zero secret content. Useful in Chrome DevTools Network panel for ext debugging.

**Token comparison** (normalized; never throws):

```ts
function compareToken(provided: unknown, expected: Buffer): boolean {
  // Normalize all non-string / missing / non-base64url to a zero-length buffer
  // so the only distinguisher to the caller is "401 or 200" — no RangeError,
  // no 500, no timing signal from input-shape branching.
  let providedBuf: Buffer
  try {
    providedBuf = typeof provided === 'string' ? Buffer.from(provided, 'utf8') : Buffer.alloc(0)
  } catch { providedBuf = Buffer.alloc(0) }
  if (providedBuf.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected)  // burn equivalent cycles
    return false
  }
  return crypto.timingSafeEqual(providedBuf, expected)
}
```

Unauthorized → `401` with empty body (no `X-Redesigner-Auth-Failure` header; route enumeration would become possible). Unknown route → `404`. Method mismatch → `405`.

**Error envelope** — RFC 9457 `application/problem+json`:

```ts
{
  type: string      // URI-reference (stable, not a live endpoint in v0):
                    //   "https://redesigner.dev/errors/{code-kebab-case}" for known codes
                    //   "https://redesigner.dev/errors/generic" as default (never "about:blank")
  title: string     // short human summary
  status: number    // HTTP status code (echoes response)
  code: string      // symbolic identifier (shim + ext branch on this, not message)
  detail?: string   // advisory human message, not load-bearing
  instance: string  // `/req/${reqId}` where reqId = crypto.randomUUID() minted per-request
                    //   and logged alongside the error; lets debug sessions correlate logs ↔ errors
}
```

Symbolic codes: `Unauthorized`, `HostRejected`, `OriginRejected`, `StaleSelection`, `ExtensionUnavailable` (terminal — no ext ever connected), `ExtensionDisconnected` (transient — ext disconnected mid-flight), `ExtensionTimeout`, `TooManyRequests`, `ConcurrencyLimitReached`, `PayloadTooLarge`, `NotReady`, `Shutdown`, `InvalidRequest`, `InstanceMismatch`. Shim maps: handle-shape → `InvalidRequest` → `McpError(InvalidRequest)`; environmental terminal (`ExtensionUnavailable`, `Shutdown`, daemon-unreachable) → `McpError(InternalError)`; environmental transient (`ExtensionDisconnected`, `ExtensionTimeout`, `ConcurrencyLimitReached`, `TooManyRequests`) → `McpError(InternalError)` after retry exhaustion.

**Route naming convention**: `/{resource}` = REST (current state of a named thing: `/health`, `/selection`, `/selection/recent`, `/manifest`); `/{snake_case_method}` = RPC proxy to the extension (`/computed_styles`, `/dom_subtree`). Mixed style is deliberate — each group has different semantics. Add `/rpc/*` namespace if the RPC surface grows beyond two methods.

**Shim consumers (selection — REST resources)**. All routes auth-required (no unauthenticated routes exist in v0):

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/health` | `200 {projectRoot, serverVersion, instanceId, uptimeMs}` | — |
| GET | `/selection` | `200 {current: ComponentHandle \| null}` (provenance stripped at wire) | — |
| GET | `/selection/recent?n=<1..100>` | `200 ComponentHandle[]` — **raw array**, matching the shipped shim tool's frozen output schema `list_recent_selections` exactly (no wrapper). Daemon's history cap is 50; `n > 50` returns at most `history.length` items silently (no `truncated` flag; v0 doesn't paginate beyond the cap). No `total` field. If `total` becomes needed post-v0 (e.g., ext wants truncation signaling), it'll ship via MCP 2026 `_meta` on the tool result, not by changing the HTTP wire shape. Zero unwrap required on shim side — value passes through to MCP tool output directly. | `400 InvalidRequest` on malformed `n`; daemon owns Zod validation |
| POST | `/selection` | `200 {kind: "noop"\|"promoted"\|"new", current: ComponentHandle}` (lets ext animate only on `new`/`promoted`) | `413 PayloadTooLarge`, `400 InvalidRequest` |
| POST | `/shutdown` | `200 OK {drainDeadlineMs: 100}` — caller synchronously waits for graceful exit per §4 alive-orphan flow. `200` (not `202`): the action's contract is "acknowledge + start drain that caller will observe complete via process exit", not "accepted for later processing." Body `{instanceId: string}` required; daemon `404 InstanceMismatch` if body `instanceId` doesn't match current `instanceId`. The `instanceId` guard prevents pid-recycling confusion between `/health` success and `/shutdown` delivery (bridge's bug surface, not an attacker defense — a same-uid attacker with a valid token can DoS-kill the daemon regardless of `instanceId`, which §10 acknowledges as out-of-scope). | `404 InstanceMismatch`, `400 InvalidRequest` |

The `noop`/`promoted`/`new` response kinds are v0's idempotency story: same id twice → `noop`, no state change. Callers don't need `Idempotency-Key` header. Header name reserved for post-v0 (e.g., when ext wants retry-safe POSTs across network blips); daemon reserves it as no-op in v0.

Body caps: `POST /selection` ≤16KB, all others ≤64KB. `POST /selection` body = `ComponentHandle`, Zod strict (unknown fields rejected per §7). Applies apply-taxonomy per §7; broadcasts `selection.updated` on `promoted` or `new`; no broadcast on `noop`.

**Manifest (ext consumer; shim reads disk directly)**:

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/manifest` | `200 Manifest` with `ETag: "${contentHash}"` (last validated copy; ETag = recomputed contentHash from §8). Ext sends `If-None-Match: "${lastKnownContentHash}"` → `304 Not Modified` with no body on match. Avoids re-streaming 10MB manifests on every HMR update when content is unchanged. | `503 NotReady` with `Retry-After: 1` until first successful watch-validate |

**Browser-tool proxy (shim → daemon → ext WS RPC)**. Auth-required:

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/computed_styles` | `200 {styles}` | `424 FailedDependency` (`ExtensionUnavailable`, terminal), `503 ServiceUnavailable` + `Retry-After: 2` (`ExtensionDisconnected`, transient), `504 GatewayTimeout` (`ExtensionTimeout`), `503` + `Connection: close` (`Shutdown`), `429` / `503 ConcurrencyLimitReached` (see rate-limits) |
| POST | `/dom_subtree` | `200 {tree}` | same error set |

Status code rationale:
- `424 FailedDependency` + `ExtensionUnavailable` — **no ext has ever connected this daemon lifetime**. Terminal from the shim's view; no retry until the user actually opens a browser tab. Shim surfaces to LLM as "no browser extension connected."
- `503 ServiceUnavailable` + `Retry-After: 2` + `ExtensionDisconnected` — **ext connected at some point but disconnected mid-flight or backpressure-closed**. Transient; reconnect is expected within seconds. Shim may retry once after `Retry-After`.
- `504 GatewayTimeout` + `ExtensionTimeout` — we proxied to ext and it didn't respond within the tool-specific timeout.
- `503` + `Connection: close` + `Shutdown` — daemon exiting; don't retry this connection.
- `503 ConcurrencyLimitReached` + `Retry-After: 0` — per-ext concurrent cap reached; retry when slot frees.
- `429 TooManyRequests` + `Retry-After: <refill>` — rate-limit bucket exhausted.

Body: `{handle: ComponentHandle, depth?: number}` (shim passes the raw handle it read; daemon re-matches by `handle.id` against current+history, rejects unknown with `404`). Flow:

1. Daemon checks WS subscriber count on `/events`; 0 → `424 ExtensionUnavailable` immediately.
2. Daemon allocates JSON-RPC 2.0 `id = crypto.randomBytes(16).toString('hex')`; stores `{resolve, reject, timer}` in correlation map keyed by `id`.
3. Daemon sends WS frame `{type:"rpc.request", seq, payload:{jsonrpc:"2.0", id, method:"getComputedStyles"|"getDomSubtree", params:{handle, depth}}}` to the single subscribed ext. (See §6 for JSON-RPC 2.0 framing.)
4. Ext replies with `{type:"rpc.response", payload:{jsonrpc:"2.0", id, result}}` or `{...payload:{jsonrpc:"2.0", id, error:{code,message}}}`; daemon matches by `id`.
5. Timeout: 5s for `computed_styles`, 10s for `dom_subtree`. On timeout → map entry cleaned, `504 ExtensionTimeout`.
6. Ext disconnects mid-flight → all pending ids rejected with `503 ExtensionDisconnected` (not 424 — retryable). Single codepath.
7. Shutdown mid-flight → all pending ids rejected with `503 Shutdown` before WS `shutdown` frame + 1001.
8. Per-ext 8 concurrent in-flight cap; 9th → `503 ConcurrencyLimitReached` + `Retry-After: 0` (semantically "try again shortly when a slot frees" — not rate-limiting). Shim backoff 250ms.
9. Backpressure-driven ext disconnect (§6 two-phase watermark) walks correlation map, rejects pending as `503 ExtensionDisconnected` — same codepath as ext-disconnect.
10. **Slot release ordering invariant**: on timeout / disconnect / shutdown, the concurrency slot is freed *before* the rejection resolves to the HTTP handler. Prevents a retrying client from racing a just-freed slot and falsely seeing `ConcurrencyLimitReached`.

**WS upgrade**:

| Method | Path | Response |
|---|---|---|
| GET | `/events` | `101 Switching Protocols` on success; `401 Unauthorized` + socket destroy before handshake on missing/invalid token; `403 OriginRejected` pre-handshake on non-allowlisted Origin; `400 InvalidRequest` pre-handshake on malformed `?since=`; `429 TooManyRequests` on upgrade-rate-limit breach |

Pre-handshake validation in `server.on('upgrade', ...)` handler, in this order:

1. `Host` header allowlist (same as HTTP — `127.0.0.1:<port>` only, not `localhost`).
2. `Origin` header check — **deny-by-default for v0**:
   - **Absent header** → accept (Node client, curl, shim — no browser context).
   - **Literal string `"null"`** → reject with `403 OriginRejected`. `Origin: null` is the CVE-2026-27977 bypass vector: sandboxed iframes, `<iframe sandbox>` without `allow-same-origin`, `data:` URLs, and `file://` in browsers all emit `Origin: null` — which is exactly why accepting `null` is the footgun. The null rejection IS the `file://`-browser defense.
   - Matches `chrome-extension://{id}` (when ext ships with known id) / `moz-extension://{id}` / `vscode-webview://{id}` → accept. **No `file://` allowlist** — browsers loading `file://` URLs emit `Origin: null` not `Origin: file://...`, so an explicit `file://` rule would be dead code; removing it prevents a future maintainer from "reconciling" null-reject with file-accept and reintroducing the CVE class.
   - Any other present Origin → `403 OriginRejected` + socket destroy. Blocks browser drive-by WS from untrusted pages (CVE-2025-52882 analog).
3. Token validation (same normalized compareToken as HTTP).
4. `?since=<seq>` parse: must match `/^(0|[1-9][0-9]{0,15})$/` (non-negative integer, max 16 digits, no leading zeros) AND `<= currentSeq`. Malformed → `400 InvalidRequest`.
5. **Upgrade rate limit**: max 5 upgrades/sec per daemon (prevents reconnect-loop storms on a buggy ext). Bucket is global. Over → `429 TooManyRequests`.

Non-sensitive `?since=<seq>` in query string is fine (seq is not secret; log leakage is informational).

**Rate limits** (authenticated bucket, per daemon process — per-client deferred to post-v0):

| Route class | Limit | Over → |
|---|---|---|
| `POST /selection` | 120/s sustained with burst cap 30 | `429 TooManyRequests` + `Retry-After: <bucket-refill-seconds>` — 120/s refill covers ext picker drag (30–60 events/s) with headroom; burst-30 allows brief spikes without 429'ing a multi-modifier drag or tight-interval two-click sequence. Daemon-side 16ms leading+trailing selection.updated coalesce absorbs rapid fires regardless. |
| `POST /computed_styles`, `POST /dom_subtree` (per method) | 5/s | same |
| `GET /selection`, `GET /selection/recent`, `GET /manifest`, `GET /health` | 100/s | same |
| WS upgrade | 5/s | `429` in upgrade response (no `Retry-After`) |

Concurrency cap (distinct from rate-limit; different backoff semantics):

| Class | Limit | Over → |
|---|---|---|
| Browser-tool per-ext in-flight | 8 | `503 ConcurrencyLimitReached` + `Retry-After: 0` |

Shim branches on status + code: `429` → honor `Retry-After`, exponential backoff if further limits hit; `503 Shutdown` → fail fast; `503 ConcurrencyLimitReached` → 250ms retry; `424 ExtensionUnavailable` → no retry (fail-fast, surfaces to LLM).

## 6. WS `/events` wire protocol

**Connection**: `GET /events` with `Upgrade: websocket` + `Authorization: Bearer {token}` (validated pre-handshake) + optional `?since=<seq>` for resync. Second concurrent subscriber → close 4409 + log. Text frames only, UTF-8 JSON.

**Envelope**:

Pre-handshake auth + Origin allowlist + rate-limit + `?since=` parse all live in §5's upgrade-route middleware chain.

**Envelope**:

```ts
interface DaemonFrame {
  type: string         // kebab.dot namespaced
  seq: number          // u53 monotonic from daemon; advances on every outbound frame
  payload: unknown     // Zod-validated per frame type
}

interface ExtFrame {
  type: string
  payload: unknown
  // Ext-originated frames MUST NOT include a `seq` field. Correlation for
  // rpc.response uses JSON-RPC 2.0 `id` inside the payload, not seq.
  // An optional client-side counter may appear as payload.extSeq for
  // ext-side debugging only; daemon ignores it.
}
```

Daemon counter is strictly monotonic on what ext tracks as "last seen"; ext-originated frames never advance it.

**Frame catalogue**

Daemon → ext:

| type | payload | notes |
|---|---|---|
| `hello` | `{serverVersion, instanceId, snapshotSeq, snapshot: {current: ComponentHandle \| null, recent: ComponentHandle[], manifestMeta: {contentHash, componentCount} \| null}}` | First frame after upgrade. `instanceId` (from handoff) lets ext detect daemon-generation change across reconnect — if `instanceId` differs from last-seen, ext treats as fresh daemon (clear derived state), regardless of `?since=`. Snapshot is *always current*. `snapshotSeq` is the watermark; any frame with `seq > snapshotSeq` received subsequently is a real delta. Recent capped at 10; ext GETs `/selection/recent?n=50` for more. When non-null, `snapshot.current === snapshot.recent[0]` — ext must not double-render. When `manifestMeta === null`, ext retries manifest fetch on next `manifest.updated`, not by polling. |
| `selection.updated` | `{current: ComponentHandle, staleManifest: boolean}` | After POST /selection when apply-kind is `new` or `promoted`. `staleManifest` is the one provenance field crossing the wire (diagnostic UX for ext). |
| `manifest.updated` | `{contentHash, componentCount}` | After validated fs.watch re-read. `contentHash` is the canonical identity across sections (§7 + §8). Ext compares to `hello.snapshot.manifestMeta.contentHash` to decide if it already has this manifest. |
| `staleManifest.resolved` | `{count}` | Informational. Ext recovery path on receipt: refetch `GET /selection` + `GET /selection/recent?n=50`. |
| `rpc.request` | `{jsonrpc: "2.0", id: string, method: "getComputedStyles" \| "getDomSubtree", params: {handle: ComponentHandle, depth?: number}}` | JSON-RPC 2.0 format (MCP itself is JSON-RPC 2.0; this aligns the nested wire). `id` is 16-byte hex from daemon. Browser-tool proxy; ext responds with `rpc.response`. |
| `resync.gap` | `{droppedFrom, droppedTo}` | Sent after `hello` when `?since < currentSeq - 256`. Ext discards local event-derived state (catchup animations, toasts, flashes), rebuilds derived state from `hello.snapshot` + GET /manifest. |
| `shutdown` | `{reason}` | Sent before WS 1001 close frame so ext suppresses reconnect spam. |
| `rpc.error` | `{jsonrpc: "2.0", id: string \| null, error: {code: number, message: string, data?: unknown}}` | Daemon-originated error on ext's `rpc.response` frame (unknown `id`, malformed shape, oversize result). `id` echoes the offending frame's id if parseable, else `null`. Codes follow JSON-RPC 2.0: `-32600 InvalidRequest`, `-32603 InternalError`. Ext logs + discards; never auto-retry on receipt. |

Ext → daemon:

| type | payload | notes |
|---|---|---|
| `rpc.response` | `{jsonrpc: "2.0", id: string, result: unknown}` \| `{jsonrpc: "2.0", id: string, error: {code: number, message: string, data?: unknown}}` | JSON-RPC 2.0 shape. Correlation by `id`. Ext error codes use JSON-RPC 2.0 server-error range (`-32000`..`-32099`). **Code allocation** (reserved, avoids silent collision): `-32001 ExtensionInternalError`, `-32002 ExtensionSelectionNotFound`, `-32003 ExtensionPermissionDenied`, `-32004 ExtensionTimeout` (ext-self-timeout, distinct from daemon's 504). Remaining `-32005..-32099` free for future ext features. Daemon logs unknown codes verbatim + maps to HTTP 500 internal with code `ExtensionInternalError` at shim boundary. |

Unknown frame types from ext → log + drop; never close over bad frames (ext version drift should be recoverable).

**Sequence numbers**: daemon mints one u53 counter at process start. Seq wraps only theoretically (u53 at 1000 events/sec = 285,000 years).

**Ring buffer** (gap signaling only; metadata-only retention): **1024** most recent outbound frame **metadata** (`{seq, type}` pairs, ≤64 bytes each → ~64KB total) retained in memory. Frame **payloads** are not retained — ring buffer exists only to decide hello-only vs hello+`resync.gap` on reconnect, never to replay state. Bumped from 256 to 1024 per research: a burst of HMR + selection-drag can consume 100+ seq in <1s, and 256 gives only ~4s of gap tolerance. 1024 ~16s buys room for laptop-sleep, short disconnects, and browser devtools pauses without forcing the expensive reconnect path. Memory cost is negligible given metadata-only retention.

Boundary conditions (off-by-one precise — buffer holds seqs `[currentSeq - 1023 .. currentSeq]` inclusive, 1024 entries):

- `?since=N` absent → send `hello` only (current snapshot).
- `N >= currentSeq` → `hello` only (nothing missed).
- `currentSeq - 1023 ≤ N < currentSeq` → `hello` only. **No replay.** Snapshot is always current; frames with `seq ≤ snapshotSeq` are already applied; replaying would double-apply.
- `N < currentSeq - 1023` → `hello` then `resync.gap{droppedFrom: N+1, droppedTo: currentSeq - 1024}`. Ext knows to skip catchup animations and rebuild derived state from snapshot.
- `N` malformed → `400 InvalidRequest` pre-handshake (not 1008). See §5 upgrade row for regex.

Ring buffer's role is reduced to gap detection.

**Advisory-only frame semantics** — `staleManifest.resolved` is **advisory-only** for the ext. Unlike `selection.updated` and `manifest.updated` (whose effects are baked into `hello.snapshot`), `staleManifest.resolved` is event-only — snapshot doesn't encode "how many records resolved in the last tick." If the ext drops a `staleManifest.resolved` (e.g., during a hello-only reconnect within the buffer window), it MUST NOT persist derived state from it. Ext recovery on receipt: refetch `GET /selection` + `GET /selection/recent?n=100` to reobserve current provenance. Spec-level contract; test enforced in §12.

**Close codes** (RFC 6455 app-layer codes in `4xxx` range are mnemonic of HTTP statuses only — clients MUST NOT apply HTTP semantics to them; ext action column is the contract):

| code | meaning | ext action |
|---|---|---|
| 1000 | normal | don't reconnect |
| 1001 | daemon shutting down (paired with `shutdown` frame) | don't reconnect this daemon; poll handoff for new instance |
| 1008 | policy violation: auth revoked mid-session (daemon respawn with new token while ext holds old) | re-read handoff before reconnect (token may have rotated) |
| 4408 | keep-alive pong timeout | reconnect immediately |
| 4409 | already subscribed from another connection | surface "another tab is connected"; do not reconnect until user dismisses |
| 4429 | backpressure: hard watermark hit | reconnect after 2s |

**Backpressure** (canonical `ws` pattern — `send()` boolean return + `drain` event, `bufferedAmount` only on hard-watermark canary):

1. **Per-broadcast gate**: daemon's `ws.send(frame)` call — per Node `ws` docs, returns `false` when the socket buffer is saturated. On `false`, daemon marks the subscriber as "paused": subsequent selection.updated/manifest.updated/staleManifest.resolved frames are dropped (payloads discarded; ring-buffer metadata still advances for gap detection).
2. **Resume on drain**: daemon uses `socket.once('drain', handler)` — strictly once-only per pause cycle. Persistent `on('drain', …)` listeners would accumulate across pause/resume cycles and leak. On `drain` firing AND `bufferedAmount < 256KB` (belt-and-suspenders; drain alone fires on any buffer reduction, not full clear), daemon unpauses and broadcasts a fresh `hello` frame to re-sync subscriber state. On the next pause, a fresh `once('drain', …)` is registered.
3. **Drain-loop cap** — if the fresh `hello` itself triggers `send() === false` (slow consumer on constrained egress), counter increments. `N >= 3` consecutive drain-rebroadcasts without a successful intermediate selection.updated/manifest.updated → escalate to hard-watermark close 4429 proactively. Prevents infinite drain→hello→drain cycles on chronically slow subscribers.
4. **Hard watermark**: if `bufferedAmount` exceeds 1MB (canary check on each broadcast attempt; cheap `ws.bufferedAmount` read), close with 4429. All pending rpc ids rejected with `503 ExtensionDisconnected` (single codepath with ext-disconnect per §5 step 9).

Removes per-broadcast polling overhead (`bufferedAmount` is a getter but requires internal deque walk). Matches canonical `ws` backpressure docs.

**Broadcast coalescing** — `selection.updated` frames use **leading+trailing** debounce with 16ms window (not trailing-only):

- First `selection.updated` within a quiet window emits immediately (leading edge) — isolated clicks pay zero latency tax.
- Subsequent updates within 16ms of the last emission replace the pending payload (newest wins).
- If no further update within 16ms, nothing; if another update arrived during window, trailing-edge fires at window close with the most-recent payload.

Rationale: trailing-only imposes a mandatory 16ms latency floor on every update (unacceptable for single-click UX); leading+trailing preserves instant feedback on isolated clicks AND coalesces drag bursts. Pattern matches rAF-aligned pointer-input conventions.

`manifest.updated` is naturally coalesced by §8's 100ms debounce; no additional coalesce needed.

**Keep-alive**: ping/pong every 10s from daemon; ext must respond within 5s or close with 4408. Cheap on loopback; snappier laptop-sleep/wake recovery than TCP keepalive. `ping` frames pre-encoded once (identical across subscribers) — `Buffer` reused across all `ws.ping()` calls.

**Frame size**: 256KB per frame. `ws` configured with `maxPayload: 256 * 1024` so library cap matches spec cap. Oversize ext frame → close 1008.

**Compression disabled**: `new WebSocketServer({ perMessageDeflate: false })` — disables the `permessage-deflate` extension by default. Defends against: (a) CRIME/BREACH-class compression-side-channel leakage if any frame mixes token-adjacent data with partially attacker-controlled payload; (b) zip-bomb DoS where a compressed ≤256KB frame decompresses well past `maxPayload` enforcement (varies by ws version). Frames are JSON over loopback — compression buys nothing material. Test in §12 asserts handshake response lacks `Sec-WebSocket-Extensions` header.

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

**Opacity enforcement**: daemon code accesses `handle.id` only through an internal helper `getSelectionId(record: SelectionRecord): string` (or `getSelectionIdFromHandle(handle: ComponentHandle): string`). A Biome custom lint rule (or a named-import restriction tsconfig boundary) bans direct `.id` access in daemon source outside this single file. Prevents a future accidental `handle.id.startsWith(...)` or `.slice(0, 8)` from locking ext into an id format daemon internally depends on — id opacity is an asserted contract, enforced in tooling.

**Broadcast dispatch timing**: synchronous within POST handler, post-mutation, pre-HTTP-response-write. Seq minted *after* mutation (not during). Zero `await` between mutation and emit — ordering guaranteed by event-loop sequencing, not convention.

**Concurrency**: HTTP handlers and manifest watcher both mutate state. Node single-threaded event loop + synchronous `apply`/`rescan` bodies = no locking needed.

**Wire shapes** (re-asserted to match §5 exactly):

- `GET /selection` → `{current: ComponentHandle | null}` (no provenance).
- `GET /selection/recent?n=N` → **raw `ComponentHandle[]`** (no wrapper, matches frozen MCP tool output; zero shim unwrap).
- `selection.updated` frame payload → `{current: ComponentHandle, staleManifest: boolean}` (staleManifest is the one provenance field on the wire; ext diagnostic UX; not exposed via shim).
- `staleManifest.resolved` frame payload → `{count: number}`.

## 8. Manifest watch pipeline

```ts
class ManifestWatcher {
  private cached: Manifest | null = null
  private cachedContentHash: string | null = null
  private cachedMtimeMs: number = 0
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private statPollTimer: NodeJS.Timeout | null = null
  private inFlight: boolean = false
  private rereadPending: boolean = false
  private stats = { events: 0, validated: 0, rejected: 0, statPollRecoveries: 0 }

  constructor(
    private manifestPath: string,
    private onValidated: (m: Manifest) => void,
    private fsReadFile: typeof fs.promises.readFile,  // injectable for single-flight tests
    private fsStat: typeof fs.promises.stat,          // injectable for stat-poll tests
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
7. **Stat-poll fallback** — register `statPollTimer = setInterval(statPollCheck, 3000); statPollTimer.unref()`. `unref()` prevents the timer from pinning the event loop; daemon exits cleanly on disconnect paths without waiting for the next tick. Belt-and-suspenders for macOS FSEvents degradation (community-documented: FSEvents can silently miss replace sequences, especially under Spotlight/Time Machine load). Chokidar-equivalent pattern.

**`statPollCheck`** (every 3s):

1. `stat = await fsStat(manifestPath)` (ENOENT → skip silently; watcher will pick up the create).
2. If `stat.mtimeMs > cachedMtimeMs` AND no re-read already queued/in-flight, invoke `scheduleReread()`. This catches the case where `fs.watch` missed the event.
3. On recovery (stat-poll triggered a successful re-read that watch missed), `stats.statPollRecoveries++` and log at `warn` level — signals platform issue worth investigating.

**`scheduleReread`**:

1. If `debounceTimer` set, clear it.
2. `debounceTimer = setTimeout(reread, 100)` — 100ms coalesce window. Research on macOS FSEvents shows burst coalescing latency can exceed 50ms under disk load; 100ms is the accepted sweet spot. Single-flight guard still absorbs any overlap; wider debounce just reduces wasted work cycles.

**`reread`** (single-flight enforced; fd-based read to close the stat-vs-read inode-swap race):

1. If `inFlight`, set `rereadPending = true` and return.
2. `inFlight = true`; clear `debounceTimer`; `stats.events++`.
3. Try (fd-based to avoid the `stat(path)` → `readFile(path)` race; plugin's `tmp+rename` swaps inode between the two syscalls, so `stat` sees inode A and `readFile` sees inode B — old cap bypassed):
   - `fd = await fsOpen(manifestPath, 'r')`.
   - `stat = await fd.stat()` — now reflects the fd's inode, not the pathname's.
   - `stat.size > 2 * 1024 * 1024` → `fd.close()`, log + rejected++ + return. **Reduced from 10MB to 2MB** per event-loop-stall analysis: `JSON.parse` + `ManifestSchema.safeParse` + sha256 on 10MB realistically stalls the single event loop for 600–1200ms, during which every HTTP handler and WS broadcast blocks. With §9's 250ms warm shim timeout, legitimate HMR refreshes would look like daemon-unreachable events. 2MB is a comfortable ceiling for realistic React+Vite projects (a 500-file project with full loc maps is typically ≤500KB) and caps the worst-case parse at ~150ms. If a user hits the cap, they see a rejected-read log and the daemon keeps serving the previous cached manifest — an honest failure mode instead of cascading timeouts.
   - **Bounded byte-exact read**: `buffer = Buffer.alloc(stat.size); const { bytesRead } = await fd.read(buffer, 0, stat.size, 0)`. Promoted from defense-only alternative to primary path because `fd.readFile({encoding: ...})` reads to EOF without honoring a prior `fd.stat().size` — if any writer extended the inode between `fd.stat()` and `fd.readFile()` (not possible with atomic tmp+rename, but defense-in-depth against a future corner case), the cap is bypassed silently. The `fd.read(buf, 0, size, 0)` form is the only actually-bounded read.
   - `fd.close()`.
   - **Invariant guard**: `assert bytesRead === stat.size`. Mismatch → log + rejected++ + return.
   - `raw = buffer.toString('utf8')`.
   - `parsed = safeJsonParse(raw)`.
   - `ManifestSchema.safeParse(parsed)`.
   - **Recompute `contentHash` from raw bytes daemon-side**: `recomputedHash = crypto.createHash('sha256').update(raw).digest('hex')`. Any `contentHash` value carried in the JSON is ignored — a compromised plugin or malicious file could freeze daemon cache by writing new content with the old hash; daemon trusts bytes only. (Shim-side `ManifestWriter` similarly must not trust plugin-written `contentHash` for its own cache invariants; pinned cross-reference.)
4. On any failure: `stats.rejected++`; rate-limited log (10/min) `"[daemon] manifest re-read rejected: ${reason}; keeping cached version"`. **Do not** clear cache, bump seq, or broadcast.
5. On success (using `recomputedHash`, not `parsed.contentHash`):
   - **Plugin-embedded `contentHash` reconciliation**: plugin's `ManifestWriter` embeds its own `contentHash` field computed over a canonical form (per `core/contentHash.ts`). That hash differs from daemon's raw-byte sha256. To prevent two-identifier confusion: before daemon caches `parsed` for later `GET /manifest` responses, **overwrite** `parsed.contentHash = recomputedHash`. Downstream consumers (ext, shim-equivalent, future CLI inspection tools) see one canonical identifier across all surfaces: `hello.snapshot.manifestMeta.contentHash`, `manifest.updated` frame payload, `GET /manifest` response body field, and `ETag` header all equal the same daemon-recomputed raw-byte hash. Plugin's canonical-form hash is an internal plugin-side detail that never crosses the daemon boundary. (Rationale: plugin's canonical hash is optimized for "did content meaningfully change" dedup; daemon's raw-byte hash is a wire identity for cache keying. Mixing them would require every ext and shim caller to know which hash to compare against on which surface.)
   - If `recomputedHash === cachedContentHash` → idempotent no-op (plugin wrote same bytes); update `cachedMtimeMs` from current stat so stat-poll doesn't re-trigger.
   - Else: atomic swap `cached = parsed; cachedContentHash = recomputedHash; cachedMtimeMs = stat.mtimeMs`; `stats.validated++`; invoke `onValidated(parsed)` which:
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

1. Clear `debounceTimer` and `statPollTimer` (both `clearTimeout`/`clearInterval`).
2. `await watcher.close()` — Promise-typed defensive; Node 20+ is synchronous. Called *before* HTTP drain so any racing GET /manifest gets 503 rather than stale-and-tearing-down state.
3. Drop cache reference.

**Observability**: `stats` populated for 60s summary log lines (`manifest watcher: N events, M validated, K rejected, S stat-poll-recoveries`). Stat-poll recovery count >0 = investigate platform flakiness. No `/internal/watcher-stats` endpoint (speculative surface).

## 9. DaemonBackend (shim-side)

```ts
interface CachedHandoff {
  path: string                  // resolved handoff-file path (cwd+env stable within process)
  parsed: Handoff | null        // null when invalidated; path survives invalidation
  urlPrefix: string | null      // `http://${host}:${port}` cached to avoid per-call URL parse
  instanceId: string | null     // last-seen daemon generation id (for reconnect dedup on ext side; shim logs it)
}

export class DaemonBackend extends FileBackend {
  private handoff: CachedHandoff | null = null
  private unreachableUntil = 0
  private unreachableReason: string | null = null
  private firstVerdictLogged = false
  private readonly UNREACHABLE_TTL_MS = 1000
  private readonly SELECTION_REQUEST_TIMEOUT_WARM_MS = 250   // warm path: daemon was reachable recently
  private readonly SELECTION_REQUEST_TIMEOUT_COLD_MS = 500   // first call after unreachable→reachable transition (cold cache)
  private readonly COMPUTED_STYLES_TIMEOUT_MS = 6000         // server 5s + 1s slack
  private readonly DOM_SUBTREE_TIMEOUT_MS = 11000            // server 10s + 1s slack
  private readonly AUTH_CIRCUIT_BREAKER_LIMIT = 5            // N consecutive same-instanceId 401s → permanent-unreachable
  private readonly AUTH_CIRCUIT_BREAKER_WINDOW_MS = 5000     // wider window prevents false-trips during daemon respawn (token rotation across respawn is benign)
  private consecutiveAuthFails = 0
  private lastAuthFailAt = 0
  private lastAuthFailInstanceId: string | null = null       // resets counter if instanceId changes (new daemon generation)
  private wasWarmLastCall = false

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

1. Resolve project root: if `REDESIGNER_PROJECT_ROOT` env set, use it; else walk up from `process.cwd()` finding the nearest `package.json` with `@redesigner/vite` in `dependencies` or `devDependencies` (HOME ceiling).
2. Compute `projectHash = sha256(realpath(projectRoot)).slice(0, 16)`.
3. Build handoff path using the same OS runtime-dir mapping daemon uses in §4 (Linux `$XDG_RUNTIME_DIR/redesigner/{projectHash}/daemon-v1.json` with `/tmp/redesigner-${uid}/...` fallback, macOS `$TMPDIR/com.redesigner.${uid}/{projectHash}/daemon-v1.json`, Windows `$LOCALAPPDATA\redesigner\${uid}\{projectHash}\daemon-v1.json`). **Never reads `node_modules/.cache/`** — that path is intentionally abandoned per §4 rationale.
4. Cache shape: `{path: string, parsed: Handoff | null, urlPrefix: string | null, authHeader: string | null, instanceId: string | null}`. Invalidation drops `parsed`/`urlPrefix`/`authHeader` only; `path` survives (cwd + env stable within process).
5. `urlPrefix` computed on parse: `http://${parsed.host}:${parsed.port}`. `authHeader` computed on parse: `\`Bearer ${parsed.token}\``. Both cached to avoid per-request string allocation.

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
2. Ensure handoff: if no cached `parsed`, run full discovery (§4 read path steps 1-5); on any discovery failure (file missing, ownership/mode fail, parse fail, major mismatch, EPERM) → enter appropriate unreachable state; return `null`.
3. Determine timeout: `timeoutMs = this.wasWarmLastCall ? SELECTION_REQUEST_TIMEOUT_WARM_MS : SELECTION_REQUEST_TIMEOUT_COLD_MS` (warm path 250ms, cold path 500ms — cold = first call after `markUnreachable→markReachable` transition). Steady-state agent runs pay only the 250ms budget; recovery paths get 500ms to absorb fork respawn / manifest bootstrap latency.
4. `try { const {current} = await httpGet('/selection', timeoutMs); markReachable(); this.wasWarmLastCall = true; return current }`.
5. On `ECONNREFUSED | ETIMEDOUT | fetch AbortError`: invalidate `parsed`, **re-run full discovery** (§4 read path steps 2-5 including ownership + pid checks) before retry. Never reuse cached token past a failure. Still failing → `markUnreachable('connection failed after handoff re-discovery')`; `this.wasWarmLastCall = false`; return `null`.
6. On `401`: **circuit breaker check first** — load current handoff's `instanceId`. If `instanceId !== lastAuthFailInstanceId` (new daemon generation), reset `consecutiveAuthFails = 0` — token rotation across respawn is the benign case and shouldn't trip the breaker. Then: if `Date.now() - lastAuthFailAt < AUTH_CIRCUIT_BREAKER_WINDOW_MS` (5s), increment `consecutiveAuthFails`; else reset to 1. `lastAuthFailAt = Date.now()`; `lastAuthFailInstanceId = instanceId`. If `consecutiveAuthFails >= AUTH_CIRCUIT_BREAKER_LIMIT` (5 fails within 5s, same instanceId), `markUnreachable('auth persistent')` and return `null` without re-discovery (prevents shim loop when daemon genuinely rejected or a same-uid attacker holds the wrong token). Otherwise: sleep 100ms → invalidate `parsed` → **re-run full discovery** before retry. Persistent → `markUnreachable('auth failed after re-discovery')`; return `null`. On success, reset `consecutiveAuthFails = 0`.
7. On `503 NotReady` (cold start): return `null` without marking unreachable (daemon healthy, selection empty).
8. On any other non-2xx → mark unreachable with symbolic code; `this.wasWarmLastCall = false`; return `null`.

**`getRecentSelections(n)`** → `ComponentHandle[]`:

1. Same error flow as `getCurrentSelection`; unreachable → `[]`.
2. On success: `return await httpGet(\`/selection/recent?n=${n}\`)` — wire shape is a raw `ComponentHandle[]` (matches the frozen MCP tool output exactly; no unwrapping, no surgery). If a future `total`/`truncated` field is added, it'll flow through MCP 2026 `_meta`, not the HTTP body.
3. `n` validation: shim's MCP tool schema accepts `n=1..100`; daemon accepts same range per §5. Shim passes through without re-clamping (daemon owns validation).

**`getComputedStyles(handle)`** (throws):

1. `isUnreachable()` → `throw McpError(InternalError, 'daemon unreachable')`.
2. `httpPost('/computed_styles', {handle}, COMPUTED_STYLES_TIMEOUT_MS)`.
3. `424 ExtensionUnavailable` (terminal) → `throw McpError(InternalError, 'no browser extension connected')`. No retry.
4. `503 ExtensionDisconnected` (transient) → honor `Retry-After: 2`; retry once; persistent → `throw McpError(InternalError, 'extension disconnected mid-request')`.
5. `504 ExtensionTimeout` → `throw McpError(InternalError, 'extension did not respond in time')`.
6. `503 ConcurrencyLimitReached` → retry once after 250ms; persistent → `throw McpError(InternalError, 'too many in-flight requests')`.
7. `429 TooManyRequests` → honor `Retry-After`; retry once; persistent → throw.
8. `503 Shutdown` → `throw McpError(InternalError, 'daemon shutting down')`. No retry.
9. Connection error → invalidate handoff + full re-discovery + retry; persistent → throw.
10. `400 InvalidRequest` or `404` (unknown handle.id) → `throw McpError(InvalidRequest, <detail from problem+json>)`.

**`getDomSubtree(handle, depth)`**: same pattern, `DOM_SUBTREE_TIMEOUT_MS = 11000`.

**`httpRequest(path, init, timeoutMs = SELECTION_REQUEST_TIMEOUT_MS)`** — uses `AbortSignal.timeout` (not `new AbortController + setTimeout`):

```ts
async httpRequest(path: string, init: RequestInit, timeoutMs = SELECTION_REQUEST_TIMEOUT_WARM_MS): Promise<Response> {
  // AbortSignal.timeout(ms) is single-shot + GC-friendly; avoids the per-request
  // AbortController leak pattern documented in nodejs/undici#2198. Do NOT wrap it in
  // AbortSignal.any([timeout, userSignal]) — that composition reintroduces the leak class
  // (nodejs/node#57736). If user cancellation is ever needed, use a single controller for
  // both timeout and user-cancel path.
  return fetch(`${this.handoff!.urlPrefix}${path}`, {
    ...init,
    redirect: 'error',       // daemon never emits 3xx (§4 step 12); belt-and-suspenders
                             // against a compromised loopback returning 302 to an attacker
                             // URL — undici's cross-origin Authorization-stripping is not
                             // reliable on same-origin-different-port (per GHSA-3787-6prv-h9w3).
    headers: {
      'Authorization': this.handoff!.authHeader!,       // pre-computed at discovery
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
}
```

`handoff.urlPrefix` and `handoff.authHeader` are both computed once at discovery parse — per-call URL parse and header-string allocation cost eliminated.

Node 22+ built-in `fetch`. No external HTTP dep.

## 10. Security model

**Defense-in-depth summary** (controls already detailed in §4/§5/§6; this section consolidates + draws threat-model boundary):

| Control | Where | Defends |
|---|---|---|
| `Host` header allowlist — `127.0.0.1:<port>` only (no `localhost`) | §5 middleware #1 | DNS rebinding + `/etc/hosts` tampering + captive-portal DNS injection (CVE-2025-66414 analog) |
| `Origin` deny-by-default on WS upgrade — reject literal `"null"`, absent OK | §5 upgrade step 2 | Drive-by WS from untrusted pages (CVE-2025-52882); `Origin: null` bypass via sandboxed iframes (CVE-2026-27977 analog) |
| Handoff in OS runtime dir (tmpfs / AppData\Local) — not `node_modules/.cache/` | §4 handoff path | Spotlight/Dropbox/iCloud/Time Machine reading the token; cloud-sync of secrets |
| `lstat` dir + `!isSymbolicLink` + uid match + mode `& 0o077 === 0` | §4 write step 1 | Symlink-plant TOCTOU; permissive parent-dir mode |
| `openSync('wx', 0o600)` with EEXIST reclaim | §4 write step 2 | Race with pre-existing file; mode set at creation |
| `fstat(fd).ino === lstat(path).ino` + `(fstat.mode & 0o177) === 0` | §4 write step 3 | File swap between `openSync` and `writeSync`; kernel/FUSE permission promotion |
| `writeFileSync(fd, data)` loops on short writes | §4 write step 7 | Truncated JSON under ENOSPC/signal → unrecoverable shim `parse` failure |
| `lstat` + uid/mode check on shim-side read | §4 read step 2 | Symlink trap or wrong-owner handoff |
| Loopback-only bind + address assertion (not deep-equal `family` field) | §4 write step 4 | DNS `127.0.0.1` tricks; shimmed `net` module; `family` normalization drift across Node versions |
| Token 32-byte base64url + normalized `timingSafeEqual` (always compares, even on length mismatch) | §5 compareToken | Timing-channel leakage; `RangeError` DoS from short/null/non-string tokens |
| Unauth rate-limit bucket (10/s) — **no failed-auth lockout** (would be DoS weapon) | §5 middleware #3 | Port-guess DoS; log-spam amplification |
| Shim-side auth circuit breaker (5 consecutive same-instanceId 401s within 5s → permanent-unreachable; counter resets on instanceId change) | §9 getCurrentSelection step 6 | Shim self-loop `401 → re-discover → 401` under attacker-held token or genuine daemon mismatch; instanceId-scoped so daemon respawn token rotation doesn't false-trip |
| `POST /shutdown` requires `instanceId` body match | §5 `/shutdown` row | Pid-recycling: between `/health` success and `/shutdown` send, pid+port could be recycled |
| Size caps (body/frame/manifest/handle-fields) | §3 invariant 7 | OOM via oversized input |
| No user-provided regex in daemon code | §10 Input validation | ReDoS |
| Token never in query strings, logs, or headers beyond `Authorization`; no redirects | §10 Secret hygiene + §4 step 12 | Log/history/process-listing leakage; `Authorization` leaking to redirect target |
| Pre-handshake WS auth (no 101 on failure) | §5 upgrade step 3 | Pre-auth frame injection (CVE-2026-35523 analog) |
| `perMessageDeflate: false` on `ws` server | §6 Compression disabled | CRIME/BREACH-class side-channels; zip-bomb DoS past `maxPayload` |
| Daemon recomputes `contentHash` from raw manifest bytes | §8 reread step 3 | Plugin-written `contentHash` field freezing cache with malicious payload |

**Token**: 32 bytes `crypto.randomBytes` → base64url (~43 chars). Process-lifetime, never rotated, never persisted. Comparison via normalized `timingSafeEqual` (§5). Transmitted only as `Authorization: Bearer` header on HTTP and WS upgrade — never in query strings (query strings leak to logs, process listings, browser history). `?since=<seq>` in WS upgrade URL is fine because seq is non-sensitive.

**Secret hygiene in logs** (enforced at logger layer, not by convention): the daemon logger wrapper rejects any object containing a `token` key and replaces its value with `[REDACTED]` before emission. Test in §12 fuzzes the logger with handoff-shaped objects and asserts the string `token` value never appears in output bytes. Even short prefixes (`slice(0, 4)`) are banned — preempts incident-triage "just log first 4 chars" temptation. `token.length` is loggable (confirms expected size without revealing content). Handoff `{path, pid, port, serverVersion, instanceId}` loggable; token explicitly excluded.

**CORS**: not enabled. No `Access-Control-*` headers. Browsers don't cross-origin-fetch loopback without opt-in; shim is Node (no CORS); ext uses WS (no preflight). `*` would invite drive-by fetches from any browser tab — token blocks access but token could be sniffed via attacker-controlled ext scripts if CORS is wide-open.

**Input validation**: length caps + Zod structural checks only. No user-provided-string regex matching in daemon code. Shipped `SELECTION_ID_RE` (`/^[A-Za-z0-9_-]{1,128}$/`) is a simple char class + length — linear and ReDoS-safe. Stated as explicit v0 boundary: any future regex addition requires ReDoS-safety review, and daemon code is forbidden from compiling user-provided regex sources.

**Explicitly NOT addressed in v0 (threat model boundary — best-effort only)**:

- **Same-uid local attacker with code-exec.** An attacker with same uid + local code-execution on the host can read `node_modules/.cache/redesigner/daemon-v1.json` regardless of 0600 mode, and from there drive the daemon with a valid token. The `lstat` + `fstat/ino` + `realpath` guards raise the bar against opportunistic symlink-plant or pre-file-swap races, but against an attacker who simply waits for the daemon to write the handoff and then reads it, no local-process-token scheme without OS sandboxing can defend. v0 assumes the user trusts their local toolchain (same boundary as running `vite dev`). Documenting this plainly rather than claiming 0600 alone is a hard wall.
- **Multi-user shared dev machine attack.** Users with read access to each other's HOME can read each other's handoffs. Out of scope.
- **Malicious VS Code extension or npm postinstall with code-exec as the user.** Same category as above — local code-exec inside the trust boundary. Out of scope.
- **TLS for loopback.** Threat model excludes on-host network sniffers; loopback traffic doesn't traverse wire.
- **Token rotation mid-session.** Daemon respawn rotates (new process, new token). No in-process rotate API.
- **DoS by a buggy on-host program.** Rate limits + in-flight caps protect against accidental flooding; a same-uid attacker willing to burn CPU can still degrade performance. Out of scope.

**Rate limits** (recap from §5): authenticated bucket per route class + separate unauth bucket (10/s). No global failed-auth lockout (DoS weapon). Shim-side circuit breaker handles self-loop risk. Per daemon process; per-client deferred.

**Input bounds** (recap): request body ≤64KB general / ≤16KB `POST /selection`; WS frame ≤256KB (enforced at `ws` library via `maxPayload: 256 * 1024`); manifest ≤10MB pre-parse via `stat.size`; ComponentHandle field caps enforced pre-Zod (filePath ≤4KB, componentName ≤256, parentChain ≤16 × ≤256).

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
- `ws` — `^8.18.0`, configured with `new WebSocketServer({ maxPayload: 256 * 1024, perMessageDeflate: false })`. Both options load-bearing: `maxPayload` matches §6 spec cap (if it falls below, DoS protection degrades silently); `perMessageDeflate: false` disables compression (CRIME/BREACH + zip-bomb defense per §6).
- `@redesigner/core` — `workspace:*`.

**No** additional runtime deps: vanilla `http` (not express/fastify); no body-parser (vanilla stream + size cap); no structured-logger dep.

**Dependabot + `ws` audit gate** (concrete, not vague):

- `.github/dependabot.yml` uses `groups` field to separate `ws` into its own group. Major bumps of `ws` require a checklist entry in the PR body (not auto-mergeable): "reviewed changelog for close-code semantics changes, `maxPayload` defaults, `permessage-deflate` defaults, per-message compression opt-ins."
- Minor + patch bumps of `ws` auto-mergeable after CI.
- Rest of deps follow standard Dependabot flow.

**Log rotation** (hand-rolled, mutex-protected):

Logger is a single module with an internal `rotationLock: boolean` and a short synchronous queue. Logging API is `log(level, msg, meta?)`. Implementation:

1. Append-only `writeSync(fd, line + '\n')` to `daemon.log`. Synchronous; line-oriented; no buffer.
2. On every log call, compare current file size vs 10MB; if over:
   - Acquire `rotationLock` (CAS — if already set, enqueue this log line and return; the holder will drain).
   - `closeSync(fd)` → `renameSync('daemon.log', 'daemon.log.1')` (overwrite any prior `.1`) → `openSync('daemon.log', 'w')` → assign new `fd`.
   - Drain queued log lines into the new fd.
   - Release lock.

The mutex makes rotation safe across concurrent log callers (route handlers + watcher + lifecycle). Hand-rolled rotation with a mutex is a deliberate trade vs pulling in `pino` — the surface is small enough to audit, and no rotation dep matches the "synchronous writeSync, zero buffering" stance.

**Zod schema hoisting invariant**: all Zod schemas live at module top-level. No `z.object(...)` construction inside request handlers or hot paths. Per Zod v4 performance research, schema reallocation per request is a known 100x regression cliff. Enforced by code review checklist entry; no runtime check.

**Parent-facing API**:

```ts
// packages/daemon/src/index.ts
export async function startDaemon(opts: { manifestPath: string }): Promise<DaemonHandle>
```

`DaemonHandle` shape already locked by existing `DaemonBridge` contract (`pid, shutdown, stdout, stdin, stderr`). Daemon process is a `child_process.fork` (for IPC disconnect event). Parent side wraps ChildProcess into DaemonHandle. Child side is the actual HTTP+WS server.

**In-scope bridge + plugin edits** (concrete diff, not hand-waved — these file changes are part of this milestone's implementation):

```diff
// packages/vite/src/integration/daemonBridge.ts
- export interface DaemonBridgeOptions {
-   mode: 'auto' | 'required' | 'off'
-   port: number
-   manifestPath: string
-   importer: () => Promise<{
-     startDaemon: (opts: { manifestPath: string; port: number }) => Promise<DaemonHandle>
-   }>
-   ...
- }
+ export interface DaemonBridgeOptions {
+   mode: 'auto' | 'required' | 'off'
+   manifestPath: string
+   importer: () => Promise<{
+     startDaemon: (opts: { manifestPath: string }) => Promise<DaemonHandle>
+   }>
+   ...
+ }

- const handle = await mod.startDaemon({ manifestPath: opts.manifestPath, port: opts.port })
+ const handle = await mod.startDaemon({ manifestPath: opts.manifestPath })

// packages/vite/src/plugin.ts (configureServer hook, currently line ~113)
- await client.daemon.start({
-   mode: daemonOpts.mode,
-   port: daemonOpts.port,
-   manifestPath: client.manifestPath,
-   ...
- })
+ await client.daemon.start({
+   mode: daemonOpts.mode,
+   manifestPath: client.manifestPath,
+   ...
+ })

// DaemonOptions type in plugin surface: `port?: number` field removed or deprecated
```

Bridge's `shutdownPosix` also switches from raw `process.kill(pid, SIGTERM)` to an `httpPost('/shutdown', {instanceId})` preferred path before signal fallback — matches §4 alive-orphan sequence. This implies bridge reads the handoff file too (same path resolution logic as shim's §9 discovery).

**Parent → child env passthrough**: bridge forks child with `env: { ...process.env, REDESIGNER_BRIDGE_VERSION: <parent pkg version>, REDESIGNER_BRIDGE_PID: String(process.pid) }`. Child logs both at startup for cross-version diagnostic (bridge-vs-daemon version mismatch in monorepos becomes debuggable). Not a security gate — values are informational.

**IPC channel lifecycle** (child-side, critical):

```ts
// src/child.ts boot
process.on('disconnect', () => shutdownGracefully())
process.channel?.unref()
// The IPC channel now doesn't pin the event loop. Disconnect still fires on parent exit.
// Without unref(), shutdown path would double-wait on channel AND server close.
```

The `unref()` call is load-bearing. **Invariant**: no further `process.on('message', …)` listener anywhere in daemon code — adding one re-refs the channel and silently reverts this decision. Enforced via named-import-restriction lint rule banning `process.on('message')` outside this one file. Documented in both the spec and the daemon CLAUDE.md.

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

Child entry exported as a distinct package entry — parent resolves via `fileURLToPath(import.meta.resolve('@redesigner/daemon/child'))`. Robust to bundling (vs fragile `new URL('./child.js', import.meta.url)` which breaks when `@redesigner/daemon` is bundled into a consumer's build).

**Node target**: `>=22.0.0` (inherits `AbortSignal.timeout`, built-in `fetch`, `crypto.randomUUID`).

**tsconfig**: `lib: ["ES2023"]`, `strict: true`, `moduleResolution: "bundler"`, no `DOM` (fetch global from `@types/node >=20`). Scaffolding commit runs a type-check to verify `fetch` resolves; fallback is `undici` client on shim side.

## 12. Testing strategy

Vitest harness. Follows repo pattern `vi.mock('node:fs', importOriginal)` with `vi.hoisted` for shared recorder state (ESM namespaces frozen; `vi.spyOn` on `node:fs` throws — CLAUDE.md pin).

**Test-harness isolation**:

- `vitest.config.ts` splits configs: unit tests (`test/unit/**`) run with default `pool: 'threads'` for throughput; integration tests (`test/integration/**`) pin `pool: 'forks', poolOptions: { forks: { singleFork: true } }` — avoids Node 22.1+ `vmForks` crash (vitest#9762) AND serializes real-fork-spawn tests that would otherwise compound Windows-2025 runner slowness. **Integration tests MUST NOT use `describe.concurrent` or `it.concurrent`** — port and handoff-path collisions flake under concurrency. Sequential execution is the Vitest default, so no `describe.sequential` API call needed (that API doesn't exist; write plain `describe(...)`).
- Each test uses a `randomTempDir()` helper (`mkdtempSync` under `os.tmpdir()` with auto-cleanup in `afterEach`) to fully isolate manifest + handoff paths. `REDESIGNER_PROJECT_ROOT` env override passed per-test.
- **`waitForWatcherReady()` helper** (required for `manifestWatcher` integration tests): after `fs.watch()` registration, write a sentinel file + await the first change event before beginning test mutations. Linux inotify registration is synchronous but kernel queue delivery can lag under cgroup-throttled CI runners, so the sentinel write MUST be paired with a retry loop (write sentinel → await event with 500ms timeout → on timeout, re-write and retry up to 3×) and an explicit failure if no event arrives. Without the retry, a sentinel-event dropped by kernel before the listener registered causes the test to hang until vitest timeout. Node core PR #8115 documented the macOS FSEvents variant (~20ms gap); Linux inotify variant is distinct and equally real under cgroup throttling.
- Each forked child pid recorded in a test-scoped `Set`; `afterEach` asserts `kill(pid, 0)` throws ESRCH (child actually exited). `afterAll` does an additional scan:
  - POSIX: `lsof -p <parent>` to detect leaked LISTEN sockets on loopback + `ps` for processes matching the daemon child entry path.
  - Windows: PowerShell `Get-CimInstance Win32_Process` (not `wmic`, deprecated on Windows 11 / Server 2025).
  - Fail suite if any orphan processes or LISTEN sockets survive.
- **Parent-side handle leak detection**: each integration test wraps with `beforeEach`/`afterEach` snapshotting `process.getActiveResourcesInfo()`; asserts delta is empty (strict — no allowlist). Allowlist-based approach was considered and rejected: real leaks often surface as `FSReqCallback`, `TickObject`, `Immediate`, or `Timeout` (even when `unref()`'d the handle still shows in the snapshot until the callback runs), and a partial allowlist silently passes those. Strict-no-delta forces the test to either run cleanup to completion before snapshot OR register the test-introduced handle deliberately. A complementary nightly-only job uses a hand-rolled `async_hooks`-based leak detector (Vitest does not ship a first-class `detectAsyncLeaks` config key — earlier spec wording was wrong; implementation uses `async_hooks.createHook()` + `init/destroy` count delta assertion with `describe.runIf(process.env.CI_NIGHTLY)`).
- **Ready-line latency telemetry**: integration harness records `readyLatencyMs` per test run and emits a CI artifact histogram. When Windows-2025 runner drifts past the 10s budget, p95 climbing in nightly trend surfaces weeks before the suite turns red.
- Cross-platform ready-line timeout: **2s on POSIX, 10s on Windows**. Windows GitHub Actions runners spawn forks 10–60× slower than POSIX (nodejs#21632), and Windows-2025 runners are slower than -2022 (actions/runner-images#12647). Platform-conditioned via `const READY_TIMEOUT = process.platform === 'win32' ? 10_000 : 2_000`.

**Unit (in-process, no forks, no network)**:

| File | Covers |
|---|---|
| `selectionState.test.ts` | apply() taxonomy (noop/promoted/new), dedupe invariants across current+history, rescan unidirectional (stale→resolved only), 50-cap eviction, broadcast payload shapes. **Ordering**: `reclick_current_is_noop_no_broadcast.test` — apply with same id as current; assert zero subscriber.send calls and apply returns `kind: noop`. |
| `manifestWatcher.test.ts` | Debounce coalescing (fake timers), schema-fail-keep-cache, idempotent re-writes no-op, **single-flight via injectable `fsReadFile` returning deferred promises** (assert ≤1 outstanding call at any instant — test controls resolution order of two deferred calls and asserts second read is queued not concurrent), content-hash swap semantics, `start()` resolves only after first validate attempt, rescan causal ordering (`staleManifest.resolved` seq < `manifest.updated` seq and both arrive synchronously in one tick). **Stat-poll fallback**: `statPoll_detects_missed_event.test` — inject `fsReadFile` that doesn't fire change event but `stat.mtimeMs` increments; advance fake timer 3s; assert re-read runs + `stats.statPollRecoveries === 1`. |
| `eventBus.test.ts` | Seq monotonicity, ring buffer metadata-only retention (~16KB for 256 entries), resync snapshot capture with `snapshotSeq`, gap-threshold branching (`?since` at boundaries `N=0`, `N=currentSeq`, `N=currentSeq-256`, `N=currentSeq-257` parameterized via `test.each`), two-phase backpressure (soft 512KB → pause, hard 1MB → 4429), keep-alive 10s/5s timing. **Stats log interval**: fake timers advance 60s; assert single log line emitted with format `manifest watcher: N events, M validated, K rejected, S stat-poll-recoveries`. |
| `handoff.test.ts` | `openSync('wx', 0o600)` mode correctness (POSIX; `describe.skipIf(process.platform === 'win32')`), wx EEXIST + pid-probe reclaim (dead pid → unlink + retry success; alive pid → exit 1), Zod round-trip, serverVersion major-mismatch rejection. **TOCTOU defenses**: `handoffDir_symlink_rejected.test` — planted symlink at runtime-dir; assert daemon `process.exit(1)` with diagnostic. `handoffFile_symlink_blocks_wx.test` — plant symlink directly at the handoff-file path pointing to `/tmp/attacker.json`; assert `openSync('wx', 0o600)` EEXIST, assert reclaim sequence (read, pid-probe, handle mismatch) exits 1 without following symlink. `handoffDir_tmpdir_ancestor_walk.test` (Linux-only) — plant a symlink at an ancestor of the runtime-dir path (`/tmp/redesigner-${uid}` as symlink); assert per-ancestor lstat walk rejects. **Fd-guard**: `postOpen_fstat_ino_mismatch_exits.test` — mock `fstat` to return different inode than `lstat`; assert exit 1 before `writeSync`. `postOpen_mode_bits_reject.test` — mock `fstat.mode` with any of `0o077` bits set; assert exit 1. |
| `auth.test.ts` | Length-mismatch → no RangeError + 401 (timingSafeEqual burned cycles). `undefined`, `""`, non-base64url, short, long all produce identical 401 body bytes (no thrown errors visible to client) via parameterized `test.each`. 401 carries `WWW-Authenticate: Bearer realm="redesigner"`. No `X-Redesigner-Auth-Failure` header. **Logger guardrail fuzz** (extended): mutate handoff object into a `Buffer`-valued token, nested-in-array token, thrown-Error-with-token-in-message, and run through `util.inspect(obj, {depth: Infinity})` and JSON.stringify paths; assert no 4-byte prefix of the token value appears in output. **Ordering**: `auth_rejects_before_body_parse.test` — POST with 64KB non-JSON body + bad token; `vi.hoisted` spy on `safeJsonParse` asserts zero invocations. `auth_413_precedes_401_when_oversized.test` — oversized body + bad token → 413 before 401 (size cap runs first). **No lockout**: `no_global_failedAuth_lockout.test` — blast `process.platform === 'win32' ? 20 : 100` bad-token requests over an `undici` Agent with keepalive (avoids Windows CI fork-spawn + AV latency); assert legitimate shim's valid-token request still returns 200. Parameterized count prevents Windows-2025 runner flakes. **Unauth bucket exempts authenticated requests**: `unauth_bucket_only_counts_missing_invalid_auth.test` — exhaust unauth bucket with bad-token requests, then issue 50 valid-token requests; assert all succeed (not throttled by unauth bucket). |
| `shimCircuitBreaker.test.ts` | Shim-side: simulate daemon serving 401 to 5 consecutive same-instanceId requests within 5s → assert `markUnreachable('auth persistent')` fired + no further re-discovery until TTL. Parameterized: 4 consecutive within 5s → still re-discovers (below threshold). 5 consecutive spread over 6s → below threshold (window elapsed), no permanent-unreachable. **InstanceId reset path**: 4 fails with instanceId A → 1 fail with instanceId B → assert counter reset, breaker at 1 (not 5); daemon respawn doesn't false-trip. |
| `hostOrigin.test.ts` | `host_header_rebinding_rejected.test` — request with `Host: attacker.com` → 400 HostRejected. Accepts only `127.0.0.1:<port>` (parameterized: `localhost:<port>` → 400, not allowed). `origin_ws_upgrade_deny_by_default.test` — WS upgrade with `Origin: https://evil.com` → 403 OriginRejected pre-handshake. **`origin_null_rejected.test`** — literal `Origin: null` → 403 (CVE-2026-27977 analog; sandboxed iframes emit this). **Absent Origin accepted** (Node client, curl). Allowlisted prefixes accepted (`chrome-extension://`, `vscode-webview://`, `file://`, `moz-extension://`). `no_3xx_from_any_route.test` — issue GET/POST to every route with various permutations; assert no response status starts with 3 (prevents `Authorization` leaking on follow-redirects clients). |
| `wsCompression.test.ts` | `perMessageDeflate_disabled.test` — client upgrades with `Sec-WebSocket-Extensions: permessage-deflate`; assert server response lacks that header. Verifies `ws` configured with `perMessageDeflate: false` (CRIME/BREACH + zip-bomb defense). |
| `shutdownInstanceId.test.ts` | `shutdown_rejects_instanceId_mismatch.test` — POST `/shutdown` with mismatched `instanceId` body → 404 InstanceMismatch, daemon does NOT exit. POST with correct `instanceId` → `200 {drainDeadlineMs: 100}` + graceful shutdown observed via process exit. |
| `manifestWatcher.test.ts` (additional cases) | `manifest_fd_based_read_respects_cap.test` — after plugin's tmp+rename swaps inode from 2MB (old) to 15MB (new malicious), assert daemon's fd-based read rejects without loading 15MB into memory. `contentHash_from_bytes_not_json.test` — write manifest with `contentHash` field lying about its content; assert daemon's recomputed sha256 differs + cache swap happens (trust bytes, not JSON field). |
| `rpcCorrelation.test.ts` | JSON-RPC 2.0 `id` allocation + correlation map lookup + timeout cleanup + ext-disconnect rejection + shutdown rejection + 8-concurrent cap → `503 ConcurrencyLimitReached`. **Slot-release ordering**: `rpcCorrelation_slot_freed_before_rejection_resolves.test` — fill to 8, time out request #5; in request #5's `catch` handler, immediately issue request #9 and assert 200 (not 503). Same shape for ext-disconnect + shutdown triggers — single codepath. |
| `rateLimit.test.ts` | Token-bucket math + distinct limits per route-class via `test.each`. `Retry-After` on `TooManyRequests` matches `Math.ceil((1 - tokens) / refillPerSec)` via fake clock. `Retry-After: 0` on `ConcurrencyLimitReached`. Unauth bucket separate from authenticated (exhaust unauth bucket; assert authenticated requests still succeed). **Explicit no-lockout assertion**: blast 100 bad-token requests in 5s window; assert daemon does NOT enter any lockout state — every subsequent valid-token request returns 200 immediately (per §5 middleware #3 "no failed-auth lockout" pin; lockout would be a DoS weapon). |

Unit harness: daemon classes instantiable with injected `Clock` + `Logger` + `fsReadFile` + `fsStat` (pattern already in shipped `ManifestWriter`). No forks. No sockets.

**Integration (real fork, real sockets)**:

| File | Covers |
|---|---|
| `endToEnd.test.ts` | Full spawn: fork `dist/child.js`, await ready line, read + Zod-validate handoff. Round-trip POST/GET /selection + verify WS frame delivery. Teardown via `POST /shutdown` (preferred path) + SIGTERM fallback. Happy-path smoke. |
| `manifestHmr.test.ts` | Sibling process writes manifest via atomic temp+rename. **`waitForWatcherReady()` runs before each mutation** (macOS FSEvents settle per harness pin). Assert: single `manifest.updated` per write, correct `contentHash`. **Coalescing case** (deterministic via fake-timer-driven debounce path): advance fake timer through a simulated 20-writes-in-30ms burst; assert exact frame count ≤3 (no `retry` — retry hides regressions). A separate real-timer smoke test runs **nightly only** (`describe.runIf(process.env.CI_NIGHTLY)`) with 10s budget — not `it.skip`, which would be zero coverage for Node-upgrade-induced `fs.watch` batching regressions on Linux 6.x kernels. |
| `manifestObserverInvariance.test.ts` | When plugin retries `renameSync` on Windows EPERM (AV lock), daemon observes one final successful event — not multiple `manifest.updated` broadcasts for the retry intermediates. Daemon-side assertion that plugin-layer retry doesn't leak through to ext. Test lives in daemon suite because daemon is the observer. Plugin-side EPERM-retry correctness is a separate test in `packages/vite`. |
| `browserToolProxy.test.ts` | No WS subscriber → POST /computed_styles → `424 ExtensionUnavailable` (terminal — never connected). Mock ext connects, subscribes, receives `rpc.request` (JSON-RPC 2.0 shape), responds → HTTP 200. Timeout: ext silent → 504 ExtensionTimeout. **Ext disconnects mid-flight → `503 ExtensionDisconnected` + `Retry-After: 2`** (transient — was connected, reconnect expected). Shutdown mid-flight → 503 Shutdown + `Connection: close`. 9th concurrent → 503 ConcurrencyLimitReached + `Retry-After: 0`. |
| `lifecycle.test.ts` | Fresh start: ready line within 2s + `instanceId` present. Parent disconnect: child exits ≤1.5s (IPC disconnect primary; POSIX ppid-change poll verified via forked-then-reparented child). `POST /shutdown` (authenticated) → graceful exit → bridge unlinks. SIGTERM path: drain ≤100ms + WS 1001 + unlink + exit 0. Stale handoff reclaim: plant dead pid → bridge unlinks + respawns. Alive orphan → `/health` identifies → `POST /shutdown` → bridge verifies exit → respawn. EPERM on `kill(pid,0)` → unlink without signal. **Windows** (isolated describe block): `{op:"shutdown"}` stdin → `ack` arrives *after* handoff unlinked (ordering assertion via tempfile presence check at ack receipt). `windows_shutdown_unlink_eperm_still_acks.test` — inject `unlinkSync` throwing EPERM twice then success; assert ack written after actual unlink success; on persistent unlink failure, ack carries `unlink: "failed"` and process exits 0 anyway. |
| `daemonRespawn.test.ts` | Start daemon → SIGKILL → bridge respawn-once-with-backoff (250ms, 1s) → shim next call: first request ECONNREFUSED → re-run full discovery → retry succeeds. Token rotated → shim 401 → 100ms backoff → re-run full discovery (verifies `lstat` + pid check happen again, not just token re-read) → retry succeeds. Second respawn fails → bridge gives up; shim continues re-reading handoff, ESRCH → manifest-only. **Ready-line race**: `ready_line_follows_handoff_closeSync.test` — `vi.hoisted` recorder on `fs.closeSync` + `process.stdout.write`; assert `closeSync(handoffFd)` call precedes `stdout.write("ready…")` call. `shim_401_backoff_recovers_from_pre_close_read.test` — inject post-`listen` pre-`closeSync` pause; race shim `GET /selection`; assert single 401 → backoff → retry succeeds. |
| `resync.test.ts` | Connect → disconnect at seq=N → reconnect `?since=N` in buffer → hello only (no replay). Disconnect → push 1100 frames → reconnect `?since` too old → hello + `resync.gap`. Malformed `?since` → 400 pre-handshake (not 1008). Second concurrent subscriber → close 4409. **Boundary-accuracy**: parameterized `test.each` for `N ∈ {0, currentSeq, currentSeq-1023, currentSeq-1024}` asserting hello-only vs hello+gap per §6 off-by-one rules (buffer size 1024 per updated §6). **Cold-start seq**: `cold_start_since_zero.test` — `currentSeq = 500`, `?since=0` → hello only (N >= currentSeq - 1023 because 1023 > 500, so N is in buffer trivially); exercises wrapped/unwrapped-seq semantics. **Instance-id reconnect dedup**: daemon respawn between disconnect and reconnect → hello arrives with different `instanceId` → ext must treat as fresh daemon regardless of `?since=`. **Snapshot consistency model test**: `fc.assert(fc.property(fc.commands([applySelectionCmd, writeManifestCmd, disconnectCmd, reconnectCmd]), commands => run(model, commands)), { numRuns: process.env.CI_NIGHTLY ? 5000 : 500, seed: Number(process.env.FC_SEED) \|\| undefined, endOnFailure: true, interruptAfterTimeLimit: 30_000 })`. `numRuns: 500` on CI, 5000 nightly (bumped from 200/2000 per combinatorial explosion of 4-command state space — 500 × avg 10 commands = 5000 states). **Interrupt-safety assertion** (empirically calibrated, not prescribed): CI pipeline must run the model test 3× on fresh Windows-2025 + POSIX runners and record observed `result.numRuns` at the `interruptAfterTimeLimit: 30_000` budget. Write the 10th-percentile of those observations as `minNumRunsForPlatform` in a config file — `expect(result.numRuns).toBeGreaterThanOrEqual(minNumRunsForPlatform)` then catches future degradation without false-positiving on the initial calibration. Do NOT hardcode platform numbers in the spec; the Windows-2025 runner is a moving target. Alternative if calibration proves brittle: drop `interruptAfterTimeLimit` entirely and raise the Windows job timeout to 5min for this single test. **Seed surfacing test**: `fc_seed_logged_on_failure.test` — inject a deterministically-failing property via a test-only command; assert thrown assertion message contains `seed=` and `counterexample=` substrings. This test disables `interruptAfterTimeLimit` so it runs to the injected failure regardless of runner speed. Hand-roll `ComponentHandle` arbitrary from `SELECTION_ID_RE` (zod-fast-check is Zod-v3-bound; daemon uses v4). |

**MCP-layer E2E** (lives in `packages/mcp/test/integration/` — exercises shim↔daemon):

| File | Covers |
|---|---|
| `daemonBackend.e2e.test.ts` | Spawn daemon. Construct `@modelcontextprotocol/sdk` `Client`, connect shim over stdio with `DaemonBackend`. Seed manifest on disk. Drive tools, verify responses. Kill daemon mid-session → tools return null/[] from selection, `McpError(InternalError)` from browser tools. Restart daemon → verify recovery after unreachable TTL. **MCP output contract**: call `list_recent_selections(n=100)` via MCP, assert output is a raw `ComponentHandle[]`. **Grep-test regression fences** (cheap, always-on): `new AbortController` → zero matches in `packages/mcp/src/**/*.ts` and `packages/daemon/src/**/*.ts` (AbortSignal.timeout is pinned per §9). `AbortSignal.any` → zero matches (composes-with-timeout leak class per nodejs/node#57736). |
| `leak-regression.nightly.test.ts` | **Nightly-only** (`describe.runIf(process.env.CI_NIGHTLY)`), `test.timeout(180_000)`. Run with `node --expose-gc`; spawn shim; take baseline `v8.getHeapSnapshot()`, call `getCurrentSelection` 10000 times against unreachable daemon, run `global.gc()` × 3 with `await new Promise(setImmediate)` between, take final snapshot. Snapshot files written to temp dir + cleaned up in afterAll (each snapshot is hundreds of MB). Assert: retained-size delta on `AbortController`, `EventTarget`, and `NodeError` constructor classes each < 1MB across the 10k calls. Heap-iteration catches the actual leak class — `heapUsed` linear regression with ±4MB GC noise is statistically invalid at this sample size per V8-core guidance (Joyee Cheung's memory-leak-testing series). Gated to nightly because `v8.getHeapSnapshot()` costs 5–30s per call and writes GB-scale JSON; running on every PR would strangle CI. Regression fence (the grep-tests above) runs always-on and catches the pattern-level regression cheaply. |
| `daemonAbsent.e2e.test.ts` | No daemon. Handoff absent. Shim's `DaemonBackend` → first selection call logs at info → returns null. Manifest tools keep working via `FileBackend` inheritance. Validates graceful "standalone" path cli.ts commits to. |

**Cross-platform**: POSIX + Windows via GitHub Actions matrix. Specifics:

- `handoff.test.ts` skips chmod + uid assertions on Windows (documented no-op; NTFS ACL-based).
- `lifecycle.test.ts` exercises `{op:"shutdown"}` stdin + ack-after-unlink ordering + EPERM retry on Windows; SIGTERM + ppid-change poll on POSIX.
- `manifestWatcher.test.ts` includes spurious-error + restart + reread scenario AND stat-poll fallback scenario (macOS `fs.watch` flakiness coverage).

**Fuzz / boundary**:

- `fast-check` with hand-rolled arbitraries for `ComponentHandleSchema`, `HandoffSchema`, `ManifestSchema`, wire-frame types (zod-fast-check is Zod-v3-bound; spec uses v4). Property: `schema.safeParse(arbitrary)` → either `.success === true` or rejected with structured error; never throws.
- Mutation strategy: start from valid fixture, apply N field-type mutations per case, assert rejected. Complements property tests for boundary cases. Concrete shape: for each schema, generate 100 valid + 300 mutated cases per test run.
- Body size caps exercised: POST /selection with 17KB → 413 without allocating full body (streaming cap). WS frame ≥257KB → close 1008. HTTP request body cap enforced before body parse per §5 middleware #2.

**Performance**: `pnpm --filter @redesigner/daemon run bench` exists locally; no CI gate; no numeric target pinned (fs-layer noise makes sustained-writes-per-second meaningless). If a number is needed later, pick one isolated from `fs.watch` (e.g., broadcast latency p99 given pre-validated manifests fed into pipeline).

**Coverage** (advisory at daemon scope; gated on DaemonBackend): daemon 85% line / 80% branch (ungated — churn punishes velocity). File-scoped gate on `packages/mcp/src/daemonBackend.ts`: 90% lines / 85% branches (high-leverage regression surface for shim↔daemon seam). Vitest coverage-v8; GitHub Actions summary.

**Fixture pattern**: existing `packages/vite/test/fixtures/` convention + pre-commit hook + `FIXTURE_CHANGELOG.md` apply automatically to daemon fixtures via globbed hook paths. New: `packages/daemon/test/fixtures/frames/*.json` with `REDESIGNER_FIXTURE_UPDATE=1` generator for canonical WS frame snapshots — catches wire-frame schema drift cheaply. **Normalization before write** (critical, spec'd once, tested once): generator strips `token`, `pid`, `port`, `timestamps`, `instanceId`, `startedAt`, and any uuid-shaped string fields to stable placeholders (`"<REDACTED_TOKEN>"`, `0` for pids/ports/timestamps) before writing fixture. Otherwise `REDESIGNER_FIXTURE_UPDATE=1` produces diff-churn every run + `FIXTURE_CHANGELOG.md` fills with noise. A unit test asserts the normalizer produces byte-identical output across two runs with different process state.

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

**CLAUDE.md additions (gotchas future contributors must know)**:

When this spec lands, add to `/Users/rafael/Code/reDesigner/CLAUDE.md`:

- `AbortSignal.timeout(ms)` not `new AbortController() + setTimeout` — undici's per-request AbortController pattern leaks EventTarget listeners on long-lived fetch callers (documented in nodejs/undici#2198, node#48478, #52203). Reverting this in the shim's `httpRequest` is a known footgun.
- `process.channel?.unref()` after registering `process.on('disconnect', …)` in daemon child entry — otherwise the IPC channel pins the event loop independent of HTTP+WS servers; shutdown path can hang.
- `crypto.timingSafeEqual` throws `RangeError` on length mismatch — always normalize inputs to equal length before compare; see `compareToken` helper in §5.
- `fs.watch` on macOS silently degrades under Spotlight/Time Machine load; daemon compensates via 3s stat-poll fallback. If anyone rips that out thinking it's redundant, expect flakiness reports from macOS users.
- Zod schemas in daemon code must be module top-level; in-handler `z.object(…)` is a known 100x regression cliff (Zod v4 perf research).

**Open questions intentionally left unresolved**: none at design level. All panel-review rounds converged without unresolved tradeoffs. Remaining latitude is in implementation values (debounce intervals, retry backoff constants, buffer sizes, log-rotation thresholds) which the daemon's config module exposes for tuning without spec change.
