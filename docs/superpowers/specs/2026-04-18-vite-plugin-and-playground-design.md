# Vite Plugin + Playground — v0 Design Spec

**Date:** 2026-04-18
**Status:** Draft — pending user review
**Codename:** `redesigner` (product name TBD; rename cost at naming time is accepted — see §10 item 6)

---

## 1. Scope

### 1.1 What this spec covers

This spec defines the **first milestone** of the v0 roadmap from `brief.md`: the Vite plugin (`@redesigner/vite`) and the playground app (`examples/playground/`), together with the monorepo scaffold that hosts them.

Concretely, this spec delivers:

- `@redesigner/vite` — a Vite plugin that injects `data-redesigner-loc` attributes onto every rendered JSX element in dev builds and emits a project manifest to `.redesigner/manifest.json`.
- `examples/playground/` — a React 19 + TypeScript + Vite app used to dogfood and test the plugin, including stress cases (children-as-function, module-scope JSX, multi-component files) rendered from `App.tsx`.
- Monorepo scaffold: pnpm workspaces, Biome, shared tsconfig base, `.gitignore`, root `README.md` + `CONTRIBUTING.md`, `.editorconfig`, and the **full CI matrix (Linux + Windows, Node 20.11+ + Node 22, pnpm 9.15.x)**.

### 1.2 What this spec does NOT cover (and why)

This v0 slice is intentionally narrow. The brief's build order (§131–136) sequences the system into six deliverables; this spec is the first two. The remaining items each get their own spec.

| Deferred item | Why out of scope here | Unblocks when |
|---|---|---|
| `@redesigner/daemon` | Brief §154–156 leaves protocol / port discovery / HMR-watch strategy open. Plugin reserves the `daemon` option shape now and the tri-state contract is specified (§6.1); behavior activates when the daemon package is installed. | Daemon spec drafted + approved. |
| `@redesigner/mcp` shim | Requires daemon. Brief §36–51. | Daemon spec complete. |
| Chrome extension | Requires daemon WS protocol; also brief §128 sequences it last. | Daemon + MCP both complete. |
| `@redesigner/cli` (`init`) | Writes `.mcp.json` + Vite config snippet; trivial once all package names + the Chrome extension ID are finalized. | MCP spec + extension ID allocation. |
| Runtime props, fiber traversal, Vue/Svelte/Next adapters, DevTools panel, extension chat UI, persistence UI, OpenAI backend, variation flows | Explicitly post-v0 per brief §141–150. | Post-v0. |
| SWC plugin wrapper | Deferred per brief. The `core/` helpers (loc formatting, key construction, path guards) are genuinely framework-agnostic; the enclosing-component resolver is Babel-coupled and will need a parallel SWC implementation (not a line-count promise). | User ask post-v0. |

### 1.3 Rationale for the slice

The brief's dogfood sequence (§119–128) walks each upstream dependency forward one step at a time. Step 1 is "Vite plugin against the playground — verify `data-redesigner-loc` appears on rendered DOM elements." That is the smallest end-to-end testable unit with no external dependencies. Every downstream piece (daemon, MCP, extension) assumes this layer is solid; landing it on its own lets the rest be built against a known-good foundation.

### 1.4 Validation gate

This spec is considered complete when all of the following pass:

1. Unit tests (`test/unit/`) green on Linux + Windows, Node 20.11 + Node 22.
2. Fixture tests (`test/fixtures/`) green, covering every component-shape edge case enumerated in §8 (including new cases: `ref-as-prop/`, `fragment-noop/`, `module-scope-jsx/`, `ssr-skip/`, `children-as-function/`).
3. Integration tests (`test/integration/`) green across the CI matrix, including HMR (line-shift + rename + two-file-cascade), SSR-transform skip, React-Compiler compat, shutdown (POSIX + Windows paths), and re-init tests.
4. Full CI matrix runs Biome + all test tiers on Linux + Windows × Node 20.11 + Node 22. A dedicated `required-checks` config makes the Windows job blocking.
5. Playground renders in the browser with `data-redesigner-loc` on every rendered JSX element.
6. `.redesigner/manifest.json` validates against the exported JSON Schema (`dist/manifest-schema.json`), and `schemaVersion` is set to `"1.0"`.
7. Manual dogfood: open playground in Chrome DevTools, inspect an element, confirm `data-redesigner-loc="src/...:line:col"` is present and points to the real source.

---

## 2. Premises fixed (do not re-litigate inside this spec)

These were decided during brainstorming and panel review. They are bound choices:

- **React 19 only** for v0. React 18 support is deferred, not blocked. React Compiler 1.0 compatibility is a v0 requirement (§8 integration test).
- **Automatic JSX runtime only.** Classic runtime triggers a hard error at startup (§7). Runtime detection reads `config.esbuild?.jsx` first (authoritative for Vite), then plugin-react config, ignoring tsconfig (which only governs `tsc` type-check).
- **`@vitejs/plugin-react` is the default companion,** but the plugin is independent (§3) — our Babel pass is self-contained. plugin-react-swc, plugin-react v6 (Babel-less) on Vite 8, and future majors are all supported by the independent-transform model.
- **pnpm workspaces** for the monorepo. Biome for lint/format. **Corepack is required** for contributors (`corepack enable`).
- **Dev-only transform** (`apply: 'serve'`). `vite build` is a no-op by default. Strict about this for privacy + bundle size.
- **Project-relative paths, posix separators** in every artifact that reaches the DOM or the manifest.
- **DOM-queryable loc is the reason we exist.** `jsxDEV` already passes `__source` through React's element internals, but that field is not visible to a Chrome extension inspecting arbitrary DOM, and it is not stable across React majors. A DOM-persisted attribute is the minimal additive claim required for our use case; this is why we duplicate `__source` information onto an attribute.
- **Codename `redesigner`.** Rename cost at naming time is accepted.
- **Minimum Node 20.11.0** (for stable `import.meta.dirname` and Corepack fixes). Declared in `engines`.
- **SSR client pass is authoritative.** When Vite calls `transform` with `options?.ssr === true`, the plugin returns `undefined` — DOM attribution only makes sense on the client pass (§5.2).

---

## 3. Architecture

### 3.1 High-level structure

```
                                   ┌──────────────────────┐
                                   │ examples/playground/ │
                                   │   React 19 + Vite    │
                                   └──────────┬───────────┘
                                              │ vite dev
                                              ▼
                 ┌────────────────────────────────────────────────┐
                 │            @redesigner/vite                    │
                 │                                                │
                 │  ┌──────────────────┐   ┌──────────────────┐   │
                 │  │  Vite plugin     │   │  Babel plugin    │   │
                 │  │  entry           │──►│  (babel-coupled) │   │
                 │  │  (enforce:'pre') │   │                  │   │
                 │  └────────┬─────────┘   └────────┬─────────┘   │
                 │           │ invokes via           │ per-file    │
                 │           │ @babel/core in        │ transform-  │
                 │           │ transform hook        │ local batch │
                 │           ▼                      ▼             │
                 │  ┌──────────────────┐   ┌──────────────────┐   │
                 │  │ Daemon bridge    │   │ Manifest         │   │
                 │  │ (optional,       │   │ aggregator       │   │
                 │  │ dynamic import,  │   │ (immutable+CAS,  │   │
                 │  │ platform-aware   │   │ same-dir temp,   │   │
                 │  │ teardown)        │   │ retry on EPERM)  │   │
                 │  └──────────────────┘   └────────┬─────────┘   │
                 │                                  │ atomic      │
                 │                                  │ write +     │
                 │                                  │ mkdir -p    │
                 │                                  ▼             │
                 │                         .redesigner/manifest.json
                 └────────────────────────────────────────────────┘
```

