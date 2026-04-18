# Vite Plugin + Playground — v0 Design Spec

**Date:** 2026-04-18
**Status:** Draft — pending user review
**Codename:** `redesigner` (product name TBD; rename cost at naming time is accepted — see §10 item 6)

---

## 1. Scope

### 1.1 What this spec covers

First milestone of the v0 roadmap from `brief.md`: the Vite plugin (`@redesigner/vite`) and the playground app (`examples/playground/`), with the monorepo scaffold that hosts them.

Deliverables:

- `@redesigner/vite` — a Vite plugin that injects `data-redesigner-loc` attributes onto every rendered host-element JSX node in dev builds (skipping React wrapper components and module-scope JSX — see §3) and emits a versioned manifest to `.redesigner/manifest.json`. Ships a small optional reader helper (`@redesigner/vite/reader`) that implements the canonical read + retry + version-check algorithm (§6.6).
- `examples/playground/` — a React 19 + TypeScript + Vite app used to dogfood and test the plugin, exercising children-as-function, module-scope JSX, multi-component files, React 19 ref-as-prop, cloneElement, React 19.2 wrapper components (`Activity`, `ViewTransition`), and Tailwind v4.
- Monorepo scaffold: pnpm workspaces, Biome, shared tsconfig base, `.gitignore`, `.npmrc` (engine-strict), root `README.md` + `CONTRIBUTING.md`, `.editorconfig`, and the **full CI matrix** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 exact + Node 22 current LTS, pnpm 9.15.4 via Corepack ≥0.31.0). Required-status-check enforcement is done via a committed GitHub ruleset JSON, synced by a dedicated workflow (§4.3).

### 1.2 What this spec does NOT cover (and why)

This v0 slice is intentionally narrow. The brief's build order (§131–136) sequences six deliverables; this spec is the first two.

| Deferred item | Why out of scope here | Unblocks when |
|---|---|---|
| `@redesigner/daemon` | Brief §154–156 leaves protocol / port / HMR-watch open. Plugin reserves the daemon option contract now (§6.1); behavior activates when the daemon package is installed. | Daemon spec drafted + approved. |
| `@redesigner/mcp` shim | Requires daemon. | Daemon spec complete. |
| Chrome extension | Requires daemon WS protocol; brief §128 sequences it last. | Daemon + MCP both complete. |
| `@redesigner/cli` (`init`) | Writes `.mcp.json` + Vite config snippet. | MCP spec + extension ID allocation. |
| Runtime props, fiber traversal, Vue/Svelte/Next adapters, DevTools panel, extension chat UI, persistence UI, OpenAI backend, variation flows | Explicitly post-v0 per brief §141–150. | Post-v0. |
| SWC plugin wrapper | Deferred per brief. `core/` helpers are framework-agnostic; the enclosing-component resolver is Babel-coupled. | User ask post-v0. |
| **SSR / RSC / isomorphic-hydration support** | DOM-attribution assumes client-only rendering. v0 no-ops on any non-client Vite environment; the playground is a client-only SPA. Hydration-safe DOM attribution is a post-v0 design. | Dedicated SSR spec. |
| **Vite 8 + `@vitejs/plugin-react` v6 (oxc pipeline)** | Unreleased/in-flight at spec time. The "independent Babel pass" architecture is already oxc-compatible in principle, but validating requires an integration cell that doesn't exist yet. Peer range for v0 is `^5 || ^6 || ^7` and `@vitejs/plugin-react ^4 || ^5`. Widening is a deliberate follow-up once a Vite 8 + plugin-react v6 integration test passes. | Vite 8 stable + plugin-react v6 stable. |
| **Daemon-survives-dev-server-restart** | The daemon lifetime is bound to the Vite process lifetime by design — `detached: false` and the pipe-drain model require it. A persistent daemon across restarts would reverse this contract. | Explicit future spec. |

### 1.3 Rationale for the slice

Brief §119–128 walks each upstream dependency forward one step at a time. Step 1 is "Vite plugin against the playground — verify `data-redesigner-loc` appears on rendered DOM elements." That is the smallest end-to-end testable unit with no external dependencies. Every downstream piece assumes this layer is solid.

### 1.4 Validation gate

This spec is complete when all of the following pass:

1. Unit tests green across the CI matrix (Ubuntu 24.04 + Windows Server 2022, Node 20.11.0 + Node 22).
2. Fixture tests green, covering every case in §8.2 (including `ref-as-prop/`, `fragment-noop/`, `wrapper-components-noop/`, `wrapper-components-react19/` (Activity, ViewTransition, Offscreen), `module-scope-jsx/`, `environment-skip/`, `clone-element/`, `compiler-hoist-order/`).
3. Integration tests green, including HMR (lower-bound update count + stable final-state; Fast-Refresh state preservation AND registration stability; two-file cascade), environment-skip, React-Compiler compat, shutdown (POSIX + Windows paths), and re-init tests.
4. Full CI matrix green. A committed **GitHub ruleset** (`.github/rulesets/main-protection.json`) is synced to GitHub by the `sync-ruleset.yml` workflow (§4.3) and names the Windows-Server-2022 + Node 22 job as a required status check.
5. Playground renders with `data-redesigner-loc` on every rendered **host-element** JSX node, with no React runtime warnings. Wrapper components (Fragment, Suspense, ErrorBoundary, Profiler, StrictMode, Activity, ViewTransition, Offscreen) and the module-scope `(module)` synthetic are NOT expected to carry DOM attributes — the synthetic exists in the manifest only, for tooling introspection.
6. `.redesigner/manifest.json` validates against the shipped JSON Schema and `schemaVersion` is set to `"1.0"`.
7. Manual dogfood: open playground in Chrome DevTools, inspect any rendered host element, confirm `data-redesigner-loc="src/...:line:col"` points to the real source. The `(module)` synthetic does NOT appear as a DOM attribute — this is by design, not a bug.

---

## 2. Premises fixed

Bound choices from brainstorming + three rounds of panel review:

- **React 19 only.** React 18 deferred. React Compiler 1.0 compatibility is required (§8 integration test).
- **Automatic JSX runtime only.** Classic runtime is a hard startup error. Detection precedence: `config.esbuild?.jsx` (authoritative) → `@vitejs/plugin-react` config → tsconfig (hint only). The thrown error message suggests the fix: "set `esbuild.jsx: 'automatic'` in vite.config, or update plugin-react to use the automatic runtime."
- **`@vitejs/plugin-react` is the default companion,** but the plugin is independent — our Babel pass is self-contained, runs `enforce: 'pre'`, and does NOT consult the user's `babel.config.*` / `.babelrc` (`configFile: false`, `babelrc: false`).
- **Client-only rendering.** Any non-client Vite environment (SSR, RSC, worker) is skipped. SSR/RSC/hydration support is post-v0.
- **pnpm workspaces** via Corepack (≥0.31.0). Biome for lint/format. `.npmrc` sets `engine-strict=true` so `engines.pnpm` is enforced.
- **Dev-only transform** (`apply: 'serve'`). `vite build` is a no-op by default.
- **Project-relative paths, posix separators** in every artifact that reaches the DOM or the manifest.
- **DOM-queryable loc is the reason we exist.** `jsxDEV` threads `__source` through React element internals; that field is not visible to a Chrome extension inspecting arbitrary DOM, and is not stable across React majors. A DOM-persisted attribute is the minimal additive claim.
- **Daemon lifetime = Vite process lifetime.** `detached: false`, pipe-drain, platform-aware teardown. A persistent daemon across restarts would reverse the spawn contract and is explicitly post-v0 (documented in §1.2).
- **Codename `redesigner`.** Rename cost at naming time is accepted.
- **Minimum Node 20.11.0.** Enforced via `engines` + `engine-strict=true`.

---

## 3. Architecture

### 3.1 High-level structure

