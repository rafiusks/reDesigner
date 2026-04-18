# Vite Plugin + Playground — v0 Design Spec

**Date:** 2026-04-18
**Status:** Draft — pending user review
**Codename:** `redesigner` (product name TBD; rename cost at naming time is accepted — see §10 item 6)

---

## 1. Scope

### 1.1 What this spec covers

This spec defines the **first milestone** of the v0 roadmap from `brief.md`: the Vite plugin (`@redesigner/vite`) and the playground app (`examples/playground/`), together with the monorepo scaffold that hosts them.

Concretely, this spec delivers:

- `@redesigner/vite` — a Vite plugin that injects `data-src-loc` attributes onto every JSX element in dev builds and emits a project manifest to `.redesigner/manifest.json`.
- `examples/playground/` — a React 19 + TypeScript + Vite app used to dogfood and test the plugin.
- Monorepo scaffold: pnpm workspaces, Biome, shared tsconfig base, `.gitignore`, root `README.md` stub, `.editorconfig`.

### 1.2 What this spec does NOT cover (and why)

This v0 slice is intentionally narrow. The brief's build order (§131–136) sequences the system into six deliverables; this spec is the first two. The remaining items each get their own spec.

| Deferred item | Why out of scope here | Unblocks when |
|---|---|---|
| `@redesigner/daemon` | Brief §154–156 leaves protocol / port discovery / HMR-watch strategy open. Forcing those decisions inside the plugin spec would either lock them prematurely or bloat scope. Plugin reserves the `daemon` option shape now; behavior activates when the daemon package is installed. | Daemon spec drafted + approved. |
| `@redesigner/mcp` shim | Requires daemon. Brief §36–51. | Daemon spec complete. |
| Chrome extension | Requires daemon WS protocol; also brief §128 deliberately sequences it last. | Daemon + MCP both complete. |
| `@redesigner/cli` (`init`) | Writes `.mcp.json` + Vite config snippet; trivial once all package names + the Chrome extension ID are finalized. | MCP spec + extension ID allocation. |
| Full CI matrix (Linux + Windows, Node 20 + 22, pnpm 9+) | Shared across every package; owning it in this spec would embed per-package assumptions. | Second published package (the daemon). |
| Runtime props, fiber traversal, Vue/Svelte/Next adapters, DevTools panel, extension chat UI, persistence UI, OpenAI backend, variation flows | Explicitly post-v0 per brief §141–150. | Post-v0. |
| SWC plugin wrapper | Deferred per brief. The framework-agnostic core mandated by this spec (§3) means SWC support is later ≈50 LOC + a Rust/Wasm build step, not a rewrite. Not a promise; a commitment that the architecture will not preclude it. | User ask post-v0. |

### 1.3 Rationale for the slice

The brief's dogfood sequence (§119–128) walks each upstream dependency forward one step at a time. Step 1 is "Vite plugin against the playground — verify `data-src-loc` appears on rendered DOM elements." That is the smallest end-to-end testable unit with no external dependencies. Every downstream piece (daemon, MCP, extension) assumes this layer is solid; landing it on its own lets the rest be built against a known-good foundation.

### 1.4 Validation gate

This spec is considered complete when all of the following pass:

1. Unit tests (`test/unit/`) green.
2. Fixture tests (`test/fixtures/`) green, covering every component-shape edge case enumerated in §7.
3. Integration tests (`test/integration/`) green on Linux, including HMR tests (line-shift + rename).
4. Minimal CI runs Biome + all test tiers on at least Linux + one Node LTS.
5. Playground renders in the browser with `data-src-loc` on every rendered JSX element.
6. `.redesigner/manifest.json` validates against the exported JSON Schema.
7. Manual dogfood: open playground in Chrome DevTools, inspect an element, confirm `data-src-loc="src/...:line:col"` is present and points to the real source.

The full CI matrix (Windows + second Node version) is deferred to a follow-up micro-spec but **must land before the daemon spec merges** — Windows path bugs are exactly the class of defect that must be caught before we ship to users.

---

## 2. Premises fixed (do not re-litigate inside this spec)

These were decided during brainstorming. They are bound choices:

- **React 19 only** for v0. React 18 support is deferred, not blocked.
- **Automatic JSX runtime only.** Classic runtime triggers a hard error at startup (§6).
- **`@vitejs/plugin-react` is the default companion,** but the plugin is independent (§2.1) so projects on `@vitejs/plugin-react-swc` still work via the Babel transform fallback.
- **pnpm workspaces** for the monorepo. Biome for lint/format. No Turborepo, no ESLint, no Prettier.
- **Dev-only transform** (`apply: 'serve'`). `vite build` is a no-op by default. Strict about this for privacy + bundle size.
- **Project-relative paths, posix separators** in every artifact that reaches the DOM or the manifest.
- **Codename `redesigner`.** Rename cost at naming time is accepted.

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
                 │  │  entry           │──►│  (core)          │   │
                 │  │  (enforce:'pre') │   │                  │   │
                 │  └────────┬─────────┘   └────────┬─────────┘   │
                 │           │ invokes via           │ visitor     │
                 │           │ @babel/core in        │ runs per    │
                 │           │ transform hook        │ JSX call    │
                 │           ▼                      ▼             │
                 │  ┌──────────────────┐   ┌──────────────────┐   │
                 │  │ Daemon bridge    │   │ Manifest         │   │
                 │  │ (optional,       │   │ aggregator       │   │
                 │  │ dynamic import)  │   │ (immutable+CAS)  │   │
                 │  └──────────────────┘   └────────┬─────────┘   │
                 │                                  │ atomic      │
                 │                                  │ write       │
                 │                                  ▼             │
                 │                         .redesigner/manifest.json
                 └────────────────────────────────────────────────┘