### 3.2 Layers, top to bottom

1. **Vite plugin entry** — owns Vite lifecycle hooks (`configResolved`, `configureServer`, `closeBundle`, `server.close`, `buildEnd`). Loads user options, resolves project root, detects the JSX runtime in the correct precedence order (§2), instantiates the manifest writer, attempts daemon bridge, and orchestrates teardown across all relevant signals (§5.4).

2. **Babel plugin (babel-coupled)** — Babel visitor. Enclosing-component resolution, loc formatting, attribute injection, and explicit `JSXFragment` skip. The `core/` directory contains genuinely framework-agnostic helpers (loc string formatting/parsing, key construction, path guards); the enclosing-component resolver lives under `babel/` because it reasons over Babel AST node types and cannot be lifted without an equivalent SWC-specific implementation.

3. **Manifest aggregator** — collects `componentKey → ComponentRecord` and `loc → LocRecord` entries from transform-local batches. **Transform-local batch semantics:** each Babel pass builds its per-file batch synchronously inside its own `transform()` invocation, then commits the whole file's batch via a single compare-and-swap on an immutable state map (`state.set(relPath, batch)` — per-file atomic replace, never append). No mutex, no contention, no deadlock possible. Debounced disk writes with maxWait and a forced initial flush after `configureServer` (to bound cold-start visibility). **Platform-aware atomic write:** temp file is always placed in the same directory as the target (`.redesigner/manifest.json.tmp-<pid>-<rand>`), never in `os.tmpdir()`, to avoid `EXDEV` across drive letters on Windows. On `EPERM`/`EBUSY` from rename (AV/Search-indexer/concurrent handles on Windows), retry up to 3× with 50 ms backoff before logging. Writer constructor runs `mkdirSync(dirname(manifestPath), { recursive: true })` before the first write. Writer exposes an internal-only `onFlush(seq: number): Promise<void>` and `quiesce(): Promise<void>` hook for tests (§8.3).

4. **Daemon bridge** — optional. Dynamic `import('@redesigner/daemon')` in `configureServer`. Discriminated `try/catch`: `ERR_MODULE_NOT_FOUND` is quiet-warn, any other error is loud-log but non-fatal. On success, the daemon subprocess is spawned with `detached: false` and `stdio: ['ignore', 'pipe', 'pipe']` so it dies with the parent on POSIX. **Platform-aware teardown** (§5.4): POSIX sends SIGTERM → waits 2 s → escalates to SIGKILL; Windows sends a graceful shutdown message over stdin/IPC then falls back to `taskkill /T /F /PID <pid>`. Teardown is registered on `server.close`, `SIGINT`, `SIGTERM`, `SIGHUP`, `beforeExit`, `uncaughtException`, and `unhandledRejection`, all routed through a single idempotent shutdown function.

### 3.3 Key design invariants

1. **SSR-aware transform.** The plugin checks `options?.ssr` in every `transform` invocation. When `true`, returns `undefined` (no Babel pass, no writer commit). The client pass is the authoritative source of DOM attribution.

2. **Independent Babel pass, not plugin-react coupling.** Our Vite plugin runs with `enforce: 'pre'`, invokes `@babel/core.transformAsync({ sourceMaps: true, inputSourceMap: true })` in its `transform` hook, and returns `{ code: result.code, map: result.map }` explicitly. Downstream React plugins (plugin-react, plugin-react-swc, plugin-react v6 on Vite 8) then process our output unaware of us. Cost: one extra parse per JSX file. Benefit: zero coupling to plugin-react internals, Vite-8-ready.

3. **Scoped "framework-agnostic core."** `core/locFormat.ts`, `core/pathGuards.ts`, `core/manifestSchema.ts`, and `core/types.ts` are pure modules with zero AST or framework dependencies. `babel/resolveEnclosingComponent.ts` is intentionally inside `babel/` because it reasons over Babel node types. SWC support later = (a) reuse all of `core/`, (b) write a parallel `swc/resolveEnclosingComponent.ts` against SWC's AST.

4. **Compile-time component resolution.** The Babel visitor walks up the AST from each JSX node to its enclosing component (function/class declaration, or arrow const, unwrapping `memo` / legacy `forwardRef`). Ref-as-prop components (React 19 idiomatic) resolve like any function component — no special case needed. Resolution happens at transform time — downstream consumers never re-derive component identity from source at runtime.

5. **Lazy manifest + bounded-staleness cold start.** Manifest grows as Vite transforms files. No eager source-tree walk at startup. After `configureServer` completes, the plugin schedules a forced flush on Vite's `buildEnd` or the first idle tick — this bounds the worst-case "empty manifest visibility" window to one idle cycle instead of `maxWait` (1 s). Downstream consumers must still tolerate an incomplete manifest during the warm-up window.

6. **Fresh state on every start.** `ManifestWriter` construction (in `configResolved`) immediately calls `mkdirSync(recursive: true)` and overwrites `manifest.json` with an empty manifest (`schemaVersion: "1.0"`, `framework: "react"`, `generatedAt: now()`, empty `components`, empty `locs`). Atomic same-directory temp-file rename with retry (Windows EPERM/EBUSY tolerance). Consumers always see a self-consistent manifest; "empty at startup, grows as transforms run" is externally honest.

7. **One-way flow: memory → disk.** Writer never reads `manifest.json` back. If the file disappears, the next debounce tick rewrites it from memory.

8. **Per-file batch replace.** `writer.commitFile(relPath, batch)` takes the **full new set of entries for that file** (not append-then-commit). Pending batches are transform-local, built synchronously inside one Babel run. The writer does a single compare-and-swap replacing `state.get(relPath)` with `batch`. Renamed or deleted components leave no stale entries; overlapping re-entries of the same file can't lose data from a prior purge-then-merge interleave.

9. **Fragment is not attributed.** `JSXFragment` nodes are explicitly skipped in the visitor — `<>...</>` cannot accept a `data-redesigner-loc` prop (React drops all Fragment props except `key`). A fixture (`fragment-noop/`) enforces this.

10. **Module-scope JSX is attributed to `<module>`.** JSX at module scope (no enclosing function) is attributed to a synthetic component named `<module>` with `componentKey = relPath + ':<module>'`. This keeps app roots (`createRoot(root).render(<App />)`) hit-testable instead of silently skipped. True dead-code JSX (never rendered) remains harmless.

---

## 4. Package + module layout