```
                                   ┌──────────────────────┐
                                   │ examples/playground/ │
                                   │   React 19 + Vite    │
                                   └──────────┬───────────┘
                                              │ vite dev (client env only)
                                              ▼
                 ┌────────────────────────────────────────────────┐
                 │            @redesigner/vite                    │
                 │                                                │
                 │  ┌──────────────────┐   ┌──────────────────┐   │
                 │  │  Vite plugin     │   │  Babel plugin    │   │
                 │  │  entry           │──►│  (babel-coupled) │   │
                 │  │  (enforce:'pre') │   │  configFile:false│   │
                 │  └────────┬─────────┘   └────────┬─────────┘   │
                 │           │ invokes via           │ per-file    │
                 │           │ @babel/core in        │ transform-  │
                 │           │ transform hook        │ local batch │
                 │           ▼                      ▼             │
                 │  ┌──────────────────┐   ┌──────────────────┐   │
                 │  │ Daemon bridge    │   │ Manifest         │   │
                 │  │ (dynamic import, │   │ aggregator       │   │
                 │  │ drain pipes,     │   │ (immutable CAS   │   │
                 │  │ platform-aware   │   │ + post-flush     │   │
                 │  │ teardown,        │   │ re-check, same-  │   │
                 │  │ returns pid)     │   │ dir temp, 7-step │   │
                 │  │                  │   │ backoff retry,   │   │
                 │  │                  │   │ startup sweep,   │   │
                 │  │                  │   │ collision throw) │   │
                 │  └──────────────────┘   └────────┬─────────┘   │
                 │                                  │ atomic      │
                 │                                  │ write +     │
                 │                                  │ contentHash │
                 │                                  ▼             │
                 │                         .redesigner/manifest.json
                 └────────────────────────────────────────────────┘
```

### 3.2 Layers, top to bottom

1. **Vite plugin entry** — owns Vite lifecycle hooks (`configResolved`, `configureServer`, `closeBundle`, `server.close`, `buildEnd`). Loads options, resolves project root, detects the JSX runtime, instantiates the manifest writer, attempts daemon bridge, orchestrates teardown (§5.4). **State is client-only by design.** The plugin does NOT opt into `perEnvironmentStartEndDuringDev`; `buildEnd` forced-flush is scoped to the client environment only. A second environment instance does not re-initialize the writer (unit-tested).

2. **Babel plugin (babel-coupled)** — Babel visitor. `core/` contains framework-agnostic helpers. `babel/resolveEnclosingComponent.ts` reasons over Babel AST node types. Invoked via `@babel/core.transformAsync` with `configFile: false`, `babelrc: false`, `sourceMaps: true`, `inputSourceMap: true`.

3. **Manifest aggregator** — collects `componentKey → ComponentRecord` and `loc → LocRecord` entries from transform-local batches. **Transform-local batch semantics:** each Babel pass builds its per-file batch synchronously; commits via `writer.commitFile(relPath, batch)` — a single compare-and-swap replacing `state.get(relPath)` with `batch`. No mutex, no contention, no deadlock.
   - **Post-flush re-check.** After every successful flush, the aggregator compares the current immutable-state identity to the snapshot it wrote. If identity differs, it immediately re-schedules a flush.
   - **Debounce semantics:** 200 ms debounce, 1000 ms maxWait, **maxWait measured from the first commit since the last successful flush** (not from the last commit). Trailing edge only.
   - **Forced initial flush** after `configureServer` on the client environment's `buildEnd` or first idle tick.
   - **Platform-aware atomic write:** temp file always in the same directory as target (`.redesigner/manifest.json.tmp-<pid>-<rand>`).
   - **Exponential-backoff retry on `EPERM`/`EBUSY`** (Windows Defender / Search Indexer / concurrent reads): **7 attempts, delays `50, 100, 200, 400, 800, 1600, 3200 ms` (~6.35 s ceiling)**. Covers the documented Windows-Defender full-scan window. On final failure, log and continue (old manifest remains valid).
   - **Startup tmp sweep.** Writer constructor runs `readdir` on the manifest directory and unlinks any `manifest.json.tmp-*` files left over from a prior SIGKILL'd run.
   - **`mkdirSync(dirname(manifestPath), { recursive: true })`** before first write.
   - **Cross-instance collision is a config error, not a runtime race.** If a second plugin instance resolves to the same `manifestPath`, the SECOND instance throws from `configResolved` with an actionable message ("two dev servers targeting the same manifestPath — pass distinct `options.manifestPath` or separate `config.root`"). First-come-first-serve lockfile is detected via an exclusive-flag lock file at construction; `proper-lockfile` is NOT a runtime dependency. This eliminates a runtime-race surface in exchange for a loud setup-time error.
   - **Internal-only test hooks:** `onFlush(seq: number): Promise<void>` and `quiesce(): Promise<void>`. `quiesce` forces a flush and resolves after it lands — decoupled from debounce/maxWait tuning.

