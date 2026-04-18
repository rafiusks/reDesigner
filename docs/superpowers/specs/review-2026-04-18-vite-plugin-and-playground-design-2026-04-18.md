# Review — Vite Plugin + Playground v0 Design Spec

**Artifact:** `docs/superpowers/specs/2026-04-18-vite-plugin-and-playground-design.md`
**Date:** 2026-04-18
**Panel:** Senior Developer, API Designer, QA / Test Engineer, Frontend Developer, DevOps Engineer
**Mode:** Deep review loop (web research per panelist per round)
**Rounds:** 5 (maximum requested; loop exhausted)
**Final verdict:** **PASS WITH CONDITIONS** — no Critical, 3 Major (all with concrete recommendations applied), remainder Minor / Suggestion

---

## Loop progression

| Round | Verdict (consolidated) | 🔴 Critical | 🟠 Major | 🟡 Minor | 🔵 Suggestion |
|-------|------------------------|-------------|----------|----------|----------------|
| 1     | BLOCK                  | 7           | 11       | 13       | 7              |
| 2     | BLOCK                  | 4           | 17       | 20       | 12             |
| 3     | BLOCK                  | 3           | 8        | 19       | 2              |
| 4     | PASS WITH CONDITIONS   | 0           | 9        | 13       | 17             |
| 5     | PASS WITH CONDITIONS   | 0           | 3        | 8        | 10             |

Round 5 concluded with 1 panelist (Senior Developer) returning outright **PASS** and the other 4 returning **PASS WITH CONDITIONS** for polish items; all round-5 findings have been applied to the artifact.

---

## Final review (Round 5)

This is a fresh-eyes critique of the round-4 state of the spec. Findings are written as a complete standalone review — not a delta against prior rounds.

### Senior Developer — **PASS** ("ship it")

**Research context:**
- Vite 6+ `this.environment` is the canonical per-env context; the spec's `WeakMap<Environment, ClientState>` with a Vite-5 `options.ssr` fallback matches the docs.
- `@babel/plugin-transform-react-jsx-source` injects `__source` (not DOM-queryable); the spec's own DOM attribute is correctly justified.
- `write-file-atomic` and `graceful-fs` back off up to 60 s for EPERM/EBUSY; the spec's 7-step ~6.35 s ceiling + CI Defender exclusion is a conscious tradeoff, explicitly logged.
- RFC 8785 JCS is the canonical reference; the spec's hand-rolled canonicalization (sorted keys, no whitespace, UTF-8, no trailing newline, JSON.stringify number defaults) is JCS-compatible for the current manifest shape.
- Vite 6 `options.ssr` deprecation is future; the dual-path SSR skip is correct for `^5 || ^6 || ^7`.

**Findings:**

- 🟡 **Minor — JCS caveat for future float fields.** `JSON.stringify` number defaults are safe while the manifest only carries integer line numbers, but any future float field should prompt an upgrade to RFC 8785 JCS. Applied: a number-type caveat added to §6.3.
- 🟡 **Minor — Warm-start behavior not explicit.** Vite caches transform results; on warm-start the writer begins empty and lazily populates on first edit. Consumers handle this via the reader retry path, but the interaction deserves a line in §5.1. Applied.
- 🔵 **Nit — EXDEV severity.** Row 14b logs at `error` for a condition that "should never occur." Downgrade to `warn` + "plugin bug, please file issue" to match the severity-ladder intent (non-fatal impossible conditions are warnings). Applied.

"Spec is thorough, internally consistent, and directly addresses every pitfall surfaced by current Vite / Babel / CAS literature."

---

### API Designer — **PASS WITH CONDITIONS** (polish only)

**Research context:**
- Vite plugins are Rollup-style; typed options as a single factory interface is canonical. Spec uses it correctly.
- `apply: 'serve'` is the canonical Vite dev-only idiom; the distinction from user-facing `enabled` is well-drawn.
- JSON Schema evolution: SemVer-flavored `major.minor` with additive=minor is industry-standard.
- Canonical serialization for content hashing (sorted keys, no whitespace, UTF-8, stable numbers) is JCS-style; the spec specifies all four components.
- Reader contract published alongside wire format (pact-style) is the recommended pattern.