```
redesigner/                           (repo root, pnpm workspace)
├── package.json                      ("packageManager": "pnpm@9.15.4", "engines": { "node": ">=20.11.0" })
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── .gitignore                        (node_modules, dist, coverage, .redesigner/, pnpm-debug.log)
├── .editorconfig
├── README.md                         (project pitch, links)
├── CONTRIBUTING.md                   (corepack enable, pnpm workflow, CI expectations)
├── .github/
│   └── workflows/
│       ├── ci.yml                    (Linux + Windows × Node 20.11 + Node 22 matrix; required checks)
│       └── required-checks.yml       (labels the Windows+Node22 job as required for daemon spec PRs)
│
├── packages/
│   └── vite/                         → @redesigner/vite
│       ├── package.json
│       ├── tsconfig.json             (extends base)
│       ├── tsup.config.ts            (builds dist/index.js + .d.ts + copies manifest-schema.json)
│       ├── scripts/
│       │   └── generate-schema.ts    (ts-json-schema-generator → dist/manifest-schema.json)
│       ├── src/
│       │   ├── index.ts              (default export: redesigner factory; `export type *` from types)
│       │   ├── core/                 (pure, zero AST/framework deps)
│       │   │   ├── locFormat.ts      (formatLoc, parseLoc)
│       │   │   ├── pathGuards.ts     (posix normalization + escape guards)
│       │   │   ├── manifestSchema.ts (TS types + schema meta)
│       │   │   └── types.ts          (Manifest, ComponentRecord, LocRecord, RedesignerOptions)
│       │   ├── babel/
│       │   │   ├── plugin.ts         (Babel wrapper; skips JSXFragment)
│       │   │   └── resolveEnclosingComponent.ts  (Babel-AST-coupled)
│       │   ├── integration/          (stateful / IO concerns)
│       │   │   ├── manifestWriter.ts (CAS batch replace + atomic write + HMR + onFlush/quiesce + mkdir-p + Windows retry)
│       │   │   ├── daemonBridge.ts   (dynamic import via injected importer, platform-aware teardown)
│       │   │   └── runtimeDetect.ts  (esbuild.jsx → plugin-react → tsconfig fallback)
│       │   └── plugin.ts             (Vite plugin entry; composes the above; SSR skip)
│       ├── test/
│       │   ├── fixtures/             (input.tsx / output.tsx / expected-manifest.json triples)
│       │   │   ├── README.md         (fixture-dir conventions; --update gate; changelog requirement)
│       │   │   ├── FIXTURE_CHANGELOG.md  (required entry per --update)
│       │   │   ├── _runner.test.ts   (fixture-runner; diffs; requires REDESIGNER_FIXTURE_UPDATE=1 for --update)
│       │   │   ├── default-export/
│       │   │   ├── named-exports/
│       │   │   ├── memo-wrapped/
│       │   │   ├── forwardRef-wrapped/            (legacy-compat; README flags React 19 idiomatic is ref-as-prop)
│       │   │   ├── ref-as-prop/                   (React 19 idiomatic)
│       │   │   ├── arrow-const/
│       │   │   ├── anonymous-default/
│       │   │   ├── inline-jsx-in-callback/
│       │   │   ├── hoc-wrapped/
│       │   │   ├── fragment-noop/                 (asserts no attr on Fragments)
│       │   │   ├── module-scope-jsx/              (asserts <module> synthetic component)
│       │   │   ├── ssr-skip/                      (asserts SSR pass emits no changes)
│       │   │   ├── children-as-function/          (render-prop stress case)
│       │   │   ├── malformed-jsx/
│       │   │   ├── pathological-node/
│       │   │   ├── jsx-outside-component/
│       │   │   ├── unicode-filename/
│       │   │   └── filename with spaces/
│       │   ├── unit/                 (pure, IO-free except mocked fs)
│       │   │   ├── locFormat.test.ts           (+ fast-check property: parseLoc(formatLoc(p,l,c)) roundtrip)
│       │   │   ├── resolveEnclosingComponent.test.ts
│       │   │   ├── pathGuards.test.ts
│       │   │   ├── runtimeDetect.test.ts
│       │   │   ├── plugin.test.ts
│       │   │   ├── manifestWriter.test.ts      (incl. Windows EPERM/EBUSY mock retry; mkdir-p; CAS batch replace)
│       │   │   └── daemonBridge.test.ts        (injected-importer strategy; vi.resetModules pattern)
│       │   └── integration/          (real Vite dev server; slow)
│       │       ├── vite.test.ts              (DOM assertions: every-has-attr + hardcoded-loc spot checks; no count-match)
│       │       ├── manifest.test.ts          (schema validation + orphans/gaps; consumer contract)
│       │       ├── hmr.test.ts               (writer.quiesce + server.waitForRequestsIdle; two-file cascade)
│       │       ├── ssr.test.ts               (options.ssr === true → no changes)
│       │       ├── react-compiler.test.ts    (babel-plugin-react-compiler enabled; assert compat)
│       │       ├── sourcemap.test.ts         (DevTools Source-map resolution survives transform)
│       │       ├── reinit.test.ts            (vite.config.ts touch during dev; no handle/daemon leaks)
│       │       ├── parallelism.test.ts       (per-test tmpdir; 10 parallel transforms; no lost writes)
│       │       ├── degradation.test.ts       (vi.resetModules + injected importer)
│       │       └── shutdown.test.ts          (real subprocess; POSIX SIGTERM→SIGKILL; Windows taskkill)
│       └── README.md                 (user-facing docs; ESM-only note; pre-enforce ordering caveat)
│
└── examples/
    └── playground/                   (not published)
        ├── package.json              ("@redesigner/vite": "workspace:*")
        ├── vite.config.ts            (two lines: import + plugin())
        ├── tsconfig.json
        ├── vite-env.d.ts
        ├── index.html
        └── src/
            ├── main.tsx                       (module-scope <App /> render → attributed to <module>)
            ├── App.tsx                        (renders Button, PricingSection 4×, Modal, all edge/*, children-as-function case)
            ├── components/
            │   ├── Button.tsx                 (default export, used everywhere)
            │   ├── PricingCard.tsx            (rendered 4× in PricingSection)
            │   ├── PricingSection.tsx
            │   ├── Modal.tsx                  (many props, nested JSX)
            │   ├── DataFetcher.tsx            (children-as-function stress case)
            │   └── edge/                      (intentional edge cases — rendered in App)
            │       ├── MemoWrapped.tsx
            │       ├── ForwardRefWrapped.tsx
            │       ├── RefAsProp.tsx          (React 19 idiomatic)
            │       ├── MultiComponentFile.tsx (two named exports; both actually used)
            │       ├── AnonymousDefault.tsx
            │       └── WithCallback.tsx
            └── styles/
                ├── app.module.css
                └── index.css                  (Tailwind entry)
```

### 4.1 Layout notes

- **Public API surface:** only `packages/vite/src/index.ts`. `export type * from './core/types'` auto-tracks type additions without manual drift. Everything else is internal; no deep imports are documented or supported.
- **`core/` = zero AST/framework deps, `babel/` = Babel-coupled (including the enclosing-component resolver), `integration/` = stateful/IO, `plugin.ts` = Vite entry.**
- **Fixture runner** lives alongside fixtures, not in `unit/`, preserving the "unit tests are IO-free" invariant. The runner requires `REDESIGNER_FIXTURE_UPDATE=1` to regenerate outputs, and a corresponding entry in `FIXTURE_CHANGELOG.md` must be committed alongside any regenerated fixtures. CI fails if either is missing when fixture files are modified.
- **Fixtures vs. playground edge cases are distinct on purpose.** `test/fixtures/` pins transform-level input/output pairs. `examples/playground/src/components/edge/` holds runtime examples. Documented in `test/fixtures/README.md`.
- **`examples/playground/src/components/edge/MultiComponentFile.tsx` must be actually rendered from `App.tsx`.** Integration tests hit the multi-component-per-file case end-to-end.
- **`manifestWriter.ts` exposes internal-only `onFlush(): Promise<void>` and `quiesce(): Promise<void>` hooks for tests.** Not part of the public API; not re-exported from `index.ts`. `onFlush` resolves after a given flush completes; `quiesce` resolves only after N ms (default 50) have passed with no pending commits — tests await `quiesce` in combination with Vite's `server.waitForRequestsIdle()` to replace hardcoded `setTimeout`.
- **`daemonBridge.ts` accepts an injected importer function.** Production wiring uses `(() => import('@redesigner/daemon'))`; tests pass their own to avoid ESM module-graph cache battles.