4. **Daemon bridge** — optional. Dynamic `import('@redesigner/daemon')` via an **injectable importer function**. Discriminated `try/catch`: `ERR_MODULE_NOT_FOUND` | `ERR_PACKAGE_PATH_NOT_EXPORTED` are quiet-warn, any other error is loud-warn (via `config.logger.warn` with stack — NOT `.error`, avoiding red-output desensitization) and non-fatal.
   - **`startDaemon()` contract.** The daemon package MUST export `startDaemon({ manifestPath, port }): Promise<DaemonHandle>` where `DaemonHandle = { pid: number; shutdown(): Promise<void>; stdout: Readable; stdin: Writable; stderr: Readable }`. `pid` is the top-level spawned process (daemon MUST NOT double-fork on Windows, so `taskkill /T` walks its tree correctly). A missing `stdin` pipe is a contract violation → throw.
   - **Pipe drain required.** Immediately after `startDaemon` resolves, the bridge wires `handle.stdout.on('data', ...)` + `handle.stderr.on('data', ...)` to `config.logger.info` / `.warn`. Unread pipe buffers fill at ~64 KB and block the child.
   - **Spawn flags** (inside the daemon's own `startDaemon` implementation — contracted, not implemented here): `detached: false`, `stdio: ['pipe', 'pipe', 'pipe']`.
   - **Platform-aware teardown** (§5.4): POSIX = SIGTERM → 2 s → SIGKILL. Windows = stdin graceful message (JSON-line) → daemon acknowledges via stdout (handshake) → 2 s → `taskkill /T /F /PID <handle.pid>`.
   - **Teardown registration.** Routed through a single idempotent `shutdown()`: `server.close`, `SIGINT`, `SIGTERM`. **`SIGHUP` registered only on non-Windows** (per nodejs/node#10165, Windows registration can deadlock `CTRL_CLOSE_EVENT`). **`beforeExit` is NOT registered** (never fires with live daemon). `uncaughtException` / `unhandledRejection` trigger teardown then re-throw.

### 3.3 Key design invariants

1. **Environment-aware transform.** On each `transform(code, id, options)` invocation: check `this.environment?.name` (Vite 6+); skip unless `'client'`. Fall back to `options?.ssr === true` being the skip condition on Vite 5. The plugin instance MAY be reused across environments; state is keyed to the client environment.

2. **Independent Babel pass.** `enforce: 'pre'` + `@babel/core.transformAsync({ sourceMaps: true, inputSourceMap: true, configFile: false, babelrc: false })`. Returns `{ code: result.code, map: result.map }` explicitly. Unit test asserts user's `babel.config.js` is NOT consulted.

3. **Scoped "core" vs. Babel coupling.** `core/` = zero AST/framework deps. `babel/resolveEnclosingComponent.ts` reasons over Babel node types.

4. **Compile-time component resolution.** Walks from each JSX node to its enclosing component (function/class/arrow; unwraps `memo` + legacy `forwardRef`). Ref-as-prop (React 19 idiom) resolves like any function component. Third-party HOCs keep the assignment-target name.

5. **Lazy manifest + bounded-staleness cold start.** Manifest grows as Vite transforms files. Forced flush scheduled on client `buildEnd` or first idle tick.

6. **Fresh state on every start.** Writer constructor: (a) `mkdirSync(recursive: true)`, (b) startup tmp sweep, (c) overwrite with empty manifest (`schemaVersion: "1.0"`, empty components + locs, initial `contentHash`). Atomic same-dir rename with retry.

7. **One-way flow: memory → disk.** Writer never reads `manifest.json` back.

8. **Per-file batch replace + post-flush re-check.** `writer.commitFile(relPath, batch)` takes the full new set for that file. Post-flush identity re-check closes the "commit during rename" race.

9. **Wrapper components get no attribute.** Skip list (in `core/wrapperComponents.ts`):
   - `JSXFragment` (`<>...</>`) — always skipped.
   - React built-ins that warn on unknown host-attr props: `React.Fragment`, `Fragment`, `Suspense`, `Profiler`, `StrictMode`, `Activity` (React 19.2), `ViewTransition` (React 19.2), `Offscreen` (legacy/experimental).
   - Userland convention (heuristic; name-only match, not import-resolved, since there is no canonical React export): `ErrorBoundary`. Commented in `core/wrapperComponents.ts` that this is the one heuristic entry; consumers who name a non-wrapper class `ErrorBoundary` accept the skip.
   - The skip list identifies wrappers via the JSX opening name resolved to its import declaration, covering aliases (`import { Fragment as F }`).
   - Ambiguous dynamic identity (`React[x]`) → inject and accept the potential runtime warning; documented as a known edge.
   - Children of Fragments/wrappers are visited normally.

10. **Module-scope JSX is attributed to `(module)`.** JSX at module scope (no enclosing function) is attributed to a synthetic component `componentName: "(module)"`, `componentKey: relPath + '::' + '(module)'`. **This is a manifest-only attribution** — the JSX being described IS the mount call (e.g., `createRoot(root).render(<App />)`), and its host-element subtree is attributed under `App`, not under the synthetic. The `(module)` entry exists for tooling introspection ("what JSX lives at module scope?"), NOT for Chrome-extension DOM hit-testing. Documented as such in the validation gate (§1.4 item 7) and in `core/types-public.ts` JSDoc.

11. **Dead-code JSX is strictly literal-false.** `{false && <X />}` and literal-null/false guards are skipped. Reachability analysis past `use(promise)` or runtime guards is NOT attempted.

12. **User may not declare a component named `(module)`.** The Babel visitor rejects user-declared component identifiers matching `/^\(module\)$/` with a clear `"(module)" is a reserved synthetic component name` error. Documented in README.

---

## 4. Package + module layout

```
redesigner/                           (repo root, pnpm workspace)
├── package.json                      ("packageManager": "pnpm@9.15.4", engines)
├── pnpm-workspace.yaml
├── .npmrc                            (engine-strict=true, package-manager-strict=true)
├── biome.json                        (noFocusedTests=error, noSkippedTests=error)
├── tsconfig.base.json
├── .gitignore
├── .editorconfig
├── README.md
├── CONTRIBUTING.md                   (Corepack ≥0.31.0 setup; proxy/MITM env vars; Husky/simple-git-hooks choice; ruleset sync owner = maintainers on main)
├── .husky/
│   └── pre-commit                    (fixture-gate + Biome check)
├── .github/
│   ├── scripts/
│   │   └── sync-rulesets.mjs         (GitHub REST: POST on first create, PUT on update, drift-check on schedule)
│   ├── workflows/
│   │   ├── ci.yml                    (matrix + concurrency + pnpm store cache via `pnpm store path` + 15-min timeout + artifact upload on failure)
│   │   └── sync-ruleset.yml          (on push to main when .github/rulesets/** changes; uses PAT; drift-check on schedule)
│   └── rulesets/
│       └── main-protection.json      (names "ci / test (windows-2022, 22)" as required status check)
│
├── packages/
│   └── vite/                         → @redesigner/vite
│       ├── package.json              ("private": true for v0; "publishConfig": { "access": "restricted" })
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       ├── scripts/
│       │   └── generate-schema.ts
│       ├── src/
│       │   ├── index.ts              (default export: redesigner factory; named re-exports from types-public)
│       │   ├── reader.ts             (canonical readManifest(path) helper; subpath-exported)
│       │   ├── core/
│       │   │   ├── locFormat.ts
│       │   │   ├── pathGuards.ts     (toPosixProjectRoot normalizes; never rejects Windows-native)
│       │   │   ├── wrapperComponents.ts  (Fragment/Suspense/Profiler/StrictMode/Activity/ViewTransition/Offscreen + ErrorBoundary heuristic)
│       │   │   ├── manifestSchema.ts
│       │   │   ├── types-public.ts   (Manifest, ComponentRecord, LocRecord, RedesignerOptions — stable surface; JSDoc includes consumer-read algorithm)
│       │   │   └── types-internal.ts (NOT re-exported)
│       │   ├── babel/
│       │   │   ├── plugin.ts
│       │   │   └── resolveEnclosingComponent.ts
│       │   ├── integration/
│       │   │   ├── manifestWriter.ts (7-step backoff; startup sweep; collision detection at construction; post-flush re-check; contentHash)
│       │   │   ├── daemonBridge.ts   (injectable importer; pipe drain; SIGHUP POSIX-only; no beforeExit; handshake stdin ack for Windows)
│       │   │   └── runtimeDetect.ts
│       │   └── plugin.ts
│       ├── test/
│       │   ├── fixtures/
│       │   │   ├── README.md
│       │   │   ├── FIXTURE_CHANGELOG.md
│       │   │   ├── _runner.test.ts
│       │   │   ├── default-export/
│       │   │   ├── named-exports/
│       │   │   ├── memo-wrapped/
│       │   │   ├── forwardRef-wrapped/
│       │   │   ├── ref-as-prop/                  (README notes: our attr is sibling of ref; neither affects the other)
│       │   │   ├── arrow-const/
│       │   │   ├── anonymous-default/
│       │   │   ├── inline-jsx-in-callback/
│       │   │   ├── hoc-wrapped/
│       │   │   ├── fragment-noop/
│       │   │   ├── wrapper-components-noop/       (Suspense/Profiler/StrictMode)
│       │   │   ├── wrapper-components-react19/    (Activity/ViewTransition/Offscreen)
│       │   │   ├── module-scope-jsx/
│       │   │   ├── environment-skip/
│       │   │   ├── clone-element/
│       │   │   ├── compiler-hoist-order/
│       │   │   ├── children-as-function/
│       │   │   ├── malformed-jsx/
│       │   │   ├── pathological-node/
│       │   │   ├── dead-code-jsx/
│       │   │   ├── unicode-filename/
│       │   │   ├── filename with spaces/
│       │   │   └── reserved-module-name/          (asserts user-declared `(module)` throws)
│       │   ├── unit/
│       │   │   ├── locFormat.test.ts              (fast-check Arbitrary: fc.string with minLength 1 filtered to exclude newlines and control characters; colon filter redundant since relPaths never contain colons)
│       │   │   ├── resolveEnclosingComponent.test.ts
│       │   │   ├── pathGuards.test.ts             (asserts Windows-native paths normalize, do not throw)
│       │   │   ├── runtimeDetect.test.ts
│       │   │   ├── wrapperComponents.test.ts
│       │   │   ├── plugin.test.ts                 (asserts user's babel.config.js is NOT consulted; environment re-init asserts writer is not double-initialized)
│       │   │   ├── manifestWriter.test.ts         (7-step exponential-backoff on mock EPERM/EBUSY; mkdir-p; startup tmp sweep; post-flush re-check; collision throws at construction; batch replace CAS; contentHash stability)
│       │   │   └── daemonBridge.test.ts
│       │   ├── integration/
│       │   │   ├── vite.test.ts
│       │   │   ├── manifest.test.ts
│       │   │   ├── hmr.test.ts
│       │   │   ├── fast-refresh.test.ts           (state preservation AND registration stability; see §8.3)
│       │   │   ├── environment-skip.test.ts
│       │   │   ├── react-compiler.test.ts
│       │   │   ├── sourcemap.test.ts
│       │   │   ├── reinit.test.ts
│       │   │   ├── parallelism.test.ts            (runs ONLY under a dedicated config file; see §8.3)
│       │   │   ├── degradation.test.ts
│       │   │   ├── daemon-real.test.ts
│       │   │   ├── hydration-safety.test.ts
│       │   │   └── shutdown.test.ts
│       │   └── vitest.parallelism.config.ts       (pool: 'forks', isolate: true, fileParallelism: false; invoked via `pnpm test:parallelism` script)
│       └── README.md
│
└── examples/
    └── playground/                   (not published; "private": true)
        ├── package.json
        ├── vite.config.ts
        ├── tsconfig.json
        ├── vite-env.d.ts
        ├── index.html
        └── src/
            ├── main.tsx                       (module-scope render → `(module)` manifest entry only; App subtree attributed under App)
            ├── App.tsx                        (renders every edge/* case; all actually reached in DOM)
            ├── components/
            │   ├── Button.tsx
            │   ├── PricingCard.tsx
            │   ├── PricingSection.tsx
            │   ├── Modal.tsx
            │   ├── DataFetcher.tsx            (children-as-function; actually invoked)
            │   └── edge/
            │       ├── MemoWrapped.tsx
            │       ├── ForwardRefWrapped.tsx
            │       ├── RefAsProp.tsx
            │       ├── MultiComponentFile.tsx
            │       ├── AnonymousDefault.tsx
            │       ├── WithCallback.tsx
            │       ├── WithWrappers.tsx       (Suspense / ErrorBoundary / Profiler / StrictMode in real render tree)
            │       ├── WithReact19Wrappers.tsx (Activity, ViewTransition)
            │       └── CloneElementDemo.tsx
            └── styles/
                ├── app.module.css
                └── index.css                  (Tailwind v4 via @tailwindcss/vite)
```

### 4.1 Layout notes

- **Public API surface:** `index.ts` (factory + named re-exports) + `reader.ts` (canonical read helper, subpath-exported as `@redesigner/vite/reader`). No `export *`.
- **`core/` = zero-dep; `babel/` = Babel-coupled; `integration/` = stateful/IO.**
- **Fixture `--update` gate** is enforced at THREE levels: (a) local: Husky `pre-commit` hook + `simple-git-hooks` alternative in `CONTRIBUTING.md`; (b) CI: `REDESIGNER_FIXTURE_UPDATE` unset check + `git diff --name-only origin/main...HEAD` (three-dot; catches multi-commit PRs) requiring a `FIXTURE_CHANGELOG.md` entry alongside any `output.tsx` / `expected-manifest.json` change; (c) Biome enforces `noFocusedTests=error` + `noSkippedTests=error`.
- **Per-directory non-empty assertion** (replacing fragile test-file count): CI asserts `unit/`, `fixtures/`, and `integration/` each contain ≥1 matching test file.
- **Fixtures vs. playground edge cases are distinct on purpose.**
- **Playground `edge/*` are all actually rendered** from `App.tsx` with real data (including `DataFetcher` invoked with a non-mocked source, `MultiComponentFile` both exports used).
- **`manifestWriter.ts`** exposes internal-only `onFlush` + `quiesce` + a `forceFlush()` test hook called by `quiesce` (decoupled from debounce timing so test behavior is stable across debounce tuning).
- **`daemonBridge.ts`** accepts an injected importer. Production wiring: `(() => import('@redesigner/daemon'))`.

### 4.2 Build toolchain

- **Bundler: `tsup`** → `dist/index.js`, `dist/reader.js`, `dist/index.d.ts`, `dist/reader.d.ts` (ESM-only).
- **Schema generation:** `ts-json-schema-generator` → `dist/manifest-schema.json`.
- **Scripts:**
  ```json
  {
    "scripts": {
      "build": "pnpm run build:schema && tsup",
      "build:schema": "tsx scripts/generate-schema.ts",
      "typecheck": "tsc --noEmit",
      "test": "vitest run",
      "test:fixtures": "vitest run test/fixtures",
      "test:parallelism": "vitest run --config test/vitest.parallelism.config.ts",
      "lint": "biome check ."
    }
  }
  ```
- **Prepublish guard.** `prepublishOnly` runs `build + typecheck + test`; `"private": true` is the authoritative escape hatch for v0 — registry rejects.

### 4.3 CI + ruleset workflow sketch

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2022]
        node: ['20.11.0', '22']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # three-dot diff requires full history
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - name: Corepack preflight
        shell: bash
        run: |
          # Node 20.11.0 ships Corepack 0.24; 0.31+ required for current key rotation
          if [ "${{ matrix.node }}" = "20.11.0" ]; then
            npm install -g corepack@latest
          fi
          # Shell-native version check (no child_process): require major>=1 OR (major=0 AND minor>=31)
          V=$(corepack --version)
          MAJOR=$(echo "$V" | cut -d. -f1)
          MINOR=$(echo "$V" | cut -d. -f2)
          if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 31 ]; then
            echo "Corepack $V is below 0.31.0 (required for current key rotation)"
            exit 1
          fi
          corepack enable
      - name: Resolve pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          key: pnpm-${{ matrix.os }}-${{ matrix.node }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm install --frozen-lockfile --strict-peer-dependencies
      - run: pnpm -r run lint
      - run: pnpm -r run typecheck
      - run: pnpm -r run test
      - run: pnpm --filter @redesigner/vite run test:parallelism
      - name: Fixture update guard (three-dot diff for multi-commit PRs)
        shell: bash
        run: |
          test -z "$REDESIGNER_FIXTURE_UPDATE" || (echo "REDESIGNER_FIXTURE_UPDATE set in CI" && exit 1)
          base="${{ github.event.pull_request.base.sha || 'origin/main' }}"
          changed=$(git diff --name-only "$base"...HEAD || true)
          if echo "$changed" | grep -qE 'test/fixtures/.+/(output\.tsx|expected-manifest\.json)$'; then
            echo "$changed" | grep -q 'test/fixtures/FIXTURE_CHANGELOG.md' || { echo "fixture changed without FIXTURE_CHANGELOG.md entry"; exit 1; }
          fi
      - name: No .only / .skip (belt + Biome rule)
        shell: bash
        run: |
          ! git grep -En '\b(describe|it|test)\.(only|skip)\b' -- 'packages/*/test' || exit 1
      - name: Upload failure artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: failure-${{ matrix.os }}-${{ matrix.node }}
          path: |
            packages/vite/test/**/*.log
            **/.redesigner/manifest.json*
```

```yaml
# .github/workflows/sync-ruleset.yml
name: sync-ruleset
on:
  push:
    branches: [main]
    paths: ['.github/rulesets/**']
  schedule:
    - cron: '0 6 * * *'   # daily drift-check
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-24.04
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
      - name: Sync / detect drift
        env:
          # PAT with "repo" scope; default GITHUB_TOKEN cannot modify rulesets
          GH_TOKEN: ${{ secrets.RULESET_PAT }}
        run: |
          node .github/scripts/sync-rulesets.mjs \
            --mode=${{ github.event_name == 'schedule' && 'drift-check' || 'sync' }}
```

The sync script (`.github/scripts/sync-rulesets.mjs`) uses POST `/repos/.../rulesets` for first-time create, PUT `/repos/.../rulesets/{id}` for updates (looked up by ruleset name), and in drift-check mode fetches the live ruleset and diffs against the committed JSON — failing the job on drift. Documented owner: repo maintainers on `main`. Fork PRs that modify `.github/rulesets/**` surface a friendly comment via a separate PR-scoped workflow, but do not attempt sync (no PAT access on forks).

---

## 5. Data flow

### 5.1 Cold start

```
vite dev invoked
    │
    ▼
Vite loads vite.config.ts → calls redesigner() factory → gets plugin object
    │
    ▼
Vite fires configResolved(config)
    │  • Capture config.logger.
    │  • toPosixProjectRoot(config.root) → normalized projectRoot (throws only on unnormalizable input)
    │  • Resolve manifestPath = path.posix.resolve(projectRoot, options.manifestPath ?? '.redesigner/manifest.json')
    │      → reject if resolved path escapes projectRoot
    │  • runtimeDetect precedence: esbuild.jsx → plugin-react → tsconfig (hint only). Classic (authoritative) → throw with fix suggestion.
    │  • ManifestWriter(projectRoot, manifestPath, options, clock):
    │      - mkdirSync(dirname(manifestPath), { recursive: true })
    │      - **Cross-instance collision check.** Attempt an exclusive-flag open of `manifestPath + '.owner-lock'`. If already present, throw with actionable message.
    │      - startup tmp sweep: unlink `manifest.json.tmp-*`
    │      - overwrite manifest.json with empty manifest
    │
    ▼
Vite fires configureServer(server)
    │  • If options.daemon.mode === 'off': daemonHandle = null, skip.
    │  • Else ('auto' | 'required'): await importer()
    │       ├─ ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED:
    │       │    • 'required' → throw with actionable message
    │       │    • 'auto' → logger.warn once; daemonHandle = null
    │       ├─ other error → logger.warn with stack; daemonHandle = null; CONTINUE
    │       └─ success → await mod.startDaemon({ manifestPath, port: options.daemon.port ?? 0 })
    │                   → validate handle contract (pid, shutdown, stdout, stdin, stderr) — throw if violated
    │                   → wire pipe-drain immediately
    │  • Register teardown: server.close, SIGINT, SIGTERM
    │      + if (process.platform !== 'win32') process.on('SIGHUP', shutdown)
    │      + uncaughtException / unhandledRejection → shutdown then re-throw
    │      (NOT beforeExit)
    ▼
Schedule forced initial flush on client environment's buildEnd or first idle tick → writer.quiesce()
    ▼
Dev server listens
```

### 5.2 Per-transform

```
Vite calls transform(code, id, options) on our plugin (enforce: 'pre')
    │
    ▼
Environment-aware skip:
    if this.environment && this.environment.name !== 'client': return undefined
    else if options?.ssr === true: return undefined
    │
    ▼
Filter: id matches include/exclude globs and ends in .jsx or .tsx
    ▼
toPosixRelative(id, projectRoot) → relPath  (on failure: logger.warn once per file; return undefined)
    ▼
Build empty transform-local batch
    │
    ▼
@babel/core.transformAsync(code, {
    plugins: [redesignerBabelPlugin({ relPath, batch })],
    sourceMaps: true,
    inputSourceMap: true,
    configFile: false,
    babelrc: false
})
    │
    ▼
Babel visitor:
    │  1. JSXFragment: skip (children visited).
    │  2. JSXOpeningElement / JSXSelfClosingElement:
    │     a. If name resolves to wrapperComponents list → skip injection (children visited).
    │     b. Else: per-case try/catch; inject attribute.
    │  3. Walk to enclosing component:
    │     • memo / legacy forwardRef unwrap
    │     • ref-as-prop: normal function component
    │     • anonymous default → PascalCase(basename(relPath))
    │     • JSX in non-component helper → outer component
    │     • module-scope JSX → synthetic (module) component (MANIFEST-ONLY; not DOM-tagged)
    │     • Literal-false guarded → skip
    │     • Third-party HOCs → assignment name
    │     • User-declared `(module)` → throw "reserved synthetic name"
    │  4. componentKey = relPath + '::' + componentName  (stable wire format; documented in JSON Schema)
    │  5. locString = formatLoc(relPath, line, col)
    │  6. Register in batch
    │  7. Inject <jsx-element data-redesigner-loc="..." ...>
    ▼
Babel returns { code, map }
    │
    ▼
Vite plugin returns { code, map } (explicit; not bare string)
    ▼
writer.commitFile(relPath, batch):
    │  newState = state.set(relPath, batch)   (CAS per-file replace)
    │  Schedule debounced flush (200 ms, maxWait 1000 ms from first commit)
    ▼
plugin-react receives { code, map }.
    ▼
Browser renders; data-redesigner-loc on host elements.
```

### 5.3 HMR

```
User edits file. Vite invalidates; affected files re-run transform().
Each re-transformed file → writer.commitFile(relPath, freshBatch).
Debounced flush fires → atomic same-dir rename (with 7-step backoff retry if needed).
Post-flush re-check: if state identity changed since snapshot, reschedule.
Vite HMR pushes update; React re-mounts (Fast Refresh preserves state for eligible edits).
```

### 5.4 Shutdown

All paths → idempotent `shutdown()`. Registered on: `server.close`, `SIGINT`, `SIGTERM`; + `SIGHUP` only on non-Windows; + `uncaughtException` / `unhandledRejection` (re-throw after teardown). NOT `beforeExit`.

```
shutdown() — idempotency flag
    │
    ▼
1. writer.flushSync() — fs.writeFileSync + try/catch;
       on EBUSY/EPERM: 7-step backoff (50,100,200,400,800,1600,3200 ms = ~6.35 s)
       on final failure: console.error
    │
    ▼
2. If daemonHandle: daemonHandle.shutdown() — platform-branched:
       │
       ├─ POSIX: SIGTERM → 2 s → SIGKILL + logger.warn
       │
       └─ Windows:
             write { "op": "shutdown" }\n to handle.stdin
             await "ack" on handle.stdout (line-delimited JSON) with 500 ms timeout
             if acked → await exit up to 1.5 s
             if no ack OR no exit: taskkill /T /F /PID ${handle.pid}
             if taskkill non-zero: logger.warn
             (absence of stdin pipe was rejected at startup per §3.2)
```

---

## 6. Public API surface

### 6.1 Entry point

```ts
// packages/vite/src/index.ts
import type { Plugin } from 'vite'

export interface DaemonOptions {
  mode?: 'auto' | 'required' | 'off'     // default: 'auto'
  port?: number                           // default: 0 (OS-assigned)
}

export interface RedesignerOptions {
  manifestPath?: string                   // relative to projectRoot; absolute & escaping rejected
  include?: string[]                      // default: ['**/*.{jsx,tsx}']
  exclude?: string[]                      // default: ['node_modules/**', '**/*.d.ts']
  enabled?: boolean                       // default: true in dev, false in build
  daemon?: DaemonOptions | 'auto' | 'required' | 'off'  // string shorthand for { mode }
}

