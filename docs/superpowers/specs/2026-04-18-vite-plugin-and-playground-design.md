# Vite Plugin + Playground — v0 Design Spec

**Date:** 2026-04-18
**Status:** Draft — pending user review
**Codename:** `redesigner` (product name TBD — see §10 item 6 for rename-cost accounting)

---

## 1. Scope

### 1.1 What this spec covers

First milestone of the v0 roadmap from `brief.md`: the Vite plugin (`@redesigner/vite`) and the playground app (`examples/playground/`), with the monorepo scaffold that hosts them.

Deliverables:

- `@redesigner/vite` — a Vite plugin that injects `data-redesigner-loc` attributes onto every rendered host-element JSX node in dev builds (skipping React wrapper components and module-scope JSX — see §3) and emits a versioned manifest to `.redesigner/manifest.json`. Ships a small optional reader helper (`@redesigner/vite/reader`) that implements the canonical read + retry + version-check algorithm (§6.6) and exports `SUPPORTED_MAJOR`.
- `examples/playground/` — a React 19 + TypeScript + Vite app used to dogfood and test the plugin, exercising children-as-function, module-scope JSX, multi-component files, React 19 ref-as-prop, cloneElement, React 19.2 wrapper components (`Activity`, `ViewTransition`), and Tailwind v4.
- Monorepo scaffold: pnpm workspaces, Biome, shared tsconfig base, `.gitignore`, `.npmrc` (engine-strict), root `README.md` + `CONTRIBUTING.md`, `.editorconfig`, and the **full CI matrix** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 exact + Node 22 current LTS, pnpm 9.15.4 via Corepack ≥0.31.0). Required-status-check enforcement uses a committed GitHub ruleset JSON synced by a dedicated workflow + a stable summary job (§4.3).

### 1.2 What this spec does NOT cover (and why)

| Deferred item | Why out of scope here | Unblocks when |
|---|---|---|
| `@redesigner/daemon` | Brief §154–156 leaves protocol / port / HMR-watch open. Plugin reserves the daemon option contract now (§6.1). | Daemon spec drafted + approved. |
| `@redesigner/mcp` shim | Requires daemon. | Daemon spec complete. |
| Chrome extension | Requires daemon WS protocol; brief §128 sequences it last. | Daemon + MCP both complete. |
| `@redesigner/cli` (`init`) | Writes `.mcp.json` + Vite config snippet. | MCP spec + extension ID allocation. |
| Runtime props, fiber traversal, Vue/Svelte/Next adapters, DevTools panel, extension chat UI, persistence UI, OpenAI backend, variation flows | Explicitly post-v0 per brief §141–150. | Post-v0. |
| SWC plugin wrapper | Deferred per brief. | User ask post-v0. |
| **SSR / RSC / isomorphic-hydration support** | DOM-attribution assumes client-only rendering. | Dedicated SSR spec. |
| **Vite 8 + `@vitejs/plugin-react` v6 (oxc pipeline)** | Unreleased/in-flight at spec time. Peer range for v0 is `^5 || ^6 || ^7` and `@vitejs/plugin-react ^4 || ^5`. Widening is a deliberate follow-up. | Vite 8 stable + plugin-react v6 stable. |
| **Daemon-survives-dev-server-restart** | Daemon lifetime is bound to Vite process lifetime. | Explicit future spec. |

### 1.3 Rationale for the slice

Brief §119–128 walks each upstream dependency forward one step at a time. Step 1 is "Vite plugin against the playground — verify `data-redesigner-loc` appears on rendered DOM elements." Smallest end-to-end testable unit. Every downstream piece assumes this layer is solid.

### 1.4 Validation gate

Complete when all of the following pass:

1. Unit tests green across the CI matrix (Ubuntu 24.04 + Windows Server 2022, Node 20.11.0 + Node 22).
2. Fixture tests green, covering every case in §8.2 (including new cases: `ref-as-prop/`, `fragment-noop/`, `wrapper-components-noop/`, `wrapper-components-react19/`, `wrapper-reexport-chain/`, `memo-to-plain-transition/`, `activity-alias-import/`, `module-scope-jsx/`, `environment-skip/`, `clone-element/`, `compiler-hoist-order/`).
3. Integration tests green, including HMR (single stable final-state assertion), Fast-Refresh state preservation + registration stability + memo↔plain transition, environment-skip, React-Compiler compat, shutdown (POSIX + Windows), re-init, parallelism (≥50 files).
4. Full CI matrix green. A committed **GitHub ruleset** (`.github/rulesets/main-protection.json`) is synced to GitHub by `sync-ruleset.yml` (§4.3) and names a single stable summary job (`ci / all-green`) as the required status check — NOT a matrix-label-coupled name.
5. Playground renders with `data-redesigner-loc` on every rendered **host-element** JSX node, zero React runtime warnings. **These carve-outs are explicitly NOT DOM-tagged (call out prominently in the README's invariants list, not only buried in §3.3):** (a) wrapper components per the skip list, (b) the `(module)` synthetic — module-scope JSX elements will have NO `data-redesigner-loc` on their DOM output; a designer tool clicking a module-root element hits nothing (use `App` as the root instead).
6. `.redesigner/manifest.json` validates against the shipped JSON Schema; `schemaVersion === "1.0"`.
7. Manual dogfood: Chrome DevTools inspection confirms `data-redesigner-loc` on host elements pointing to real source. `(module)` is manifest-only by design.

---

## 2. Premises fixed

- **React 19 only.** React 18 deferred. React Compiler 1.0 compat required.
- **Automatic JSX runtime only.** Classic → hard startup error.

  Classic-runtime detection algorithm (see §5.1):
  1. If `config.esbuild?.jsx` is explicitly set, it is authoritative. Classic → throw with fix hint. Automatic → proceed.
  2. Else if `@vitejs/plugin-react` config is readable, it is authoritative at that level. Classic → throw with fix hint naming plugin-react.
  3. Else tsconfig is a hint only. Classic in tsconfig + authoritative source automatic (or absent) → `debug` log, proceed.
  4. If no authoritative source is readable, assume automatic (Vite default) + `debug` log.
- **`@vitejs/plugin-react` is the default companion,** plugin is independent. Babel pass: `configFile: false`, `babelrc: false`.
- **Client-only rendering.** Any non-client Vite environment is skipped.
- **pnpm workspaces** via Corepack ≥0.31.0. Biome. `.npmrc` `engine-strict=true`.
- **Dev-only transform** (`apply: 'serve'`). `vite build` is always a no-op regardless of `enabled` (apply takes precedence); `enabled` gates within `serve` only.
- **Project-relative paths, posix separators.**
- **DOM-queryable loc is the reason we exist.** `jsxDEV`'s `__source` is not DOM-queryable and not stable across React majors.
- **Daemon lifetime = Vite process lifetime.** `detached: false`, pipe-drain, platform-aware teardown.
- **Codename `redesigner`.** Rename cost at naming time is accepted and explicitly includes: package names, the `.redesigner/` directory, and **the `data-redesigner-loc` DOM attribute name** (a wire-format break for any future consumer).
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
                 │  │ returns pid,     │   │ dir temp, 7-step │   │
                 │  │ shell:false)     │   │ backoff retry,   │   │
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

1. **Vite plugin entry** — owns Vite lifecycle hooks. **Environment state keying:** the plugin keeps a `WeakMap<Environment, ClientState>` where `ClientState` is lazily initialized only for the client environment. `configResolved` binds the client environment reference; `configureServer` initializes the writer and daemon bridge attached to that state. Transforms from other environments short-circuit at the top (§5.2) before touching any state. `buildEnd` forced-flush targets the client environment only; plugin does NOT opt into `perEnvironmentStartEndDuringDev`. Unit test asserts: (a) second environment lookup finds no entry and short-circuits, (b) repeated `configResolved` calls do not re-initialize writer (idempotent on the same client environment instance).