### 4.2 Build toolchain

- **Bundler: `tsup`** (esbuild under the hood) produces `dist/index.js` (ESM-only) and `dist/index.d.ts`.
- **Schema generation: `scripts/generate-schema.ts`** invokes `ts-json-schema-generator` against `core/types.ts`, writing `dist/manifest-schema.json`.
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
- **Prepublish hook:** `prepublishOnly` invokes `build` + `typecheck` + `test`. No publish happens in v0 — the hook is in place for when it does.

---

## 5. Data flow

Three distinct flows: cold start, per-transform, HMR. Shutdown is described separately (§5.4).

### 5.1 Cold start

```
vite dev invoked
    │
    ▼
Vite loads vite.config.ts → calls redesigner() factory → gets plugin object
    │
    ▼
Vite fires configResolved(config)
    │  • Capture config.logger; store on plugin instance
    │  • pathGuards.assertPosixProjectRoot(config.root)  → throw if backslash / drive-letter
    │  • Resolve manifestPath = path.posix.resolve(config.root, options.manifestPath ?? '.redesigner/manifest.json')
    │      → reject if resolved path escapes projectRoot
    │  • Detect JSX runtime via runtimeDetect.ts in precedence order:
    │       1. config.esbuild?.jsx (authoritative for Vite builds)
    │       2. @vitejs/plugin-react options, if plugin present
    │       3. tsconfig.compilerOptions.jsx (hint only; type-check-only)
    │      → if classic: throw with actionable message. v0 requires automatic runtime.
    │  • Instantiate ManifestWriter(projectRoot, manifestPath, options, clock)
    │      → constructor runs mkdirSync(dirname(manifestPath), { recursive: true })
    │      → immediately writes an empty Manifest to disk (atomic same-dir rename, with EPERM/EBUSY retry on Windows)
    │
    ▼
Vite fires configureServer(server)
    │  • If options.daemon === false: daemonHandle = null, skip.
    │  • Else (options.daemon === true || { ... } || undefined with package installed):
    │    attempt `const mod = await importer()` where importer is injected (`() => import('@redesigner/daemon')`)
    │       ├─ ERR_MODULE_NOT_FOUND:
    │       │    • if options.daemon?.required === true: throw (user explicitly asked for it)
    │       │    • else: logger.warn once; daemonHandle = null
    │       ├─ other error → logger.error with full stack; daemonHandle = null; CONTINUE (do not rethrow; dev server stays up)
    │       └─ success → await mod.startDaemon({ manifestPath, port }); store handle
    │                   → spawn uses detached: false, stdio: ['ignore','pipe','pipe'] (parent-death behavior on POSIX)
    │  • Register teardown on: server.close, SIGINT, SIGTERM, SIGHUP, beforeExit, uncaughtException, unhandledRejection
    │      (all paths route through a single idempotent shutdown() function; §5.4)
    ▼
Schedule forced initial flush: buildEnd OR first idle tick → writer.flush()
    │  (bounds worst-case "empty manifest visibility" to one idle cycle)
    ▼
Dev server listens on its chosen port
```

### 5.2 Per-transform (every `.jsx`/`.tsx` Vite serves)

```
Vite calls transform(code, id, options) on our plugin (enforce: 'pre')
    │
    ▼
if options?.ssr === true: return undefined  (client pass is authoritative; §3.3 invariant 1)
    │
    ▼
Filter: id matches include/exclude globs and ends in .jsx or .tsx
    │  (no match → return undefined)
    ▼
pathGuards.toPosixRelative(id, projectRoot) → relPath
    │  (on failure → logger.warn once per file; skip visitor; return undefined. NEVER throw from transform.)
    ▼
Build an empty transform-local batch object
    │
    ▼
Invoke @babel/core.transformAsync(code, {
    plugins: [redesignerBabelPlugin({ relPath, batch })],
    sourceMaps: true,
    inputSourceMap: true
})
    │
    ▼
Babel visitor runs:
    │  1. JSXFragment: explicitly skipped. No attribute injection. (§3.3 invariant 9)
    │  2. JSXOpeningElement / JSXSelfClosingElement: wrap case body in try/catch.
    │     On throw → logger.warn with file:line; skip this node; continue.
    │  3. Walk up AST to enclosing component (resolveEnclosingComponent):
    │     • unwrap `memo(X)`, legacy `forwardRef(...)` → the real inner identifier
    │     • arrow-const, named-function, class components all supported
    │     • ref-as-prop components (`function X({ ref })`) resolve as normal function components (no special case)
    │     • anonymous default → fallback: PascalCase(basename(relPath))
    │     • JSX transitively inside a non-component helper (render prop, map callback)
    │       → attributed to the enclosing component, not the helper
    │     • JSX at module scope (no enclosing function of any kind)
    │       → attributed to synthetic component `<module>` with componentKey `relPath + ':<module>'`
    │     • True dead-code JSX (never rendered, e.g. guarded behind a literal false) → skip silently
    │     • Third-party HOCs (styled, observer, emotion.styled, etc.) → NOT unwrapped.
    │       Component identity follows the `const X = ...` assignment, regardless of RHS shape.
    │       Only React's official transparent wrappers (memo, legacy forwardRef) are unwrapped.
    │  4. componentKey = relPath + '::' + componentName
    │     • `::` separator avoids ambiguity with any single-colon occurrences and reserves a clean splittable boundary
    │     • componentKey is treated as opaque by consumers; §6.3's LocRecord also carries structured `{ filePath, componentName }` to make consumers independent of the format
    │  5. locString = formatLoc(relPath, line, col)  →  "src/components/Button.tsx:12:4"
    │  6. Register in batch: batch.components[componentKey] = { ... }; batch.locs[locString] = { componentKey, filePath, componentName }
    │  7. Inject <jsx-element data-redesigner-loc="..." ...> attribute
    ▼
Babel returns { code: result.code, map: result.map }
    │
    ▼
Vite plugin returns { code, map }  explicitly  (does NOT return a bare string)
    │
    ▼
writer.commitFile(relPath, batch):
    │  • Atomic compare-and-swap on immutable state map:
    │       newState = state.set(relPath, batch)
    │    (per-file replace; prior entries for relPath are discarded atomically in one op)
    │  • Schedule debounced flush (200 ms debounce, 1000 ms max-wait)
    ▼
plugin-react (or plugin-react-swc / plugin-react v6) receives { code, map }, does its JSX transform.
    │
    ▼
Browser loads page → React renders → DOM elements carry data-redesigner-loc.
```

### 5.3 HMR

```
User edits src/components/Button.tsx
    │
    ▼
Vite invalidates the module graph. Affected files re-run through transform().
    │  HMR cascade: Button.tsx AND importers may be re-transformed. Each re-transformed file
    │              triggers its own writer.commitFile(relPath, freshBatch) → per-file atomic replace.
    ▼
Debounced disk flush fires (at most maxWait=1000ms later) → atomic same-dir temp-file rename → .redesigner/manifest.json updated
    │
    ▼
(Out of scope here, noted for interface clarity:)
Daemon (if running, separate spec) watches manifest.json → reloads its in-memory index
    │
    ▼
Vite HMR pushes new module to browser → React re-mounts → new data-redesigner-loc on rerendered elements
```