export default function redesigner(options?: RedesignerOptions): Plugin

// Explicit named re-exports (stable public surface):
export type { Manifest, ComponentRecord, LocRecord, RedesignerOptions, DaemonOptions }
```

```ts
// packages/vite/src/reader.ts — subpath-exported as '@redesigner/vite/reader'
import type { Manifest } from './core/types-public'
export async function readManifest(
  manifestPath: string,
  opts?: { expectedMajor?: number; maxRetries?: number; retryDelayMs?: number }
): Promise<Manifest>
```

The reader helper implements the canonical algorithm (§6.6): read + parse + retry-once on parse failure + version-check + schema-validate. Third-party readers can use it directly or re-implement from the documented algorithm.

`daemon` options — nesting now prevents v1 sprawl. String shorthand (`daemon: 'off'`) keeps the common case one line.

### 6.2 User-facing usage

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import redesigner from '@redesigner/vite'

export default defineConfig({
  plugins: [react(), redesigner()],
})
```

Position does not matter relative to non-`enforce` plugins. With another `enforce: 'pre'` plugin that transforms JSX/TSX, declaration order governs — README recommends declaring `redesigner()` first. Tailwind v4's `@tailwindcss/vite` operates on CSS; no ordering concern.

### 6.3 Manifest shape

```ts
// packages/vite/src/core/types-public.ts

/** @see §6.6 for the consumer read algorithm; @redesigner/vite/reader implements it. */
export type SchemaVersion = '1.0'   // union of known versions; bump deliberately on each release

export interface Manifest {
  schemaVersion: SchemaVersion
  framework: string                       // 'react' today; 'vue' etc. are additive (minor-bump) future values
  generatedAt: string                     // ISO-8601 UTC; present for humans. Consumers wanting change-detection use contentHash.
  contentHash: string                     // sha256 of the serialized components+locs (excluding generatedAt + contentHash itself). Readers use this for change-detection without string compare.
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string                        // project-relative, posix separators
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  /**
   * Stable wire-format join key. Format is `<filePath>::<componentName>`.
   * The `::` separator is part of the documented schema; split on `::` is supported.
   * Changing the separator requires a major schema bump.
   */
  componentKey: string
  filePath: string
  componentName: string
}
```

