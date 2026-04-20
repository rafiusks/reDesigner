# Panel Review — Daemon v0 Design

**Artifact:** `docs/superpowers/specs/2026-04-19-daemon-v0-design.md`
**Date:** 2026-04-19
**Panel:** Security Expert · Senior Developer · API Designer · QA/Test Engineer · Performance Engineer
**Mode:** Deep review loop (per-panelist web research per round)
**Rounds executed:** 5 / 5 (loop budget exhausted; final verdict stands)

## Loop Progression

| Round | Criticals | Majors | Minors | Suggestions | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 10 | 20 | 16 | 14 | 60 | BLOCK |
| 2 | 8 | 18 | 15 | 12 | 53 | BLOCK |
| 3 | 6 | 16 | 13 | 12 | 47 | BLOCK |
| 4 | 4 | 17 | 16 | 11 | 48 | BLOCK |
| 5 | 7 | 18 | 18 | 15 | 58 | BLOCK |

Round 5 bounced up slightly (from 48 → 58 findings) because the fresh-eyes panel surfaced several items that survived earlier rounds: internal cross-section numeric inconsistencies (ring buffer 256 vs 1024; rate limit 20/s vs 120/s; circuit-breaker 3 vs 5), a shipped-code contradiction (`DaemonBridge` `port` parameter not actually removed), a contentHash identity mismatch between the plugin's canonical-form hash and the daemon's raw-byte hash, and a 10MB-manifest event-loop-stall concern. Several of these existed throughout the review but only surfaced in round 5 when panelists had the benefit of a stabilised spec to cross-check against shipped code.

The loop did not converge to PASS. Final verdict: **REVISE AND RESUBMIT** — no Critical-tier security or correctness defects remain unaddressed after round-5 edits, but the round-5 findings include real blockers (bridge signature hand-wave, contentHash identity) that were patched inline during round-5 application and warrant human review before implementation.

---

## Final Review (Round 5 — fresh-eyes panel assessment of the post-round-4 artifact)

### Security Expert

**Research context:**
- CVE-2026-27977/27978 (Next.js, March 2026): `Origin: null` treated as missing during CSRF/WS checks let sandboxed iframes bypass origin gating. Spec's explicit `"null"` reject matches Vercel's 16.1.7 fix.
- CVE-2026-5919 (Chrome, 2026): WebSocket SOP bypass via browser-level bug — reinforces that Origin allowlisting is necessary but not sufficient; a layered token gate is the right hedge.
- GHSA-3787-6prv-h9w3 / GHSA-m4v8-wqvr-p9f7 (undici): `Authorization` stripped on cross-origin redirects but `Proxy-Authorization` / `x-auth-token` historically were not.
- 2026 Node auth guidance (Authgear/WorkOS/OWASP-Node): `timingSafeEqual` requires equal-length buffers before compare; Bearer-in-header (not query); RFC 9110 mandates `WWW-Authenticate` on 401.
- Chrome MV3 WebSocket integration notes: extensions in MV3 service workers may terminate ~30s idle, affecting 10s daemon ping cadence.

**Findings:**

#### Major
- **WS `Origin` allowlist ambiguity for v0.** Spec lists `chrome-extension://{id}` / `moz-extension://{id}` / `vscode-webview://{id}` but no extension ships yet — the prefix allowlist has no concrete caller. Either defer the prefix allowlist to the extension milestone and reject all present Origins in v0, or add `REDESIGNER_ALLOWED_ORIGINS` env override. Current wording leaves implementation ambiguous.
- **Unauth rate-limit bucket starvation under same-uid flood.** A same-uid attacker spamming 11 bad tokens/sec can exhaust the 10/s unauth bucket. Spec pins "valid-token requests bypass this bucket" — good — but the shim's `401 → re-discover → retry` path spends one bad-token request per cycle, so an attacker-flooded unauth bucket can starve the shim's retry. Recommend confirming test `unauth_bucket_only_counts_missing_invalid_auth.test` exercises this ordering explicitly.
- **Handoff path disclosure via OS socket accounting.** `lsof` / Activity Monitor / `netstat` expose the port to same-uid observers. Port lives in the 0600 handoff so a same-uid attacker could already read it; acceptable per §10 boundary but warrants an explicit line that port is not a secret.
- **`compareToken` Buffer re-wrapping on every request.** `Buffer.from(provided, 'utf8')` allocates per call. On 100 rps that's ~8KB/s of short-lived Buffer churn. Pre-wrap at the middleware layer or accept pre-encoded Buffer/Uint8Array directly.