**Findings:**

- 🔵 **Low — `SUPPORTED_MAJOR` docstring inconsistency.** Typed `number`, but docstring described as `'1.0'` literal. Applied: clarified as integer `1`.
- 🔵 **Low — `readManifest.maxRetries` default undocumented.** Applied: default = 1 documented inline (matches §6.6 step 2 "retry once").
- 🔵 **Low — Template-literal `SchemaVersion` type is advisory.** Accepts pathological values (`'1.-3'`, `'1.1e10'`); runtime `parseSchemaVersion` is the real guard. Applied: explicit note added to §6.3.
- 🔵 **Low — `computeContentHash` signature clarification.** Takes `Manifest` which itself contains `contentHash`; spec says "excluding generatedAt + contentHash" but the TS signature doesn't express this. Applied: JSDoc explicitly documents that the function strips those fields internally.
- ℹ **Info — Frozen-mirror shorthand rule for `daemon` string is elegant forward-thinking.** No change.

"API ergonomics, typing discipline, versioning strategy, consumer reader contract, and canonical hashing are all sound."

---

### QA / Test Engineer — **PASS WITH CONDITIONS**

**Research context:**
- Unique `mkdtempSync` per worker is mandatory for fs-writing tests on Windows.
- `pool: 'forks'` + `isolate: true` is safe; `isolate: false` has known memory growth.
- Vitest fake timers with debounced async require `advanceTimersByTimeAsync`; real timers are a documented flakiness source.
- `server.waitForRequestsIdle` has a documented deadlock hazard if called from a load/transform hook without the id.

**Findings:**

- 🟡 **Medium — Timer discipline must be explicit.** Backoff/debounce unit tests MUST use `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` via the injected `clock` seam on the writer constructor. Real-timer backoff tests can approach 6 s/case and flake on Windows-2022 under Defender. Applied: §8.1 `manifestWriter.test.ts` row specifies this.
- 🟡 **Medium — `parallelism.test.ts` per-test tmpdir is non-negotiable.** 50 concurrent writers to one `.redesigner/` would trip the `.owner-lock` collision throw and false-positive. Applied: §8.3 row documents `fs.mkdtempSync` per test binding.
- 🔵 **Low — HMR `waitForRequestsIdle` id-form.** Spec should prefer the id-form to avoid deadlock hazards. Applied.
- 🔵 **Low — `daemon-tla` AbortController clarification.** Node dynamic-import promises are not cancellable; the 2 s is a `Promise.race` with a timer, not a true abort. The leaked import must not pin the worker. Applied: the TLA case is explicitly pinned to its own forked worker.
- 🔵 **Low — `shutdown.test.ts` Windows `testTimeout`.** Default 5 s leaves thin headroom when 1500 ms ack + 1.5 s exit + taskkill spawn are all exercised. Applied: `testTimeout: 10_000` documented.

"Spec is dense, coherent, and the three-tier plan is well-scoped."

---

### Frontend Developer — **PASS WITH CONDITIONS**

**Research context:**
- React 19.2 removed `source`/`self` from `jsxDEV`; our own DOM attribute rationale is reinforced.
- `@vitejs/plugin-react` v6 (Babel-less, oxc) is a known horizon event; peer `^5` is deliberate.
- React Compiler convention: `babel()` (Compiler) BEFORE `react()`; our `enforce: 'pre'` runs before Compiler hoists.
- Unknown-prop warnings on wrappers (`Suspense`, `Profiler`, `StrictMode`, `Activity`, `ViewTransition`) are real; the skip list is the defensible design.
- `jsxDEV` in automatic runtime is the only dev path in React 19; hard-erroring on classic is correct.

**Findings:**