**Schema version evolution rules (part of the contract):**

- `schemaVersion` is a union of known strings. Current: `'1.0'`. Bumping is a deliberate code change, not a runtime string construction — prevents accidental narrowing breakage.
- **Additive** (new optional field, new object entry, new `framework` value like `'vue'`) → minor bump, new union member added. Consumers MUST accept unknown fields.
- **Breaking** → major bump. Consumers MUST reject on major mismatch.
- Minor-ahead → warn but continue.

**`componentKey` format is STABLE under minor bumps.** Separator is `::`. Documented in the JSON Schema's `LocRecord.componentKey.pattern`. Consumers MAY split on `::`.

**`data-redesigner-loc` attribute VALUE format.** `"relPath:line:col"`. Colons in the value are HTML-legal. CSS attribute selectors against this value require standard attribute-selector value quoting (use `[data-redesigner-loc='...']` or the `\3A ` / `\:` escape); documented in `dist/reader-contract.md` with examples. Attribute NAME is lowercase with hyphens (HTML5 compliant).

**`projectRoot` intentionally absent from the schema** (leaks filesystem layout).

**No `$schema` URL in v0 manifests** (nothing published; URL would 404). Consumers locate the schema via `@redesigner/vite/manifest-schema.json`.

JSON Schema (`manifest-schema.json`, draft-2020-12) generated from `core/types-public.ts` via `ts-json-schema-generator`.

### 6.4 `package.json` essentials