### 5.4 Shutdown

All termination paths route through a single idempotent `shutdown()`. Fired by: `server.close`, `SIGINT`, `SIGTERM`, `SIGHUP`, `beforeExit`, `uncaughtException`, `unhandledRejection`. An idempotency flag guards re-entry.

```
shutdown() — idempotency flag check; second call returns immediately
    │
    ▼
1. writer.flushSync() — fs.writeFileSync wrapped in try/catch;
       on EBUSY/EPERM (Windows AV / locked handle): retry up to 3× with 50 ms backoff
       on final failure: fall back to console.error (config.logger may be torn down)
       Upper bound ≈ 100 ms for 10k+ components; documented in README.
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
             send graceful shutdown message via stdin/IPC
             wait up to 2 s
             if still alive: spawn taskkill /T /F /PID <pid> (tree-kill)
             if taskkill fails: logger.warn; manual user cleanup required
```

Abnormal termination (the parent itself gets SIGKILL'd) cannot be cleaned up from our side. The daemon (in its own spec) is responsible for detecting parent death via a `ppid` watchdog and self-exiting on Windows (where process-group parent-death semantics don't exist as on POSIX).

---

## 6. Public API surface

### 6.1 Entry point

```ts
// packages/vite/src/index.ts
import type { Plugin } from 'vite'

export interface RedesignerOptions {
  manifestPath?: string               // relative to projectRoot; absolute paths and escaping paths rejected
  include?: string[]                  // default: ['**/*.{jsx,tsx}']
  exclude?: string[]                  // default: ['node_modules/**', '**/*.d.ts']
  enabled?: boolean                   // default: true in dev (apply: 'serve'), false in build
  daemon?: boolean | {
    port?: number                     // default: 0 (OS-assigned)
    required?: boolean                // default: false. If true, missing daemon package throws at startup.
  }
  // Interpretation:
  //   undefined | true | { ... }  → attempt autostart when @redesigner/daemon is installed
  //   false                         → never attempt
  //   { required: true }            → attempt; on ERR_MODULE_NOT_FOUND, throw
}

export default function redesigner(options?: RedesignerOptions): Plugin

export type * from './core/types'     // re-exports Manifest, ComponentRecord, LocRecord, RedesignerOptions, etc.
```

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

Position in `plugins` array does not matter relative to plugins **without** `enforce`. If the user has another `enforce: 'pre'` plugin that also transforms JSX/TSX, order among `pre`-enforced plugins is declaration order. Documented in README: "declare `redesigner()` before any other `enforce: 'pre'` plugin that transforms JSX/TSX."

### 6.3 Manifest shape (exported types + shipped JSON Schema)

```ts
// packages/vite/src/core/types.ts
export interface Manifest {
  $schema?: string                    // URL to the published schema for this version
  schemaVersion: '1.0'                // string semver "<major>.<minor>"; see evolution rules below
  framework: 'react'
  generatedAt: string                 // new Date().toISOString() — UTC with Z suffix
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string                    // project-relative, posix separators
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  componentKey: string                // opaque. Consumers SHOULD prefer the structured fields below.
  filePath: string                    // same as ComponentRecord.filePath
  componentName: string               // readable component name
}
```

**Schema version evolution rules (part of the contract):**

- `schemaVersion` is `"<major>.<minor>"` (string, not integer). Current: `"1.0"`.
- **Additive change** (new optional field, new object entry type) → **minor bump** (`1.0` → `1.1`). Consumers MUST accept unknown fields (forward compatibility).
- **Breaking change** (remove field, rename field, change type, change value semantics) → **major bump** (`1.0` → `2.0`). Consumers MUST reject on major mismatch.
- On minor-ahead (consumer saw `1.0`, manifest is `1.2`) → warn but continue.
- On parse failure, consumers SHOULD retry once after a 50 ms sleep — covers the rename-in-progress window. On second failure, treat the manifest as unavailable and poll.

**`projectRoot` intentionally absent from the published schema.** An absolute filesystem path in a file that may end up in git or shared artifacts leaks the developer's local layout. Plugins that need it can obtain it from their own process config; it is not part of the manifest contract.

**`componentKey` is opaque.** The format is `relPath::componentName` today but MAY change in future minor bumps (e.g. to include multi-instance suffixes). Consumers MUST treat it as an opaque identifier. The `LocRecord.filePath` + `componentName` structured fields are the stable, consumer-facing split.

**`$schema` URL** is populated at build time to point at the published schema for the current version. Consumers can use it to locate the matching JSON Schema without version-mapping logic of their own.

The JSON Schema (`manifest-schema.json`, draft-2020-12) is generated at build time from the TS types via `ts-json-schema-generator`. Single source of truth is the `.ts` file. Schema is shipped in the package via `package.json`'s `exports` map (`./manifest-schema.json`) and `files` array.

### 6.4 `package.json` essentials

```json
{
  "name": "@redesigner/vite",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./manifest-schema.json": "./dist/manifest-schema.json"
  },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20.11.0" },
  "peerDependencies": {
    "vite": "^5 || ^6 || ^7 || ^8",
    "@vitejs/plugin-react": "^4 || ^5 || ^6"
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
    "vitest": "^2"
  }
}
```

Root-level `package.json` includes:
```json
{
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=20.11.0", "pnpm": ">=9.15" }
}
```

Notes:

- **ESM-only for v0.** No `require` conditional export. If a CJS consumer needs this in the future, that is a v1 ask.
- **`@redesigner/daemon` is NOT listed in any deps field.** Dynamic `import()` at runtime handles presence correctly. Users install the daemon explicitly: `pnpm add -D @redesigner/daemon`.
- **Vite peer range spans 5–8.** Supports Vite 8 + plugin-react v6 (Babel-less; we carry our own Babel). Documented in README.
- **`@vitejs/plugin-react` is an optional peer** with a wide range (`^4 || ^5 || ^6`). SWC users get our Babel pass via the independent transform hook.
- **Corepack enforces `packageManager`.** CI and `CONTRIBUTING.md` both instruct `corepack enable` as the first step. Exact version pin (`pnpm@9.15.4`) is required by Corepack's strict-match.

### 6.5 User-visible messages

All messages prefixed `[redesigner]`. Routed through `config.logger` (captured in `configResolved`).

| Severity | Example | When |
|---|---|---|
| `error` | "manifestPath escapes projectRoot" | Misconfigured options; thrown from `configResolved` |
| `error` | "classic JSX runtime detected; v0 requires automatic runtime" | Thrown from `configResolved` |
| `error` | daemon `startDaemon()` threw on import | Non-fatal: logged, plugin continues in manifest-only mode |
| `error` | daemon `required: true` but package missing | Thrown from `configureServer` |
| `warn` | daemon package not installed (`ERR_MODULE_NOT_FOUND`, `required !== true`) | One-time; quiet |
| `warn` | Classic runtime configured only in tsconfig but esbuild/plugin-react use automatic | `debug` (no action) |
| `warn` | Transform / path-guard error for a single file | One-time per file |
| `warn` | Per-node visitor exception | With `file:line` |
| `warn` | Atomic rename retried N times before success (Windows EPERM/EBUSY) | Only if retries exceeded a threshold (e.g. 2+ retries) |
| `warn` | Shutdown flush retried after EBUSY | Once per shutdown |
| `info` | First successful manifest write | One-time |
| `debug` | Per-transform timings; SSR-pass skip notifications; `@vitejs/plugin-react` absent | Behind `DEBUG=redesigner:*` |