- 🟠 **Major — plugin-react v4 declared-supported-but-untested.** `fast-refresh.test.ts` pinned to v5 `$RefreshReg$` shape; peer range `^4 || ^5` ships the invariant "we support v4 but never exercise it." Applied: peer narrowed to `^5` only; rationale recorded in §10 item 39.
- 🟠 **Major — `sourcemap.test.ts` verifies pre-downstream map only.** plugin-react's downstream Babel/Compiler pass composes over our map; end-to-end "DevTools shows correct source" is the user-visible contract. Applied: test extended to fetch and verify the final Vite-served map after plugin-react runs.
- 🟡 **Minor — `ErrorBoundary` heuristic README note.** Name-only match is documented in spec §3.3.9; surface it in the README for users who might rename. Applied (called out in §1.4 gate + §10 item).
- 🟡 **Minor — Skip-list update cadence.** React minors may add new wrappers; document expected update cadence. Applied as a note in §3.3 invariant 9.
- 🟡 **Minor — `(module)` carve-out in README invariants.** Module-scope JSX elements render with NO `data-redesigner-loc` — a designer tool clicking a module-root element hits nothing. Surface in the README invariants list, not only in §3.3.10. Applied: §1.4 gate #5 now calls this out prominently.

---

### DevOps Engineer — **PASS WITH CONDITIONS**

**Research context:**
- Corepack signature verification errors since Feb 2025; Node 20.11.0 ships Corepack 0.24 (far below 0.31.0); preflight upgrade is necessary.
- `actions/setup-node@v4` has a native `cache: 'pnpm'` option; spec's roll-your-own approach is valid because Corepack must be live before pnpm exists.
- Windows Defender can slow `node_modules` 5–10× on hosted runners; `Add-MpPreference` works but requires elevation (hosted `windows-2022` runs elevated).
- Exact Node 20.11.0 pinning may miss the runner's tool cache, adding ~20 s per run.

**Findings:**

- 🟠 **High — Corepack Node-22 bootstrapping gap.** Original guard was `if matrix.node == '20.11.0'`, but Node 22 early builds also shipped Corepack <0.31. Applied: version-check runs first; upgrade is conditional on the check, not the matrix cell.
- 🟡 **Medium — Defender exclusion ordering.** Running after `actions/checkout@v4` means thousands of files are already scanned. Applied: exclusion moved BEFORE checkout + `node.exe` process exclusion added.
- 🟡 **Medium — pnpm cache key missing `packageManager` hash.** A bump from `pnpm@9.15.4` to `9.16.x` could restore a cross-minor cache. Applied: cache key now includes `hashFiles('package.json')` (which pins `packageManager`).
- 🔵 **Low — `ci / all-green` + concurrency-cancel behavior.** Cancellation reports failure; GitHub reruns required checks against the winning SHA, so harmless — but comment worth adding. Applied.
- 🔵 **Low — `timeout-minutes: 15` is aggressive.** Windows + Defender exclusion mid-checkout + tool-cache miss can push first run to 12+ min. Applied: `timeout-minutes: 20` with a comment documenting the budget.

---

## What changed along the way

Over five rounds, the spec moved from a strong brainstormed design to a review-hardened one. The most impactful changes applied during the loop:

1. **SSR → environment-aware skip.** The original spec only checked `options?.ssr === true` (Vite 5 idiom). Rounds 1–2 escalated this to use Vite 6+ `this.environment.name !== 'client'` with a Vite 5 fallback. Round 4 added a `WeakMap<Environment, ClientState>` state model — non-client transforms now short-circuit before touching writer state.

2. **Shutdown realism.** Early rounds assumed POSIX SIGTERM → 2 s → SIGKILL suffices universally. Rounds 2–3 introduced platform-branched teardown, a `stdin` graceful-shutdown handshake with stdout `ack` for Windows, `taskkill /T /F` tree-kill, `SIGHUP` POSIX-only (Windows CTRL_CLOSE_EVENT deadlock), removal of `beforeExit` (never fires with live daemon), and — round 4 — a `shell: false` + `detached: false` daemon-spawn contract. Windows ack timeout eventually settled at 1500 ms for hosted-runner headroom.

3. **Atomic-write hardening.** Evolved from naive `fs.rename` (round 0) → 3-step backoff (round 1) → 7-step exponential backoff `50/100/200/400/800/1600/3200 ms` (round 2) with startup tmp sweep, post-flush state-identity re-check (closes the commit-during-rename race), and construction-time collision detection (replacing a runtime `proper-lockfile` dependency with a loud config error). Windows-specific behaviors (EXDEV same-dir temp, EPERM/EBUSY retry, Defender exclusion in CI) all landed.