```json
{
  "name": "@redesigner/vite",
  "version": "0.0.0",
  "private": true,
  "publishConfig": { "access": "restricted" },
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./reader": { "types": "./dist/reader.d.ts", "import": "./dist/reader.js" },
    "./manifest-schema.json": "./dist/manifest-schema.json"
  },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20.11.0" },
  "peerDependencies": {
    "vite": "^5 || ^6 || ^7",
    "@vitejs/plugin-react": "^4 || ^5"
  },
  "peerDependenciesMeta": {
    "@vitejs/plugin-react": { "optional": true }
  },
  "dependencies": {
    "@babel/core": "^7",
    "@babel/parser": "^7",
    "@babel/traverse": "^7",
    "@babel/types": "^7"
  },
  "devDependencies": {
    "tsup": "^8",
    "tsx": "^4",
    "ts-json-schema-generator": "^2",
    "fast-check": "^3",
    "vitest": "^2",
    "husky": "^9",
    "simple-git-hooks": "^2"
  }
}
```

Root `package.json`:
```json
{
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=20.11.0", "pnpm": ">=9.15" }
}
```

Root `.npmrc`:
```
engine-strict=true
package-manager-strict=true
```

Notes:

- **ESM-only.**
- **`"private": true` + `"publishConfig"`.** Accidental `npm publish` rejected.
- **`@redesigner/daemon` NOT in any deps field.** Users install explicitly.
- **Vite peer range `^5 || ^6 || ^7`.** Vite 8 + plugin-react v6 (oxc) are a deferred widening with a real integration test required first.
- **`@vitejs/plugin-react` peer `^4 || ^5`.** v6 (oxc-default) is the same deferred widening.
- **Corepack enforces `packageManager`.** Node 20.11.0 ships Corepack 0.24 — CI upgrades to `corepack@latest` on that matrix leg before `corepack enable`.
- **No `proper-lockfile` runtime dependency.** Cross-instance collision is detected at construction and thrown as a config error.

### 6.5 User-visible messages

All prefixed `[redesigner]`. Routed through `config.logger`.

| Severity | Example | When |
|---|---|---|
| `error` | "manifestPath escapes projectRoot" | `configResolved` |
| `error` | "classic JSX runtime detected (authoritative source); v0 requires automatic runtime. Set `esbuild.jsx: 'automatic'` in vite.config, or ensure plugin-react uses automatic." | `configResolved` |
| `error` | `daemon.mode === 'required'` but package missing | `configureServer` |
| `error` | Two plugin instances resolving to same manifestPath | `configResolved` (config error) |
| `error` | User-declared component named `(module)` | Babel visitor |
| `warn` | Daemon package not installed (`mode: 'auto'`) | Once; quiet |
| `warn` | Daemon `startDaemon()` threw on import | With stack; plugin continues |
| `warn` | Transform / path-guard error per file | Once per file |
| `warn` | Per-node visitor exception | With `file:line` |
| `warn` | Atomic rename failed after first disk-write attempt | **SEVERITY LADDER:** attempts 1–2 fail → `debug`; attempts 3–6 → `warn` (retry continuing); attempt 7 final failure → `error`. Aligns with "avoid red-output desensitization" principle. |
| `warn` | Shutdown flush retried after EBUSY | Once per shutdown |
| `info` | First successful manifest write | Once |
| `debug` | Per-transform timings; non-client environment skip; plugin-react absent; tsconfig-only classic runtime; initial disk-write attempts before retry | Behind `DEBUG=redesigner:*` |

### 6.6 Consumer reader contract

Published alongside the package as `dist/reader-contract.md`. Canonical algorithm:

1. **Open + parse** `manifestPath` as UTF-8 JSON.
2. **Parse failure** (rename-in-progress window): sleep 50 ms, retry once. Second failure → unavailable; poll.
3. **Validate** parsed JSON against `manifest-schema.json`.
4. **Version check:** parse `schemaVersion` into major + minor. Major mismatch with consumer's supported major → reject. Minor-ahead → warn + continue.
5. **Change detection:** use `contentHash` (sha256 of components+locs serialized, excluding `generatedAt` + `contentHash` itself). Do NOT use `generatedAt` for change detection — it rewrites on every flush even when content is unchanged.
6. **CSS selector escaping of `data-redesigner-loc` values.** Example: `[data-redesigner-loc='src/components/Button.tsx:12:4']` must quote the value (colons are legal inside an HTML attribute value but break unquoted CSS attribute selectors). `document.querySelector('[data-redesigner-loc="…"]')` is the safe pattern.
7. **Watch recommendation:** `fs.watch` fires reliably on POSIX after atomic rename but is flaky on Windows + SMB. Recommend poll (250–500 ms) as the safe default; `fs.watch` as an optimization on POSIX local FS.

`@redesigner/vite/reader` implements steps 1–5. Step 6 is a DOM-side concern. Step 7 is an operational recommendation.

---

## 7. Error handling & failure modes

| # | Trigger | Detected in | Handling | User sees | Test |
|---|---|---|---|---|---|
| 1 | `manifestPath` escapes projectRoot | `configResolved` | Throw | Fails to start | unit |
| 2 | `manifestPath` absolute | `configResolved` | Throw | Same | unit |
| 3 | projectRoot cannot be normalized | `configResolved` | Throw ("plugin bug — please report") | Fails to start | unit |
| 3b | Two plugin instances resolve to same manifestPath | `configResolved` (construction) | Throw with actionable message | Fails to start; one instance survives | unit |
| 4 | Classic JSX runtime (authoritative) | `configResolved` | Throw with fix suggestion | Fails to start | unit |
| 4b | Classic only in tsconfig; esbuild/plugin-react automatic | `configResolved` | `debug` log, proceed | None | unit |
| 5 | `@vitejs/plugin-react` absent, SWC present | `configResolved` | `debug` | None | integration |
| 6 | Daemon import → NOT_FOUND \| NOT_EXPORTED, `auto` | `configureServer` | `warn` once | Yellow one-line | unit + daemon-real |
| 6b | Same, `required` | `configureServer` | Throw | Fails to start | unit |
| 7 | Daemon import → other error | `configureServer` | `warn` with stack; continue | Yellow warning | unit |
| 7b | Daemon handle missing required pipes | `configureServer` | Throw (contract violation) | Fails to start | unit |
| 8 | Per-file path normalization fails | `transform` | `warn` once per file; skip visitor | Per-file warning | unit |
| 9 | Babel parser fails on whole file | `transform` | `warn`; return `undefined` | Per-file warning | fixture |
| 10 | Per-node visitor exception | Babel plugin | Per-case try/catch; `warn`; skip node | Per-node warning | fixture |
| 11 | Literal-false-guarded dead code | Babel plugin | Skip silently | None | fixture |
| 11b | JSX in non-component helper transitively within component | Babel plugin | Attribute to outer | None | fixture |
| 11c | JSX at module scope | Babel plugin | Synthetic `(module)` (manifest-only) | None | fixture |
| 11d | JSXFragment | Babel plugin | Skip; children visited | None | fixture |
| 11e | Wrapper component (Fragment/Suspense/Profiler/StrictMode/Activity/ViewTransition/Offscreen/ErrorBoundary) | Babel plugin | Skip; children visited | None | fixture |
| 11f | Ambiguous wrapper identity (`React[x]`) | Babel plugin | Inject; accept warning cost | Potential React warning | documented |
| 11g | User-declared component named `(module)` | Babel plugin | Throw | Fails transform of that file | fixture: `reserved-module-name/` |
| 12 | Writer state contention | `manifestWriter` | N/A — CAS + post-flush re-check | None | (design) |
| 12b | Overlapping re-transform | `manifestWriter` | Per-file replace wins | None | unit + parallelism |
| 12c | Commit during rename | `manifestWriter` | Post-flush re-check reschedules | None | unit |
| 13 | Disk write fails (EACCES/ENOSPC) | `manifestWriter` flush | Retry next debounce; severity ladder per §6.5 | Escalating severity | unit (mock fs) |
| 14 | Atomic rename fails EPERM/EBUSY | `manifestWriter` flush | **7-step exponential backoff (50/100/200/400/800/1600/3200 ms)** | Warning past retry threshold; error only on final failure | unit + CI matrix |
| 14b | EXDEV | `manifestWriter` flush | Should never occur; log `error` + paths if observed | Red error (plugin bug) | unit |
| 14c | Construction collision with existing `.owner-lock` | `ManifestWriter` constructor | Throw with actionable message | Fails to start | unit |
| 14d | Orphaned tmp files from prior crash | Constructor | Startup sweep unlinks | None | unit |
| 15 | Shutdown before debounce flush | shutdown() | Sync flush + 7-step backoff; fall back to console.error | None (clean) | integration |
| 16 | POSIX: daemon ignores SIGTERM | Teardown | 2 s → SIGKILL + warn | Yellow warning | unit (real subprocess) |
| 16b | Windows: daemon ignores stdin graceful | Teardown | No ack within 500 ms → taskkill /T; warn on non-zero | Yellow warning | unit (Windows-only) |
| 16c | Windows: stdin pipe missing | Teardown | Straight to taskkill; warn | Yellow warning | unit |
| 17 | Teardown fires twice | All paths | Idempotency flag | None | unit |
| 18 | Vite config reload during dev | Plugin reinit | Old shutdown fires; new starts fresh | Normal Vite messaging | integration |
| 19 | Non-client Vite environment transform | `transform` | Return `undefined` | None | integration + fixture |
| 20 | `.redesigner/` missing on fresh clone | Constructor | `mkdirSync({ recursive: true })` | None | unit |
| 21 | Attempted SSR render of playground | `hydration-safety.test.ts` | Test asserts rendered HTML contains no `data-redesigner-loc` | None (test invariant) | integration |

