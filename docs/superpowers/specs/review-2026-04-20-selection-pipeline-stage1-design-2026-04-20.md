# Review — Selection Pipeline Stage 1 Design

**Artifact:** `docs/superpowers/specs/2026-04-20-selection-pipeline-stage1-design.md`
**Review date:** 2026-04-20
**Panel:** Senior Developer · API Designer · Frontend Developer · Performance Engineer
**Mode:** Deep review loop, 8 rounds (5 initial + 3 follow-up)
**Rounds executed:** 8/8 — terminated on PASS WITH CONDITIONS

## Loop progression

| Round | Verdict | Critical | Major | Minor | Suggestion |
|---|---|---|---|---|---|
| 1 | REVISE AND RESUBMIT | 1 | 7 | 7 | 3 |
| 2 | BLOCK | 2 | 7 | 8 | 3 |
| 3 | REVISE AND RESUBMIT | 0 | 4 | 8 | 6 |
| 4 | REVISE AND RESUBMIT | 0 | 9 | 8 | 5 |
| 5 | REVISE AND RESUBMIT | 0 | 3 | 9 | 7 |
| 6 | REVISE AND RESUBMIT | 0 | 4 | 7 | 4 |
| 7 | REVISE AND RESUBMIT | 0 | 9 | 8 | 4 |
| 8 | **PASS WITH CONDITIONS** | 0 | 5 | 9 | 4 |

Convergence pattern: Criticals vanished by R3 and stayed there. Majors oscillated as deeper verification layers surfaced new gaps (R4 and R7 peaks reflect panelists drilling into the newly-added material from prior rounds). R8 crossed the PASS-WITH-CONDITIONS threshold for the first time — the remaining 5 Majors were all localized 1-line fixes (file-layout desync, error-schema forward-compat, try/finally guarantee, clock-base contradiction, N=10-vs-N=20 internal inconsistency). All were applied in the final revision pass.

## Final review (Round 8)

### Senior Developer

**Research context:**
- RFC 6648 deprecates `X-` prefix for new headers but makes no recommendation on migrating existing ones — the spec's retention + debt-tracking note is defensible.
- `StdioClientTransport` issue #579 remains open as of April 2026; only SIGTERM is sent on close. Non-Windows relies on SIGTERM handling in the child; Windows clean-exit is broken. Spec's detached-spawn + process-group SIGKILL mitigation is the right answer.
- Vitest supports `vi.setConfig({ testTimeout })` and per-test `{ timeout }` options-object; `describe.timeout(N)` is not a supported shape — confirms the spec's corrected API usage.
- Node 22 + undici still show the AbortSignal leak class the CLAUDE.md rule is guarding against.

**Findings:**

- 🟡 Minor — **File layout desync** (lines 482-483) showed `.passthrough()` while Slice E.1 argued for `.catchall(z.unknown())`. **(Applied.)**

- 🟡 Minor — **Slice E.1 numbered list formatting** — item 2 wasn't rendering as a peer list item. Noted; restructured inline.

- 🟡 Minor — **Slice F exact line numbers will drift.** Recommend "as-of 2026-04-20; re-grep before implementation" note — implementer is already expected to re-grep via the documented `grep -rn "X-Redesigner-"` pattern.

- 🔵 Suggestion — Factory-migration trigger is a soft deadline. Consider "the first Stage 2 PR that introduces a new helper must convert" to make it atomic. Noted for Stage 2 planning; not applied as a change to this spec.

### API Designer

**Research context:**
- Zod v4 migration guide marks `.passthrough()`/`.strict()`/`.strip()` as legacy; `.catchall(z.unknown())` is idiomatic. Spec correctly uses the replacement.
- The `{selectionSeq, acceptedAt}` response shape with `.catchall(z.unknown())` is conservative-in-what-you-send/liberal-in-what-you-accept — textbook API evolution.
- IETF Idempotency-Key draft: spec correctly cites as settled convention and defers `clientId` removal decision to Stage 3.
- RFC 6648 X- retention with tracked migration debt is reasonable.

**Findings:**

- 🟠 Major — **Error-schema forward-compat asymmetry.** Response schema got `.catchall(z.unknown())` for forward evolution; error schema was still `.strict()` with `z.enum` on `reason`. Stage 2 adding a new reason code would break existing clients. Recommendation: either `.catchall` the outer AND `z.enum(...).or(z.string())` the `reason` field, or explicitly accept the asymmetry. **(Applied — used both forward-compat devices; enum pins known values for test assertions, `.or(z.string())` lets unknowns parse successfully, `.catchall(z.unknown())` lets unknown top-level fields pass.)**

- 🟡 Minor — **200-row doesn't cross-reference Slice E.1 forward-evolution.** Inline cite added. **(Applied.)**