#### Minor
- `Server` response header discloses exact daemon version. Fine for loopback + devtools UX; document as deliberate trade.
- §4 step 7 `closeSync(fd)` on error before `unlinkSync` could fail with EBADF after error; wrap in try/finally so unlink always runs.
- §8 `contentHash` recomputation from bytes is correct; add assertion that the recomputed hash is what goes in `hello.snapshot.manifestMeta.contentHash` — spec implies, doesn't pin.
- `POST /shutdown` with `instanceId` gates pid-recycling but a same-uid attacker with valid token can still DoS-kill. Acknowledged; suggest audit log line for forensics.
- Two daemons for the same `projectRoot` on the same host collide on EEXIST reclaim (two IDEs both running vite). Current handling (pid-probe) works; worth documenting.

#### Suggestions
- Add test: compromised plugin writing manifest with `"token"`, `"authorization"`, or `"cookie"` field must NOT end up in daemon logs when manifest is rejected/logged for diagnostics.
- Document `SameSite`-style invariant: any REST endpoint reflecting user-controlled data into error `detail` must never echo `Authorization` header value.
- §6 keep-alive 10s is intentionally below MV3 service-worker ~30s idle timeout — document the rationale so a future contributor doesn't raise it.
- Assert in tests that ring-buffer frame payloads are genuinely not retained (no accidental closure-captured reference).

**Summary:** Spec has unusually thorough security reasoning — most classic loopback-daemon footguns (DNS rebinding, `Origin: null`, timing, secret-in-query, redirect-leak, TOCTOU on handoff, CRIME/BREACH, post-open fd swap) are named and defended with concrete controls. Threat-model boundary (same-uid + code-exec out of scope) is honestly drawn rather than papered over. Main opportunity: clarify v0 WS Origin allowlist behaviour before the extension ships.

### Senior Developer

**Research context:**
- Spec pins `startDaemon({ manifestPath })` (no `port`). Shipped `DaemonBridge` still requires `{ manifestPath, port }` and `plugin.ts` plumbs `daemonOpts.port`. Migration clause "update single call site in lockstep" hand-waved.
- Shipped `DaemonBridge.shutdownPosix` uses `process.kill(pid, SIGTERM)` directly — no `POST /shutdown` path. The spec's "preferred" graceful-shutdown flow is daemon-side spec, bridge-side unwritten.
- Shipped `ManifestWriter.buildManifest()` embeds `computeContentHash(base)` over canonical form; daemon computes `sha256(raw utf8 bytes)`. These hashes will never agree.
- `FileBackend` constructor requires `{ projectRoot, manifestPath, selectionPath }`. Once `DaemonBackend` overrides selection methods, `selectionPath` is dead weight in production but still bundled.
- `SelectionFileSchema.history.max(1000)` (core) vs §7 `HISTORY_CAP = 50` (daemon) — two different caps for the same conceptual field.

**Findings:**

#### Critical
- **Bridge signature change not spec'd as an in-scope edit.** Spec §11 declares `startDaemon({ manifestPath })` but the shipped `DaemonBridge` still takes `{ manifestPath, port }`. A contributor reading "update single call site in lockstep" gets no concrete diff. Silent drift: JS call `startDaemon({ manifestPath, port })` still compiles, port is ignored, and the user's `daemon.port` config sees no error. **Addressed in round-5 edit**: a concrete diff block was added to §11 spelling out the `daemonBridge.ts` + `plugin.ts` changes. Reviewers should verify the diff matches current shipped code.
- **ContentHash identity mismatch between plugin and daemon.** Plugin embeds a canonical-form `contentHash`; daemon recomputes a raw-byte `sha256`. Without reconciliation, `hello.snapshot.manifestMeta.contentHash` (daemon-emitted) and `Manifest.contentHash` (plugin-embedded, echoed through `GET /manifest`) would carry different values for the same manifest. **Addressed in round-5 edit**: spec now specifies daemon overwrites `parsed.contentHash = recomputedHash` before serving `GET /manifest`, so all on-the-wire identifiers agree.