```

### 3.2 Layers, top to bottom

1. **Vite plugin entry** — owns Vite lifecycle hooks (`configResolved`, `configureServer`, `closeBundle`, `server.close`). Loads user options, resolves project root, instantiates the manifest writer, attempts daemon bridge, orchestrates teardown.
2. **Babel plugin (core)** — pure-ish Babel visitor. Enclosing-component resolution, loc formatting, JSX attribute injection. **Framework-agnostic transform logic** lives in a separate internal module (`core/`) so a future SWC wrapper reuses it without depending on Babel.
3. **Manifest aggregator** — collects `componentKey → ComponentRecord` and `loc → LocRecord` entries from visitor passes. Immutable map + atomic pointer swap (no mutex, no contention, no deadlock risk). Debounced writer with maxWait. Atomic temp-file rename to disk. HMR-aware: per-file purge is a single atomic operation.
4. **Daemon bridge** — optional. Dynamic `import('@redesigner/daemon')` in `configureServer`. Discriminated `try/catch`: `ERR_MODULE_NOT_FOUND` is quiet-warn, any other error is loud-log but non-fatal (plugin continues in manifest-only mode). Handle tracked; teardown in `server.close` + SIGINT/SIGTERM with idempotency flag.

### 3.3 Key design invariants

1. **Independent Babel pass, not plugin-react coupling.** Our Vite plugin runs with `enforce: 'pre'`, invokes `@babel/core.transformAsync` in its `transform` hook, and returns modified source. Downstream React plugins (plugin-react or plugin-react-swc) then process our output unaware of us. Cost: one extra parse per JSX file. Benefit: zero coupling to plugin-react internals; the same Babel path works alongside plugin-react-swc for users who have chosen it.

2. **Framework-agnostic core.** `core/locFormat.ts` and `core/resolveEnclosingComponent.ts` are pure modules with no Vite or React runtime dependencies. Only Babel types are coupled (unavoidable for AST work). SWC support later = new thin wrapper calling the same core.

3. **Compile-time component resolution.** The Babel visitor walks up the AST from each JSX node to its enclosing component (function/class declaration, or arrow const, unwrapping `memo` / `forwardRef`). Resolution happens at transform time — daemon never re-derives component identity from source at runtime.

4. **Lazy manifest.** Manifest grows as Vite transforms files. No eager source-tree walk at startup. Downstream consumers must tolerate an incomplete manifest during the warm-up window.

5. **Fresh state on every start.** `ManifestWriter` construction (in `configResolved`) immediately overwrites `manifest.json` with an empty manifest (`version`, `framework`, `generatedAt: now()`, empty `components`, empty `locs`). Atomic temp-file rename, same as normal writes. This ensures any consumer always sees a self-consistent manifest; "empty at startup, grows as transforms run" becomes externally honest, not just internally.

6. **One-way flow: memory → disk.** Writer never reads manifest.json back. If the file disappears, the next debounce tick rewrites it from memory.

7. **Per-file purge before merge.** When a file is re-transformed (including HMR), the aggregator removes all entries whose `filePath === relPath` and adds new entries in a single atomic operation. Renamed or deleted components leave no stale entries.

---

## 4. Package + module layout

```
redesigner/                           (repo root, pnpm workspace)
├── package.json                      ("packageManager": "pnpm@9.15.x")
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── .gitignore                        (node_modules, dist, coverage, .redesigner/, pnpm-debug.log)
├── .editorconfig
├── README.md                         (stub — project pitch + link to this spec)
│
├── packages/
│   └── vite/                         → @redesigner/vite
│       ├── package.json
│       ├── tsconfig.json             (extends base)
│       ├── src/
│       │   ├── index.ts              (default export: redesigner factory; re-exports types)
│       │   ├── core/                 (pure, reusable across wrappers)
│       │   │   ├── locFormat.ts      (formatLoc, parseLoc)
│       │   │   ├── resolveEnclosingComponent.ts
│       │   │   ├── manifestSchema.ts (TS types + schema export build)
│       │   │   └── types.ts          (Manifest, ComponentRecord, LocRecord, RedesignerOptions)
│       │   ├── babel/
│       │   │   └── plugin.ts         (Babel wrapper, thin; uses core/*)
│       │   ├── integration/          (stateful / IO concerns)
│       │   │   ├── manifestWriter.ts (aggregator + atomic write + HMR purge + injectable clock)
│       │   │   ├── daemonBridge.ts   (dynamic import, teardown, idempotency)
│       │   │   └── pathGuards.ts     (posix normalization + escape guards)
│       │   └── plugin.ts             (Vite plugin entry; composes the above)
│       ├── test/
│       │   ├── fixtures/             (input.tsx / output.tsx / expected-manifest.json triples)
│       │   │   ├── README.md         (fixture-dir conventions; fixtures ≠ playground/edge)
│       │   │   ├── _runner.test.ts   (fixture-runner; reads fixtures + diffs)
│       │   │   ├── default-export/
│       │   │   ├── named-exports/
│       │   │   ├── memo-wrapped/
│       │   │   ├── forwardRef-wrapped/
│       │   │   ├── arrow-const/
│       │   │   ├── anonymous-default/
│       │   │   ├── inline-jsx-in-callback/
│       │   │   ├── hoc-wrapped/
│       │   │   ├── malformed-jsx/
│       │   │   ├── pathological-node/
│       │   │   ├── jsx-outside-component/
│       │   │   ├── unicode-filename/
│       │   │   └── filename with spaces/
│       │   ├── unit/                 (pure, IO-free)
│       │   │   ├── locFormat.test.ts
│       │   │   ├── resolveEnclosingComponent.test.ts
│       │   │   ├── pathGuards.test.ts
│       │   │   ├── plugin.test.ts
│       │   │   ├── manifestWriter.test.ts
│       │   │   └── daemonBridge.test.ts
│       │   └── integration/          (real Vite dev server; slow)
│       │       ├── vite.test.ts
│       │       ├── manifest.test.ts
│       │       ├── hmr.test.ts
│       │       ├── degradation.test.ts
│       │       └── shutdown.test.ts
│       ├── manifest-schema.json      (generated at build; shipped in package.files)
│       └── README.md                 (user-facing docs)
│
└── examples/
    └── playground/                   (not published)
        ├── package.json              ("@redesigner/vite": "workspace:*")
        ├── vite.config.ts            (two lines: import + plugin())
        ├── tsconfig.json
        ├── vite-env.d.ts
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx               (imports + renders all components including edge cases)
            ├── components/
            │   ├── Button.tsx                  (default export, used everywhere)
            │   ├── PricingCard.tsx             (rendered 4× in PricingSection)
            │   ├── PricingSection.tsx
            │   ├── Modal.tsx                   (many props, nested JSX)
            │   └── edge/                       (intentional edge cases — rendered in App)
            │       ├── MemoWrapped.tsx
            │       ├── ForwardRefWrapped.tsx
            │       ├── MultiComponentFile.tsx  (two named exports)
            │       ├── AnonymousDefault.tsx
            │       └── WithCallback.tsx        (inline JSX in a callback)
            └── styles/
                ├── app.module.css              (CSS Modules sample)
                └── index.css                   (Tailwind entry)
```

### 4.1 Layout notes

- **Public API surface:** only `packages/vite/src/index.ts`. Everything else is internal; no deep imports are documented or supported.
- **`core/` = pure, `babel/` = Babel wrapper, `integration/` = stateful/IO, `plugin.ts` = Vite entry that composes them.** This separation is what lets future SWC support reuse `core/` without dragging in Vite or Babel-specific stateful code.
- **Fixture runner** lives alongside fixtures, not in `unit/`, preserving the "unit tests are IO-free" invariant.
- **Fixtures vs. playground edge cases are distinct on purpose.** `test/fixtures/` pins transform-level input/output pairs that must never change by accident. `examples/playground/src/components/edge/` holds handwritten runtime examples. They cover similar cases intentionally — do not unify them. This distinction is documented in `test/fixtures/README.md`.
- **`examples/playground/src/components/edge/MultiComponentFile.tsx` must be actually rendered from `App.tsx`.** The multi-component-per-file case is where unit tests worry most; integration tests must hit it end-to-end, not leave it as an unused asset.
- **`manifestWriter.ts` exposes an internal-only `onFlush(): Promise<void>` hook for tests.** Not part of the public API; not re-exported from `index.ts`. HMR and shutdown integration tests await it to replace hardcoded `setTimeout`. Documented here so the boundary is visible at the layout level and doesn't drift out of view.

---

## 5. Data flow

Three distinct flows: cold start, per-transform, HMR.

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
    │  • Detect JSX runtime (from tsconfig.compilerOptions.jsx + plugin-react config hints)
    │      → if classic: throw with actionable message. v0 requires automatic runtime.
    │  • Instantiate ManifestWriter(projectRoot, manifestPath, options, clock)
    │      → writer's constructor immediately writes an empty Manifest to disk (atomic rename)
    │
    ▼
Vite fires configureServer(server)
    │  • If options.daemon === false: daemonHandle = null, skip.
    │  • Else: attempt `const mod = await import('@redesigner/daemon')`
    │       ├─ ERR_MODULE_NOT_FOUND → logger.warn("[redesigner] daemon package not installed …") once; daemonHandle = null
    │       ├─ other error → logger.error with full stack; daemonHandle = null; CONTINUE (do not rethrow; dev server stays up)
    │       └─ success → await mod.startDaemon({ manifestPath, port }); store handle
    │  • Register teardown on: server.close, process SIGINT, process SIGTERM
    │      (all paths route through a single idempotent shutdown() function)
    ▼
Dev server listens on its chosen port
```

### 5.2 Per-transform (every `.jsx`/`.tsx` Vite serves)

```
Vite calls transform(code, id) on our plugin (enforce: 'pre')
    │
    ▼
Filter: id matches include/exclude globs and ends in .jsx or .tsx
    │  (no match → return undefined; Vite passes original to next plugin)
    ▼
pathGuards.toPosixRelative(id, projectRoot) → relPath
    │  (on failure → logger.warn once per file; skip visitor; return undefined. NEVER throw from transform.)
    ▼
Invoke @babel/core.transformAsync(code, {
    plugins: [redesignerBabelPlugin({ relPath, writer })]
})
    │
    ▼
Babel visitor runs:
    │  1. On each JSXOpeningElement / JSXFragment: wrap the case body in try/catch.
    │     On throw → logger.warn with file:line; skip this node; continue walking.
    │  2. Walk up AST to enclosing component (resolveEnclosingComponent):
    │     • unwrap `memo(X)`, `forwardRef(...)` → the real inner identifier
    │     • arrow-const, named-function, class components all supported
    │     • anonymous default → fallback: PascalCase(basename(relPath))
    │     • JSX transitively inside a non-component helper (render prop, map callback)
    │       → attributed to the enclosing component, not the helper
    │     • JSX outside any enclosing component → skip silently (legitimate case, no warning)
    │     • Third-party HOCs (styled, observer, emotion.styled, etc.) → NOT unwrapped.
    │       Component identity follows the `const X = ...` assignment, regardless of RHS shape.
    │       Only React's official transparent wrappers (memo, forwardRef) are unwrapped.
    │  3. componentKey = relPath + ':' + componentName  (full relPath, not basename — avoids cross-dir collisions)
    │  4. formatLoc(relPath, line, col) → "src/components/Button.tsx:12:4"
    │  5. Register with writer (pending batch for this file):
    │       components[componentKey] = { filePath, exportKind, lineRange, displayName }
    │       locs[locString] = { componentKey }
    │  6. Inject <jsx-element data-src-loc="..." ...> attribute
    ▼
Babel returns transformed code; Vite plugin returns it (with preserved source maps — Babel default; not disabled)
    │
    ▼
writer.commitFile(relPath):
    │  • Atomic compare-and-swap on immutable state map:
    │       newState = purge(oldState, filePath=relPath) then merge(pendingBatch)
    │  • Schedule debounced flush (200 ms debounce, 1000 ms max-wait)
    ▼
plugin-react (or plugin-react-swc) receives modified source, does its JSX transform, passes on.
    │
    ▼
Browser loads page → React renders → DOM elements carry data-src-loc.
```

### 5.3 HMR

```
User edits src/components/Button.tsx
    │
    ▼
Vite invalidates the module graph. Affected files re-run through transform().
    │  Note: HMR cascade may re-transform importers too. Each re-transformed file
    │        triggers its own writer.commitFile → own purge → own merge. Aggregator
    │        handles this correctly (per-file purge is the unit).
    ▼
Debounced disk flush fires (at most maxWait=1000ms later) → atomic temp-file rename → .redesigner/manifest.json updated
    │
    ▼
(Out of scope here, noted for interface clarity:)
Daemon (if running, separate spec) watches manifest.json → reloads its in-memory index
    │
    ▼
Vite HMR pushes new module to browser → React re-mounts → new data-src-loc on rerendered elements
```

### 5.4 Shutdown

```
server.close() fired (or SIGINT/SIGTERM)
    │
    ▼
shutdown() — idempotency flag check; second call returns immediately
    │
    ▼
1. writer.flushSync() — fs.writeFileSync in try/catch; on failure fall back to console.error
       (config.logger may be torn down; console.error is the safe last resort)
       Upper bound ≈ 100 ms for 10k+ components; document in README.
    │
    ▼
2. If daemonHandle: daemonHandle.stop() → await up to 2 s → if still alive, kill('SIGKILL'), logger.warn
```

---

## 6. Public API surface

### 6.1 Entry point

```ts
// packages/vite/src/index.ts
import type { Plugin } from 'vite'

export interface RedesignerOptions {
  manifestPath?: string               // relative to Vite's resolved projectRoot; absolute paths rejected
  include?: string[]                  // default: ['**/*.{jsx,tsx}']
  exclude?: string[]                  // default: ['node_modules/**', '**/*.d.ts']
  enabled?: boolean                   // default: true in dev (apply: 'serve'), false in build
  daemon?: {
    autostart?: boolean               // default: true if @redesigner/daemon installed, false otherwise
    port?: number                     // default: 0 (OS-assigned)
  } | false                           // explicit false = never attempt daemon
}