### 7.1 Non-goals (error handling)

- No recovery from partial manifest (retry makes it recoverable-or-loud).
- No user-configurable log levels beyond Vite's `--logLevel`.
- No telemetry / update-check.

---

## 8. Testing plan

Three tiers, Vitest throughout. `fast-check` for roundtrip properties.

### 8.1 Unit tests — `test/unit/`

Pure or mocked-IO; no real subprocesses, no real Vite servers.

| File | Coverage |
|---|---|
| `locFormat.test.ts` | Roundtrip + fast-check. Arbitrary = `fc.string({ minLength: 1 })` filtered to exclude newlines and control characters. No redundant colon filter — filenames never contain colons in relPaths (drive letters normalized; Windows paths are input, not emitted). |
| `pathGuards.test.ts` | `toPosixProjectRoot` normalizes `C:\...` → `C:/...`, does NOT throw on Windows-native input. Escape guards. |
| `runtimeDetect.test.ts` | Precedence; mismatch (tsconfig classic, esbuild automatic → debug). |
| `wrapperComponents.test.ts` | Skip list + alias imports + `ErrorBoundary` heuristic note. |
| `resolveEnclosingComponent.test.ts` | All component shapes + reserved-name rejection. |
| `plugin.test.ts` | Lifecycle; options merge; `configResolved` throws (config errors); user's `babel.config.js` NOT consulted; environment re-init does not double-initialize. |
| `manifestWriter.test.ts` | CAS per-file replace. Startup empty-write + mkdir-p + tmp sweep. Debounce + maxWait-from-first-commit. Post-flush re-check triggers reschedule. **7-step exponential-backoff** on mock EPERM/EBUSY (50/100/200/400/800/1600/3200 ms). EXDEV never occurs. Construction-time collision throws. contentHash stable across reorder. `quiesce` forces flush + resolves after. |
| `daemonBridge.test.ts` | Injected importer: NOT_FOUND/NOT_EXPORTED vs generic error discrimination; contract validation throws on missing pipes; pipe drain wired on both stdout+stderr; teardown idempotency; POSIX SIGTERM→SIGKILL; Windows stdin ack handshake + taskkill fallback (Windows-only); SIGHUP non-win32-only; no `beforeExit`; startDaemon contract rejection. |

### 8.2 Fixture tests — `test/fixtures/`

On-disk triples. Regeneration gated by env var + `FIXTURE_CHANGELOG.md` entry + Husky + CI three-dot-diff. Cases per §4 layout.

`compiler-hoist-order/` is special: fixture simulates both orders to prove our attribute survives React Compiler memoization/hoisting with the original source line preserved.

`reserved-module-name/` asserts that `function (module)(){...}` or equivalent user-declared identifier throws with a clear message.

### 8.3 Integration tests — `test/integration/`

Real Vite dev server, real playground. Per-test tmpdir via `fs.mkdtemp`. `parallelism.test.ts` runs under a **dedicated config file** (`test/vitest.parallelism.config.ts` with `{ pool: 'forks', isolate: true, fileParallelism: false }`), invoked via the separate script `pnpm test:parallelism`. Pool/parallelism are project-level in vitest.config; per-file pool overrides are not supported.