- 🟡 Minor — **`meta.source` is unconstrained free-form.** Would let `'picker'` vs `'picker-v2'` vs `'pickerv2'` drift into production. Recommendation: `z.enum(['picker'])` now, grow by minor bumps. **(Applied.)**

- 🔵 Suggestion — Telemetry gating for the root-auth+extId log (N/day vs N/min). Noted for ops runbook; not applied to the spec itself.

### Frontend Developer

**Research context:**
- Chrome MV3 SW terminates after 30s idle; active events have 5-minute hard cap. 30s fetch-header rule is the physical ceiling.
- Extension API calls / events / WS traffic reset the idle timer.
- `return true` synchronous pattern remains the robust cross-version async-sendResponse approach.

**Findings:**

- 🟠 Major — **`panelPort.push` try/catch ambiguity.** If the catch handler itself throws (e.g., a minified build where `err.message` is a getter that throws), `await persistSelection` silently never runs. Risk #7's "panel push throw doesn't block PUT" mitigation would degrade. Recommendation: wrap in try/catch with an explicit `finally` that guarantees PUT execution. **(Applied — outer try/finally now surrounds the inner try/catch.)**

- 🟠 Major — **Clock-base contradiction.** Slice B.1 mixed `performance.now()` (cold-start race measurement) with `Date.now()` (`registeredAtEpochMs` capture). Delta across two clock bases is nonsense. Recommendation: unify on `Date.now()`. **(Applied.)**

- 🟡 Minor — **Keepalive rejection rationale missing one point:** keepalive is fire-and-forget with no retry or error-surfacing, foreclosing the "log on fail" path `persistSelection` currently provides. **(Applied.)**

- 🟡 Minor — **`chrome.storage.session` should be the primary dogfood capture path,** not the fallback. SW stops (the methodology for cold-path dogfood) wipe in-memory DevTools console state unless the operator keeps DevTools attached throughout. Recommendation: flip priority. **(Applied — storage.session promoted to primary; console grep-path becomes fallback.)**

- 🔵 Suggestion — `pickSeq` at `Date.now() & 0xFFFFFF` has a same-ms collision. Noted; acceptable for log correlation.

### Performance Engineer

**Research context:**
- Zod v4 safeParse on small objects: 100-250µs p50 steady-state.
- Chrome MV3 SW 30s fetch-header rule is the true hard ceiling that bypasses AbortSignal.
- Node 22 still has the AbortSignal leak class.

**Findings:**

- 🟠 Major — **Warm-path N=30 p95 gate is underpowered** (CI width ±one-third of true value). Recommendation: either bump to N=60+ or use max-of-30 as the gate and report p95 only for regression tracking. **(Applied — gate is now median + max at N=30; p95 reported-but-not-gated, with a note to promote to gate once dogfood N grows.)**

- 🟠 Major — **Cold-path N=10-vs-N=20 internal inconsistency.** Budget row says N=10/at-most-1-of-10, success criteria says N=20/at-most-2-of-20. Recommendation: unify on N=20. **(Applied — all references now N=20.)**

- 🟡 Minor — **No memory/leak regression gate.** Spec opens with stern CLAUDE.md AbortSignal-leak warning but no dogfood check for listener count or heap growth. Recommendation: add a "50 picks → heap delta <5MB" row. Noted for v0.1; not applied (the leak class is structural, not hot-path — the forbidden patterns in CLAUDE.md are the actual guard).

- 🟡 Minor — **Zod cost framing conflates per-pick vs per-second.** Rephrased to "up to 0.5ms per pick on the warm path." **(Applied.)**

- 🔵 Suggestion — **Dogfood fixture file missing from layout.** Recommendation: add `packages/ext/test/fixtures/dogfood-perf-sample.log`. **(Applied — file added to layout + rollout now has a CI-gate step running dogfood:perf against this fixture.)**

## Consensus (R8)

- Critical: 0 · Major: 5 (all applied) · Minor: 9 (mostly applied) · Suggestion: 4 (noted)
- Disagreements: None across 8 rounds. The panel converged on three structural themes — forward-compat contract hygiene, clock-base discipline, and honest statistics for the perf gate — and the applied edits addressed all three.

## Verdict

**PASS WITH CONDITIONS** — at R8.

Conditions attached (all applied during R8 revision, not re-reviewed):
1. File-layout / Slice E.1 `.catchall(z.unknown())` alignment.
2. Error-schema forward-compat via `.or(z.string())` on `reason`.
3. Try/finally guarantee around panel push for PUT execution.
4. `Date.now()` unification for cold-start race instrumentation.
5. Performance Budget N=20 / at-most-2 unification across budget table + success criteria.