---

## 7. Error handling & failure modes

| # | Trigger | Detected in | Handling | User sees | Test |
|---|---|---|---|---|---|
| 1 | `manifestPath` escapes projectRoot | `configResolved` | Throw | Dev server fails to start, clear message | unit |
| 2 | `manifestPath` absolute | `configResolved` | Throw | Same | unit |
| 3 | projectRoot contains backslash / drive letter | `configResolved` | Throw ("plugin bug — please report") | Dev server fails to start | unit |
| 4 | **Classic JSX runtime detected via esbuild/plugin-react** (authoritative sources) | `configResolved` | Throw with actionable message: "v0 requires the automatic JSX runtime." | Dev server fails to start | unit (runtimeDetect fixtures) |
| 4b | Classic only in tsconfig but esbuild/plugin-react automatic | `configResolved` | `debug` log, proceed normally | None at default log level | unit |
| 5 | `@vitejs/plugin-react` absent, SWC plugin present | `configResolved` | `debug` log | None | integration |
| 6 | Daemon dynamic import → `ERR_MODULE_NOT_FOUND`, `required !== true` | `configureServer` | `warn` once; `daemonHandle = null`; continue | One-line yellow warning | unit (injected importer; `vi.resetModules` pattern) |
| 6b | Daemon dynamic import → `ERR_MODULE_NOT_FOUND`, `required === true` | `configureServer` | Throw | Dev server fails to start | unit |
| 7 | Daemon dynamic import → other error | `configureServer` | `error` log with full stack; `daemonHandle = null`; continue | Red error; dev server continues | unit (injected importer) |
| 8 | Per-file path normalization fails | `transform` | `warn` once per file; skip visitor; return `undefined`; never throw from transform | Per-file warning | unit |
| 9 | Babel parser fails on whole file | `transform` | `warn` with file path; return `undefined`; let plugin-react attempt its own parse | Per-file warning | fixture: `malformed-jsx/` |
| 10 | **Visitor exception on a single JSX node** | Babel plugin | Per-visitor-case try/catch (wrap `JSXOpeningElement`, `JSXSelfClosingElement` case bodies individually). `warn` with `file:line`; skip that node; continue. | Per-node warning | fixture: `pathological-node/` |
| 11 | True dead-code JSX (guarded behind literal false, etc.) | Babel plugin | Skip silently | None | fixture: `jsx-outside-component/` (renamed to `dead-code-jsx/`) |
| 11b | JSX inside a non-component helper but transitively within a component | Babel plugin | Attribute to the outer component | None | fixture: `inline-jsx-in-callback/` |
| 11c | JSX at module scope (no enclosing function) | Babel plugin | Attribute to synthetic `<module>` component | None | fixture: `module-scope-jsx/` |
| 11d | JSX inside a `JSXFragment` (`<>`) — visiting the Fragment itself | Babel plugin | Skip the Fragment; children visited normally | None | fixture: `fragment-noop/` |
| 12 | Writer state contention | `manifestWriter` | N/A — state is an immutable map, mutated by atomic compare-and-swap. Per-file replace semantics. | None | (design choice; no test needed) |
| 12b | Overlapping re-transform of the same file (transform re-entry) | `manifestWriter` | Per-file replace wins (each transform-local batch is the full new set). No lost writes. | None | unit + parallelism.test.ts |
| 13 | Disk write fails (EACCES, ENOSPC) | `manifestWriter` flush | `error` log; retry next debounce tick; after 3 consecutive failures, `warn` "manifest writes failing; daemon will see stale data" | Red error, escalating warning | unit (mock fs) |
| 14 | **Atomic rename fails with EPERM/EBUSY (Windows AV, Search-indexer, concurrent reads)** | `manifestWriter` flush | Retry up to 3× with 50 ms backoff, then unlink temp file; `warn`; continue (old manifest remains valid) | Yellow warning only after retries exceeded | unit (mock fs throws EPERM twice, succeeds third); CI runs Linux + Windows |
| 14b | Atomic rename fails with `EXDEV` (cross-device) | `manifestWriter` flush | Should never occur — temp file is always same-dir. If observed, indicates bug: log `error` with paths. | Red error (indicates bug, not user issue) | unit |
| 15 | Shutdown before debounce flush | shutdown() | `fs.writeFileSync` wrapped in `try/catch`; on EBUSY/EPERM (Windows) retry up to 3× with 50 ms backoff; on final failure fall back to `console.error` | None (clean) | integration |
| 16 | POSIX: daemon didn't die after SIGTERM + 2 s | Teardown | `kill('SIGKILL')`; `warn` | Yellow warning | unit (real subprocess) |
| 16b | Windows: daemon didn't die after graceful message + 2 s | Teardown | `taskkill /T /F /PID <pid>`; `warn` on failure | Yellow warning on shutdown | unit (real subprocess, Windows-only skip on non-Windows) |
| 17 | Teardown fires twice (SIGINT + server.close race; uncaughtException inside teardown) | All teardown paths | Single idempotency flag; second call returns immediately | None | unit |
| 18 | Vite config reload during dev | Plugin reinit | Old instance's shutdown fires; new instance starts fresh. Covered by `reinit.test.ts` (no longer "verify empirically"). | Normal Vite reload messaging | integration: `reinit.test.ts` |
| 19 | SSR transform call (`options?.ssr === true`) | `transform` | Return `undefined` — no Babel pass, no commit | None | integration: `ssr.test.ts`; fixture: `ssr-skip/` |
| 20 | `.redesigner/` directory missing on fresh clone | `ManifestWriter` constructor | `mkdirSync(dirname(manifestPath), { recursive: true })` before first write | None | unit (delete dir, instantiate writer) |
| 21 | User edits `vite.config.ts` during dev; plugin re-initializes | Vite lifecycle | Idempotent shutdown teardown; new plugin instance starts fresh | Normal Vite reload messaging | integration: `reinit.test.ts` |

### 7.1 Non-goals (error handling)

- No recovery from a partially written manifest. Atomic rename (with Windows retry) makes this recoverable-or-loud, not silent.
- No user-configurable log levels beyond Vite's own `--logLevel`.
- No telemetry, no remote error reporting, no auto-update / version-check ping. If we ever add any of these, it is behind an explicit opt-in flag with prominent docs.

---

## 8. Testing plan

Three tiers, each with explicit scope. Vitest throughout. Fast-check for roundtrip properties.

### 8.1 Unit tests — `test/unit/`

**Invariant: pure functions + small utilities; no filesystem I/O beyond mocked fs.**