export default function redesigner(options?: RedesignerOptions): Plugin

export type { Manifest, ComponentRecord, LocRecord } from './core/types'
// RedesignerOptions is already exported via the interface declaration above;
// wrapper packages that want the type can import it directly.
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

Position in `plugins` array does not matter relative to plugins **without** `enforce`. If the user has another `enforce: 'pre'` plugin that also transforms JSX/TSX, order among `pre`-enforced plugins is declaration order. Document in README: "declare `redesigner()` before any other `enforce: 'pre'` plugin that transforms JSX/TSX."

### 6.3 Manifest shape (exported types + shipped JSON Schema)

```ts
// packages/vite/src/core/types.ts
export interface Manifest {
  version: 1
  framework: 'react'
  generatedAt: string                 // new Date().toISOString() — UTC with Z suffix
  projectRoot: string                 // absolute path; informational, path-sensitive consumers should not rely on it for portability
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
  componentKey: string                // e.g. "src/components/Button.tsx:Button"
}
```

The JSON Schema (`manifest-schema.json`, draft-07) is generated at build time from the TS types via `ts-json-schema-generator`. Single source of truth is the `.ts` file. Schema is shipped in the package via `package.json`'s `exports` map and `files` array.

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
  "files": ["dist", "manifest-schema.json", "README.md"],
  "peerDependencies": {
    "vite": "^5 || ^6 || ^7",
    "@vitejs/plugin-react": "^4"
  },
  "peerDependenciesMeta": {
    "@vitejs/plugin-react": { "optional": true }
  },
  "dependencies": {
    "@babel/core": "^7",
    "@babel/parser": "^7",
    "@babel/traverse": "^7",
    "@babel/types": "^7"
  }
}
```

Notes:

- **ESM-only for v0.** No `require` conditional export. If a CJS consumer needs this in the future, that is a v1 ask.
- **`@redesigner/daemon` is NOT listed in any deps field.** `optionalDependencies` would force install (wrong semantic). `workspace:*` wouldn't resolve in consumer projects. The dynamic `import()` at runtime handles presence correctly. Users install the daemon explicitly when they want autostart: `pnpm add -D @redesigner/daemon`.
- **Vite peer range spans 5–7.** Plugin API hasn't shifted meaningfully across these majors for the hooks we use.
- **`@vitejs/plugin-react` is an optional peer.** SWC users still get our Babel pass via the independent transform hook.

### 6.5 User-visible messages

All messages prefixed `[redesigner]`. Routed through `config.logger` (captured in `configResolved`) — `this.info`/`this.warn`/`this.error` only exist on Rollup plugin context (transform/load hooks), not across Vite-lifecycle-only hooks, so `config.logger` is the one consistent surface.

| Severity | Example | When |
|---|---|---|
| `error` | "manifestPath escapes projectRoot" | Misconfigured options; thrown from `configResolved` |
| `error` | "classic JSX runtime detected; v0 requires automatic runtime" | Thrown from `configResolved` (hard error; see §7) |
| `error` | daemon `startDaemon()` threw on import | Non-fatal: logged, plugin continues in manifest-only mode |
| `warn` | daemon package not installed (`ERR_MODULE_NOT_FOUND`) | One-time; quiet |
| `warn` | Transform/path-guard error for a single file | One-time per file |
| `warn` | Per-node visitor exception | With `file:line` |
| `info` | First successful manifest write | One-time |
| `debug` | Per-transform timings | Behind `DEBUG=redesigner:*` |

---

## 7. Error handling & failure modes

| # | Trigger | Detected in | Handling | User sees | Test |
|---|---|---|---|---|---|
| 1 | `manifestPath` escapes projectRoot | `configResolved` | Throw | Dev server fails to start, clear message | unit |
| 2 | `manifestPath` absolute | `configResolved` | Throw | Same | unit |
| 3 | projectRoot contains backslash / drive letter | `configResolved` | Throw ("plugin bug — please report") | Dev server fails to start | unit |
| 4 | **Classic JSX runtime configured** | `configResolved` | **Throw** with actionable message: "v0 requires the automatic JSX runtime. Set `jsx: 'react-jsx'` in tsconfig or update plugin-react config." | Dev server fails to start | unit |
| 5 | `@vitejs/plugin-react` absent, SWC plugin present | `configResolved` | `debug` log (not `info`, to avoid noise in common SWC-user case) | None at default log level | integration |
| 6 | Daemon dynamic import → `ERR_MODULE_NOT_FOUND` | `configureServer` | `warn` once; `daemonHandle = null`; continue | One-line yellow warning | integration (via `vi.doMock`) |
| 7 | Daemon dynamic import → other error | `configureServer` | `error` log with full stack; `daemonHandle = null`; **continue** (do not rethrow) | Red error; dev server continues in manifest-only mode | unit (via `vi.doMock`) |
| 8 | Per-file path normalization fails | `transform` | `warn` once per file; skip visitor; return `undefined`; never throw from transform (would surface error overlay for our own bug) | Per-file warning | unit |
| 9 | Babel parser fails on whole file | `transform` | `warn` with file path; return `undefined`; let plugin-react attempt its own parse + surface its error | Per-file warning | fixture: `malformed-jsx/` |
| 10 | **Visitor exception on a single JSX node** | Babel plugin | **Per-visitor-case try/catch** (wrap `JSXOpeningElement`, `JSXFragment` case bodies individually, NOT the whole visitor). `warn` with `file:line`; skip that node; continue visiting siblings. | Per-node warning | fixture: `pathological-node/` |
| 11 | JSX not transitively inside any component | Babel plugin | Skip silently (legitimate; tool-under-test JSX, example snippets, etc.) | None | fixture: `jsx-outside-component/` |
| 11b | JSX inside a non-component helper (render prop, callback) but transitively within a component | Babel plugin | Attribute to the outer component | None | fixture: `inline-jsx-in-callback/` |
| 12 | Writer state contention | `manifestWriter` | N/A — state is an immutable map, mutated by atomic compare-and-swap. No mutex, no timeout, no deadlock possible. | None | (design choice; no test needed) |
| 13 | Disk write fails (EACCES, ENOSPC) | `manifestWriter` flush | `error` log; retry next debounce tick; after 3 consecutive failures, `warn` "manifest writes failing; daemon will see stale data" | Red error, escalating warning | unit (mock fs) |
| 14 | Atomic rename fails mid-flight | `manifestWriter` flush | Unlink temp file; `warn`; continue (old manifest on disk remains valid) | Yellow warning | unit (mock fs) |
| 15 | Shutdown before debounce flush | `server.close` / shutdown | `fs.writeFileSync` wrapped in `try/catch`; fall back to `console.error` (logger may be torn down); documented ~100 ms cap for 10k+ components | None (clean) | integration |
| 16 | Daemon process didn't die on teardown signal | Teardown | After 2 s, `kill('SIGKILL')`; `warn` | Yellow warning on shutdown | unit (real subprocess; see §8) |
| 17 | Teardown fires twice (SIGINT + server.close race) | All teardown paths | Single idempotency flag; second call returns immediately | None | unit |
| 18 | Vite config reload during dev | Plugin reinit | Old instance's shutdown fires; new instance starts fresh. **Verify empirically in integration tests** (Vite reload behavior has varied across majors). | Normal Vite reload messaging | integration |

### 7.1 Non-goals (error handling)

- No recovery from a partially written manifest. Atomic rename makes this impossible in practice.
- No user-configurable log levels beyond Vite's own `--logLevel`.
- No telemetry, no remote error reporting, no auto-update / version-check ping. If we ever add any of these, it is behind an explicit opt-in flag with prominent docs.

---

## 8. Testing plan

Three tiers, each with explicit scope and boundary. Vitest throughout.

### 8.1 Unit tests — `test/unit/`

**Invariant: pure functions + small utilities; no filesystem I/O beyond mocked fs.**

| File | Coverage |
|---|---|
| `locFormat.test.ts` | `formatLoc` / `parseLoc` roundtrip. Posix handling. Backslash / drive-letter rejection. Unicode filenames. Spaces in paths. |
| `pathGuards.test.ts` | `assertPosixProjectRoot`, `toPosixRelative`, escape guards (`../`, absolute `manifestPath`). |
| `resolveEnclosingComponent.test.ts` | AST walk for each component shape. Small inline snippets, Babel-parse, assert the walk result. |
| `plugin.test.ts` | Vite plugin lifecycle: options merge, `configResolved` throws on bad config (escape, classic runtime), re-exports typing. Uses Vite `createServer` helper with mocked fs. |
| `manifestWriter.test.ts` | Immutable-map + CAS semantics. `commitFile` purge-before-merge atomicity. Startup empty-manifest write. Debounce + maxWait timing with `vi.useFakeTimers` and injected clock. Synchronous final flush. Disk-write retry ladder (3 failures → warning). |
| `daemonBridge.test.ts` | `vi.doMock` stubs for `@redesigner/daemon`: (a) throwing `ERR_MODULE_NOT_FOUND` → quiet warn, (b) throwing generic error → loud error + continue. Teardown idempotency. SIGKILL escalation after 2 s. Logger-torn-down fallback to `console.error`. |

### 8.2 Fixture tests — `test/fixtures/`

**On-disk `input.tsx` / `output.tsx` / `expected-manifest.json` triples. Diffed as text. Regenerable via `pnpm test:fixtures --update`.**

Rationale vs. inline snapshots: PR reviewers see the exact transformed code as a file change, not a snapshot string. Inline snapshots are reserved for unit tests of small helpers.

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
- `forwardRef-wrapped/` — `React.forwardRef(...)` unwraps correctly
- `arrow-const/` — `const Button = () => <div />`
- `anonymous-default/` — `export default () => <div />`
- `inline-jsx-in-callback/` — JSX inside a map/render-prop attributes to outer component (row 11b)
- `hoc-wrapped/` — third-party HOC: `const StyledButton = styled(Button)` → componentKey `StyledButton`, NOT unwrapped
- `malformed-jsx/` — parse failure, warn + skip (row 9)
- `pathological-node/` — one node throws, others succeed (row 10)
- `jsx-outside-component/` — silent skip (row 11)
- `unicode-filename/` — non-ASCII file path normalization
- `filename with spaces/` — space-in-path normalization

The **fixture runner** is `test/fixtures/_runner.test.ts`. It enumerates directories, runs Babel with our plugin, diffs `output.tsx` and `expected-manifest.json`. On mismatch, prints a readable diff and the `--update` hint.

### 8.3 Integration tests — `test/integration/`

**Real Vite dev server, real playground, real filesystem. Slower; extended Vitest timeout.**

| File | Coverage |
|---|---|
| `vite.test.ts` | Programmatic `createServer` with playground. GET `/`. Parse DOM within the `#root` mount (excluding the mount element itself). Separately AST-count JSX elements in the playground source. Assert `data-src-loc` count in DOM matches expected count; on mismatch emit a readable diff identifying which components are under-tagged. Fail loud with specifics, not "47 ≠ 49." |
| `manifest.test.ts` | Start server, wait for initial flush, read `.redesigner/manifest.json`. Validate against the exported JSON Schema. Assert: every `data-src-loc` in DOM resolves to a manifest entry (no orphans); every manifest entry's `componentKey` maps to a real file. Spot-check `PricingCard` rendered 4× — all four DOM elements resolve to the same `componentKey`. |
| `hmr.test.ts` | Uses the writer's internal `onFlush(): Promise<void>` test hook (not public API) — NO hardcoded `setTimeout` waits. (1) Capture baseline for `Button.tsx:Button`. Prepend a line to the file. Await next `onFlush`. Re-fetch manifest. Assert `lineRange` shifted, loc still resolves. (2) Rename the component. Await next `onFlush`. Assert old `componentKey` is gone, new one present, no stale entries. |
| `degradation.test.ts` | (a) `daemon: false` → no attempt, silent. (b) `vi.doMock('@redesigner/daemon', () => { throw new Error('simulated') })` → error logged, plugin continues, manifest still written. (c) Corrupt a source file mid-server → warn, plugin continues, other files still work. |
| `shutdown.test.ts` | Use a **real subprocess** (a 10-line signal-responsive "fake daemon" in `test/fixtures/fake-packages/`), not a mock. Trigger several transforms, `server.close()`, assert final manifest state on disk. Verify teardown idempotent (call twice). Verify subprocess reaped; SIGKILL escalation if it ignores SIGTERM. |