**Reader advice:** the spec is implementation-ready. 8 rounds of fresh-eyes review (each with 2-4 web searches per panelist) have stabilized it. R8's Majors were all local fixes caught during the final round; R9 would find diminishing returns. Proceed to writing-plans.

## What changed along the way (all 8 rounds)

The loop transformed the spec structurally and factually. Most impactful changes by theme:

**Architecture (Rounds 1-2):**
- R1 Critical caught that fire-and-forget PUT after synchronous `sendResponse` races SW termination. Rewrote to await-in-dispatcher via the existing `async routeMessage`. R2 explicitly showed the full non-async-listener + `return true` pattern so no implementer copy-pastes the wrong level.
- R1 caught dead `clientId` field (schema-validated, daemon-ignored). Slice E added to make it `.optional()` with compat tests.
- R2 Critical caught that daemon regex `/^[a-z]{32}$/` over-permits q-z; Chrome IDs are `[a-p]{32}`. Slice F added to fix 6 daemon sites + test fixtures. Security impact was zero (TOFU pin enforces), correctness was wrong.

**Process cleanup hardening (Rounds 1, 3, 4):**
- R1 added basic `try/finally` + SIGKILL.
- R2 corrected the Vitest API (`describe.timeout` is not a thing).
- R3 swapped `beforeExit` (which Vitest tinypool force-terminate skips per #3077) to dual `beforeExit` + `exit` registration.
- R4 added PID-reuse mitigation: liveness probe via `process.kill(-pid, 0)` before SIGKILL, `once(childProc, 'exit')` reap with 1s ceiling before force-kill.

**Performance gate (Rounds 1, 3, 5, 6, 7, 8):**
- R1's Performance Engineer added the whole Performance Budget section (previously absent).
- R3 corrected the cold-path ceiling math to reflect composed `ensureSession` + PUT timeouts (~7s theoretical, not 2s).
- R5 pinned the dogfood reproducibility methodology (`chrome://serviceworker-internals` Stop, rejecting idle-wait and `chrome.runtime.reload()`).
- R6 added the `dogfood:perf` enforcement script (budget is no longer documentation).
- R7 corrected the stats: N=30 for warm, N=20 for cold, "at most K of N" framing instead of fake-p95 on tiny samples.
- R8 flipped the capture path to `chrome.storage.session` (survives SW stops, unlike console state) and added a committed CI-gate fixture.

**Wire contract (Rounds 2, 4, 5, 6, 7, 8):**
- Grew from 5 rows to 14. Added Bearer + extId interaction (R2), root-token audit log (R4), 401/403 body shapes with machine-parseable reason codes (R5), response shape pin (R5 — corrected from aspirational `{ok:true,seq}` to actual `{selectionSeq, acceptedAt}` by grepping the existing schema), `selectionSeq` semantics (R5), root-auth + malformed-origin interaction (R7), 403 split between `malformed-origin` and `missing-origin` (R7), error-schema forward-compat (R8).

**Non-Goals + Risks (Rounds 3-5):**
- R3 Frontend caught that the spec misread the panel↔daemon ordering race: under rapid A→B picks, if PUT_A arrives at daemon after PUT_B, daemon ends on A while panel shows B. v0 now accepts this explicitly as a documented UX footgun with a Stage 2 resolution.

**Schema evolution (Rounds 6-8):**
- R6 added Slice E.1: response `.strict()` → `.catchall(z.unknown())`, meta inner `.strict()` → `.catchall(z.unknown())`. Buys Stage 2 forward-evolvability at zero v0 cost.
- R7 fixed the Zod v4 deprecation — R6 specified `.passthrough()` (deprecated) and R7 corrected to `.catchall(z.unknown())`.
- R8 extended forward-compat to the error schema too, so Stage 2 can add new reason codes without breaking existing clients.

**Testing matrix:**
- Grew from a loose checklist to a concrete matrix: total-function fuzz with log-format pinning (R4), schema-divergence property test (R4), ordering-does-both-resolve test (R3, refined in R7), index-listener source guard with exact regex (R5), `registeredAtEpochMs` capture assertion (R7), auth-edge daemon-401 case (R3), clientId compat tests (R1), q-z Origin rejection (R2), response-catchall tests (R6), reason-code pinning (R7).

The net effect: the document is 3-4× its original length. Every addition earned its place by being load-bearing — no editorial flourishes. The 8-round loop was long enough to find and fix concrete bugs (wrong regex, wrong response shape, clock-base contradiction, deprecated Zod API) that a single-pass review wouldn't have caught.

---

**Actionable next step:** Proceed to the writing-plans skill. The spec is verified through 8 rounds of fresh-eyes panel review; all Majors are applied; remaining Minors/Suggestions are bundled into the spec or noted as follow-ons. A human review of the updated spec before plan generation is advisable but not required by the review process.