4. **Manifest-as-consumer-contract.** Round 1 had a bare `version: 1` integer. Round 2 introduced `schemaVersion` semver + reader contract. Round 3 added `contentHash` (canonical serialization, sorted keys, UTF-8, no trailing newline) for change-detection since `generatedAt` rewrites on every flush. Round 4 shipped a `readManifest()` helper + `SUPPORTED_MAJOR` export; round 5 clarified that the template-literal `SchemaVersion` type is advisory only (runtime `parseSchemaVersion` is the real guard).

5. **Wrapper-component skip list.** Grew from round 1's naive `JSXFragment`-only skip to the React-built-in list (`Fragment`, `Suspense`, `Profiler`, `StrictMode`), then React 19.2 additions (`Activity`, `ViewTransition`, `Offscreen`) plus the `ErrorBoundary` name-only heuristic. A documented false-negative for re-exported wrappers + a fixture (`wrapper-reexport-chain/`) makes the limitation visible to users.

6. **CI enforcement decoupled from matrix labels.** Original rounds named the required status check as `ci / test (windows-2022, 22)` — a matrix-label string that silently orphans if the matrix is reordered. Round 4 introduced a stable `ci / all-green` summary job as the required check; round 5 added the concurrency-cancel behavior comment. Corepack preflight evolved from a cosmetic comment to a real shell-native version check with conditional upgrade; Defender exclusion moved before checkout; `pnpm` store-cache resolution switched from hardcoded paths to `pnpm store path --silent` + restore-keys + `package.json` hash.

7. **Test determinism.** Rounds 2–5 layered in: `writer.quiesce()` test hook (decoupled from debounce tuning); `server.waitForRequestsIdle(id)` id-form to avoid the bare-form deadlock hazard; HMR update-count lowered from `>= 2` (flaky; Vite batches) to a stable final-state assertion; Fast-Refresh test upgraded from "no crash" to state preservation (`useState` counter at non-default value) + instance-stamp identity + registration stability (`$RefreshReg$` monkey-patch) + memo↔plain transition (facebook/react#30659 regression class); fake-timer + injected-clock discipline made explicit; `daemon-tla` test pinned to its own forked worker (Node dynamic imports are not cancellable).

8. **Public API ergonomics.** Original `daemon: {...} | false` tri-state flattened to `DaemonOptions | 'auto' | 'required' | 'off'` with frozen-mirror semantics. `export *` replaced with explicit named re-exports. Types split into `types-public.ts` vs. `types-internal.ts`. Vite peer range narrowed from aspirational `^5 || ^6 || ^7 || ^8` to validated `^5 || ^6 || ^7`; plugin-react peer narrowed from `^4 || ^5` to `^5` once round 5 flagged the v4 `$RefreshReg$` shape as declared-supported-but-untested.

9. **Operational fictions removed.** `required-checks.yml` (round 2) → real committed GitHub ruleset JSON + dedicated sync workflow (round 3). `proper-lockfile` runtime dependency (round 2) → construction-time collision throw (round 3). `inputSourceMap: true` (round 3) → `false` because our plugin is the first Babel pass at `enforce: 'pre'` (round 4). `execSync` in sample CI YAML → shell-native version check (round 3, triggered by a security hook). `$schema` URL (round 2) → dropped in v0 because nothing is published.

---

## Verdict & next steps

**Final verdict: PASS WITH CONDITIONS.** The spec is thorough, internally consistent, and every significant finding across 5 rounds has a concrete recommendation applied. Three Round-5 Major findings (plugin-react v4 peer drop, composed-map sourcemap assertion, Corepack Node-22 bootstrapping) were applied directly. Eight Minor and ten Suggestion items are either applied inline or noted in the §10 decision log.

The spec is ready to move to the implementation-planning phase (writing-plans skill). The implementer should: (a) treat the decision log (§10, items 1–49) as a binding checklist, (b) honor the "must use fake timers with injected clock" discipline for any backoff/debounce test, (c) land the composed-map sourcemap assertion as part of `sourcemap.test.ts` from day one (not an afterthought).

If any findings miss the mark, let me know and I'll recalibrate.