### 8.4 CI (minimal now, full matrix before daemon spec merges)

Ships with this spec:
- Linux, one Node LTS, pnpm 9.15+.
- Biome check, unit, fixtures, integration all run.
- `packageManager` field in root `package.json` pins the pnpm version dev + CI share.

Deferred to a micro-spec that **must land before the daemon spec merges**:
- Add Windows runner.
- Add second Node LTS (20 and 22).

Also: in integration tests, log total transform time for the full playground as a debug breadcrumb. Not a gate; just a number CI captures so regressions are visible before they become user complaints.

### 8.5 Non-goals (testing)

- No Playwright / real-browser E2E. No extension exists yet.
- No performance benchmarks as gates.
- No DOM snapshot of the entire playground — brittle; fixture tests + spot checks cover what matters.
- No coverage threshold gate. Coverage numbers lie; the fixture + HMR + degradation suites cover the known-risky paths intentionally.

---

## 9. Open questions (carried forward, not resolved here)

From brief §152–157. None block this spec; each belongs in its owning spec.

- **Daemon ↔ extension protocol** — decide in daemon spec.
- **HMR granularity beyond file-level** — out of scope; plugin side does per-file purge, daemon side handles consumer reload.
- **Port discovery** — daemon spec decision. Plugin passes `daemon.port` through (default 0).
- **Product name** — still TBD. Codename `redesigner` is internal.