2. **Babel plugin (babel-coupled)** — Babel visitor. `core/` = framework-agnostic helpers. `babel/resolveEnclosingComponent.ts` reasons over Babel AST nodes. Invoked via `@babel/core.transformAsync` with **`configFile: false`**, **`babelrc: false`**, **`sourceMaps: true`**, **`inputSourceMap: false`** (we run at `enforce: 'pre'` — we are the FIRST Babel pass, so there is no prior source map to consume; setting `inputSourceMap: true` would be inert at best and invite a surprise fetch of `//# sourceMappingURL=` comments). Downstream plugin-react consumes OUR map as its input, which is the correct chain.

3. **Manifest aggregator** — collects `componentKey → ComponentRecord` and `loc → LocRecord` entries from transform-local batches. Each Babel pass builds a per-file batch synchronously; commits via `writer.commitFile(relPath, batch)` — a single compare-and-swap replacing `state.get(relPath)` with `batch`.
   - **Post-flush re-check.** After every successful flush, compare current immutable-state identity to the snapshot written; if changed, re-schedule.
   - **Debounce semantics:** 200 ms debounce, 1000 ms maxWait (measured from first commit since last flush). Trailing edge only.
   - **Forced initial flush** after `configureServer` on the client environment's `buildEnd` or first idle tick.
   - **Platform-aware atomic write:** temp file always in same directory as target (`.redesigner/manifest.json.tmp-<pid>-<rand>`).
   - **Exponential-backoff retry on `EPERM`/`EBUSY`**: **7 attempts, delays `50, 100, 200, 400, 800, 1600, 3200 ms` (~6.35 s ceiling)**. Intended to cover most Windows Defender / Search-Indexer windows. Cloud-delivered protection under load can exceed this; §4.3 CI adds a Defender exclusion step for CI runners, and final failure is logged with per-attempt durations at `debug` so tuning PRs have data.
   - **Startup tmp sweep.** Constructor `readdir` + unlink `manifest.json.tmp-*` files.
   - **`mkdirSync(dirname(manifestPath), { recursive: true })`** before first write.
   - **Cross-instance collision is a config error.** Second plugin instance resolving to same `manifestPath` throws at construction (exclusive-flag lock file at `manifestPath + '.owner-lock'`). `proper-lockfile` is NOT a runtime dependency.
   - **Internal-only test hooks:** `onFlush(seq)` + `quiesce()` (forces a flush, resolves after; decoupled from debounce tuning).