| File | Coverage |
|---|---|
| `locFormat.test.ts` | `formatLoc` / `parseLoc` roundtrip including fast-check property: `parseLoc(formatLoc(p, l, c)) === { p, l, c }` for generated inputs covering unicode filenames, spaces, and embedded-colon edge cases. Backslash / drive-letter rejection. |
| `pathGuards.test.ts` | `assertPosixProjectRoot`, `toPosixRelative`, escape guards (`../`, absolute `manifestPath`). |
| `runtimeDetect.test.ts` | Precedence: esbuild.jsx → plugin-react config → tsconfig. Fixtures: all-automatic; esbuild-automatic + tsconfig-classic (row 4b); esbuild-classic (row 4). |
| `resolveEnclosingComponent.test.ts` | AST walk for each component shape: default/named/arrow/memo/legacy-forwardRef/ref-as-prop/HOC/module-scope/dead-code. |
| `plugin.test.ts` | Vite plugin lifecycle: options merge, `configResolved` throws on bad config (escape, classic runtime, daemon required+missing), re-exports typing, SSR-pass skip. Uses Vite `createServer` helper with mocked fs. |
| `manifestWriter.test.ts` | Immutable-map + CAS semantics. `commitFile(relPath, batch)` per-file replace atomicity. Startup empty-manifest write + mkdir-p. Debounce + maxWait timing with `vi.useFakeTimers` and injected clock. Synchronous final flush. Windows mock: `fs.rename` throws EPERM twice, succeeds; retry count observable. EXDEV never occurs (temp always same-dir) — assertion. `onFlush` monotonic seq. `quiesce` waits for idle window. |
| `daemonBridge.test.ts` | **Injected importer strategy** (preferred over module-cache surgery). Tests: (a) importer throws `ERR_MODULE_NOT_FOUND`, required=false → quiet warn. (b) same, required=true → throws. (c) importer throws generic error → loud error + continue. (d) importer resolves → daemon spawned with `detached: false, stdio: ['ignore','pipe','pipe']`. (e) Teardown idempotency. (f) POSIX SIGTERM → 2s → SIGKILL. (g) Windows: graceful IPC → 2s → taskkill (runs only on Windows CI). (h) Logger-torn-down fallback to `console.error`. For rare module-cache tests, uses `vi.resetModules()` + fresh `await import()` pattern, documented in `test/fixtures/README.md`. |

### 8.2 Fixture tests — `test/fixtures/`

**On-disk `input.tsx` / `output.tsx` / `expected-manifest.json` triples. Diffed as text.**

Regeneration is gated: `pnpm test:fixtures --update` fails unless `REDESIGNER_FIXTURE_UPDATE=1` is set AND a corresponding entry is added to `test/fixtures/FIXTURE_CHANGELOG.md` in the same commit. A Biome/pre-commit hook blocks commits that modify `output.tsx` or `expected-manifest.json` without a changelog entry. CI fails if `.only`/`.skip` leaks, if `REDESIGNER_FIXTURE_UPDATE` is set in CI env, or if the expected test-file count drops (see §8.5).

Each case directory contains:
```
fixtures/<case>/
  input.tsx
  output.tsx
  expected-manifest.json
  README.md            (one paragraph: what this case proves)
```

Cases:

- `default-export/` — simple default export component
- `named-exports/` — multi-component file
- `memo-wrapped/` — `React.memo(Component)` unwraps correctly
- `forwardRef-wrapped/` — legacy `React.forwardRef(...)` unwraps correctly (React-18-compat case; README flags React 19 idiom is ref-as-prop)
- `ref-as-prop/` — React 19 idiomatic `function X({ ref })`; resolves like any function component
- `arrow-const/` — `const Button = () => <div />`
- `anonymous-default/` — `export default () => <div />`
- `inline-jsx-in-callback/` — JSX inside a map/render-prop → attributed to outer component
- `children-as-function/` — render-prop stress: `<DataFetcher>{(data) => <Row data={data} />}</DataFetcher>`; both JSX nodes get distinct locs attributed correctly
- `hoc-wrapped/` — third-party HOC: `const StyledButton = styled(Button)` → componentKey uses assignment name, NOT unwrapped
- `fragment-noop/` — `<>...</>` gets no attribute (JSXFragment skipped); children get attributes normally
- `module-scope-jsx/` — module-scope JSX → synthetic `<module>` component (row 11c)
- `ssr-skip/` — Babel plugin invoked with SSR flag → emits no changes (row 19)
- `malformed-jsx/` — parse failure, warn + skip (row 9)
- `pathological-node/` — one node throws, others succeed (row 10)
- `jsx-outside-component/` (aka `dead-code-jsx/`) — silent skip only for genuinely unreachable JSX
- `unicode-filename/` — non-ASCII file path normalization
- `filename with spaces/` — space-in-path normalization

The **fixture runner** is `test/fixtures/_runner.test.ts`. It enumerates directories, runs Babel with our plugin, diffs `output.tsx` and `expected-manifest.json`. On mismatch, prints a readable diff identifying which component is under-tagged, and the `--update` hint with the env-var and changelog requirements.

### 8.3 Integration tests — `test/integration/`

**Real Vite dev server, real playground, real filesystem. Per-test tmpdir isolation (see `parallelism.test.ts`). Extended Vitest timeout.**

| File | Coverage |
|---|---|
| `vite.test.ts` | Programmatic `createServer` with playground. GET `/`. **DOM assertions (no count-match):** (a) every rendered DOM element within the `#root` mount carries `data-redesigner-loc` (excluding the mount element itself, excluding text-only Fragment wrappers). (b) every `data-redesigner-loc` value parses and resolves to a manifest entry. (c) hardcoded-loc set: `PricingCard` × 4, `Button` × N, `DataFetcher`, `Row` (inside render prop), and `module-scope <App />` must all appear with expected keys. Failure messages identify missing/extra component by name, not just numeric diff. |
| `manifest.test.ts` | Start server, wait for `writer.quiesce() + server.waitForRequestsIdle()`, read `.redesigner/manifest.json`. Validate against exported JSON Schema. Consumer-contract checks: `schemaVersion === "1.0"`, `$schema` URL present, unknown-field tolerance, retry-on-parse-failure demo. Assert: every `data-redesigner-loc` in DOM resolves to a manifest entry (no orphans); every manifest entry's `componentKey` maps to a real file. Spot-check `PricingCard` × 4. |
| `hmr.test.ts` | Uses **`writer.quiesce()` + `server.waitForRequestsIdle()`** — NO hardcoded `setTimeout`. Scenarios: (1) prepend line to `Button.tsx`, quiesce, assert `lineRange` shifted, loc still resolves. (2) rename component, quiesce, assert old componentKey gone, new present, no stale entries. (3) **two-file cascade:** edit `Button.tsx` and immediately edit `PricingCard.tsx`; after both quiesce, assert both files' entries are accurate and no interleaved loss. |
| `ssr.test.ts` | Invoke `server.transformRequest(url, { ssr: true })` directly on a JSX file. Assert (a) returned code is equivalent to input (no attributes), (b) writer state for that file is unchanged, (c) no commit happened. |
| `react-compiler.test.ts` | Playground runs with `babel-plugin-react-compiler` enabled. Start server, verify attributes still present, verify compiler output hoists correctly with attributes preserved. Baseline: if this fails, document the known interaction in README. |
| `sourcemap.test.ts` | Start server. Fetch transformed source for `Button.tsx`. Parse the returned source map. Assert: a `data-redesigner-loc`-annotated line maps back to the original source line (not the transformed line). Verifies `{ code, map }` is returned correctly, not a bare string. |
| `reinit.test.ts` | Start server. Touch `vite.config.ts`. Vite reloads config. Assert: old writer's shutdown fires; new writer instance flushes empty manifest; no duplicate daemon processes; `process._getActiveHandles()` count stable. Covers row 18. |
| `parallelism.test.ts` | Per-test tmpdir: `beforeEach` copies playground via `fs.mkdtemp()` and points Vite root there. Stress: 10 parallel `transform` calls on distinct files via `server.transformRequest`; assert final manifest contains all 10 entries with no lost writes. |
| `degradation.test.ts` | Uses injected importer (no ESM module-graph surgery). (a) `daemon: false` → no attempt, silent. (b) importer throws generic `Error('simulated')` → error logged, plugin continues, manifest still written. (c) `daemon: { required: true }` + missing daemon → dev server fails to start. (d) Corrupt a source file mid-server → warn, plugin continues, other files still work. |
| `shutdown.test.ts` | Uses a **real subprocess** fake daemon (`test/fixtures/fake-packages/`). POSIX scenario: send SIGTERM, subprocess responds after 500 ms, flush completes cleanly. POSIX escalation: subprocess ignores SIGTERM, 2 s elapse, SIGKILL sent, exit observed. Windows scenario (skip on non-Windows): graceful stdin message → subprocess exits; if subprocess ignores, taskkill invoked, process tree terminated. Teardown idempotency: call shutdown twice, only one flush, only one signal. |