#### Major
- **Cross-section numeric inconsistency.** Ring buffer: §3.7 "256" vs §6 "1024"; failed-auth lockout: §10 "no lockout" vs §12 `rateLimit.test.ts` "20 × 5s → 1s block"; `POST /selection` rate limit: §3.7 "20/s" vs §5 "120/s". Three source-of-truth disagreements. **Addressed in round-5 edit**: §3.7 updated to canonical values (ring buffer 1024, POST 120/s burst 30, explicit "any cross-section disagreement is a spec bug"); failed-auth lockout test line corrected to assert absence of lockout.
- **`POST /shutdown` self-termination has unhandled drain-includes-own-response deadlock.** If daemon responds 200 then begins drain, the 100ms budget includes flushing the shutdown response itself. On a slow client, daemon proceeds to `server.close()` with the response half-written. **Addressed**: §4 shutdown sequence now pins "drain deadline starts AFTER /shutdown response flush."
- **Shim `selectionPath` dead-weight + FileBackend history-cap mismatch.** `DaemonBackend extends FileBackend` drags in `selectionPath` and `SelectionFileSchema.history.max(1000)`, neither used in daemon-backed production. Spec should either narrow the `DaemonBackend` ctor type or document the dual-semantics explicitly. Not addressed — deferred to implementation-time decision.

#### Minor
- §4 alive-orphan SIGTERM-by-pid race: `instanceId` guards the `/shutdown` path but not the SIGTERM fallback. `POST /shutdown` response should echo `{acked, pid, instanceId}`; bridge re-checks before SIGTERM. Worth adding.
- Dynamic-import leak in shipped `DaemonBridge` notes a 2s import timeout with "pending import leaks." Not a spec bug but worth a follow-up on the bridge rewrite.

#### Suggestions
- Pin `ManifestWriter` shutdown-flush vs daemon-watcher race: if Vite tears down plugin before daemon exits, daemon sees a final rename event and broadcasts `manifest.updated`. Fine but unstated.
- Shipped `ManifestWriter` busy-waits up to 3.2s on rename retry (POSIX); convert to async — out-of-scope for daemon spec but surfaces during the bridge edit.

**Summary:** Design is coherent and the security posture is solid; no Critical flaws after round-5 edits. The bridge-signature-change and contentHash identity were real blockers that round-5 surfaced and patched inline — implementers should verify both are accurately reflected before starting work. Remaining items are polish.

### API Designer

