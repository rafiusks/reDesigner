# Vite Plugin + Playground — v0 Design Spec

**Date:** 2026-04-18
**Status:** Draft — pending user review
**Codename:** `redesigner` (product name TBD; rename cost at naming time is accepted — see §10 item 6)

---

## 1. Scope

### 1.1 What this spec covers

First milestone of the v0 roadmap from `brief.md`: the Vite plugin (`@redesigner/vite`) and the playground app (`examples/playground/`), with the monorepo scaffold that hosts them.

Deliverables:

- `@redesigner/vite` — a Vite plugin that injects `data-redesigner-loc` attributes onto every rendered JSX element in dev builds and emits a versioned manifest to `.redesigner/manifest.json`.
- `examples/playground/` — a React 19 + TypeScript + Vite app used to dogfood and test the plugin, exercising children-as-function, module-scope JSX, multi-component files, React 19 ref-as-prop, cloneElement, and Tailwind v4.
- Monorepo scaffold: pnpm workspaces, Biome, shared tsconfig base, `.gitignore`, `.npmrc` (engine-strict), root `README.md` + `CONTRIBUTING.md`, `.editorconfig`, and the **full CI matrix** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 exact + Node 22 current LTS, pnpm 9.15.4 via Corepack ≥0.31.0). Required-status-check enforcement is done via a committed GitHub ruleset JSON (not a workflow file).

### 1.2 What this spec does NOT cover (and why)

This v0 slice is intentionally narrow. The brief's build order (§131–136) sequences six deliverables; this spec is the first two.

| Deferred item | Why out of scope here | Unblocks when |
|---|---|---|
| `@redesigner/daemon` | Brief §154–156 leaves protocol / port / HMR-watch open. Plugin reserves the daemon option contract now (§6.1); behavior activates when the daemon package is installed. | Daemon spec drafted + approved. |
| `@redesigner/mcp` shim | Requires daemon. | Daemon spec complete. |
| Chrome extension | Requires daemon WS protocol; brief §128 sequences it last. | Daemon + MCP both complete. |
| `@redesigner/cli` (`init`) | Writes `.mcp.json` + Vite config snippet. | MCP spec + extension ID allocation. |
| Runtime props, fiber traversal, Vue/Svelte/Next adapters, DevTools panel, extension chat UI, persistence UI, OpenAI backend, variation flows | Explicitly post-v0 per brief §141–150. | Post-v0. |
| SWC plugin wrapper | Deferred per brief. `core/` helpers are framework-agnostic; the enclosing-component resolver is Babel-coupled and a parallel SWC implementation will be needed. | User ask post-v0. |
| **SSR / RSC / isomorphic-hydration support** | The DOM-attribution model assumes client-only rendering. v0 explicitly **no-ops** on any non-client Vite environment and the playground is a client-only SPA. Hydration-safe DOM attribution is a post-v0 design question. | Dedicated SSR spec; user demand. |

### 1.3 Rationale for the slice

Brief §119–128 walks each upstream dependency forward one step at a time. Step 1 is "Vite plugin against the playground — verify `data-redesigner-loc` appears on rendered DOM elements." That is the smallest end-to-end testable unit with no external dependencies. Every downstream piece assumes this layer is solid.

### 1.4 Validation gate

This spec is complete when all of the following pass:

1. Unit tests green across the CI matrix (Ubuntu 24.04 + Windows Server 2022, Node 20.11.0 + Node 22).
2. Fixture tests green, covering every case enumerated in §8.2 (including new cases: `ref-as-prop/`, `fragment-noop/`, `wrapper-components-noop/`, `module-scope-jsx/`, `environment-skip/`, `clone-element/`, `compiler-hoist-order/`).
3. Integration tests green, including HMR (line-shift + rename + two-file cascade + Fast-Refresh state preservation), environment-skip, React-Compiler compat, shutdown (POSIX + Windows paths), and re-init tests.
4. Full CI matrix green. A committed **GitHub ruleset** (`.github/rulesets/main-protection.json`) marks the Windows-Server-2022 + Node 22 job as a required status check on the `main` branch and on PRs.
5. Playground renders with `data-redesigner-loc` on every rendered JSX element, with no React runtime warnings (including wrapper-component prop warnings).
6. `.redesigner/manifest.json` validates against the shipped JSON Schema and `schemaVersion` is set to `"1.0"`.
7. Manual dogfood: open playground in Chrome DevTools, inspect an element, confirm `data-redesigner-loc="src/...:line:col"` points to the real source.

---

## 2. Premises fixed

Bound choices from brainstorming + two rounds of panel review:

- **React 19 only.** React 18 deferred. React Compiler 1.0 compatibility is required (§8 integration test).
- **Automatic JSX runtime only.** Classic runtime is a hard startup error. Runtime detection precedence: `config.esbuild?.jsx` (authoritative) → `@vitejs/plugin-react` config → tsconfig (hint only).
- **`@vitejs/plugin-react` is the default companion,** but the plugin is independent — our Babel pass is self-contained, runs `enforce: 'pre'`, and does NOT consult the user's `babel.config.*` / `.babelrc` (`configFile: false`, `babelrc: false`).
- **Client-only rendering.** Any non-client Vite environment (SSR, RSC, worker) is skipped — see §3.3 invariant 1. SSR/RSC/hydration support is post-v0.
- **pnpm workspaces** via Corepack (≥0.31.0). Biome for lint/format. `.npmrc` sets `engine-strict=true` so `engines.pnpm` is enforced.
- **Dev-only transform** (`apply: 'serve'`). `vite build` is a no-op by default.
- **Project-relative paths, posix separators** in every artifact that reaches the DOM or the manifest.
- **DOM-queryable loc is the reason we exist.** `jsxDEV` threads `__source` through React element internals; that field is not visible to a Chrome extension inspecting arbitrary DOM, and it is not stable across React majors. A DOM-persisted attribute is the minimal additive claim required.
- **Codename `redesigner`.** Rename cost at naming time is accepted.
- **Minimum Node 20.11.0** (for stable `import.meta.dirname` and Corepack fixes). Enforced via `engines` + `engine-strict=true`.

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
                 │  │ returns pid)     │   │ dir temp, expo   │   │
                 │  │                  │   │ backoff retry,   │   │
                 │  │                  │   │ startup sweep,   │   │
                 │  │                  │   │ cross-instance   │   │
                 │  │                  │   │ lock)            │   │
                 │  └──────────────────┘   └────────┬─────────┘   │
                 │                                  │ atomic      │
                 │                                  │ write       │
                 │                                  ▼             │
                 │                         .redesigner/manifest.json
                 └────────────────────────────────────────────────┘