---

## 10. Appendix — decision log

Key decisions made during brainstorming that shape this spec, recorded so later work does not re-litigate them:

1. **Spec scope = Vite plugin + playground only** (brief build order 1 + 2). Daemon, MCP, extension, CLI each get separate specs.
2. **pnpm workspaces + Biome.** No Turborepo, no ESLint/Prettier.
3. **`@vitejs/plugin-react` + Babel path** (not plugin-react-swc). Keep framework-agnostic core so SWC becomes a thin later addition.
4. **`data-src-loc` format: `"relPath:line:col"`**, project-relative, posix separators. Fail loud on backslash / drive-letter leakage.
5. **Manifest shape:** single source of truth is `components` (keyed by `relPath:componentName`); `locs` entries only carry `componentKey`. Prevents drift.
6. **Codename `redesigner`, rename accepted.** No placeholder substitution.
7. **Dev-only (`apply: 'serve'`)**, `enabled` flag reserves an escape hatch.
8. **Zero-config factory default export.** Options object optional; `daemon` option shape reserved but dormant until daemon package installed.
9. **Approach 1 for daemon cross-cut:** dynamic `import()` with `ERR_MODULE_NOT_FOUND` vs. other-error discrimination. Never rethrow other errors into the dev-server startup path.
10. **React 19 + automatic JSX runtime only.** Classic runtime is a hard error at startup, not a best-effort fallback.
11. **Independent Babel pass with `enforce: 'pre'`**, not coupled to plugin-react's `babel.plugins` option.
12. **Immutable map + CAS** for writer state, not a mutex. No contention, no deadlock, no timeout logic.
13. **Per-file purge-then-merge** is a single atomic writer operation.
14. **Empty-manifest write at startup** — consumers always see self-consistent manifest, never rehydrate from prior state.
15. **Per-visitor-case try/catch** for node-level resilience, not whole-visitor wrap.
16. **HOC unwrap policy:** only React's official transparent wrappers (`memo`, `forwardRef`). Third-party HOCs keep the assignment-target name as `componentKey`.
17. **Source-map chain preserved** by Babel's default behavior; we do not use runtime source maps for loc resolution.
18. **No telemetry, no update-check.**
19. **ESM-only for v0.**
20. **Minimal CI now, full matrix before daemon spec merges.**