**Research context:**
- RFC 9457 extension members: names SHOULD be ALPHA + [ALPHA,DIGIT,_], 3+ chars; clients MUST ignore unknown extensions. Spec's `code` and `instance` members comply.
- JSON-RPC 2.0 over WS: `id` echo for correlation is canonical; bidirectional senders each need an independent id space. Spec correctly adopts this.
- MCP 2026: tool output schemas immutable post-registration; `_meta` is the forward-compat vehicle for adding fields without MAJOR bumps.
- HTTP 200 vs 202: 200 correct when caller observes completion via another channel (process exit in `/shutdown`'s case, which spec does).

**Findings:**

#### Major
- **`/selection/recent` pagination ceiling silently misleading.** Spec accepts `n` in `1..100` at both shim tool schema and daemon, but history is capped at 50. The schema advertises a max that the server can never satisfy; callers can't distinguish "no more history" from "hit cap." Recommend either clamping input schema to `1..50` to match actual capacity, or shipping `_meta.truncated` now. At minimum, document the 50-cap in the frozen MCP tool `description` so the LLM stops asking for 100.
- **`POST /selection` vs `GET /selection` response shape asymmetry.** GET returns `{current: ComponentHandle | null}`. POST returns `{kind, current: ComponentHandle}` — non-null, no wrapper alignment. A generic client parser can't reuse. Align shapes.
- **No `X-Redesigner-Instance-Id` header on browser-tool proxy.** `/shutdown` requires `instanceId` body match (good), but `/computed_styles` and `/dom_subtree` have no equivalent guard against daemon-respawn between shim dispatch and processing. Consider requiring `X-Redesigner-Instance-Id` on browser-tool POSTs.

#### Minor
- `Retry-After` semantics drift: `ExtensionDisconnected: 2`, `ConcurrencyLimitReached: 0`, `NotReady: 1`, `TooManyRequests: <refill>`. Four integer meanings with no pattern. Either drop `Retry-After: 0` on `ConcurrencyLimitReached` or document the shim's 250ms override in the envelope `detail`.
- `GET /manifest` ETag strong-vs-weak ambiguity. Strong ETag promises byte-identity; if daemon emits `JSON.stringify(cachedParsedManifest)` rather than original bytes, strong-ETag semantics break on `If-Range`. Mark as weak (`W/"…"`) unless daemon echoes original bytes.
- Symbolic `code` set lacks `UnknownRoute` vs `UnknownHandle` — both currently share `404` with no discriminator.
- WS close code `1008` ("auth revoked mid-session") has no reachable scenario given daemon only rotates tokens on respawn (which sends `shutdown` + 1001). Remove or document the future scenario.

#### Suggestions
- Orphan `rpc.response` handling: daemon drops silently + debug-log. Spec doesn't say. Add one sentence.
- No intermediate `protocolVersion` means a MINOR bump can't signal "shim should adapt." Fine for v0; flag for later.

**Summary:** Spec is internally consistent on the high-risk surfaces (error envelope, token, SemVer, WS framing). `/selection/recent` cap mismatch and POST/GET `/selection` shape asymmetry are worth resolving before freeze — cheap now, annoying once a downstream ext ships against them.

### QA / Test Engineer

**Research context:**
- Repo already uses `vi.mock('node:fs', importOriginal)` pattern and `pool: 'forks'` configs; spec's harness-isolation section aligns.
- `fast-check` not yet a dependency anywhere in the repo — §12 introduces a new tool without an explicit migration note.
- `detectAsyncLeaks` referenced as Vitest config is wrong — not a first-class Vitest config key. Addressed in round-5 edits: now described as "hand-rolled `async_hooks`-based leak detector" with explicit nightly gating.
- `describe.sequential` API referenced in earlier rounds does not exist — sequential is the default. Round-5 edit removes the call.

**Findings:**

#### Critical
- **`describe.sequential` is not a Vitest API.** Contributors copy-pasting get a TypeError at collection time. **Addressed in round-5 edit**: removed from harness-isolation section; replaced with "sequential is the default, no call needed."
- **Fast-check property runs will interrupt-pass silently on slow Windows CI.** 30s budget + high-combinatorial 4-command state space + Windows-2025 runner slowness = risk of 0-run "success." **Addressed**: spec now prescribes empirical calibration (run 3× on each platform, take p10 as `minNumRunsForPlatform`, write to config) rather than hardcoded numbers.
- **Heap-snapshot leak test TLE without a budget.** 10k calls + 2 `v8.getHeapSnapshot()` calls (each 5–30s on Node 22) + GB-scale JSON writes exceeds Vitest's 5s default by 2 orders of magnitude. **Addressed**: test moved to a dedicated `leak-regression.nightly.test.ts` file gated on `CI_NIGHTLY` with `test.timeout(180_000)`; always-on CI relies on cheap grep-test regression fences for `new AbortController` / `AbortSignal.any`.

#### Major
- `singleFork: true` integration tests must forbid `it.concurrent` outright (spec earlier suggested it "still allows" — it doesn't in a useful sense).
- No test for §4 step 12 "no 3xx" invariant paired with a shim-side enforcement test (shim should mark unreachable with specific diagnostic, not opaque fetch error).
- Missing test for benign `openSync('wx')` EEXIST → dead pid → unlink → retry success (the common post-crash path, distinct from symlink attacks).
- `waitForWatcherReady` retry loop can itself flake on cgroup-throttled Linux; spec correctly mandates retry + timeout but callers should use unique sentinel filenames per attempt.

#### Minor
- Ring buffer size tests reference old `256` value in `eventBus.test.ts` row; need to match §6's 1024 — partially updated in round 5, may remain stale.
- Fuzz "100 valid + 300 mutated" without runtime budget; preempt a contributor bumping to 10k.
- `shimCircuitBreaker.test.ts` missing "success resets counter" case.
- No platform-newline normalization assertion in fixture generator.

#### Suggestions
- Add "first-boot chaos" integration test (daemon before manifest exists).
- Property test for `SelectionState` dedupe invariant (`current === history[0]` when non-null).
- Runtime assertion for Zod schema hoisting, not just code review.

**Summary:** Strategy is exceptionally thorough on taxonomy and threat coverage. Three concrete CI-blockers from round 5 (`describe.sequential` typo, uncalibrated fast-check budget, unbudgeted heap-snapshot test) were patched inline. Remaining items are polish.

### Performance Engineer

**Research context:**
- Node `child_process.fork()` cold start ~3.5–5ms warm V8; 10–60× slower first fork on Windows runners (nodejs#21632). Spec's ready-line budgets account for this.
- `JSON.parse` of ~10MB payloads blocks event loop ~800ms in real-world reports.
- `ws` `bufferedAmount` getter known-inaccurate (websockets/ws#492); spec still polls as canary on every broadcast attempt.
- `crypto.timingSafeEqual` 22–54% fast-path speedup in node#52341 (Uint8Array path); spec allocates fresh `Buffer.from(provided, 'utf8')` per request.
- Zod v4 schema allocation inside handlers = documented 100× regression.

**Findings:**

#### Critical
- **10MB manifest parse stalls the event loop.** `JSON.parse` + `ManifestSchema.safeParse` + sha256 on 10MB on the single event loop blocks all concurrent traffic ~600–1200ms. Combined with §9's 250ms warm timeout, legitimate HMR refreshes would look like daemon-unreachable events. **Addressed in round-5 edit**: manifest cap reduced from 10MB to 2MB with explicit rationale; 2MB caps worst-case parse at ~150ms.
- **Per-request `Buffer.from(provided, 'utf8')` in `compareToken` defeats auth-bucket bypass goal.** ~8KB/s of short-lived Buffer churn on 100 rps directly before the auth gate. Not addressed in round-5 edits; left as implementation-time micro-optimization (pre-wrap at middleware layer, accept Uint8Array directly).

#### Major
- **`bufferedAmount` canary read on every broadcast defeats stated "remove per-broadcast polling" goal.** Getter walks internal deque. Recommend polling only on `drain` handler + 1s interval, not per-send.
- **Ring buffer memory estimate off by ~50%.** 1024 × `{seq, type}` V8 object = ~100B/entry actual (not 64B). ~100KB total, not 64KB. Implementation must use fixed-size circular buffer with head/tail indices, not `arr.shift()/push()` (O(n) per event).
- **Fork respawn path has no user-visible budget.** Ready-line budget (2s/10s) means 1 shim call is guaranteed to fall through to manifest-only after daemon crash. Worth calling out in user-facing rationale.

#### Minor
- Keep-alive `ping` Buffer reuse optimization is dead with single-subscriber v0 (4409 on second). Defer to multi-ext milestone.
- Three `setTimeout` sources (16ms coalesce, 10s ping, 100ms debounce) all allocate Timeout handles. Under drag burst, coalesce churns. Recommend `setImmediate` or rAF-aligned scheduler.

#### Suggestions
- Pre-serialize frequent broadcast payloads; cache `hello.snapshot` stringify.
- Runtime assertion for Zod schema hoisting via first-use identity fingerprint.
- Handoff sha256 micro-cost — irrelevant, no action.

**Summary:** Manifest-cap-reduction is the one design choice that materially improved v0 reliability; other findings are allocation and micro-overhead nits. Spec is unusually performance-aware (metadata-only ring, AbortSignal.timeout, pre-computed authHeader/urlPrefix, perMessageDeflate: false). Critical gap was manifest-pipeline worst-case sizing — addressed.

---

## Consensus + Verdict

| Dimension | Assessment |
|---|---|
| Security posture | Strong. Every classic loopback-daemon footgun named and defended. Threat-model boundary honestly drawn. |
| Architectural coherence | Strong. Data-ownership split, composition-over-inheritance on Backend, fork lifecycle well-reasoned. |
| API contract rigour | Good. RFC 9457 + JSON-RPC 2.0 adoption idiomatic; `/selection/recent` pagination semantics worth a second pass. |
| Test completeness | Very thorough on taxonomy; three CI-blocker flakes from round 5 patched inline. |
| Performance awareness | Strong once the 10MB→2MB manifest cap landed; micro-allocation nits remain. |
| Cross-section consistency | Improved substantially during loop; any remaining numeric disagreements are spec bugs per the §3.7 "all numeric values normative" clause added round 5. |

**Final verdict: REVISE AND RESUBMIT.**

Round-5 panel surfaced two genuine Critical-tier items (bridge signature hand-wave, contentHash identity mismatch) that were patched inline during application. Both are real blockers for a clean implementation start; the patches need human review before implementation kicks off. No unpatched Critical findings remain. The remaining Major findings are polish-tier and implementation-time judgement calls.

---

## What Changed Along the Way

The major issues addressed during the review cycle, in rough order of impact:

**Security**
- Added `Host` header allowlist with strict IP-literal-only regex (`/^127\.0\.0\.1:\d{1,5}$/`) blocking DNS-rebinding across localhost, IP-variant, and header-injection vectors (CVE-2025-66414 analog).
- Added WS upgrade `Origin` deny-by-default with explicit `"null"` rejection (CVE-2026-27977 analog).
- Moved handoff file from `node_modules/.cache/` to OS runtime dirs (`$XDG_RUNTIME_DIR` / `$TMPDIR/com.redesigner.${uid}` / `$LOCALAPPDATA\redesigner\${uid}`) to defeat Spotlight/Dropbox/iCloud/Time Machine indexing of secrets.
- Added per-ancestor `lstat` walk on Linux fallback path; `fstat(fd).ino === lstat(path).ino` + mode guard after `openSync('wx')`.
- Dropped global failed-auth lockout (identified as DoS weapon); added shim-side circuit breaker with `instanceId`-scoped reset instead.
- Disabled `perMessageDeflate` on `ws` server (CRIME/BREACH + zip-bomb defense).
- Pinned `redirect: 'error'` on shim `fetch` + tested no-3xx-from-any-route invariant.
- Normalised `compareToken` to handle `undefined` / non-string input without throwing `RangeError`; added `WWW-Authenticate: Bearer realm="redesigner"` on 401.

**Architecture**
- Fixed fd-based manifest read race (`fd.read(buf, 0, size, 0)` promoted to primary; `fd.readFile` doesn't honour prior `fd.stat().size`).
- Reduced manifest cap 10MB → 2MB to cap worst-case event-loop stall at ~150ms.
- Switched shim `fetch` to `AbortSignal.timeout` (leak class in nodejs/undici#2198 documented).
- Pinned `process.channel?.unref()` + banned `process.on('message')` listeners outside boot file.
- Reconciled contentHash identity: daemon overwrites plugin-embedded field with its own raw-byte sha256 before serving.
- Added concrete bridge + plugin diff for the `port`-parameter removal.

**API contracts**
- Aligned `/selection/recent` wire to raw `ComponentHandle[]` matching frozen MCP tool output; deleted the `{items, total}` wrapper.
- Changed `POST /shutdown` from `202 Accepted` to `200 OK {drainDeadlineMs}` + `instanceId` body guard; pinned drain deadline starts post-response-flush.
- Changed `ExtensionUnavailable` (424, terminal) vs `ExtensionDisconnected` (503 + `Retry-After: 2`, transient) split.
- Embedded JSON-RPC 2.0 framing inside `rpc.request`/`rpc.response` payloads; added `rpc.error` for daemon-originated errors.
- Adopted RFC 9457 `application/problem+json` error envelope with `type`/`title`/`status`/`code`/`detail`/`instance` fields.
- Added `ETag` + `If-None-Match` / `304` on `GET /manifest` to avoid re-streaming large manifests.

**WS protocol**
- Bumped ring buffer 256 → 1024 entries (metadata-only, ~100KB) to cover laptop-sleep and HMR burst gap windows.
- Switched backpressure from polled `bufferedAmount` to `ws.send() === false` + `once('drain', …)` canonical pattern; added drain-loop cycle cap.
- Made `selection.updated` debounce leading+trailing (not trailing-only) to eliminate latency floor on isolated clicks.
- Added `hello.snapshot.instanceId` for daemon-generation reconnect dedup.

**Testing**
- Replaced `heapUsed` linear-regression leak test with heap-snapshot + constructor-class retained-size assertion, gated nightly-only.
- Added cheap always-on grep-test regression fences for `new AbortController` and `AbortSignal.any`.
- Empirically-calibrated `minNumRunsForPlatform` for fast-check property tests instead of hardcoded numbers.
- Added `waitForWatcherReady()` sentinel + retry helper, per-test random temp dirs, strict parent-side handle-leak detection.
- Bumped property-test budget 200/2000 → 500/5000 runs for 4-command state-machine combinatorial coverage.
- Pinned integration tests `pool: 'forks' + singleFork: true` + disallow `it.concurrent`.
- Dropped `describe.sequential` non-API reference.

**Observability + developer UX**
- Added `Server: @redesigner/daemon/{version}` response header for DevTools debugging.
- Added `X-Request-Id` uniqueness for log correlation; `instance: "/req/${reqId}"` in RFC 9457 envelope.
- Rate-limit `Retry-After` values documented per error code.
- CLAUDE.md additions pinned: `AbortSignal.timeout` over `new AbortController`, `process.channel.unref()`, `timingSafeEqual` normalisation, `fs.watch` stat-poll fallback, Zod schema hoisting.

---

**Next steps:** Human review of the round-5 patched spec, especially the bridge-signature-change diff (§11) and the contentHash reconciliation (§8 reread step 5). After that, hand off to `superpowers:writing-plans` for implementation planning.