```

### 3.2 Layers, top to bottom

1. **Vite plugin entry** — owns Vite lifecycle hooks (`configResolved`, `configureServer`, `closeBundle`, `server.close`, `buildEnd`). Loads options, resolves project root, detects the JSX runtime, instantiates the manifest writer, attempts daemon bridge, orchestrates teardown across POSIX signals (§5.4). Registers JSX-runtime detection with the correct precedence order (§2).

2. **Babel plugin (babel-coupled)** — Babel visitor. `core/` contains framework-agnostic helpers (loc format, key construction, path guards). `babel/resolveEnclosingComponent.ts` reasons over Babel AST node types. Invoked via `@babel/core.transformAsync` with `configFile: false`, `babelrc: false`, `sourceMaps: true`, `inputSourceMap: true` — our pass must not leak the user's Babel config into a double-application.

3. **Manifest aggregator** — collects `componentKey → ComponentRecord` and `loc → LocRecord` entries from transform-local batches. **Transform-local batch semantics:** each Babel pass builds its per-file batch synchronously, then commits via `writer.commitFile(relPath, batch)` — a single compare-and-swap replacing `state.get(relPath)` with `batch`. No mutex, no contention, no deadlock.
   - **Post-flush re-check.** After every successful flush, the aggregator compares the current immutable-state identity to the snapshot it wrote. If identity differs, it immediately re-schedules a flush. Closes the "commit during rename" window where a newer state could sit in memory indefinitely.
   - **Debounce semantics:** 200 ms debounce, 1000 ms maxWait, **maxWait measured from the first commit since the last successful flush** (not from the last commit). Trailing edge only; no leading-edge fire.
   - **Forced initial flush** after `configureServer` on `buildEnd` or first idle tick (bounds worst-case "empty manifest visibility").
   - **Platform-aware atomic write:** temp file always placed in the same directory as the target (`.redesigner/manifest.json.tmp-<pid>-<rand>`) — never `os.tmpdir()` (avoids `EXDEV` across drive letters).
   - **Exponential-backoff retry on `EPERM`/`EBUSY`** (Windows Defender / Search Indexer / concurrent reads): 5 attempts, delays `50, 100, 200, 400, 800 ms` (~1.55 s ceiling). On final failure, log and continue (old manifest remains valid).
   - **Startup tmp sweep.** Writer constructor runs `readdir` on the manifest directory and unlinks any `manifest.json.tmp-*` files left over from a SIGKILL'd prior run. Prevents unbounded `.redesigner/` growth across crashes.
   - **`mkdirSync(dirname(manifestPath), { recursive: true })`** before the first write.
   - **Cross-instance lock.** When multiple Vite plugin instances share the same resolved `manifestPath` (monorepo with two dev servers targeting the same `config.root`), the writer acquires a `proper-lockfile` around each rename. Each Vite app's default path is `config.root + '/.redesigner/manifest.json'` — different `config.root` means different file, no lock needed. The lock is only activated when two writers resolve to the same file.
   - **Internal-only test hooks:** `onFlush(seq: number): Promise<void>` and `quiesce(): Promise<void>`. `quiesce` forces a flush and resolves after it lands — decoupled from `debounce` / `maxWait` tuning, not waiting for inactivity.

4. **Daemon bridge** — optional. Dynamic `import('@redesigner/daemon')` via an **injectable importer function** (production wiring: `() => import('@redesigner/daemon')`; tests inject their own). Discriminated `try/catch`: `ERR_MODULE_NOT_FOUND` is quiet-warn, any other error is loud-warn (logged via `config.logger.warn` with stack, not `.error` — avoids training users to ignore red output) and non-fatal.
   - **`startDaemon()` contract.** The daemon package MUST export `startDaemon({ manifestPath, port }): Promise<DaemonHandle>` where `DaemonHandle = { pid: number; shutdown(): Promise<void>; stderr: Readable; stdout: Readable }`. `pid` is the top-level spawned process (the daemon MUST NOT double-fork on Windows, so `taskkill /T` walks its tree correctly).
   - **Pipe drain required.** Immediately after `startDaemon` resolves, the bridge wires `handle.stdout.on('data', ...)` + `handle.stderr.on('data', ...)` to `config.logger.info` / `.warn`. Unread pipe buffers fill at ~64 KB and block the child; this is not optional.
   - **Spawn flags** (inside the daemon's own `startDaemon` implementation — not this spec's concern, but contracted): `detached: false`, `stdio: ['pipe', 'pipe', 'pipe']` (stdin 'pipe' is required so Windows shutdown can send a graceful message via stdin).
   - **Platform-aware teardown** (§5.4): POSIX = SIGTERM → 2 s → SIGKILL. Windows = stdin graceful message → 2 s → `taskkill /T /F /PID <handle.pid>`.
   - **Teardown registration.** All paths route through a single idempotent `shutdown()` function: `server.close`, `SIGINT`, `SIGTERM`. **`SIGHUP` is registered only on non-Windows platforms** (per nodejs/node#10165, registering SIGHUP on Windows can deadlock `CTRL_CLOSE_EVENT`). **`beforeExit` is NOT registered** (it only fires when the event loop is empty; with a live daemon the loop is never empty, so it would never fire — misleading to include). `uncaughtException` and `unhandledRejection` are registered only to trigger teardown, then re-throw so Node's default exit behavior completes.

### 3.3 Key design invariants

1. **Environment-aware transform.** On each `transform(code, id, options)` invocation, the plugin consults `this.environment?.name` when defined (Vite 6+ Environments API) and skips unless the environment name is `"client"`. Falls back to `options?.ssr === true` being the skip condition on Vite 5. Any non-client environment (`ssr`, `rsc`, `worker`, custom) is unconditionally skipped. The client pass is the sole source of DOM attribution.

2. **Independent Babel pass, not plugin-react coupling.** Our Vite plugin runs with `enforce: 'pre'`, invokes `@babel/core.transformAsync({ sourceMaps: true, inputSourceMap: true, configFile: false, babelrc: false })`, and returns `{ code: result.code, map: result.map }` explicitly. Downstream React plugins then process our output unaware of us. Unit test asserts the user's `babel.config.js` is NOT consulted by our pass.

3. **Scoped "core" vs. Babel coupling.** `core/locFormat.ts`, `core/pathGuards.ts`, `core/manifestSchema.ts`, and `core/types-public.ts` / `core/types-internal.ts` are pure modules with zero AST or framework dependencies. `babel/resolveEnclosingComponent.ts` is inside `babel/` because it reasons over Babel node types.

4. **Compile-time component resolution.** The Babel visitor walks from each JSX node to its enclosing component (function/class/arrow; unwraps `memo` + legacy `forwardRef`). Ref-as-prop components (React 19 idiom) resolve like any function component. Third-party HOCs keep the assignment-target name.

5. **Lazy manifest + bounded-staleness cold start.** Manifest grows as Vite transforms files. No eager source walk. After `configureServer`, a forced flush is scheduled on `buildEnd` or first idle tick — bounds worst-case "empty manifest visibility."

6. **Fresh state on every start.** `ManifestWriter` constructor: (a) `mkdirSync(recursive: true)`, (b) startup tmp sweep (unlinks `manifest.json.tmp-*`), (c) overwrite `manifest.json` with empty manifest (`schemaVersion: "1.0"`, empty components + locs). Atomic same-dir rename with retry.

7. **One-way flow: memory → disk.** Writer never reads `manifest.json` back.

8. **Per-file batch replace + post-flush re-check.** `writer.commitFile(relPath, batch)` takes the full new set for that file; per-file replace is atomic. After every successful disk flush, the aggregator compares current state identity to the snapshot and re-schedules if changed — closes the "commit during rename" race.

9. **Wrapper components get no attribute.**
   - `JSXFragment` (`<>...</>`): explicitly skipped.
   - JSX elements whose opening-name resolves to a known React wrapper that warns on unknown props — `React.Fragment`, `Fragment`, `Suspense`, `ErrorBoundary`, `Profiler`, `StrictMode` — are also skipped.
   - The skip list is declared in `core/wrapperComponents.ts`. Users who render these under a different import binding (e.g., `import { Fragment as F } from 'react'`) are detected by resolving the JSX opening name to its import declaration. If resolution is ambiguous (dynamic `React[x]`), we inject and accept the warning cost — document as a known edge.
   - Children of Fragments/wrappers are visited normally.

10. **Module-scope JSX is attributed to `(module)`.** JSX at module scope (no enclosing function) is attributed to a synthetic component with `componentName: "(module)"` and `componentKey = relPath + '::' + '(module)'`. Parentheses (not angle brackets) avoid CSS-selector / HTML-escape / JSON-viewer brittleness. `(module)` is a reserved synthetic identifier documented in the README.

11. **Dead-code JSX is strictly literal-false, not reachability analysis.** `{false && <X />}` and guards behind literal `false` / `null` are skipped silently. Reachability analysis (e.g., past a `use(promise)` call) is NOT attempted — those elements are tagged normally.

---

## 4. Package + module layout

```
redesigner/                           (repo root, pnpm workspace)
├── package.json                      ("packageManager": "pnpm@9.15.4", "engines": { "node": ">=20.11.0", "pnpm": ">=9.15" })
├── pnpm-workspace.yaml
├── .npmrc                            (engine-strict=true, package-manager-strict=true)
├── biome.json                        (noFocusedTests=error, noSkippedTests=error, both enabled explicitly)
├── tsconfig.base.json
├── .gitignore                        (node_modules, dist, coverage, .redesigner/, pnpm-debug.log)
├── .editorconfig
├── README.md
├── CONTRIBUTING.md                   (corepack enable; Corepack ≥0.31.0 check; proxy / MITM notes)
├── .github/
│   ├── workflows/
│   │   └── ci.yml                    (matrix defined below; concurrency group; pnpm store cache; 15-min timeout per job)
│   └── rulesets/
│       └── main-protection.json      (committed GitHub ruleset making `ci / test (windows-2022 / node-22)` a required status check)
│
├── packages/
│   └── vite/                         → @redesigner/vite
│       ├── package.json              ("private": true for v0; "publishConfig": { "access": "restricted" })
│       ├── tsconfig.json
│       ├── tsup.config.ts            (builds dist/index.js + .d.ts + copies manifest-schema.json)
│       ├── scripts/
│       │   └── generate-schema.ts    (ts-json-schema-generator → dist/manifest-schema.json)
│       ├── src/
│       │   ├── index.ts              (default export: redesigner factory; explicit named re-exports from types-public)
│       │   ├── core/                 (pure, zero AST/framework deps)
│       │   │   ├── locFormat.ts
│       │   │   ├── pathGuards.ts     (toPosixProjectRoot normalize; NEVER rejects Windows-native; throws only on unnormalizable input)
│       │   │   ├── wrapperComponents.ts  (Fragment / Suspense / ErrorBoundary / Profiler / StrictMode skip list)
│       │   │   ├── manifestSchema.ts
│       │   │   ├── types-public.ts   (Manifest, ComponentRecord, LocRecord, RedesignerOptions — the stable surface)
│       │   │   └── types-internal.ts (writer internals, batch types, etc. — NOT re-exported)
│       │   ├── babel/
│       │   │   ├── plugin.ts         (Babel wrapper; skips JSXFragment + wrapper components; per-node try/catch)
│       │   │   └── resolveEnclosingComponent.ts
│       │   ├── integration/          (stateful / IO concerns)
│       │   │   ├── manifestWriter.ts
│       │   │   ├── daemonBridge.ts   (injectable importer; pipe drain; platform-aware teardown; SIGHUP POSIX-only; no beforeExit)
│       │   │   └── runtimeDetect.ts  (esbuild.jsx → plugin-react → tsconfig fallback)
│       │   └── plugin.ts             (Vite plugin entry; composes the above; environment-aware skip)
│       ├── test/
│       │   ├── fixtures/
│       │   │   ├── README.md         (conventions; --update gate; changelog + Husky requirement)
│       │   │   ├── FIXTURE_CHANGELOG.md
│       │   │   ├── _runner.test.ts
│       │   │   ├── default-export/
│       │   │   ├── named-exports/
│       │   │   ├── memo-wrapped/
│       │   │   ├── forwardRef-wrapped/             (legacy-compat)
│       │   │   ├── ref-as-prop/                    (React 19 idiomatic)
│       │   │   ├── arrow-const/
│       │   │   ├── anonymous-default/
│       │   │   ├── inline-jsx-in-callback/
│       │   │   ├── hoc-wrapped/
│       │   │   ├── fragment-noop/                  (asserts no attr on <> or <Fragment>)
│       │   │   ├── wrapper-components-noop/        (Suspense/ErrorBoundary/Profiler/StrictMode)
│       │   │   ├── module-scope-jsx/               (asserts (module) synthetic)
│       │   │   ├── environment-skip/               (asserts non-client environments emit no changes; Vite 5 ssr flag + Vite 6+ environment.name)
│       │   │   ├── clone-element/                  (asserts cloneElement loc preservation)
│       │   │   ├── compiler-hoist-order/           (React Compiler runs after us; hoisted JSX retains our attribute with correct loc)
│       │   │   ├── children-as-function/
│       │   │   ├── malformed-jsx/
│       │   │   ├── pathological-node/
│       │   │   ├── dead-code-jsx/                  (renamed from jsx-outside-component; literal-false guards)
│       │   │   ├── unicode-filename/
│       │   │   └── filename with spaces/
│       │   ├── unit/
│       │   │   ├── locFormat.test.ts               (+ fast-check roundtrip; Arbitrary = fc.string().filter(s => !/[\r\n\x00-\x1f]/.test(s) && !/[:\u0000-\u001f]/.test(s) && s.length > 0))
│       │   │   ├── resolveEnclosingComponent.test.ts
│       │   │   ├── pathGuards.test.ts              (asserts Windows-native paths normalize, do not throw)
│       │   │   ├── runtimeDetect.test.ts
│       │   │   ├── wrapperComponents.test.ts
│       │   │   ├── plugin.test.ts                  (asserts user's babel.config.js is NOT consulted)
│       │   │   ├── manifestWriter.test.ts          (5×exponential-backoff on mock EPERM/EBUSY; mkdir-p; startup tmp sweep; post-flush re-check; cross-instance lock; batch replace CAS)
│       │   │   └── daemonBridge.test.ts            (injected importer; SIGHUP POSIX-only; no beforeExit; startDaemon contract; pipe-drain smoke)
│       │   └── integration/
│       │       ├── vite.test.ts                    (DOM assertions: every-has-attr + hardcoded-loc spot checks; no count-match)
│       │       ├── manifest.test.ts                (schema validation; reader contract; consumer retry behavior)
│       │       ├── hmr.test.ts                     (hmr.waitFor('update', expectedCount) + writer.quiesce; two-file cascade; Fast-Refresh STATE PRESERVATION verified via a useState counter)
│       │       ├── environment-skip.test.ts        (ssr=true AND a mock rsc environment both skip via server.transformRequest + server.ssrLoadModule + renderToString; asserts rendered HTML contains no attribute)
│       │       ├── react-compiler.test.ts          (compiler enabled; (a) fresh render has attribute, (b) attribute survives prop-change re-render, (c) HMR edit updates attribute — stale-memoized regression catch)
│       │       ├── sourcemap.test.ts               (column accuracy: originalPositionFor on a token past the injection point maps back to original column within ±0)
│       │       ├── reinit.test.ts
│       │       ├── parallelism.test.ts             (Vitest: { pool: 'forks', isolate: true, fileParallelism: false } in vitest.config.ts for this file via /// @vitest-environment annotation)
│       │       ├── degradation.test.ts             (injected importer; ERR_PACKAGE_PATH_NOT_EXPORTED vs ERR_MODULE_NOT_FOUND discrimination)
│       │       ├── daemon-real.test.ts             (one real fixture daemon package exercising the production () => import() path; covers ESM resolution cache, export-not-found)
│       │       ├── hydration-safety.test.ts        (playground is client-only; this test locks the premise: server-rendering the playground MUST fail early with a clear "SSR is post-v0" error, not emit orphan attributes)
│       │       └── shutdown.test.ts                (real subprocess; POSIX SIGTERM→SIGKILL; Windows stdin graceful message → taskkill /T tree-kill; idempotent shutdown)
│       └── README.md                 (user-facing docs; ESM-only note; pre-enforce ordering caveat; Tailwind v4 ordering note; custom-element & (module) reserved-name notice)
│
└── examples/
    └── playground/                   (not published; "private": true)
        ├── package.json              ("@redesigner/vite": "workspace:*")
        ├── vite.config.ts            (two lines: import + plugin())
        ├── tsconfig.json
        ├── vite-env.d.ts
        ├── index.html
        └── src/
            ├── main.tsx                       (module-scope <App /> render → attributed to (module))
            ├── App.tsx                        (renders every edge/* case; NOT dead-code — all actually rendered)
            ├── components/
            │   ├── Button.tsx
            │   ├── PricingCard.tsx
            │   ├── PricingSection.tsx
            │   ├── Modal.tsx
            │   ├── DataFetcher.tsx            (children-as-function; actually invoked with non-mocked data so Row reaches the DOM)
            │   └── edge/
            │       ├── MemoWrapped.tsx
            │       ├── ForwardRefWrapped.tsx
            │       ├── RefAsProp.tsx
            │       ├── MultiComponentFile.tsx
            │       ├── AnonymousDefault.tsx
            │       ├── WithCallback.tsx
            │       ├── WithWrappers.tsx       (uses Suspense / ErrorBoundary / Profiler / StrictMode in real render tree)
            │       └── CloneElementDemo.tsx
            └── styles/
                ├── app.module.css
                └── index.css                  (Tailwind v4 via @tailwindcss/vite)
```

### 4.1 Layout notes

- **Public API surface:** only `packages/vite/src/index.ts`. Types re-exported by **explicit named re-exports** from `core/types-public.ts` (no `export *` — avoids silent surface expansion).
- **`core/` = zero-deps pure helpers; `babel/` = Babel-coupled; `integration/` = stateful/IO; `plugin.ts` = Vite entry.**
- **Fixture runner** lives under `test/fixtures/`, preserving the "unit = IO-free" invariant.
- **Fixture `--update` gate:** `REDESIGNER_FIXTURE_UPDATE=1` env var + a matching entry in `FIXTURE_CHANGELOG.md` are both required. Enforced by a **Husky** `pre-commit` hook (`.husky/pre-commit` + `simple-git-hooks` alternative noted in `CONTRIBUTING.md` for Husky-averse contributors). CI runs a shell check that `REDESIGNER_FIXTURE_UPDATE` is unset in the job env and that `git diff --name-only HEAD~1` does not show `output.tsx` / `expected-manifest.json` changes without a corresponding `FIXTURE_CHANGELOG.md` change.
- **`.only` / `.skip` leak detection** is enforced by **Biome's `noFocusedTests` (default on) AND `noSkippedTests` (opt-in — explicitly set to `error` in `biome.json`)**. CI also runs `grep -rEn '\.(only|skip)\(' packages/vite/test/ || exit 0` with post-processing to catch uncommon patterns (`describe.only.each`, etc.).
- **Per-directory non-empty assertion** (replacing the fragile test-file count): CI asserts `unit/`, `fixtures/`, and `integration/` each contain ≥1 matching test file. Deletions are caught by this alone; no brittle count file.
- **Fixtures vs. playground edge cases are distinct on purpose.** Fixtures pin transform-level IO. `examples/playground/src/components/edge/` holds runtime examples. Documented in `test/fixtures/README.md`.
- **Playground `edge/*` components are all actually rendered from `App.tsx`** — `MultiComponentFile`, `WithWrappers`, `CloneElementDemo`, `DataFetcher` (with real data, not mocked) all reach the DOM under integration test.
- **`manifestWriter.ts` exposes internal-only `onFlush` + `quiesce`** (not re-exported). `quiesce` forces a flush and resolves after it lands — decoupled from `debounce` / `maxWait` tuning.
- **`daemonBridge.ts` accepts an injected importer function.** Production wiring uses `(() => import('@redesigner/daemon'))`; tests pass their own. A dedicated `daemon-real.test.ts` exercises the production path against a real fixture package.

### 4.2 Build toolchain

- **Bundler: `tsup`** produces `dist/index.js` (ESM-only) + `dist/index.d.ts`.
- **Schema generation:** `scripts/generate-schema.ts` invokes `ts-json-schema-generator` against `core/types-public.ts`, writing `dist/manifest-schema.json`.
- **Scripts in `packages/vite/package.json`:**
  ```json
  {
    "scripts": {
      "build": "pnpm run build:schema && tsup",
      "build:schema": "tsx scripts/generate-schema.ts",
      "typecheck": "tsc --noEmit",
      "test": "vitest run",
      "test:fixtures": "vitest run test/fixtures",
      "lint": "biome check ."
    }
  }
  ```
- **Prepublish guard.** `prepublishOnly` runs `build + typecheck + test`, but `"private": true` on the package is the authoritative escape hatch for v0 — an accidental `npm publish` is rejected by the registry itself.

### 4.3 CI workflow sketch

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
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: |
          corepack --version
          # Fail fast if Corepack is pre-0.31.0; mitigation instructions in CONTRIBUTING.md
          corepack enable
      - uses: actions/cache@v4
        with:
          path: |
            ~/.local/share/pnpm/store
            ~/AppData/Local/pnpm/store
          key: pnpm-${{ matrix.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm install --frozen-lockfile --strict-peer-dependencies
      - run: pnpm -r run lint
      - run: pnpm -r run typecheck
      - run: pnpm -r run test
      - name: "fixture update guard"
        run: |
          test -z "$REDESIGNER_FIXTURE_UPDATE" || (echo "REDESIGNER_FIXTURE_UPDATE set in CI" && exit 1)
      - name: "no .only / .skip"
        run: |
          ! git grep -En '\b(describe|it|test)\.(only|skip)\b' -- 'packages/*/test' || exit 1
```

Branch protection on `main` is enforced by the committed ruleset (`.github/rulesets/main-protection.json`) — NOT by a workflow file. The ruleset specifies `ci / test (windows-2022, 22)` as a required status check. The ruleset JSON is synced to GitHub via `gh api --method PUT /repos/.../rulesets/...` in a separate setup step (documented in `CONTRIBUTING.md`, not automated in CI).

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
    │  • toPosixProjectRoot(config.root) → normalized projectRoot (throws only if unnormalizable)
    │  • Resolve manifestPath = path.posix.resolve(projectRoot, options.manifestPath ?? '.redesigner/manifest.json')
    │      → reject if resolved path escapes projectRoot
    │  • runtimeDetect: esbuild.jsx → plugin-react → tsconfig (hint only). Classic (authoritative) → throw.
    │      Classic only in tsconfig but esbuild/plugin-react automatic → debug log, proceed.
    │  • ManifestWriter(projectRoot, manifestPath, options, clock):
    │      - mkdirSync(dirname(manifestPath), { recursive: true })
    │      - startup tmp sweep: unlink any `manifest.json.tmp-*` files left over from prior crashes
    │      - overwrite manifest.json with empty manifest { schemaVersion: "1.0", framework: "react", generatedAt: now(), components: {}, locs: {} } (atomic rename)
    │
    ▼
Vite fires configureServer(server)
    │  • If options.daemon === 'off': daemonHandle = null, skip.
    │  • Else ('auto' or 'required'): attempt `await importer()` (injected; production = () => import('@redesigner/daemon'))
    │       ├─ ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED:
    │       │    • if daemon === 'required': throw with actionable message
    │       │    • else ('auto'): logger.warn once; daemonHandle = null
    │       ├─ other error → logger.warn with full stack; daemonHandle = null; CONTINUE (dev server stays up)
    │       └─ success → await mod.startDaemon({ manifestPath, port: options.daemonPort ?? 0 })
    │                   → store handle { pid, shutdown, stdout, stderr }
    │                   → wire pipe-drain: handle.stdout.on('data', buf => logger.info(buf.toString())); same for stderr → warn
    │  • Register teardown on: server.close, SIGINT, SIGTERM
    │      + conditionally: if (process.platform !== 'win32') process.on('SIGHUP', shutdown)
    │      + uncaughtException / unhandledRejection → shutdown then re-throw
    │      (NOT beforeExit — never fires with live daemon)
    │      All paths route through idempotent shutdown(); §5.4
    ▼
Schedule forced initial flush on buildEnd or first idle tick → writer.quiesce()
    ▼
Dev server listens
```

### 5.2 Per-transform (every `.jsx`/`.tsx` Vite serves)

```
Vite calls transform(code, id, options) on our plugin (enforce: 'pre')
    │
    ▼
Environment-aware skip:
    if this.environment && this.environment.name !== 'client': return undefined
    else if options?.ssr === true: return undefined   (Vite 5 fallback)
    │
    ▼
Filter: id matches include/exclude globs and ends in .jsx or .tsx
    │  (no match → return undefined)
    ▼
toPosixRelative(id, projectRoot) → relPath
    │  (on failure → logger.warn once per file; skip visitor; return undefined. NEVER throw.)
    ▼
Build an empty transform-local batch object
    │
    ▼
Invoke @babel/core.transformAsync(code, {
    plugins: [redesignerBabelPlugin({ relPath, batch })],
    sourceMaps: true,
    inputSourceMap: true,
    configFile: false,             // do NOT consult user's babel.config.*
    babelrc: false                 // do NOT consult user's .babelrc
})
    │
    ▼
Babel visitor runs:
    │  1. JSXFragment: skipped. Children visited normally.
    │  2. JSXOpeningElement / JSXSelfClosingElement:
    │     a. If element name resolves to a known wrapper component (core/wrapperComponents.ts),
    │        skip attribute injection. Children visited normally.
    │     b. Else: wrap case body in try/catch.
    │        On throw → logger.warn with file:line; skip this node; continue.
    │  3. Walk up AST to enclosing component (resolveEnclosingComponent):
    │     • unwrap `memo(X)`, legacy `forwardRef(...)`
    │     • ref-as-prop: resolves normally
    │     • anonymous default → PascalCase(basename(relPath))
    │     • JSX transitively inside a non-component helper → attributed to the enclosing component
    │     • JSX at module scope (no enclosing function) → componentName "(module)", componentKey `relPath + '::(module)'`
    │     • Literal-false-guarded dead code → skip silently
    │     • Third-party HOCs → assignment-target name (not unwrapped)
    │  4. componentKey = relPath + '::' + componentName
    │     (format is stable under minor schema bumps; consumers MAY split)
    │  5. locString = formatLoc(relPath, line, col)  →  "src/components/Button.tsx:12:4"
    │  6. batch.components[componentKey] = { filePath, exportKind, lineRange, displayName }
    │     batch.locs[locString] = { componentKey, filePath, componentName }
    │  7. Inject <jsx-element data-redesigner-loc="..." ...> attribute
    ▼
Babel returns { code, map }
    │
    ▼
Vite plugin returns { code: result.code, map: result.map }  (explicit; not bare string)
    │
    ▼
writer.commitFile(relPath, batch):
    │  • newState = state.set(relPath, batch)  (compare-and-swap; per-file replace)
    │  • Schedule debounced flush (200 ms debounce, 1000 ms maxWait-from-first-commit; trailing edge only)
    ▼
plugin-react (or plugin-react-swc / plugin-react v6) receives { code, map }, does its JSX transform.
    ▼
Browser loads page → React renders → DOM elements carry data-redesigner-loc.
```

### 5.3 HMR

```
User edits src/components/Button.tsx
    │
    ▼
Vite invalidates the module graph. Affected files re-run through transform() (cascade).
    │  Each re-transformed file triggers its own writer.commitFile(relPath, freshBatch).
    ▼
Debounced flush fires (maxWait measured from first commit since last flush) → atomic same-dir rename
    │
    ▼
Writer post-flush re-check: if in-memory state identity changed since snapshot, re-schedule flush
    │
    ▼
(Out of scope — daemon watches manifest.json, reloads.)
    ▼
Vite HMR pushes new module to browser → React re-mounts (Fast Refresh preserves state for leaf edits) → new attributes on rerendered elements
```

### 5.4 Shutdown

All termination paths route through an idempotent `shutdown()`. Registered on: `server.close`, `SIGINT`, `SIGTERM`; + `SIGHUP` only if `process.platform !== 'win32'`; + `uncaughtException` / `unhandledRejection` (which re-throw after teardown). **NOT `beforeExit`** (never fires with a live daemon).

```
shutdown() — idempotency flag check; second call returns immediately
    │
    ▼
1. writer.flushSync() — fs.writeFileSync wrapped in try/catch;
       on EBUSY/EPERM: exponential backoff (50, 100, 200, 400, 800 ms)
       on final failure: console.error (config.logger may be torn down)
       Upper bound ~1.55 s added to shutdown under worst-case AV hold.
    │
    ▼
2. If daemonHandle: daemonHandle.shutdown() — platform-branched:
       │
       ├─ POSIX:
       │     send SIGTERM
       │     wait up to 2 s
       │     if still alive: kill('SIGKILL') + logger.warn
       │
       └─ Windows:
             write graceful shutdown message to handle.stdin  (stdin MUST be a 'pipe', per §3.2 daemon spawn contract)
             wait up to 2 s
             if still alive: spawn `taskkill /T /F /PID ${handle.pid}` (tree-kill)
             if taskkill exits non-zero: logger.warn; manual cleanup may be required
```

Abnormal termination (parent SIGKILL'd) cannot be cleaned up from our side. The daemon is responsible for detecting parent death via a `ppid` watchdog (its own spec).

---

## 6. Public API surface

### 6.1 Entry point

```ts
// packages/vite/src/index.ts
import type { Plugin } from 'vite'
import type {
  Manifest,
  ComponentRecord,
  LocRecord,
  RedesignerOptions,
} from './core/types-public'

export interface RedesignerOptions {
  manifestPath?: string               // relative to projectRoot; absolute & escaping paths rejected
  include?: string[]                  // default: ['**/*.{jsx,tsx}']
  exclude?: string[]                  // default: ['node_modules/**', '**/*.d.ts']
  enabled?: boolean                   // default: true in dev (apply: 'serve'), false in build
  daemon?: 'auto' | 'required' | 'off'  // default: 'auto'
  daemonPort?: number                 // default: 0 (OS-assigned)
}

export default function redesigner(options?: RedesignerOptions): Plugin

// Explicit named re-exports (no export *; stable surface only):
export type { Manifest, ComponentRecord, LocRecord, RedesignerOptions }
```

`daemon` interpretation:
- `'auto'` (default) → attempt autostart; on `ERR_MODULE_NOT_FOUND` | `ERR_PACKAGE_PATH_NOT_EXPORTED`, quiet-warn and continue.
- `'required'` → attempt; missing daemon package → throw with actionable message.
- `'off'` → never attempt.

### 6.2 User-facing usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import redesigner from '@redesigner/vite'

export default defineConfig({
  plugins: [react(), redesigner()],
})
```

Position does not matter relative to plugins without `enforce`. If another `enforce: 'pre'` plugin also transforms JSX/TSX, declaration order governs — README recommends declaring `redesigner()` before any such plugin. Tailwind v4's `@tailwindcss/vite` operates on CSS, so no ordering concern.

### 6.3 Manifest shape (exported types + shipped JSON Schema)

```ts
// packages/vite/src/core/types-public.ts
export interface Manifest {
  schemaVersion: `${number}.${number}`  // string semver; see evolution rules
  framework: 'react'
  generatedAt: string                   // new Date().toISOString() — UTC with Z suffix
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string                      // project-relative, posix separators
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  componentKey: string                  // format is stable; consumers MAY split on '::'
  filePath: string                      // same as ComponentRecord.filePath
  componentName: string                 // readable component name
}
```

**Schema version evolution rules (part of the contract):**

- `schemaVersion` is `"<major>.<minor>"` (template-literal type to allow minor bumps without breaking narrowing). Current: `"1.0"`.
- **Additive** (new optional field, new object entry) → **minor bump**. Consumers MUST accept unknown fields.
- **Breaking** (remove field, rename field, change type, change value semantics) → **major bump**. Consumers MUST reject on major mismatch.
- On minor-ahead (consumer saw `1.0`, manifest is `1.2`) → warn but continue.
- On parse failure, consumers SHOULD retry once after 50 ms — covers the rename-in-progress window.

**`projectRoot` intentionally absent from the published schema** (leaks filesystem layout).

**`componentKey` format is stable** across minor bumps: `relPath + '::' + componentName`. Consumers MAY split on `'::'` and do so will continue to work. Structured `LocRecord.filePath` + `LocRecord.componentName` fields are the primary consumer-facing surface; `componentKey` is the join-key equivalent.

**No `$schema` URL in v0 manifests.** Nothing published yet → URL would 404. Consumers locate the schema via `@redesigner/vite/manifest-schema.json`.

JSON Schema (`manifest-schema.json`, draft-2020-12) is generated at build time from `core/types-public.ts` via `ts-json-schema-generator`. Single source of truth is the `.ts` file.

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
    "./manifest-schema.json": "./dist/manifest-schema.json"
  },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20.11.0" },
  "peerDependencies": {
    "vite": "^5 || ^6 || ^7",
    "@vitejs/plugin-react": "^4 || ^5 || ^6"
  },
  "peerDependenciesMeta": {
    "@vitejs/plugin-react": { "optional": true }
  },
  "dependencies": {
    "@babel/core": "^7",
    "@babel/parser": "^7",
    "@babel/traverse": "^7",
    "@babel/types": "^7",
    "proper-lockfile": "^4"
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

Root-level `package.json`:
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

- **ESM-only.** No `require` conditional export.
- **`"private": true` + `"publishConfig"`.** Accidental `npm publish` in v0 is rejected by the registry itself. When v1 lands, flip `private: false` deliberately.
- **`@redesigner/daemon` is NOT in any deps field.** Runtime dynamic `import()` handles presence; users install explicitly: `pnpm add -D @redesigner/daemon`.
- **Vite peer range `^5 || ^6 || ^7`.** Vite 8 is unreleased at spec time; compatibility is a roadmap note, not a peer claim. Widened once a real integration test passes.
- **Corepack enforces `packageManager`.** `CONTRIBUTING.md` instructs `corepack enable` and requires Corepack ≥0.31.0. CI first step: `corepack --version` check then `corepack enable`. Behind corporate proxy with MITM, `COREPACK_NPM_REGISTRY` + `NODE_EXTRA_CA_CERTS` environment variables are documented in `CONTRIBUTING.md`.
- **`proper-lockfile`** for the cross-instance-writer lock (§3.2 layer 3).

### 6.5 User-visible messages

All prefixed `[redesigner]`. Routed through `config.logger`.

| Severity | Example | When |
|---|---|---|
| `error` | "manifestPath escapes projectRoot" | Misconfigured options; thrown from `configResolved` |
| `error` | "classic JSX runtime detected (authoritative source); v0 requires automatic runtime" | Thrown from `configResolved` |
| `error` | `daemon: 'required'` but package missing | Thrown from `configureServer` |
| `warn` | Daemon package not installed (`daemon: 'auto'`) | One-time; quiet |
| `warn` | Daemon `startDaemon()` threw on import | Logged with stack; plugin continues in manifest-only mode (deliberately NOT `error` to avoid training users to ignore red) |
| `warn` | Transform / path-guard error for a single file | One-time per file |
| `warn` | Per-node visitor exception | With `file:line` |
| `warn` | Atomic rename retried past threshold (≥2 retries) before success | Signals Windows AV interference |
| `warn` | Shutdown flush retried after EBUSY | Once per shutdown |
| `info` | First successful manifest write | One-time |
| `debug` | Per-transform timings; non-client environment skip; `@vitejs/plugin-react` absent; classic runtime only in tsconfig | Behind `DEBUG=redesigner:*` |

### 6.6 Consumer reader contract

Published alongside the package as `dist/reader-contract.md`. Canonical read algorithm for third-party tools (and our own future daemon/MCP consumers):

1. **Open:** `await fs.readFile(manifestPath, 'utf-8')`.
2. **Parse failure** (e.g., rename-in-progress window): sleep 50 ms, retry once. Second failure → treat as unavailable, poll or fall back.
3. **Validate:** parsed JSON against `manifest-schema.json`.
4. **Version check:** `schemaVersion` split on `.` →
   - Major mismatch with consumer's supported major → reject. Do not attempt partial parsing.
   - Minor ahead (manifest minor > consumer's known minor) → warn, continue. Consumer MUST accept unknown fields.
5. **Watch recommendation:** `fs.watch` fires reliably on POSIX after atomic rename but is flaky on Windows + SMB. Recommend poll (250–500 ms) as the safe default; `fs.watch` as an optimization on POSIX local FS.
6. **No mtime-based incremental parsing.** Always read full file; the manifest is small enough (<10 MB even for large projects) that delta-parsing is not worth the complexity.

---

## 7. Error handling & failure modes

| # | Trigger | Detected in | Handling | User sees | Test |
|---|---|---|---|---|---|
| 1 | `manifestPath` escapes projectRoot | `configResolved` | Throw | Dev server fails to start, clear message | unit |
| 2 | `manifestPath` absolute | `configResolved` | Throw | Same | unit |
| 3 | projectRoot cannot be normalized by `toPosixProjectRoot` | `configResolved` | Throw ("plugin bug — please report") | Dev server fails to start | unit |
| 4 | Classic JSX runtime detected via esbuild/plugin-react (authoritative) | `configResolved` | Throw | Dev server fails to start | unit |
| 4b | Classic only in tsconfig but esbuild/plugin-react automatic | `configResolved` | `debug` log, proceed | None at default log level | unit |
| 5 | `@vitejs/plugin-react` absent, SWC plugin present | `configResolved` | `debug` log | None | integration |
| 6 | Daemon import → `ERR_MODULE_NOT_FOUND` \| `ERR_PACKAGE_PATH_NOT_EXPORTED`, `daemon === 'auto'` | `configureServer` | `warn` once; `daemonHandle = null`; continue | One-line yellow warning | unit + `daemon-real.test.ts` |
| 6b | Same, `daemon === 'required'` | `configureServer` | Throw | Dev server fails to start | unit |
| 7 | Daemon import → other error | `configureServer` | `warn` with stack; `daemonHandle = null`; continue (NOT `error`; avoids ignore-the-red training) | Yellow warning; dev server continues | unit |
| 7b | Daemon handle returned but `stdout`/`stderr` not pipes | `configureServer` | Throw with actionable message (daemon contract violation) | Dev server fails to start | unit |
| 8 | Per-file path normalization fails | `transform` | `warn` once per file; skip visitor; return `undefined`; never throw | Per-file warning | unit |
| 9 | Babel parser fails on whole file | `transform` | `warn`; return `undefined` | Per-file warning | fixture: `malformed-jsx/` |
| 10 | Per-node visitor exception | Babel plugin | Per-visitor-case try/catch; `warn` with file:line; skip that node; continue | Per-node warning | fixture: `pathological-node/` |
| 11 | Literal-false-guarded dead-code JSX | Babel plugin | Skip silently | None | fixture: `dead-code-jsx/` |
| 11b | JSX inside a non-component helper but transitively within a component | Babel plugin | Attribute to the outer component | None | fixture: `inline-jsx-in-callback/` |
| 11c | JSX at module scope | Babel plugin | Synthetic `(module)` component | None | fixture: `module-scope-jsx/` |
| 11d | JSXFragment (`<>`) | Babel plugin | Skip the Fragment; children visited | None | fixture: `fragment-noop/` |
| 11e | JSX opening element resolves to Fragment/Suspense/ErrorBoundary/Profiler/StrictMode | Babel plugin | Skip the element; children visited | None | fixture: `wrapper-components-noop/` |
| 11f | Ambiguous wrapper-component identity (dynamic `React[x]`) | Babel plugin | Inject; accept potential runtime warning | Potential React dev warning | documented in README |
| 12 | Writer state contention | `manifestWriter` | N/A — immutable map + CAS + post-flush re-check | None | (design) |
| 12b | Overlapping re-transform of same file | `manifestWriter` | Per-file replace wins | None | unit + parallelism.test.ts |
| 12c | Commit lands during disk rename | `manifestWriter` | Post-flush re-check re-schedules | None | unit |
| 13 | Disk write fails (EACCES, ENOSPC) | `manifestWriter` flush | `error` log; retry next debounce tick; after 3 consecutive → `warn` escalating | Red error then warning | unit (mock fs) |
| 14 | Atomic rename fails with `EPERM`/`EBUSY` | `manifestWriter` flush | Exponential backoff (50, 100, 200, 400, 800 ms), 5 attempts; on final failure `warn` and continue | Yellow warning only past retry threshold | unit (mock throws EPERM 2×) + CI matrix |
| 14b | `EXDEV` (cross-device) | `manifestWriter` flush | Should never occur (temp always same-dir). If observed, log `error` + paths | Red error (indicates plugin bug) | unit |
| 14c | Cross-instance lock contention (two Vite apps same manifestPath) | `manifestWriter` | `proper-lockfile` serializes renames; each write waits up to 1 s for lock | None | unit |
| 14d | Orphaned `manifest.json.tmp-*` from prior crash | `manifestWriter` constructor | Startup sweep unlinks | None | unit |
| 15 | Shutdown before debounce flush | shutdown() | `fs.writeFileSync` + exponential backoff on EBUSY/EPERM; fall back to `console.error` | None (clean) | integration |
| 16 | POSIX: daemon didn't die after SIGTERM + 2 s | Teardown | `kill('SIGKILL')`; `warn` | Yellow warning | unit (real subprocess) |
| 16b | Windows: daemon didn't exit after stdin graceful + 2 s | Teardown | `taskkill /T /F /PID <pid>`; `warn` on non-zero exit | Yellow warning | unit (real subprocess, Windows-only) |
| 16c | Windows: `handle.stdin` absent or closed | Teardown | Fall straight to `taskkill`; `warn` "stdin unavailable" | Yellow warning | unit |
| 17 | Teardown fires twice | All teardown paths | Idempotency flag | None | unit |
| 18 | Vite config reload during dev | Plugin reinit | Old instance's shutdown fires; new instance starts fresh | Normal Vite reload messaging | integration: `reinit.test.ts` |
| 19 | Non-client Vite environment transform | `transform` | Return `undefined` (no Babel, no commit) | None | integration + fixture: `environment-skip/` |
| 20 | `.redesigner/` missing on fresh clone | `ManifestWriter` constructor | `mkdirSync({ recursive: true })` | None | unit |
| 21 | Attempted SSR render of playground | `hydration-safety.test.ts` | Playground renders only on client; SSR attempt is test-locked to fail early | None (test invariant) | integration: `hydration-safety.test.ts` |

### 7.1 Non-goals (error handling)

- No recovery from a partially written manifest (atomic rename + retry makes this recoverable or loud).
- No user-configurable log levels beyond Vite's `--logLevel`.
- No telemetry, no remote error reporting, no auto-update / version-check ping.

---

## 8. Testing plan

Three tiers, Vitest throughout. `fast-check` for roundtrip properties.

### 8.1 Unit tests — `test/unit/`

**Invariant: pure or mocked-IO. No real subprocesses. No real Vite servers.**

| File | Coverage |
|---|---|
| `locFormat.test.ts` | Roundtrip + fast-check property. Arbitrary explicitly declared as `fc.string().filter(s => s.length > 0 && !/[\r\n\x00-\x1f]/.test(s))` — excludes newlines and control chars; includes unicode, spaces, embedded colons. |
| `pathGuards.test.ts` | `toPosixProjectRoot` normalizes Windows-native paths (`C:\...` → `C:/...`), does NOT throw on them. `toPosixRelative`, escape guards. |
| `runtimeDetect.test.ts` | Precedence (esbuild → plugin-react → tsconfig). Mismatch cases (tsconfig classic, esbuild automatic → debug). |
| `wrapperComponents.test.ts` | Skip list identification including alias-imports (`import { Fragment as F } from 'react'`). |
| `resolveEnclosingComponent.test.ts` | AST walk for each component shape. |
| `plugin.test.ts` | Lifecycle; options merging; configResolved throws on bad config; **user's `babel.config.js` is NOT consulted by our pass** (asserted by mocking `configFile`/`babelrc` detection); environment-aware skip. |
| `manifestWriter.test.ts` | CAS per-file replace. Startup empty-write + mkdir-p + tmp sweep. Debounce + maxWait-from-first-commit. Post-flush re-check triggers re-schedule. Exponential-backoff retry on mock EPERM/EBUSY (5 attempts, 50/100/200/400/800 ms). EXDEV never occurs. Cross-instance lock via `proper-lockfile`. `onFlush` monotonic seq. `quiesce` forces flush + resolves after. |
| `daemonBridge.test.ts` | Injected importer: (a) ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED, `auto` → warn; (b) same, `required` → throw; (c) generic import error → warn + continue; (d) success → pipe drain wired on stdout+stderr immediately; (e) teardown idempotency; (f) POSIX SIGTERM→SIGKILL; (g) Windows stdin graceful → taskkill (runs on Windows-only); (h) SIGHUP registered only on non-win32; (i) `beforeExit` NOT registered; (j) startDaemon contract enforcement (pid, shutdown, stdout, stderr). |

### 8.2 Fixture tests — `test/fixtures/`

On-disk `input.tsx` / `output.tsx` / `expected-manifest.json` triples. Regeneration gated by `REDESIGNER_FIXTURE_UPDATE=1` + `FIXTURE_CHANGELOG.md` entry. Husky `pre-commit` hook enforces; CI also asserts.

Cases include everything in §4 layout's `fixtures/` subtree. Each directory has a `README.md` stating what the case proves.

`compiler-hoist-order/` is special: the fixture runs the Babel plugin against input that already contains React Compiler `_c[n] =` cache slots (the compiler runs after us per `enforce: 'pre'`, but the fixture simulates both orders to prove our attribute lands on the raw JSX and is preserved when the compiler hoists).

### 8.3 Integration tests — `test/integration/`

Real Vite dev server, real playground. Per-test tmpdir via `fs.mkdtemp`. **`parallelism.test.ts` forces `{ pool: 'forks', isolate: true, fileParallelism: false }` via a dedicated `vitest.parallelism.config.ts`** (Vitest workers-within-file otherwise share signal-handler registry + module-level singletons; `fs.mkdtemp` alone does not isolate those).

| File | Coverage |
|---|---|
| `vite.test.ts` | DOM assertions (no count-match): (a) every rendered DOM element within `#root` carries `data-redesigner-loc` (excluding mount, text-only Fragment wrappers, and wrapper-component subtrees per §3.3 invariant 9); (b) every value parses and resolves to a manifest entry; (c) hardcoded-loc spot set: `PricingCard × 4`, `Button × N`, `DataFetcher`, `Row` (inside render prop), `module-scope <App />` attributed to `(module)`, `WithWrappers` tree. Failure messages name missing components. |
| `manifest.test.ts` | Schema validation; consumer reader contract (retry-once on parse failure, major-reject, minor-ahead-warn). |
| `hmr.test.ts` | **Uses `server.waitForRequestsIdle` + `writer.quiesce` + Vite `hmr` update event counting**: subscribes to `server.ws`, records update messages with a counter, awaits an expected count. Scenarios: (1) prepend line to `Button.tsx`; (2) rename component; (3) two-file cascade: edit Button and PricingCard in rapid succession; assert both files' entries accurate. **(4) Fast Refresh state preservation:** playground component mounts a `useState` counter, test increments via DOM event, edits an unrelated leaf JSX in that same component, assert state survived (counter value preserved). |
| `environment-skip.test.ts` | (a) `server.transformRequest(url, { ssr: true })` → no attribute. (b) If Vite 6+ Environments API present, simulate a server environment by calling `server.environments.ssr?.transformRequest` → no attribute. (c) `server.ssrLoadModule` + `renderToString` → rendered HTML contains no `data-redesigner-loc`. |
| `react-compiler.test.ts` | `babel-plugin-react-compiler` enabled in playground. (a) First render has attribute. (b) Attribute survives a prop-change re-render (memoization doesn't stale it). (c) HMR edit to a component updates the attribute (no stale-memoization regression). |
| `sourcemap.test.ts` | Column accuracy: fetch transformed source, parse its map with `source-map`. For a token past the injection point on the same JSX opening, `originalPositionFor` maps back to the original column within ±0. Line accuracy also asserted. |
| `reinit.test.ts` | Touch `vite.config.ts`; assert old writer's shutdown fires; new writer instance flushes empty manifest; `process._getActiveHandles()` count stable before/after; no duplicate daemon. |
| `parallelism.test.ts` | Runs under the dedicated parallelism config. 10 parallel `transform` calls across distinct files; assert final manifest contains all 10 with no lost writes. Handle-count stability check. |
| `degradation.test.ts` | Injected importer: (a) `daemon: 'off'` → no attempt, silent. (b) importer throws generic error → warn, plugin continues. (c) `daemon: 'required'` + missing → dev server fails to start. (d) Corrupt source file mid-server → warn, plugin continues. |
| `daemon-real.test.ts` | **Real production-path test.** A fixture package at `test/fixtures/fake-packages/@redesigner/daemon/` with three variants: (i) throws on import → production dynamic import reports `ERR_MODULE_NOT_FOUND`; (ii) exports nothing → `ERR_PACKAGE_PATH_NOT_EXPORTED`; (iii) top-level-await that never resolves → timeout caught. This catches ESM module-cache poisoning the injected-importer tests bypass. |
| `hydration-safety.test.ts` | Locks the "client-only" premise: attempt to `renderToString(<App />)` — must throw a clear error before silently emitting attributes into server HTML. Future SSR spec must update this test deliberately, which forces a design decision. |
| `shutdown.test.ts` | **Real subprocess** fake daemon (`test/fixtures/fake-packages/fake-daemon/index.js`, spawned explicitly as `['node', path]` with `stdio: ['pipe','pipe','pipe']`; stdin reads line-delimited JSON). POSIX: SIGTERM → subprocess responds → flush clean. Escalation: subprocess ignores → 2 s → SIGKILL. Windows (skip on non-Windows): write `{"op":"shutdown"}\n` to stdin → subprocess exits; if subprocess ignores → `taskkill /T /F` invoked, process tree terminated. Idempotency: call shutdown twice, only one flush, only one signal/taskkill. |

### 8.4 CI matrix (ships with this spec)

- **GitHub Actions:** `.github/workflows/ci.yml` per sketch in §4.3.
- **Matrix:** Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 (exact minimum floor) + Node 22 current LTS. Pinned OS labels for reproducibility.
- **Concurrency group** cancels stale pushes.
- **pnpm store cache** (`actions/cache` keyed on lockfile + OS).
- **`corepack --version` preflight** + `corepack enable` + `pnpm install --frozen-lockfile --strict-peer-dependencies`.
- **Per-job timeout: 15 minutes** (prevents a stuck Windows test from consuming the 6 h default).
- **Biome (lint + `noFocusedTests=error` + `noSkippedTests=error`)**, typecheck, unit, fixtures, integration — all tiers on every matrix cell (Windows-only branches scoped via `if (process.platform === 'win32')` in the test itself).
- **Fixture-update guard** (CI env assertion that `REDESIGNER_FIXTURE_UPDATE` is unset).
- **`.only` / `.skip` grep** as a secondary check.
- **Per-directory non-empty assertion** (each of `unit/`, `fixtures/`, `integration/` must contain ≥1 `.test.ts` file; catches accidental deletion without a brittle count file).
- **Required status checks via committed GitHub ruleset** (`.github/rulesets/main-protection.json`), synced out-of-band with `gh api --method PUT`. Documented in `CONTRIBUTING.md`. Ruleset names the Windows-2022 + Node 22 job as required; no "required-checks workflow file" fiction.
- **Integration test transform-time breadcrumb** becomes a **loose gate**: fails if total playground transform time exceeds **30 s** on any matrix cell. Prevents silent regression; ceiling is high enough not to be flaky.

### 8.5 Non-goals (testing)

- No Playwright / real-browser E2E.
- No performance benchmarks as hard gates beyond the 30 s transform-time ceiling.
- No DOM snapshot of entire playground.
- No coverage-threshold gate. Deliberate per-tier + per-case coverage instead.

---

## 9. Open questions (carried forward)

From brief §152–157. None block this spec.

- **Daemon ↔ extension protocol** — decide in daemon spec.
- **HMR granularity beyond file-level** — out of scope; plugin does per-file replace, daemon spec handles consumer reload.
- **Port discovery** — daemon spec decision. Plugin passes `daemonPort` through (default 0).
- **Product name** — still TBD. Codename `redesigner` is internal.

---

## 10. Appendix — decision log

Key decisions from brainstorming + two rounds of panel review:

1. **Spec scope = Vite plugin + playground only** (brief build order 1 + 2).
2. **pnpm workspaces + Biome + `engine-strict`.** Corepack ≥0.31.0 required.
3. **`@vitejs/plugin-react` companion,** plugin is independent (self-contained Babel pass; `configFile: false, babelrc: false`).
4. **DOM attribute: `data-redesigner-loc`** (namespaced). Format: `"relPath:line:col"`, project-relative, posix. `parseLoc` helper exported from core.
5. **Manifest schema:** `schemaVersion` template-literal `"<number>.<number>"`; additive=minor, breaking=major; consumers accept unknown fields; retry-once on parse failure; `componentKey` stable-format (consumers MAY split); `projectRoot` not in manifest; no `$schema` URL in v0.
6. **Codename `redesigner`, rename accepted.**
7. **Dev-only (`apply: 'serve'`)**, `enabled` flag as escape hatch.
8. **Zero-config factory default export.** `daemon: 'auto' | 'required' | 'off'` + `daemonPort?: number`.
9. **Daemon cross-cut via injected importer.** Discriminated ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED vs other error. Never rethrow into dev-server startup for `auto` mode. `daemon-real.test.ts` covers real-production-path edge cases the injected-importer tests bypass.
10. **React 19 + automatic JSX runtime only.** Classic = hard error at startup. Runtime detection precedence: esbuild → plugin-react → tsconfig (hint only).
11. **Independent Babel pass with `enforce: 'pre'`**, `sourceMaps: true`, `inputSourceMap: true`, `configFile: false`, `babelrc: false`. Returns `{ code, map }` explicitly.
12. **Immutable map + per-file replace CAS + post-flush re-check.** No mutex. Closes commit-during-rename window.
13. **Empty-manifest write + startup tmp sweep + `mkdir -p`** at startup.
14. **Per-visitor-case try/catch** for node-level resilience.
15. **Wrapper-component skip list.** `JSXFragment`, `React.Fragment`, `Fragment`, `Suspense`, `ErrorBoundary`, `Profiler`, `StrictMode` — no attribute injection; children visited normally. Ambiguous dynamic identity accepts the runtime warning.
16. **Module-scope JSX attributed to synthetic `(module)` component** (parentheses, not angle brackets).
17. **HOC unwrap policy:** only React's official transparent wrappers (`memo`, legacy `forwardRef`). Third-party HOCs keep the assignment-target name.
18. **Environment-aware skip.** Vite 6+ `this.environment.name !== 'client'` or Vite 5 `options.ssr === true` → no Babel pass, no commit. SSR / RSC / hydration is explicitly post-v0.
19. **No telemetry, no update-check.**
20. **ESM-only for v0.**
21. **Full CI matrix ships with this spec** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 + Node 22, pnpm 9.15.4 via Corepack ≥0.31.0).
22. **Required status checks via committed GitHub ruleset JSON**, not a workflow file (`required-checks.yml` is fiction).
23. **Platform-aware shutdown.** POSIX: SIGTERM → 2 s → SIGKILL. Windows: stdin graceful → 2 s → `taskkill /T /F`. SIGHUP registered only on non-Windows (prevents CTRL_CLOSE_EVENT deadlock). `beforeExit` NOT registered (never fires with live daemon).
24. **Daemon contract.** `startDaemon()` returns `{ pid, shutdown, stdout, stderr }`. Pipes drained immediately to logger. `stdio: ['pipe','pipe','pipe']` required so Windows shutdown can write to stdin.
25. **Windows-aware atomic write.** Same-directory temp. Exponential-backoff retry on EPERM/EBUSY (50, 100, 200, 400, 800 ms = ~1.55 s ceiling). Startup tmp sweep.
26. **Cross-instance writer lock** via `proper-lockfile` for the monorepo-two-Vite-apps case.
27. **Corepack + exact `packageManager` pin** (`pnpm@9.15.4`). Corepack ≥0.31.0 preflight check. `.npmrc` `engine-strict=true` enforces `engines.pnpm`.
28. **Build toolchain: `tsup` + `ts-json-schema-generator`.** `"private": true` + `"publishConfig"` prevent accidental publish.
29. **Fixture `--update` is gated** by env var + `FIXTURE_CHANGELOG.md` entry + Husky pre-commit + CI assertion.
30. **Property-based test** on `formatLoc`/`parseLoc` roundtrip via `fast-check` with explicit Arbitrary filter (no control chars, no empty strings).
31. **React Compiler compat verified** by integration test covering fresh render, prop-change, and HMR-edit scenarios (stale-memoization regression).
32. **Types split:** `core/types-public.ts` (re-exported) vs `core/types-internal.ts` (not re-exported). Explicit named re-exports only; no `export *`.
33. **`noFocusedTests` + `noSkippedTests` both set to `error` in Biome config.** Per-directory non-empty assertion replaces a brittle expected-count file.
34. **Playground `edge/*` components are all actually rendered from `App.tsx`.** `WithWrappers`, `CloneElementDemo`, `DataFetcher` (real data), `MultiComponentFile` all reach the DOM under integration test. Fast-Refresh state-preservation integration test added.