| File | Coverage |
|---|---|
| `vite.test.ts` | DOM assertions (no count-match): every rendered **host-element** within `#root` carries `data-redesigner-loc` (excluding mount, wrapper-component subtrees per §3.3 invariant 9, and the `(module)` synthetic which is manifest-only). Every value parses and resolves to a manifest entry. Hardcoded-loc spot set present (PricingCard × 4, Button × N, DataFetcher, Row, WithWrappers subtree, React 19.2 wrappers present in manifest but NOT in DOM attrs). Failure messages name missing components. |
| `manifest.test.ts` | Schema validation; consumer reader contract exercised via `readManifest()`; contentHash stability + change detection; minor-ahead behavior; classic-runtime error message contains the fix hint. |
| `hmr.test.ts` | Uses `server.waitForRequestsIdle` + Vite HMR `update` events subscribed on `server.ws`. Scenarios: (1) prepend line to `Button.tsx`, wait for **at least one** update + `writer.quiesce`, assert lineRange shifted + loc still resolves. (2) Rename component; assert old key gone, new present, no stale entries. (3) Two-file cascade: edit Button + PricingCard rapidly; assert `updateCount >= 2` (lower-bound, because Vite may batch) AND final manifest contains correct entries for both files. (4) Deleted-via-editor case: remove a component; assert its manifest entry is purged. All waits use `server.waitForRequestsIdle` + `writer.quiesce`; no `setTimeout`. |
| `fast-refresh.test.ts` | **State preservation AND registration stability.** (a) Component mounts with a `useState` counter. Click DOM event 3 times; assert `textContent === "3"`. Component also mounts a `const instanceStamp = useRef(Math.random())` exposed via a `data-instance-stamp` attribute. Edit an unrelated leaf JSX inside the same file. Wait for HMR update. Re-assert `textContent === "3"` AND `data-instance-stamp` unchanged (proves no re-mount). (b) Registration stability: instrument `window.$RefreshReg$` via a monkey-patch; count registrations for each component across edits to unrelated leaves; assert exactly 1 per component per module load. |
| `environment-skip.test.ts` | `server.transformRequest(url, { ssr: true })` → no attribute. Vite 6+: simulate `server.environments.ssr?.transformRequest` → no attribute. `server.ssrLoadModule` + `renderToString` → rendered HTML contains zero `data-redesigner-loc`. |
| `react-compiler.test.ts` | `babel-plugin-react-compiler` enabled. Asserts: (a) first render has attribute at correct source line; (b) attribute survives prop-change re-render (memo doesn't stale); (c) HMR edit updates attribute (no stale-memoization regression). |
| `sourcemap.test.ts` | **Column accuracy:** for a token past the injection point, `originalPositionFor` returns the exact original column (reworded from ambiguous "±0"). Line accuracy asserted too. |
| `reinit.test.ts` | Touch `vite.config.ts`; old shutdown fires; new writer flushes empty manifest; `process._getActiveHandles()` count stable; no duplicate daemon. |
| `parallelism.test.ts` | Under dedicated config. 10 parallel transforms on distinct files; assert all 10 entries present in final manifest. |
| `degradation.test.ts` | Injected importer variants covered inline. |
| `daemon-real.test.ts` | **Three sibling test packages** under `test/fixtures/fake-packages/`: `@redesigner-test/daemon-throws`, `@redesigner-test/daemon-no-export`, `@redesigner-test/daemon-tla` (top-level-await never resolves). Each test runs with a parameterized importer pointing at a different package — avoids ESM module-cache poisoning (once an import specifier resolves, its cache is process-local; three distinct specifiers means three distinct cache entries). Each test validates the production dynamic-import path without needing forked workers. |
| `hydration-safety.test.ts` | Locks the "client-only" premise. Implementation: `renderToString(<App />)` DOES NOT throw (React is permissive). Assertion: rendered HTML contains **zero** occurrences of `data-redesigner-loc`. This holds because transforms during SSR are routed through non-client environments and skipped (§3.3 invariant 1); plugin-react on our untransformed code produces no attributes. If a future SSR spec changes this, the test must be updated deliberately — forcing the design decision to the surface. |
| `shutdown.test.ts` | **Real subprocess** fake daemon at `test/fixtures/fake-packages/fake-daemon/index.js`, spawned as `['node', path]` with `stdio: ['pipe','pipe','pipe']`. Protocol: stdin accepts line-delimited JSON `{ "op": "shutdown" }`; subprocess acknowledges via `{ "ack": true }` on stdout before exiting. POSIX: SIGTERM → subprocess responds with ack → clean flush. Escalation: subprocess ignores → 2 s → SIGKILL. Windows-only (skip elsewhere): write `{"op":"shutdown"}\n` → wait 500 ms for `{"ack":true}\n` on stdout → on ack, await exit up to 1.5 s → on no ack OR no exit, `taskkill /T /F`. Idempotency: shutdown called twice performs only one flush + one signal/taskkill. |

### 8.4 CI matrix (ships with this spec)

Per the workflow sketch in §4.3. Summary:

- **Matrix:** Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 (exact floor) + Node 22.
- **Corepack preflight:** `npm install -g corepack@latest` on Node 20.11.0 leg (Node 20.11.0 ships Corepack 0.24; key rotation requires 0.31+) + shell-native version check (no child_process invocation from Node).
- **pnpm store cache:** resolved by `pnpm store path --silent` (not hardcoded paths — canonical per pnpm docs).
- **`pnpm install --frozen-lockfile --strict-peer-dependencies`.**
- **Biome + typecheck + unit + fixtures + integration + parallelism-config run**.
- **Fixture-update guard** via three-dot diff `origin/main...HEAD` (catches multi-commit PRs regardless of merge strategy); env-var must be unset in CI.
- **`.only` / `.skip` grep** as secondary check; Biome rules are primary.
- **Per-directory non-empty assertion**.
- **`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`**.
- **`timeout-minutes: 15`** per job.
- **Artifact upload on failure** (`actions/upload-artifact@v4` with `if: failure()`) for logs + partial manifests.
- **Required status checks via committed GitHub ruleset** synced by the dedicated `sync-ruleset.yml` workflow (with drift-check on a daily schedule). Ruleset JSON names `ci / test (windows-2022, 22)` as required.
- **Integration transform-time gate: 30 s ceiling** on the full playground.

### 8.5 Non-goals (testing)

- No Playwright / real-browser E2E.
- No hard perf benchmarks beyond the 30 s transform ceiling.
- No DOM snapshot of entire playground.
- No coverage-threshold gate. Deliberate per-tier + per-case coverage instead.

---

## 9. Open questions (carried forward)

From brief §152–157.

- **Daemon ↔ extension protocol** — decide in daemon spec.
- **HMR granularity beyond file-level** — out of scope.
- **Port discovery** — daemon spec decision. Plugin passes `daemon.port` through (default 0).
- **Product name** — still TBD.

---

## 10. Appendix — decision log

Decisions from brainstorming + three rounds of panel review:

1. **Spec scope = Vite plugin + playground only** (brief build order 1 + 2).
2. **pnpm workspaces + Biome + `engine-strict`.** Corepack ≥0.31.0 (upgraded on Node 20.11.0 leg).
3. **`@vitejs/plugin-react` companion,** plugin is independent (`configFile: false, babelrc: false`).
4. **DOM attribute: `data-redesigner-loc`** (namespaced). Format: `"relPath:line:col"`, posix. `parseLoc` helper exported from core; CSS-selector escape documented in reader contract.
5. **Manifest schema:** `schemaVersion` is a string-literal union (bumped deliberately); additive=minor (including `framework: 'vue'`), breaking=major; consumers accept unknown fields; retry-once on parse failure; `componentKey` format stable + documented `::` separator; `contentHash` for change-detection (drops reliance on `generatedAt`); `projectRoot` not in manifest; no `$schema` URL in v0. Canonical reader shipped as `@redesigner/vite/reader`.
6. **Codename `redesigner`, rename accepted.**
7. **Dev-only (`apply: 'serve'`).**
8. **Zero-config factory default export.** `daemon: DaemonOptions | 'auto' | 'required' | 'off'` (nested object prevents v1 sprawl; string shorthand for the common case).
9. **Daemon cross-cut via injected importer.** Discriminated ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED vs other error. Never rethrow into dev-server startup for `'auto'`. Real production-path covered by three sibling fixture packages (`-throws`, `-no-export`, `-tla`) — ESM cache poisoning averted by distinct import specifiers.
10. **React 19 + automatic JSX runtime only.** Classic = hard error at startup with fix hint.
11. **Independent Babel pass with `enforce: 'pre'`**, `sourceMaps: true`, `inputSourceMap: true`, `configFile: false`, `babelrc: false`. Returns `{ code, map }`.
12. **Immutable map + per-file replace CAS + post-flush re-check.** No mutex.
13. **Empty-manifest write + startup tmp sweep + `mkdir -p`** at startup.
14. **Per-visitor-case try/catch.**
15. **Wrapper-component skip list.** React built-ins: `JSXFragment`, `React.Fragment`, `Fragment`, `Suspense`, `Profiler`, `StrictMode`, `Activity` (React 19.2), `ViewTransition` (React 19.2), `Offscreen` (legacy). Userland heuristic: `ErrorBoundary` (name-only; documented). Ambiguous dynamic identity injects with accepted warning cost.
16. **Module-scope JSX attributed to synthetic `(module)` component — MANIFEST-ONLY.** Not hit-testable from DOM. Documented in validation gate and JSDoc. User-declared components named `(module)` throw.
17. **HOC unwrap:** only `memo` + legacy `forwardRef`. Third-party HOCs keep assignment name.
18. **Environment-aware skip.** Vite 6+ `this.environment.name !== 'client'` OR Vite 5 `options.ssr === true` → no transform. SSR / RSC / hydration post-v0.
19. **No telemetry, no update-check.**
20. **ESM-only for v0.**
21. **Full CI matrix ships with this spec** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 + Node 22).
22. **Required status checks via committed GitHub ruleset + dedicated sync workflow** (`sync-ruleset.yml`, drift-check on schedule, PAT-based).
23. **Platform-aware shutdown.** POSIX: SIGTERM → 2 s → SIGKILL. Windows: stdin graceful → handshake ack → 2 s → `taskkill /T /F`. SIGHUP POSIX-only. No `beforeExit`.
24. **Daemon contract.** `startDaemon()` → `{ pid, shutdown, stdout, stdin, stderr }`. Pipes drained immediately. `stdio: ['pipe','pipe','pipe']` required.
25. **Windows-aware atomic write.** Same-dir temp. **7-step exponential backoff (50/100/200/400/800/1600/3200 ms, ~6.35 s ceiling)**. Startup tmp sweep. Severity ladder: attempts 1–2 = debug; attempts 3–6 = warn; final failure = error.
26. **Cross-instance collision is a config error.** Detected at construction via exclusive-flag lock file. `proper-lockfile` NOT a runtime dependency.
27. **Corepack + exact `packageManager` pin** (`pnpm@9.15.4`). Upgrade to `corepack@latest` on Node 20.11.0 CI leg. `.npmrc` enforces `engine-strict`.
28. **Build toolchain: `tsup` + `ts-json-schema-generator`.** `"private": true`.
29. **Fixture `--update` is gated** at three levels: Husky pre-commit + CI three-dot diff + Biome rules.
30. **Property-based test** on `formatLoc`/`parseLoc` via `fast-check`, Arbitrary specified.
31. **React Compiler compat verified** by integration covering fresh render, prop-change, HMR-edit.
32. **Types split:** `types-public.ts` (re-exported) vs `types-internal.ts`. Explicit named re-exports only.
33. **`noFocusedTests` + `noSkippedTests` = error** in Biome. Per-directory non-empty assertion replaces brittle count file.
34. **Playground `edge/*` all actually rendered from `App.tsx`.** Fast-Refresh state-preservation AND registration stability integration tests added.
35. **Daemon lifetime = Vite process lifetime.** `detached: false`. Persistent daemon is a deferred post-v0 spec.
36. **Vite 8 / plugin-react v6 (oxc) is a deferred widening**, not a v0 claim. Integration test gates it.
37. **`(module)` synthetic name is reserved.** User-declared components matching the literal are rejected.