### 8.4 CI matrix (ships with this spec, not deferred)

- **GitHub Actions matrix:** `{ os: [ubuntu-latest, windows-latest], node: [20.11, 22] }`.
- **pnpm activation:** first step is `corepack enable`; second is `pnpm install --frozen-lockfile`.
- **Jobs:** Biome check, unit, fixtures, integration — all four run on every matrix cell. `shutdown.test.ts` Windows branch runs only on `windows-latest`.
- **Required checks** enforced via `.github/workflows/required-checks.yml`: the `windows-latest + node-22` job is marked required on branches that touch the daemon spec or any code under `packages/` — preventing the "works on Linux, ships broken on Windows" class.
- **CI also asserts:** no `.only`/`.skip` in test files; `glob('test/**/*.test.ts').length >= EXPECTED` (count committed in `test/_expected-count.json` alongside the runner); `REDESIGNER_FIXTURE_UPDATE` is not set.
- **Integration test breadcrumb:** after full transform of playground, logs total transform time. Not a gate; CI captures the trend so regressions are visible before they become user complaints.

### 8.5 Non-goals (testing)

- No Playwright / real-browser E2E. No extension exists yet.
- No performance benchmarks as gates.
- No DOM snapshot of the entire playground — brittle; fixture tests + spot checks cover what matters.
- No coverage threshold gate. Coverage numbers lie; the fixture + HMR + degradation + parallelism suites cover the known-risky paths intentionally. **Test-file count smoke check** compensates for the specific "whole test file accidentally skipped" risk.

---

## 9. Open questions (carried forward, not resolved here)

From brief §152–157. None block this spec; each belongs in its owning spec.

- **Daemon ↔ extension protocol** — decide in daemon spec.
- **HMR granularity beyond file-level** — out of scope; plugin side does per-file replace, daemon side handles consumer reload.
- **Port discovery** — daemon spec decision. Plugin passes `daemon.port` through (default 0).
- **Product name** — still TBD. Codename `redesigner` is internal.

---

## 10. Appendix — decision log

Key decisions made during brainstorming and panel review, recorded so later work does not re-litigate them:

1. **Spec scope = Vite plugin + playground only** (brief build order 1 + 2). Daemon, MCP, extension, CLI each get separate specs.
2. **pnpm workspaces + Biome.** No Turborepo, no ESLint/Prettier.
3. **`@vitejs/plugin-react` + Babel path** (not plugin-react-swc). Plugin is independent; Vite 8 + plugin-react v6 (Babel-less) supported.
4. **DOM attribute: `data-redesigner-loc`** (namespaced to avoid collision with other devtool plugins + React's `__source`). Format: `"relPath:line:col"`, project-relative, posix separators. Fail loud on backslash / drive-letter leakage.
5. **Manifest schema:** `schemaVersion: "1.0"` string semver; additive=minor, breaking=major; consumers accept unknown fields; retry-once on parse failure; `componentKey` opaque + structured `filePath`/`componentName` fields; `projectRoot` not in manifest.
6. **Codename `redesigner`, rename accepted.** No placeholder substitution.
7. **Dev-only (`apply: 'serve'`)**, `enabled` flag reserves an escape hatch.
8. **Zero-config factory default export.** `daemon` option is tri-state: `undefined|true|{...}` → attempt autostart; `false` → never; `{ required: true }` → fail if missing.
9. **Daemon cross-cut via injected importer.** Dynamic `import()` with `ERR_MODULE_NOT_FOUND` vs. other-error discrimination. Never rethrow other errors into the dev-server startup path. Tests inject their own importer instead of fighting ESM module cache.
10. **React 19 + automatic JSX runtime only.** Classic runtime is a hard error at startup. Runtime detection precedence: esbuild.jsx → plugin-react config → tsconfig (hint only).
11. **Independent Babel pass with `enforce: 'pre'`**, `sourceMaps: true, inputSourceMap: true`, returning `{ code, map }` explicitly.
12. **Immutable map + per-file replace CAS** for writer state. `commitFile(relPath, batch)` takes the full new set. No mutex. Transform-local batches eliminate re-entry races.
13. **Empty-manifest write at startup** — `mkdir -p` before first write; consumers always see self-consistent manifest; no rehydration from prior state.
14. **Per-visitor-case try/catch** for node-level resilience.
15. **JSXFragment explicitly skipped;** children attributed normally.
16. **Module-scope JSX attributed to synthetic `<module>` component;** app roots stay hit-testable.
17. **HOC unwrap policy:** only React's official transparent wrappers (`memo`, legacy `forwardRef`). Third-party HOCs keep the assignment-target name.
18. **SSR pass skipped.** Client pass is authoritative for DOM attribution.
19. **No telemetry, no update-check.**
20. **ESM-only for v0.**
21. **Full CI matrix ships with this spec** (Linux + Windows × Node 20.11 + Node 22). Deferring to a "before daemon merges" milestone was judged too risky.
22. **Platform-aware shutdown.** POSIX: SIGTERM → 2 s → SIGKILL. Windows: graceful IPC → 2 s → taskkill tree-kill. Teardown registered on SIGINT/SIGTERM/SIGHUP/beforeExit/uncaughtException/unhandledRejection. Daemon spawn uses `detached: false, stdio: ['ignore','pipe','pipe']`.
23. **Windows-aware atomic write.** Same-directory temp file (no `os.tmpdir()`), EPERM/EBUSY retry with 50 ms backoff.
24. **Corepack + exact `packageManager` pin** (`pnpm@9.15.4`). `CONTRIBUTING.md` instructs `corepack enable`. `engines.node: ">=20.11.0"` + `engines.pnpm: ">=9.15"`.
25. **Build toolchain: `tsup` + `ts-json-schema-generator`.** `dist/` contains `index.js`, `index.d.ts`, `manifest-schema.json`.
26. **Fixture --update is gated** by `REDESIGNER_FIXTURE_UPDATE=1` env var + `FIXTURE_CHANGELOG.md` entry; pre-commit and CI both enforce.
27. **Property-based test** on `formatLoc`/`parseLoc` roundtrip via `fast-check`.
28. **React Compiler compat verified** by integration test; runs first via `enforce: 'pre'`.