4. **Daemon bridge** — optional. Dynamic `import('@redesigner/daemon')` via an injectable importer. Discriminated `try/catch`: `ERR_MODULE_NOT_FOUND` | `ERR_PACKAGE_PATH_NOT_EXPORTED` are quiet-warn; any other error is loud-warn (`.warn` with stack, NOT `.error`) and non-fatal.
   - **`startDaemon()` contract.** Exports `startDaemon({ manifestPath, port }): Promise<DaemonHandle>` where `DaemonHandle = { pid; shutdown; stdout; stdin; stderr }`. `pid` is the top-level spawned process. The daemon **MUST NOT**: (a) double-fork (`taskkill /T` would orphan descendants), (b) spawn via `cmd /c` or any shell wrapper on Windows — spawn with `shell: false` (wraps become the PID parent, the daemon becomes a grandchild, orphaning ensues). Missing required pipes → throw (contract violation).
   - **Pipe drain required** immediately after `startDaemon` resolves (stdout → `logger.info`, stderr → `logger.warn`).
   - **Spawn flags** (contracted): `detached: false`, `shell: false`, `stdio: ['pipe', 'pipe', 'pipe']`.
   - **Platform-aware teardown** (§5.4): POSIX = SIGTERM → 2 s → SIGKILL. Windows = stdin JSON-line `{"op":"shutdown"}` → await ack on stdout (**1500 ms timeout** on hosted CI runners where Defender stalls can exceed 500 ms) → 2 s exit wait → `taskkill /T /F /PID <pid>`.
   - **Teardown registration.** `server.close`, `SIGINT`, `SIGTERM`; `SIGHUP` only on non-Windows (nodejs/node#10165); `uncaughtException` / `unhandledRejection` trigger teardown then re-throw. **NOT `beforeExit`** (never fires with live daemon).

### 3.3 Key design invariants

1. **Environment-aware transform.** `transform(code, id, options)` checks `this.environment?.name` (Vite 6+) and skips unless `'client'`. Falls back to `options?.ssr === true` skip on Vite 5. State is keyed per-environment; non-client transforms never touch writer state.

2. **Independent Babel pass.** `enforce: 'pre'` + `@babel/core.transformAsync({ sourceMaps: true, inputSourceMap: false, configFile: false, babelrc: false })`. Returns `{ code, map }` on success; returns `undefined` if Babel returns `null` (file had no JSX to modify).

3. **Scoped "core" vs. Babel coupling.** `core/` = zero AST/framework deps. `babel/resolveEnclosingComponent.ts` is Babel-coupled.

4. **Compile-time component resolution.** Enclosing-component walk unwraps `memo` + legacy `forwardRef`; ref-as-prop resolves as normal function component; third-party HOCs keep assignment-target name.

5. **Lazy manifest + bounded-staleness cold start.** Forced flush on client `buildEnd` or first idle tick.

6. **Fresh state on every start.** Writer constructor: `mkdirSync(recursive: true)` → startup tmp sweep → overwrite with empty manifest. Atomic same-dir rename with retry.

7. **One-way flow: memory → disk.** Writer never reads back.

8. **Per-file batch replace + post-flush re-check.** CAS takes the full new set; re-check closes commit-during-rename.

9. **Wrapper components get no attribute.** Skip list in `core/wrapperComponents.ts`:
   - `JSXFragment` (`<>…</>`) — always skipped.
   - React built-ins warning on unknown host-attr props: `React.Fragment`, `Fragment`, `Suspense`, `Profiler`, `StrictMode`, `Activity` (React 19.2), `ViewTransition` (React 19.2), `Offscreen` (legacy alias).
   - Userland heuristic (name-only): `ErrorBoundary`. Documented as heuristic; non-wrapper classes named `ErrorBoundary` accept the skip.
   - **Resolution:** matches the JSX opening name against the direct import declaration (covers aliases like `import { Fragment as F }`).
   - **Known limitation — re-export chains.** `import { Suspense } from './my-react-shim'` (where the shim re-exports React) is NOT followed — we resolve only through the direct import. Such a case yields a false-negative (attribute injected on actual Suspense) and a React dev warning. Documented in §3.3.9 / README; fixture `wrapper-reexport-chain/` demonstrates the false-negative so users are not surprised. Module-graph resolution is a post-v0 enhancement.
   - Ambiguous dynamic identity (`React[x]`) → inject; accept warning.
   - Children of Fragments/wrappers are visited normally.

10. **Module-scope JSX attributed to `(module)`.** Synthetic component; MANIFEST-ONLY. Not DOM-tagged. The `(module)` string is a **reserved manifest-key namespace** (not an identifier grammar constraint — JS would never let a user write `function (module)`). The Babel visitor rejects any user-declared component whose resolved `displayName` is the literal `"(module)"` with a clear error. `core/wrapperComponents.ts` comment documents this reservation scope.

11. **Dead-code JSX is strictly literal-false.** No reachability analysis.

12. **User may not name a component `"(module)"` (as a displayName).** Collision detector throws with actionable message.

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
├── .husky/pre-commit                 (fixture-gate + Biome check)
├── .github/
│   ├── scripts/sync-rulesets.mjs     (GitHub REST: POST create, PUT update by name; drift-check mode)
│   ├── workflows/
│   │   ├── ci.yml                    (matrix + concurrency + pnpm store cache via `pnpm store path` + restore-keys + Defender exclusion + 15-min timeout + artifact upload on failure + all-green summary job)
│   │   └── sync-ruleset.yml          (on push to main when .github/rulesets/** changes; PAT; drift-check on schedule; fork-execution guard)
│   └── rulesets/main-protection.json (names "ci / all-green" as required status check — stable name, not matrix-coupled)
│
├── packages/
│   └── vite/                         → @redesigner/vite
│       ├── package.json              ("private": true; "publishConfig": { "access": "restricted" })
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       ├── scripts/generate-schema.ts
│       ├── src/
│       │   ├── index.ts              (default export factory; named re-exports)
│       │   ├── reader.ts             (canonical readManifest; exports SUPPORTED_MAJOR)
│       │   ├── core/
│       │   │   ├── locFormat.ts
│       │   │   ├── pathGuards.ts
│       │   │   ├── wrapperComponents.ts  (Fragment/Suspense/Profiler/StrictMode/Activity/ViewTransition/Offscreen + ErrorBoundary heuristic)
│       │   │   ├── manifestSchema.ts
│       │   │   ├── contentHash.ts    (canonical serialization + sha256; §6.3)
│       │   │   ├── types-public.ts
│       │   │   └── types-internal.ts
│       │   ├── babel/
│       │   │   ├── plugin.ts
│       │   │   └── resolveEnclosingComponent.ts
│       │   ├── integration/
│       │   │   ├── manifestWriter.ts (7-step backoff; per-attempt duration telemetry at debug; startup sweep; collision throw; post-flush re-check; contentHash)
│       │   │   ├── daemonBridge.ts   (injectable importer; shell:false contract; 1500 ms Windows ack; SIGHUP POSIX-only; no beforeExit)
│       │   │   └── runtimeDetect.ts  (ordered algorithm per §2)
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
│       │   │   ├── ref-as-prop/
│       │   │   ├── arrow-const/
│       │   │   ├── anonymous-default/
│       │   │   ├── inline-jsx-in-callback/
│       │   │   ├── hoc-wrapped/
│       │   │   ├── fragment-noop/
│       │   │   ├── wrapper-components-noop/
│       │   │   ├── wrapper-components-react19/
│       │   │   ├── wrapper-reexport-chain/         (documents the false-negative case)
│       │   │   ├── activity-alias-import/          (`import { unstable_Offscreen as Activity }`)
│       │   │   ├── memo-to-plain-transition/       (fixture under --update scenarios documents expected transition)
│       │   │   ├── module-scope-jsx/
│       │   │   ├── environment-skip/
│       │   │   ├── clone-element/
│       │   │   ├── compiler-hoist-order/
│       │   │   ├── children-as-function/
│       │   │   ├── malformed-jsx/
│       │   │   ├── pathological-node/
│       │   │   ├── dead-code-jsx/
│       │   │   ├── null-result/                    (file has no JSX; asserts Babel null → transform returns undefined)
│       │   │   ├── unicode-filename/
│       │   │   ├── filename with spaces/
│       │   │   └── reserved-module-name/
│       │   ├── unit/
│       │   │   ├── locFormat.test.ts
│       │   │   ├── resolveEnclosingComponent.test.ts
│       │   │   ├── pathGuards.test.ts
│       │   │   ├── runtimeDetect.test.ts
│       │   │   ├── wrapperComponents.test.ts
│       │   │   ├── contentHash.test.ts            (canonical serialization + determinism + sorted-key property)
│       │   │   ├── plugin.test.ts
│       │   │   ├── manifestWriter.test.ts
│       │   │   └── daemonBridge.test.ts
│       │   ├── integration/
│       │   │   ├── vite.test.ts                   (+ `querySelectorAll('[data-redesigner-loc*="(module)"]').length === 0` assertion)
│       │   │   ├── manifest.test.ts
│       │   │   ├── hmr.test.ts
│       │   │   ├── fast-refresh.test.ts           (state preservation, registration stability, memo↔plain transition)
│       │   │   ├── environment-skip.test.ts
│       │   │   ├── react-compiler.test.ts
│       │   │   ├── sourcemap.test.ts
│       │   │   ├── reinit.test.ts
│       │   │   ├── parallelism.test.ts
│       │   │   ├── degradation.test.ts
│       │   │   ├── daemon-real.test.ts
│       │   │   ├── hydration-safety.test.ts
│       │   │   └── shutdown.test.ts
│       │   └── vitest.parallelism.config.ts
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
            ├── main.tsx
            ├── App.tsx
            ├── components/
            │   ├── Button.tsx
            │   ├── PricingCard.tsx
            │   ├── PricingSection.tsx
            │   ├── Modal.tsx
            │   ├── DataFetcher.tsx
            │   └── edge/
            │       ├── MemoWrapped.tsx
            │       ├── ForwardRefWrapped.tsx
            │       ├── RefAsProp.tsx
            │       ├── MultiComponentFile.tsx
            │       ├── AnonymousDefault.tsx
            │       ├── WithCallback.tsx
            │       ├── WithWrappers.tsx
            │       ├── WithReact19Wrappers.tsx
            │       └── CloneElementDemo.tsx
            └── styles/
                ├── app.module.css
                └── index.css
```

### 4.1 Layout notes

- **Public API surface:** `index.ts` (factory + named re-exports) + `reader.ts` (canonical reader + `SUPPORTED_MAJOR` export). No `export *`.
- **`core/` = zero-dep; `babel/` = Babel-coupled; `integration/` = stateful/IO.**
- **Fixture `--update` gate** at three levels: Husky pre-commit + CI three-dot diff + Biome rules.
- **Per-directory non-empty assertion** in CI.
- **Playground `edge/*` all actually rendered** from `App.tsx`.
- **`manifestWriter.ts`** exposes internal-only `onFlush` + `quiesce` + `forceFlush`.
- **`daemonBridge.ts`** accepts an injected importer.

### 4.2 Build toolchain

- **Bundler: `tsup`** → `dist/index.js`, `dist/reader.js`, `dist/index.d.ts`, `dist/reader.d.ts` (ESM-only).
- **Schema generation:** `ts-json-schema-generator` → `dist/manifest-schema.json`.
- Scripts: `build` / `build:schema` / `typecheck` / `test` / `test:fixtures` / `test:parallelism` / `lint`.
- `prepublishOnly` runs `build + typecheck + test`; `"private": true` is authoritative escape hatch.

### 4.3 CI + ruleset workflow

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    timeout-minutes: 20   # Windows + Defender exclusion + 50-file parallelism + exact Node 20.11.0 tool-cache miss can approach 12+ min first run.
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2022]
        node: ['20.11.0', '22']
    runs-on: ${{ matrix.os }}
    steps:
      # Defender exclusion runs BEFORE checkout so the thousands of files being
      # written aren't scanned in real-time — saves significant wall time on Windows.
      - name: Windows Defender exclusion (hosted runner)
        if: matrix.os == 'windows-2022'
        shell: pwsh
        run: |
          Add-MpPreference -ExclusionPath "${{ github.workspace }}"
          Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\pnpm\store"
          Add-MpPreference -ExclusionProcess "node.exe"
      - uses: actions/checkout@v4
        with: { fetch-depth: 50 }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - name: Corepack preflight
        shell: bash
        run: |
          # Version check FIRST — independent of Node major. Node 22 early builds
          # also shipped Corepack < 0.31.0; do not trust the matrix cell to imply version.
          V=$(corepack --version || echo "0.0")
          MAJOR=$(echo "$V" | cut -d. -f1)
          MINOR=$(echo "$V" | cut -d. -f2)
          if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 31 ]; then
            echo "Corepack $V below 0.31.0 — upgrading"
            npm install -g corepack@latest
          fi
          corepack enable pnpm
          # Assert the shim is on PATH with the expected version:
          command -v pnpm
          pnpm --version
      - name: Resolve pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v4
        id: pnpm-cache
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          # Include root package.json in the key so a bump of `packageManager`
          # (e.g., pnpm@9.15.4 → 9.16.x) cannot restore a store from a prior minor
          # into a newer client. Lockfile alone does not cover this.
          key: pnpm-${{ matrix.os }}-${{ matrix.node }}-${{ hashFiles('package.json', 'pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-${{ matrix.os }}-${{ matrix.node }}-
            pnpm-${{ matrix.os }}-
      - run: pnpm install --frozen-lockfile --strict-peer-dependencies
      - run: pnpm -r run lint
      - run: pnpm -r run typecheck
      - run: pnpm -r run test
      - run: pnpm --filter @redesigner/vite run test:parallelism
      - name: Fixture update guard (three-dot diff)
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

  # Stable-name summary job — THIS is what the ruleset requires.
  # Matrix label reorders/changes cannot silently orphan the check.
  # `if: always()` ensures the check reports even if `test` was cancelled by the
  # concurrency group; GitHub re-runs required checks against the winning SHA, so
  # a cancellation-induced failure here is harmless (rerun on the superseding push).
  all-green:
    needs: [test]
    if: always()
    runs-on: ubuntu-24.04
    steps:
      - name: Verify all matrix cells passed
        run: |
          if [ "${{ needs.test.result }}" != "success" ]; then
            echo "Matrix job did not succeed: ${{ needs.test.result }}"
            exit 1
          fi
```

```yaml
# .github/workflows/sync-ruleset.yml
name: sync-ruleset
on:
  push:
    branches: [main]
    paths: ['.github/rulesets/**']
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:
jobs:
  sync:
    # Skip on forks (no PAT access)
    if: github.repository_owner == 'OWNER_PLACEHOLDER'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Sync / detect drift
        env:
          GH_TOKEN: ${{ secrets.RULESET_PAT }}
        run: |
          node .github/scripts/sync-rulesets.mjs \
            --mode=${{ github.event_name == 'schedule' && 'drift-check' || 'sync' }}
```

The sync script (`.github/scripts/sync-rulesets.mjs`) uses GitHub REST — POST to create, PUT `/repos/.../rulesets/{id}` (looked up by name) to update, drift-check mode diffs live ruleset against committed JSON. The ruleset names `ci / all-green` (stable) as the required status check, decoupling it from matrix labels.

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
    │  • toPosixProjectRoot(config.root)
    │  • Resolve manifestPath; reject if escapes projectRoot
    │  • runtimeDetect ordered algorithm (§2 premises):
    │       1. esbuild.jsx set? → authoritative
    │       2. plugin-react config readable? → authoritative
    │       3. tsconfig = hint only
    │      Classic from (1) or (2) → throw with fix hint naming source; classic only in tsconfig → debug
    │  • Bind client environment reference in state map
    │  • ManifestWriter(projectRoot, manifestPath, options, clock):
    │      - mkdirSync(recursive: true)
    │      - Cross-instance collision: exclusive-flag open of manifestPath + '.owner-lock'; throw if present
    │      - Startup tmp sweep: unlink manifest.json.tmp-*
    │      - Write empty manifest (atomic same-dir rename)
    │
    ▼
Vite fires configureServer(server)
    │  • If options.daemon.mode === 'off': daemonHandle = null, skip.
    │  • Else: await importer()
    │       ├─ ERR_MODULE_NOT_FOUND | ERR_PACKAGE_PATH_NOT_EXPORTED:
    │       │    • 'required' → throw
    │       │    • 'auto' → logger.warn once; daemonHandle = null
    │       ├─ other error → logger.warn with stack; daemonHandle = null; CONTINUE
    │       └─ success → await mod.startDaemon({ manifestPath, port: options.daemon.port ?? 0 })
    │                   → validate handle contract (pid, shutdown, stdout, stdin, stderr) — throw if violated
    │                   → wire pipe-drain immediately (stdout→info, stderr→warn)
    │  • Register teardown: server.close, SIGINT, SIGTERM
    │      + SIGHUP only on non-Windows
    │      + uncaughtException / unhandledRejection → shutdown then re-throw
    │      (NOT beforeExit)
    ▼
Schedule forced initial flush on client buildEnd or first idle tick → writer.quiesce()
    ▼
Dev server listens

Warm-start note: Vite caches transform results across `vite dev` restarts. On a warm start, the
Babel pass does NOT re-run, so the manifest writer starts empty (§3.3 invariant 6) and only
repopulates on first edit. Downstream consumers tolerate this via the reader retry path (§6.6
step 2 + poll watch).
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
toPosixRelative(id, projectRoot) → relPath  (on failure: logger.warn once; return undefined)
    ▼
Build empty transform-local batch
    │
    ▼
@babel/core.transformAsync(code, {
    plugins: [redesignerBabelPlugin({ relPath, batch })],
    sourceMaps: true,
    inputSourceMap: false,      // we are FIRST Babel pass at enforce:'pre'; no prior map
    configFile: false,
    babelrc: false
})
    │
    ▼
if result === null: return undefined  // file had no JSX to modify; Babel null-result
    │
    ▼
Babel visitor:
    │  1. JSXFragment: skip (children visited).
    │  2. JSXOpeningElement / JSXSelfClosingElement:
    │     a. Name resolves to wrapperComponents list → skip (children visited).
    │        Known false-negative: re-exported wrappers (§3.3 invariant 9).
    │     b. Else: per-case try/catch; inject attribute.
    │  3. Walk to enclosing component (as in §3.3).
    │  4. If resolved displayName === "(module)" AND this is a user-declared component: throw (reserved).
    │  5. componentKey = relPath + '::' + componentName
    │  6. locString = formatLoc(relPath, line, col)
    │  7. Register in batch
    │  8. Inject <jsx-element data-redesigner-loc="..." ...>
    ▼
Babel returns { code, map }
    │
    ▼
Vite plugin returns { code: result.code, map: result.map }
    ▼
writer.commitFile(relPath, batch):
    │  CAS per-file replace
    │  Schedule debounced flush (200 ms, maxWait 1000 ms from first commit)
    ▼
plugin-react receives { code, map }; browser renders.
```

### 5.3 HMR

```
Edit. Vite invalidates; affected files re-run transform().
Each re-transformed file → writer.commitFile(relPath, freshBatch).
Debounced flush → atomic same-dir rename (7-step backoff if needed).
Post-flush re-check: if state identity changed since snapshot, reschedule.
Vite HMR pushes update; React re-mounts (Fast Refresh preserves state for eligible edits).
```

### 5.4 Shutdown

Routed through idempotent `shutdown()`. Registered on: `server.close`, `SIGINT`, `SIGTERM`; + `SIGHUP` only non-Windows; + `uncaughtException` / `unhandledRejection` (re-throw after teardown).

```
shutdown() — idempotency flag
    │
    ▼
1. writer.flushSync() — fs.writeFileSync in try/catch
       on EBUSY/EPERM: 7-step backoff (50/100/200/400/800/1600/3200 ms)
       on final failure: console.error + per-attempt durations at debug
    │
    ▼
2. If daemonHandle: daemonHandle.shutdown() — platform-branched:
       │
       ├─ POSIX: SIGTERM → 2 s → SIGKILL + logger.warn
       │
       └─ Windows:
             write `{"op":"shutdown"}\n` to handle.stdin
             await "ack" on handle.stdout (line-delimited JSON), 1500 ms timeout (hosted-runner safe)
             if acked → await exit up to 1.5 s
             if no ack OR no exit → taskkill /T /F /PID ${handle.pid}
             if taskkill non-zero: logger.warn
```

---

## 6. Public API surface

### 6.1 Entry point

```ts
// packages/vite/src/index.ts
import type { Plugin } from 'vite'

export interface DaemonOptions {
  /** 'auto' = attempt autostart, quiet-warn if missing; 'required' = throw if missing; 'off' = never attempt. */
  mode?: 'auto' | 'required' | 'off'    // default: 'auto'
  port?: number                          // default: 0 (OS-assigned)
}

export interface RedesignerOptions {
  manifestPath?: string                  // relative to projectRoot; absolute & escaping rejected
  include?: string[]                     // default: ['**/*.{jsx,tsx}']
  exclude?: string[]                     // default: ['node_modules/**', '**/*.d.ts']
  /**
   * Gate WITHIN `apply: 'serve'`. `apply: 'serve'` always applies first;
   * `vite build` is always a no-op regardless of this flag.
   * Default: true (i.e., plugin is active in dev).
   */
  enabled?: boolean
  /**
   * DaemonOptions | string shorthand.
   * The shorthand string is FROZEN to mirror `DaemonOptions.mode` values exactly.
   * Adding a new mode value in the future means adding to both places; removing a mode
   * is a major-bump concern. Documented in the reader-contract.
   */
  daemon?: DaemonOptions | 'auto' | 'required' | 'off'
}

export default function redesigner(options?: RedesignerOptions): Plugin

// Explicit named re-exports:
export type { Manifest, ComponentRecord, LocRecord, RedesignerOptions, DaemonOptions, SchemaVersion }
```

```ts
// packages/vite/src/reader.ts — subpath-exported as '@redesigner/vite/reader'
import type { Manifest } from './core/types-public'

/**
 * The major version (integer) this reader was built for.
 * Used as the default `expectedMajor` in readManifest.
 * Example: `if (SUPPORTED_MAJOR !== 1) { /* consumer too new * / }`.
 * (Note: integer, NOT the string "1.0".)
 */
export const SUPPORTED_MAJOR: number = 1

export async function readManifest(
  manifestPath: string,
  opts?: {
    /** Defaults to SUPPORTED_MAJOR. Consumers SHOULD pin to the major their code supports. */
    expectedMajor?: number
    /** Default: 1 (matches §6.6 step 2: retry-once on parse failure). */
    maxRetries?: number
    /** Configurable — Windows SMB paths may need >50ms. Default: 50. */
    retryDelayMs?: number
  }
): Promise<Manifest>

/**
 * Computes the canonical contentHash from a Manifest.
 * The function internally strips `generatedAt` and `contentHash` before hashing,
 * so callers MAY pass a partially-built Manifest (one where `contentHash` is the
 * empty string or not yet set). Never pass a modified / filtered object; pass the
 * full Manifest shape and let the function exclude the two fields.
 */
export function computeContentHash(manifest: Manifest): string
```

### 6.2 User-facing usage

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import redesigner from '@redesigner/vite'

export default defineConfig({
  plugins: [react(), redesigner()],
})
```

### 6.3 Manifest shape

```ts
// packages/vite/src/core/types-public.ts

/**
 * Template-literal type. Consumers accept unknown fields (§6.6).
 * The `'1.0'` literal is exported separately as `SUPPORTED_MAJOR` so consumers can pin to
 * the major of the installed reader without narrowing future minor bumps into a type error.
 */
export type SchemaVersion = `${number}.${number}`

export interface Manifest {
  schemaVersion: SchemaVersion
  /**
   * Framework identifier. Today: 'react'. Additive values (e.g., 'vue') are a MINOR bump
   * and require simultaneous addition to any framework-specific record fields below,
   * which are currently React-shaped. Adding non-React frameworks is an explicit design
   * step, not a casual string addition.
   */
  framework: string
  /** Human-readable wall clock. Consumers wanting change-detection use contentHash. */
  generatedAt: string
  /**
   * sha256 of the serialized `{components, locs}` subset (excluding generatedAt + contentHash itself).
   *
   * CANONICAL SERIALIZATION:
   *   - UTF-8 encoding
   *   - JSON with sorted keys at every object level (lexicographic)
   *   - Separators (`,`, `:`) — no whitespace
   *   - No trailing newline
   *   - Numbers serialized via JSON.stringify defaults
   *
   * Readers computing their own hash MUST follow this exact algorithm. `computeContentHash`
   * exported from `@redesigner/vite/reader` is the reference.
   */
  contentHash: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string                       // project-relative, posix
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  /**
   * Stable wire-format join key. Format: `<filePath>::<componentName>`.
   * `componentName` MUST NOT contain `::` (enforced by the JSON Schema `pattern`).
   * Consumers MAY split on the LAST occurrence of `::`.
   */
  componentKey: string
  filePath: string
  componentName: string
}
```

**Schema version rules:**

- `schemaVersion` type is template-literal `` `${number}.${number}` `` — type-compatible across minor bumps. **The TypeScript type is advisory; real validation is the runtime `parseSchemaVersion` in the reader (§6.6 step 4). TS template literals accept pathological values (`'1.-3'`, `'1.1e10'`); do not rely on the type as a validator.**
- Additive (field, object entry, new `framework` value) → minor bump.
- Breaking → major bump.
- Minor-ahead → warn + continue.
- Consumers pin on **major** (via `SUPPORTED_MAJOR`). Never pin on the full string.

**Number-type caveat.** The canonical content-hash serialization relies on `JSON.stringify` number defaults. The v0 manifest contains only strings + `lineRange: [number, number]` integer tuples — safe. If a future minor bump introduces floating-point fields, upgrade the serialization to RFC 8785 JCS (handles float edge cases deterministically).

**`componentKey`** stable format; JSON-Schema-level pattern constrains `componentName` to exclude `::`.

**`data-redesigner-loc` attribute.** NAME lowercase+hyphens (HTML5-conformant); VALUE `"relPath:line:col"`. Colons in value are HTML-legal. For CSS selectors over the value, use `CSS.escape()` (not manual quoting — neither quote style is safe universally): `` `[data-redesigner-loc="${CSS.escape(loc)}"]` ``. Documented in `dist/reader-contract.md`.

**`projectRoot` intentionally absent** from the schema.

**No `$schema` URL in v0 manifests.** A future publish may populate `$id` on the schema file itself even if unresolvable, for IDE-tooling integrations. Not in the emitted manifest.

JSON Schema (`manifest-schema.json`, draft-2020-12) generated from `core/types-public.ts`.

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
    "@vitejs/plugin-react": "^5"
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

- ESM-only.
- `"private": true` prevents accidental publish.
- **`@redesigner/daemon` NOT in any deps field.**
- Vite peer `^5 || ^6 || ^7`; plugin-react peer `^5`. v4 was dropped at round-5 review because `$RefreshReg$` shape differences were declared-supported-but-untested; v6 (oxc-default) is a deferred widening pending integration test.
- Corepack upgrades to latest on Node 20.11.0 CI leg.
- **No `proper-lockfile` runtime dependency.**

### 6.5 User-visible messages

| Severity | Example | When |
|---|---|---|
| `error` | "manifestPath escapes projectRoot" | `configResolved` |
| `error` | "classic JSX runtime detected in <esbuild.jsx | plugin-react config>; v0 requires automatic runtime. Set `esbuild.jsx: 'automatic'` in vite.config, or update plugin-react to use automatic." | `configResolved` (names the specific authoritative source) |
| `error` | `daemon.mode === 'required'` but package missing | `configureServer` |
| `error` | Two plugin instances resolving to same manifestPath | `configResolved` |
| `error` | User-declared component named `(module)` | Babel visitor |
| `warn` | Daemon not installed (`mode: 'auto'`) | Once |
| `warn` | Daemon `startDaemon()` threw on import | With stack; continue |
| `warn` | Transform / path-guard error per file | Once per file |
| `warn` | Per-node visitor exception | With `file:line` |
| `warn` | Atomic rename retried (severity ladder) | Attempts 1–2 = debug; 3–6 = warn; final = error |
| `warn` | Shutdown flush retried after EBUSY | Once per shutdown |
| `info` | First successful manifest write | Once |
| `debug` | Per-transform timings; non-client env skip; plugin-react absent; tsconfig-only classic; individual disk-retry attempt durations | Behind `DEBUG=redesigner:*` |

### 6.6 Consumer reader contract

Published as `dist/reader-contract.md`. Canonical algorithm:

1. **Open + parse** UTF-8 JSON.
2. **Parse failure:** sleep `retryDelayMs` (default 50), retry once. Configurable — Windows SMB users may want 250+. Second failure → unavailable; poll.
3. **Validate** against `manifest-schema.json`.
4. **Version check:** `parseSchemaVersion(schemaVersion) → { major, minor }`. Compare major to `expectedMajor` (defaults to `SUPPORTED_MAJOR`). Mismatch → reject. Minor-ahead → warn + continue.
5. **Change detection:** `contentHash` (sha256 of canonically serialized `{components, locs}`; sorted keys, no whitespace, UTF-8, no trailing newline). Not `generatedAt`.
6. **CSS selector escape:** use `CSS.escape(locValue)` — manual quote picking is not safe for arbitrary strings:
   ```js
   document.querySelector(`[data-redesigner-loc="${CSS.escape(loc)}"]`)
   ```
7. **Watch recommendation:** POSIX `fs.watch` reliable on local FS; Windows/SMB use poll (250–500 ms).

`@redesigner/vite/reader` implements steps 1–5. `CSS.escape` is browser-native.

---

## 7. Error handling & failure modes

| # | Trigger | Detected in | Handling | User sees | Test |
|---|---|---|---|---|---|
| 1 | `manifestPath` escapes projectRoot | `configResolved` | Throw | Fails to start | unit |
| 2 | `manifestPath` absolute | `configResolved` | Throw | Same | unit |
| 3 | projectRoot cannot be normalized | `configResolved` | Throw (plugin bug) | Fails to start | unit |
| 3b | Two plugin instances → same manifestPath | `configResolved` (construction) | Throw | Fails; one survives | unit |
| 4 | Classic JSX runtime (authoritative source) | `configResolved` | Throw naming source + fix | Fails to start | unit |
| 4b | Classic only in tsconfig; authoritative sources automatic or absent | `configResolved` | `debug`, proceed | None | unit |
| 5 | `@vitejs/plugin-react` absent, SWC present | `configResolved` | `debug` | None | integration |
| 6 | Daemon import → NOT_FOUND / NOT_EXPORTED, `auto` | `configureServer` | `warn` once | Yellow one-line | unit + daemon-real |
| 6b | Same, `required` | `configureServer` | Throw | Fails to start | unit |
| 7 | Daemon import → other error | `configureServer` | `warn` with stack; continue | Yellow | unit |
| 7b | Daemon handle missing required pipes | `configureServer` | Throw (contract violation) | Fails to start | unit |
| 7c | Daemon spawn used shell wrapper on Windows | Integration | Tree-kill may orphan; daemon contract documents `shell: false` requirement | — | documented |
| 8 | Per-file path normalization fails | `transform` | `warn` once per file; skip visitor | Per-file warning | unit |
| 9 | Babel parser fails on whole file | `transform` | `warn`; return `undefined` | Per-file warning | fixture |
| 9b | Babel returns `null` (no changes needed) | `transform` | Return `undefined` | None | fixture: `null-result/` |
| 10 | Per-node visitor exception | Babel plugin | Per-case try/catch; `warn`; skip node | Per-node warning | fixture |
| 11 | Literal-false-guarded dead code | Babel plugin | Skip silently | None | fixture |
| 11b | JSX in non-component helper transitively within component | Babel plugin | Attribute to outer | None | fixture |
| 11c | JSX at module scope | Babel plugin | Synthetic `(module)` (manifest-only) | None | fixture |
| 11d | JSXFragment | Babel plugin | Skip; children visited | None | fixture |
| 11e | Wrapper component (skip list) | Babel plugin | Skip; children visited | None | fixture |
| 11f | Ambiguous wrapper identity (`React[x]`) | Babel plugin | Inject; accept warning | Potential React warning | documented |
| 11g | Re-exported wrapper (`./my-react-shim`) | Babel plugin | Inject (false-negative); documented limitation | Potential React warning | fixture: `wrapper-reexport-chain/` |
| 11h | User-declared displayName = `"(module)"` | Babel plugin | Throw | Fails transform | fixture: `reserved-module-name/` |
| 12 | Writer state contention | `manifestWriter` | N/A — CAS + post-flush re-check | None | (design) |
| 12b | Overlapping re-transform | `manifestWriter` | Per-file replace wins | None | unit + parallelism |
| 12c | Commit during rename | `manifestWriter` | Post-flush re-check reschedules | None | unit |
| 13 | Disk write fails (EACCES/ENOSPC) | `manifestWriter` flush | Retry next debounce; severity ladder | Escalating severity | unit |
| 14 | Atomic rename EPERM/EBUSY | `manifestWriter` flush | 7-step exponential backoff (~6.35 s) + per-attempt timing at debug | Warning past threshold; final failure = error | unit + CI |
| 14b | EXDEV | `manifestWriter` flush | Should never occur (same-dir temp); log `warn` + "plugin bug, please file issue" — downgraded from `error` to match severity ladder intent (non-fatal impossible conditions are warnings, not errors) | Yellow warning (plugin bug) | unit |
| 14c | Construction collision with `.owner-lock` | Constructor | Throw | Fails to start | unit |
| 14d | Orphaned tmp files from prior crash | Constructor | Startup sweep | None | unit |
| 15 | Shutdown before debounce flush | shutdown() | Sync flush + 7-step backoff; console.error fallback | None (clean) | integration |
| 16 | POSIX: daemon ignores SIGTERM | Teardown | 2 s → SIGKILL + warn | Yellow | unit |
| 16b | Windows: daemon ignores stdin graceful | Teardown | 1500 ms ack timeout → taskkill /T; warn on non-zero | Yellow | unit (Windows-only) |
| 16c | Windows: stdin pipe missing | Teardown | Straight to taskkill; warn | Yellow | unit |
| 17 | Teardown fires twice | All paths | Idempotency flag | None | unit |
| 18 | Vite config reload | Plugin reinit | Old shutdown fires; new starts fresh | Normal Vite messaging | integration |
| 19 | Non-client Vite environment transform | `transform` | Return `undefined` | None | integration + fixture |
| 20 | `.redesigner/` missing on fresh clone | Constructor | `mkdirSync({ recursive: true })` | None | unit |
| 21 | Attempted SSR render of playground | `hydration-safety.test.ts` | Assert rendered HTML has zero `data-redesigner-loc` | None (test invariant) | integration |

---

## 8. Testing plan

Three tiers, Vitest. `fast-check` for properties.

### 8.1 Unit tests — `test/unit/`

| File | Coverage |
|---|---|
| `locFormat.test.ts` | Roundtrip + fast-check. Arbitrary: `fc.string({ minLength: 1 })` filtered to exclude newlines + control chars. |
| `pathGuards.test.ts` | Normalization, escape guards, Windows-native input does NOT throw. |
| `runtimeDetect.test.ts` | Ordered algorithm (§2); authoritative-source identification in thrown errors (§6.5). |
| `wrapperComponents.test.ts` | Skip list + alias imports; `ErrorBoundary` heuristic note. |
| `contentHash.test.ts` | Canonical serialization determinism: sorted keys, no whitespace, UTF-8 bytes, no trailing newline. Property-based: shuffle keys, hash matches. |
| `resolveEnclosingComponent.test.ts` | All component shapes + reserved-displayName rejection. |
| `plugin.test.ts` | Lifecycle; options merge; `configResolved` throws; user's `babel.config.js` NOT consulted; environment re-init asserts writer is not double-initialized; WeakMap<Env, State> short-circuits for non-client envs. |
| `manifestWriter.test.ts` | CAS per-file replace. Startup empty-write + mkdir-p + tmp sweep. Debounce + maxWait-from-first-commit. Post-flush re-check. **7-step exponential-backoff** (50/100/200/400/800/1600/3200 ms). Per-attempt duration telemetry at `debug`. EXDEV never occurs. Construction collision throws. contentHash stability + determinism. `quiesce` forces flush. **Timer discipline: all debounce / maxWait / backoff tests MUST use `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` via the injected `clock` seam on the writer constructor. Real-timer backoff tests would approach or exceed 6 s per case and flake on Windows-2022 under Defender.** |
| `daemonBridge.test.ts` | Injected importer: NOT_FOUND/NOT_EXPORTED vs generic discrimination; contract validation; pipe drain; teardown idempotency; POSIX SIGTERM→SIGKILL; Windows stdin ack handshake (1500 ms) + taskkill fallback; SIGHUP non-win32-only; no `beforeExit`; `shell: false` contract documented. |

### 8.2 Fixture tests — `test/fixtures/`

On-disk triples. Gated by env var + `FIXTURE_CHANGELOG.md` + Husky + CI three-dot-diff. Cases per §4.

New cases:
- `wrapper-reexport-chain/` — documents false-negative (re-exported Suspense injected, README captures the limitation).
- `activity-alias-import/` — `import { unstable_Offscreen as Activity }` aliased.
- `memo-to-plain-transition/` — Babel output for pre/post transition; documents expected behavior across the Fast-Refresh hazard.
- `null-result/` — source with no JSX; asserts transform returns `undefined`.
- `compiler-hoist-order/` — pre and post React-Compiler hoisting; attribute survives with original source line.
- `reserved-module-name/` — user-declared `(module)` displayName throws.

### 8.3 Integration tests — `test/integration/`

Real Vite dev server, real playground. Per-test tmpdir via `fs.mkdtemp`. `parallelism.test.ts` runs under dedicated config (`{ pool: 'forks', isolate: true, fileParallelism: false }`).

| File | Coverage |
|---|---|
| `vite.test.ts` | DOM assertions: every rendered **host-element** within `#root` carries `data-redesigner-loc` (excluding wrapper subtrees + mount). Every value resolves to a manifest entry. Hardcoded-loc spot set. Failure messages name missing components. **Asserts `document.querySelectorAll('[data-redesigner-loc*="(module)"]').length === 0`** — the `(module)` synthetic is manifest-only. |
| `manifest.test.ts` | Schema validation; reader contract via `readManifest()` + `SUPPORTED_MAJOR`; `contentHash` determinism + change detection; minor-ahead behavior; classic-runtime error names its source. |
| `hmr.test.ts` | **Subscription ordering is explicit:** `server.ws.on('message', ...)` listener attached BEFORE the file edit. Scenarios: (1) prepend line — quiesce — assert lineRange shifted, loc still resolves. (2) Rename — quiesce — assert old key gone, new present. (3) Two-file cascade — edit rapidly — `updateCount >= 1` (NOT `>= 2` — Vite may batch) AND final manifest contains correct entries for both files. (4) Delete — quiesce — assert entry purged. All waits use `server.waitForRequestsIdle(id)` (the id-form; the bare form has a documented deadlock hazard if ever invoked from a load/transform hook path) + `writer.quiesce`; no `setTimeout`. |
| `fast-refresh.test.ts` | (a) State preservation via `useState` counter: click 3 times, assert `textContent === "3"`; also mount `const instanceStamp = useRef(Math.random())` exposed via `data-instance-stamp`. Edit unrelated leaf JSX. Assert `textContent === "3"` AND `data-instance-stamp` unchanged. (b) Registration stability: monkey-patch `window.$RefreshReg$` (test pinned to plugin-react v5 shape; noted in test file header that v4 shape diverges). (c) **memo↔plain transition:** start with `export default memo(Foo)`, edit to `export default Foo` via HMR, assert no Fast-Refresh crash and our attribute still resolves correctly (facebook/react#30659 class of regressions). |
| `environment-skip.test.ts` | `server.transformRequest(url, { ssr: true })` + Vite 6+ `environments.ssr?.transformRequest` → no attribute. `server.ssrLoadModule` + `renderToString` → rendered HTML has zero `data-redesigner-loc`. |
| `react-compiler.test.ts` | Compiler enabled. (a) Fresh render has attribute at correct source line. (b) Attribute survives prop-change re-render. (c) HMR edit updates attribute (no stale memoization). |
| `sourcemap.test.ts` | **Column accuracy:** pick a token on a line AFTER the injection point (different line; avoids column drift from the injected attribute's width). `originalPositionFor` returns the exact original line AND column. **Composed-map assertion:** additionally fetch the final map served by Vite (after plugin-react's downstream Babel/Compiler pass has run on our output), parse it, and assert the same token still maps back to the original source line — this is the user-visible contract ("browser DevTools shows correct source"), not just our pre-downstream map. |
| `reinit.test.ts` | Touch `vite.config.ts`; old shutdown fires; new writer flushes empty manifest; `process._getActiveHandles()` stable; no duplicate daemon. |
| `parallelism.test.ts` | Under dedicated config. **50 parallel transforms** on distinct files; assert all 50 entries present in final manifest (realistic CAS stress). **Explicit tmpdir isolation: `beforeEach` creates `fs.mkdtempSync` and points the test's Vite root there. 50 concurrent writers against a shared `.redesigner/` would trip the `.owner-lock` collision throw; per-test tmpdir is non-negotiable for this file.** |
| `degradation.test.ts` | Injected importer variants covered inline. |
| `daemon-real.test.ts` | **Three sibling test packages** (distinct specifiers, distinct import cache entries). `daemon-tla` case uses `Promise.race(importPromise, timerPromise)` with a 2 s timer; the underlying TLA import is NOT truly aborted (Node dynamic import is not cancellable), so the test MUST run in its own forked worker to avoid a leaked import pinning the pool. Explicitly annotated `{ pool: 'forks', isolate: true, fileParallelism: false }` via the dedicated config (same as `parallelism.test.ts`). |
| `hydration-safety.test.ts` | Locks client-only premise. Asserts `renderToString(<App />)` produces HTML with zero `data-redesigner-loc`. Rationale: plugin-react on our untransformed SSR modules emits no attributes. A future SSR spec must update this test deliberately. |
| `shutdown.test.ts` | Real subprocess fake daemon spawned as `['node', path]` with `shell: false` and `stdio: ['pipe','pipe','pipe']`. Protocol: stdin line-delimited JSON; subprocess acks on stdout. POSIX: SIGTERM → ack → clean flush; escalation: 2 s → SIGKILL. Windows (skip elsewhere): stdin `{"op":"shutdown"}\n` → **1500 ms ack timeout** → on ack, 1.5 s exit → fallback `taskkill /T /F`. Idempotency: double-call performs one flush + one signal/taskkill. **Vitest `testTimeout: 10_000` for this file: the fallback-path ack-timeout (1.5 s) + taskkill-spawn (up to 1.5 s on slow runners) leaves thin headroom against the default 5 s.** |

### 8.4 CI matrix

Per §4.3. Summary:

- **Matrix:** Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 + Node 22.
- **Corepack preflight** (with `npm install -g corepack@latest` on Node 20.11.0 leg, shell-native version check, `corepack enable pnpm` explicit, `command -v pnpm` + `pnpm --version` PATH assertion).
- **Windows Defender exclusion** for workspace + pnpm store on Windows runners.
- **pnpm store cache** via `pnpm store path --silent`, with `restore-keys` fallback.
- **`pnpm install --frozen-lockfile --strict-peer-dependencies`.**
- Biome + typecheck + unit + fixtures + integration + parallelism run.
- **Fixture-update guard** via three-dot diff `origin/main...HEAD`.
- **`.only`/`.skip` grep** secondary check; Biome rules primary.
- Per-directory non-empty assertion.
- `concurrency` cancels stale pushes; `timeout-minutes: 15`.
- Artifact upload on failure.
- **`ci / all-green` summary job** (stable name) = required status check.
- Integration transform-time gate: 30 s ceiling.

### 8.5 Non-goals (testing)

- No Playwright / real-browser E2E.
- No perf benchmarks as hard gates beyond 30 s ceiling.
- No full-playground DOM snapshot.
- No coverage-threshold gate.

---

## 9. Open questions (carried forward)

- **Daemon ↔ extension protocol** — daemon spec.
- **HMR granularity beyond file-level** — out of scope.
- **Port discovery** — daemon spec. Plugin passes `daemon.port` through.
- **Product name** — still TBD.

---

## 10. Appendix — decision log

1. **Spec scope = Vite plugin + playground only.**
2. **pnpm workspaces + Biome + `engine-strict`.** Corepack ≥0.31.0 upgraded on Node 20.11.0 CI leg.
3. **`@vitejs/plugin-react` companion,** plugin is independent (`configFile: false, babelrc: false, inputSourceMap: false`).
4. **DOM attribute: `data-redesigner-loc`** — lowercase-hyphen HTML5-conformant name; VALUE `"relPath:line:col"`. CSS selector users MUST use `CSS.escape(locValue)` (documented).
5. **Manifest schema:** `SchemaVersion = \`${number}.${number}\`` template-literal; additive=minor, breaking=major; `SUPPORTED_MAJOR` exported from reader; consumers pin on major, never on exact string; `contentHash` via canonical serialization (sorted keys, no whitespace, UTF-8, no trailing newline) — exported as `computeContentHash`; `componentKey` stable `<filePath>::<componentName>` with JSON-Schema pattern disallowing `::` inside `componentName`; `projectRoot` not in manifest; no `$schema` URL in v0.
6. **Codename `redesigner`, rename cost includes the DOM attribute name** (wire-format break).
7. **Dev-only (`apply: 'serve'`).** `enabled` gates within serve only; `vite build` is always a no-op.
8. **Zero-config factory.** `daemon: DaemonOptions | 'auto' | 'required' | 'off'`. Shorthand string FROZEN to mirror `mode` values exactly — new modes must be added to both places.
9. **Daemon injected importer.** Discriminated NOT_FOUND / NOT_EXPORTED vs other error. Never rethrow for `'auto'`. Three sibling fixture packages (`-throws`, `-no-export`, `-tla` with AbortController) cover the production path.
10. **React 19 + automatic JSX runtime only.** Classic = hard error with fix hint naming the authoritative source.
11. **Independent Babel pass with `enforce: 'pre'`**, `sourceMaps: true`, **`inputSourceMap: false`** (we are the first pass; no prior map to consume), `configFile: false`, `babelrc: false`. Returns `{ code, map }`; `null` Babel result → `undefined`.
12. **Immutable map + per-file replace CAS + post-flush re-check.** No mutex.
13. **Empty-manifest write + startup tmp sweep + `mkdir -p`** at startup.
14. **Per-visitor-case try/catch.**
15. **Wrapper-component skip list.** React built-ins + userland `ErrorBoundary` heuristic. **Known limitation:** re-export chains are a false-negative (fixture documents).
16. **Module-scope JSX → synthetic `(module)` — MANIFEST-ONLY.** Not DOM-tagged. `(module)` is a reserved manifest-key namespace; users may not set displayName to the literal.
17. **HOC unwrap:** only `memo` + legacy `forwardRef`.
18. **Environment-aware skip** via `WeakMap<Environment, ClientState>`. Vite 6+ `this.environment.name === 'client'`; Vite 5 `options.ssr === true` skip.
19. **No telemetry / update-check.**
20. **ESM-only.**
21. **Full CI matrix** (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 + Node 22) + **Windows Defender exclusion** step.
22. **Required status checks via committed GitHub ruleset** pointing at the stable `ci / all-green` summary job (NOT matrix-coupled label). Sync via dedicated workflow + script with drift-check on schedule; fork-execution guard.
23. **Platform-aware shutdown.** POSIX SIGTERM→2 s→SIGKILL. Windows stdin ack (**1500 ms timeout**) → 2 s → `taskkill /T /F`. `SIGHUP` POSIX-only. No `beforeExit`.
24. **Daemon contract.** `startDaemon()` → `{ pid, shutdown, stdout, stdin, stderr }`. Pipes drained. `detached: false`, **`shell: false`**, `stdio: ['pipe','pipe','pipe']`. No double-fork on Windows.
25. **Windows-aware atomic write.** Same-dir temp. **7-step backoff (50/100/200/400/800/1600/3200 ms, ~6.35 s)**. Per-attempt duration telemetry at `debug`. CI adds a Defender exclusion step. Startup tmp sweep. Severity ladder: attempts 1–2 = debug, 3–6 = warn, final = error.
26. **Cross-instance collision is a config error** via `.owner-lock` exclusive-flag file at construction.
27. **Corepack + exact `packageManager` pin** + upgrade to latest on Node 20.11.0 leg + PATH assertion after `enable` + `corepack enable pnpm` explicit.
28. **Build toolchain: `tsup` + `ts-json-schema-generator`.** `"private": true`.
29. **Fixture `--update` gated** at three levels.
30. **Property-based test** on `formatLoc`/`parseLoc` + on `contentHash` (key-order determinism).
31. **React Compiler compat** verified across fresh, prop-change, HMR.
32. **Types split:** `types-public.ts` (re-exported) vs `types-internal.ts`. Explicit named re-exports.
33. **`noFocusedTests` + `noSkippedTests` = error** in Biome. Per-directory non-empty assertion replaces brittle count file.
34. **Playground `edge/*` all actually rendered.** Fast-Refresh state preservation + registration stability + memo↔plain transition integration tests.
35. **Daemon lifetime = Vite process lifetime.** Persistent daemon is deferred post-v0.
36. **Vite 8 / plugin-react v6 (oxc) is a deferred widening**, not a v0 claim.
37. **`(module)` synthetic name is reserved.**
38. **Workflow-level `permissions: { contents: read }`** on CI. Sync-ruleset workflow has fork-execution guard.
39. **plugin-react peer narrowed to `^5` only** at round-5 review. v4's `$RefreshReg$` shape was declared-supported-but-untested — shipping that invariant is worse than narrowing.
40. **`sourcemap.test.ts` asserts the COMPOSED map** served by Vite (after plugin-react's downstream pass) in addition to our immediate Babel-output map. End-to-end "DevTools shows correct source" is the user-visible contract.
41. **CI Corepack preflight version-checks FIRST, upgrades conditionally.** Cannot trust any specific Node release to ship Corepack ≥0.31; Node 22 early builds also shipped older Corepack.
42. **CI Defender exclusion runs BEFORE checkout** + excludes `node.exe` as a process exclusion. Real-time scanning thousands of checked-out files negates the benefit if ordered after.
43. **pnpm cache key includes `package.json` hash** (not just the lockfile). `packageManager` bump rotates the cache, preventing a cross-minor store restore.
44. **`timeout-minutes: 20`** (from 15). Windows first-run with Defender exclusion + tool-cache miss for exact Node 20.11.0 + 50-file parallelism can approach 12+ minutes.
45. **Timer discipline for backoff/debounce tests:** `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` via injected clock seam. Real-timer backoff under Windows Defender load = documented flake source.
46. **`daemon-real.test.ts` TLA case runs under its own forked worker** (via the dedicated parallelism config). `Promise.race` with a 2 s timer is a test-level ceiling; Node dynamic-import promises are not cancellable, so the underlying import must not leak to sibling tests.
47. **EXDEV row downgraded from `error` to `warn`** — non-fatal impossible conditions are warnings, not errors, per the severity-ladder intent.
48. **Warm-start manifest populates lazily** (Vite transform cache): on `vite dev` restart, the writer begins empty and fills on first edit. Consumers tolerate via reader retry path (§6.6 step 2).
49. **`SUPPORTED_MAJOR` is an integer (`1`), not a string (`'1.0'`).** Consumers pin on integer major; template-literal `SchemaVersion` type is advisory only — runtime `parseSchemaVersion` is the real guard.
