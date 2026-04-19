# MCP Shim v0 — Design

**Status:** Approved for planning
**Date:** 2026-04-19
**Scope:** Pieces #2 and #3 from `brief.md`, MVP slice (A + modifications — no long-running daemon)
**Parent spec:** `2026-04-18-vite-plugin-and-playground-design.md` (v0 plugin)

## 1. Goal

Ship `@redesigner/mcp` — a stdio MCP server that Claude Code spawns per session. Surfaces the Vite plugin's `.redesigner/manifest.json` to Claude Code as an MCP resource, and exposes four selection tools whose schemas are frozen from v0. A file-backed selection stub (`.redesigner/selection.json`) lets developers exercise the selection tools by hand-editing, before a daemon or Chrome extension exists.

Ship `@redesigner/core` alongside — a new shared-kernel package that holds the reader + types + Zod schemas, replacing the current `@redesigner/vite/reader` surface.

Harden ManifestWriter: bootstrap write uses the same atomic temp-file + rename path as HMR flushes.

## 2. Non-goals for this iteration

- No long-running daemon process. No WebSocket. No HTTP loopback.
- No Chrome extension.
- No real selection source — `.redesigner/selection.json` is hand-edited during dogfood.
- No browser-dependent tool implementations — `get_computed_styles` and `get_dom_subtree` register full schemas and return `null`.
- No CLI (`@redesigner/cli`) — that's a separate follow-up.
- No `.mcp.json` scaffolding helper — user writes it by hand for v0 dogfood.
- No multi-project multiplexing. One MCP server process per CC session per project.

## 3. Architectural invariants

1. **Backend abstraction isolates transport.** MCP tool handlers call `backend.foo()`. The `FileBackend` implementation hits fs; a future `DaemonBackend` will hit HTTP loopback. No fs paths, no fs-specific semantics, and no file existence checks appear in MCP tool schemas or descriptions. Swapping implementations is a one-file change in `backend.ts`.
2. **Tool schemas are frozen from v0.** All four selection tools register with their complete input/output schemas even though two of them return `null` in FileBackend mode. This prevents breaking CC workflows when the daemon ships.
3. **Selection file is the wire format.** The JSON shape of `.redesigner/selection.json` is the same shape the future daemon will receive over WebSocket from the Chrome extension, serialize into its in-memory state, and surface via its HTTP loopback. Design the file schema once.
4. **Validation errors surface as `McpError`.** Both malformed JSON and Zod schema mismatches produce `McpError(ErrorCode.InvalidRequest, ...)` so Claude Code sees an actionable message instead of a crash or generic 500.
5. **Atomic writes, always.** ManifestWriter's bootstrap and flush paths both use temp-file + rename. No code path produces a partial manifest that a concurrent reader could observe.
6. **Project resolution is explicit, not magic.** `--project` flag wins; else walk up from CWD until `.redesigner/manifest.json` is found or until a package-root boundary is hit. No silent scan-the-whole-home-directory fallback.

## 4. Package layout

```
packages/
├── core/                          NEW
│   ├── package.json                @redesigner/core
│   ├── tsconfig.json
│   ├── tsup.config.ts              esm only; no bundler deps at runtime
│   ├── src/
│   │   ├── index.ts                barrel: reader, types, schema
│   │   ├── reader.ts               moved verbatim from packages/vite/src/reader.ts
│   │   ├── types.ts                ComponentHandle, Manifest, ComponentRecord, LocRecord, SchemaVersion, SelectionFile
│   │   └── schema.ts               Zod: ComponentHandleSchema, ManifestSchema, SelectionFileSchema
│   └── test/unit/
│       ├── reader.test.ts          moved from packages/vite
│       └── schema.test.ts          NEW: Zod fixtures cover valid + 3 malformed cases per schema
├── vite/                          MODIFIED
│   ├── src/
│   │   ├── reader.ts               REPLACED with re-export from @redesigner/core (keeps public entry stable)
│   │   ├── index.ts                re-exports types from @redesigner/core (unchanged external surface)
│   │   ├── core/types-public.ts    slim down: types now live in @redesigner/core; this file re-exports
│   │   └── integration/
│   │       └── manifestWriter.ts   hardening: constructor bootstrap goes through atomic rename path
│   └── package.json                adds dep: "@redesigner/core": "workspace:*"
└── mcp/                           NEW
    ├── package.json                @redesigner/mcp; bin: @redesigner/mcp → dist/cli.js
    ├── tsconfig.json
    ├── tsup.config.ts
    ├── src/
    │   ├── cli.ts                  parse argv, resolveConfig, buildServer, stdio transport, graceful shutdown
    │   ├── server.ts               buildServer(backend): Server — registers 4 tools + 2 resources
    │   ├── backend.ts              Backend interface + FileBackend implementation
    │   ├── config.ts               resolveConfig(argv, cwd): ResolvedConfig
    │   └── errors.ts               toMcpError(err): McpError — unified mapping from fs + zod + json errors
    └── test/
        ├── unit/
        │   ├── config.test.ts      walk-up algorithm, --project flag, boundary stops
        │   ├── backend.test.ts     FileBackend: missing file = null, valid file = parsed, malformed JSON = McpError, schema mismatch = McpError
        │   └── server.test.ts      uses MCP SDK's in-process test client; asserts tool list, resource list, response shapes
        └── integration/
            └── inspector.test.ts   spawns cli.ts via tsx, speaks MCP protocol, verifies list_tools + get_current_selection round-trip
```

## 5. `@redesigner/core` migration

### 5.1 Types (moved from `packages/vite/src/core/types-public.ts`)

```ts
// core/src/types.ts
export type SchemaVersion = '1.0'

export interface ComponentRecord { /* unchanged */ }
export interface LocRecord { /* unchanged */ }
export interface Manifest { /* unchanged */ }

export interface ComponentHandle {
  id: string
  componentName: string
  filePath: string
  lineRange: [number, number]
  domPath: string
  parentChain: string[]
  timestamp: number
}

export interface SelectionFile {
  current: ComponentHandle | null
  history: ComponentHandle[]  // newest-first; does NOT include `current`
}
```

`RedesignerOptions` and `DaemonOptions` stay in `@redesigner/vite` — they're plugin-specific.

### 5.2 Schemas (new)

```ts
// core/src/schema.ts
import { z } from 'zod'

export const ComponentHandleSchema = z.object({
  id: z.string().min(1),  // loosened from uuid() — hand-editing during dogfood shouldn't require real UUIDs
  componentName: z.string(),
  filePath: z.string(),
  lineRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  domPath: z.string(),
  parentChain: z.array(z.string()),
  timestamp: z.number(),
})

export const SelectionFileSchema = z.object({
  current: ComponentHandleSchema.nullable(),
  history: z.array(ComponentHandleSchema),
})

export const ManifestSchema = z.object({ /* mirror of Manifest interface */ })
```

### 5.3 Reader re-export from `@redesigner/vite`

`packages/vite/src/reader.ts` becomes a one-line re-export:
```ts
export { readManifest } from '@redesigner/core'
```

Plus `SUPPORTED_MAJOR` re-exported from `@redesigner/core`. Keeps the public entry `@redesigner/vite/reader` stable.

### 5.4 Package boundary

`@redesigner/core` has zero runtime dependencies except `zod`. No babel, no node:fs-heavy stuff beyond what reader.ts already uses. It must stay small — its job is "shared-kernel types + reader."

## 6. MCP shim (`@redesigner/mcp`)

### 6.1 Backend interface

```ts
// backend.ts
export interface Backend {
  getManifest(): Promise<Manifest>
  getCurrentSelection(): Promise<ComponentHandle | null>
  getRecentSelections(n: number): Promise<ComponentHandle[]>
  getComputedStyles(selectionId: string): Promise<Record<string, string> | null>
  getDomSubtree(selectionId: string, depth: number): Promise<unknown | null>
  getConfig(): Promise<ResolvedConfigResource>
}
```

### 6.2 FileBackend behaviors

| Method | Behavior |
|---|---|
| `getManifest()` | reads `<projectRoot>/.redesigner/manifest.json` via `@redesigner/core#readManifest`; Zod-validates via `ManifestSchema`; version-check via `SUPPORTED_MAJOR` |
| `getCurrentSelection()` | if `selection.json` absent → returns `null`; else read + JSON.parse (wrapped) + Zod-validate → returns `parsed.current` |
| `getRecentSelections(n)` | same read path; returns `parsed.history.slice(0, n)` (caller's `n` is clamped to `[0, 100]`) |
| `getComputedStyles(id)` | returns `null` (documented: browser-dependent, requires daemon + extension) |
| `getDomSubtree(id, depth)` | returns `null` (documented: browser-dependent) |
| `getConfig()` | returns `{framework: 'react', projectRoot, manifestPath, viteConfigPath?}` synthesized from `resolveConfig` output |

### 6.3 MCP tools

All four registered with full input/output schemas from v0. Tool descriptions for the browser-dependent pair explicitly document what `selectionId` refers to:

| Tool | Input | Output | Description snippet (excerpted) |
|---|---|---|---|
| `get_current_selection` | `{}` | `ComponentHandle \| null` | Returns the currently selected component, or null if nothing is selected. |
| `list_recent_selections` | `{n: number}` (1–100) | `ComponentHandle[]` | Returns the n most-recent selections, newest first. |
| `get_computed_styles` | `{selectionId: string}` | `Record<string, string> \| null` | "Returns computed CSS styles for the selection. `selectionId` is the `id` field of a `ComponentHandle` returned by `get_current_selection` or `list_recent_selections`. Returns null in file-backed mode (requires Chrome extension)." |
| `get_dom_subtree` | `{selectionId: string, depth: number}` (depth 0–10) | `unknown \| null` | "Returns a serialized DOM subtree rooted at the selection. `selectionId` is the `id` field of a `ComponentHandle`. Returns null in file-backed mode (requires Chrome extension)." |

### 6.4 MCP resources

| URI | MIME | Payload |
|---|---|---|
| `project://manifest` | `application/json` | full `Manifest` from `getManifest()` |
| `project://config` | `application/json` | `{framework, projectRoot, manifestPath, viteConfigPath?, entryPoints?: []}` — entry-points deferred to when we have a reason |

Resource listing returns exactly those two URIs.

## 7. Config resolution algorithm

```ts
// config.ts
export function resolveConfig(argv: {project?: string}, cwd: string): ResolvedConfig {
  if (argv.project) {
    const p = path.resolve(argv.project)
    const mp = path.join(p, '.redesigner', 'manifest.json')
    if (!existsSync(mp)) throw new Error(`[mcp] no .redesigner/manifest.json at ${p}`)
    return buildFromRoot(p)
  }
  let cur = path.resolve(cwd)
  while (true) {
    if (existsSync(path.join(cur, '.redesigner', 'manifest.json'))) return buildFromRoot(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break              // filesystem root
    if (existsSync(path.join(cur, 'package.json')) && cur !== cwd) break  // package-root boundary
    cur = parent
  }
  throw new Error('[mcp] no .redesigner/ found walking up from cwd. Run `vite dev` in a project with @redesigner/vite installed, or pass --project <path>.')
}
```

The package-root boundary stops the walk at the first enclosing `package.json` that isn't the CWD itself — prevents escaping the user's repo into a parent monorepo or home directory.

## 8. Validation + error surface

Unified mapping in `errors.ts`:

```ts
// errors.ts
export function toMcpError(err: unknown, context: string): McpError {
  if (err instanceof SyntaxError) {
    return new McpError(ErrorCode.InvalidRequest, `${context}: malformed JSON — ${err.message}`)
  }
  if (err instanceof z.ZodError) {
    const first = err.issues[0]
    return new McpError(ErrorCode.InvalidRequest, `${context}: ${first.path.join('.')} — ${first.message}`)
  }
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new McpError(ErrorCode.InvalidRequest, `${context}: file not found`)
  }
  return new McpError(ErrorCode.InternalError, `${context}: ${String(err)}`)
}
```

Both `JSON.parse` and Zod `.parse()` paths route through this. FileBackend wraps all reads:

```ts
try {
  const raw = await readFile(selectionPath, 'utf8')  // if ENOENT caught upstream → null
  const obj = JSON.parse(raw)                        // SyntaxError → McpError
  return SelectionFileSchema.parse(obj)              // ZodError → McpError
} catch (err) {
  if (isENOENT(err)) return emptySelection()
  throw toMcpError(err, 'reading .redesigner/selection.json')
}
```

## 9. ManifestWriter atomic bootstrap

`packages/vite/src/integration/manifestWriter.ts` constructor currently calls `this.writeSync(this.buildManifest())` directly. Change: extract the atomic temp-file + rename loop from `flush()` into `private atomicWrite(manifest: Manifest)`; both constructor bootstrap and `flush()` call `atomicWrite`. Existing test `test/integration/parallelism.test.ts` + HMR tests already cover the rename path — add one new unit test that asserts no `manifest.json` file exists at any observable moment between process start and first atomicWrite completion (via a synthetic fs-spy).

## 10. Testing strategy

### 10.1 `@redesigner/core`
- `reader.test.ts` — moved as-is from vite package.
- `schema.test.ts` — three malformed inputs per schema (missing field, wrong type, extra field if strict), plus valid happy path.

### 10.2 `@redesigner/mcp` unit
- `config.test.ts` — `--project` precedence, walk-up finds root, walk-up stops at package-root boundary, CWD-only walk-up succeeds, nothing-found throws.
- `backend.test.ts` — FileBackend with tmpdir fixtures: missing selection.json → null current + [] history; valid file → correct parse; malformed JSON → McpError w/ InvalidRequest; schema mismatch → McpError w/ InvalidRequest.
- `server.test.ts` — construct server with an in-memory fake `Backend`, list tools (assert all 4 present with schemas), list resources (assert 2 present), call each tool and assert response shape.

### 10.3 `@redesigner/mcp` integration
- `inspector.test.ts` — spawns `cli.ts` via tsx with `--project <fixture>`, opens the MCP stdio transport, calls `tools/list`, calls `get_current_selection`, calls `resources/read project://manifest`. Asserts protocol round-trip works end-to-end. No mocks.

### 10.4 Fixture
- `packages/mcp/test/fixtures/minimal-project/.redesigner/manifest.json` — hand-authored; two components, three locs.
- Same dir: `.redesigner/selection.json` with one `current` and two `history` entries — covers both selection tools.

## 11. Dogfood sequence (post-merge)

1. Build: `pnpm --filter @redesigner/core build`, same for mcp.
2. In `examples/playground/`: hand-write `.mcp.json`:
   ```json
   { "mcpServers": { "redesigner": { "command": "node", "args": ["../../packages/mcp/dist/cli.js"] } } }
   ```
3. Start playground: `pnpm --filter @redesigner/playground run dev` (produces `.redesigner/manifest.json`).
4. Hand-edit `examples/playground/.redesigner/selection.json` with a ComponentHandle referring to a real manifest entry.
5. Open Claude Code in `examples/playground/`, trust the workspace, ask: *"What's currently selected in redesigner?"* — CC calls `get_current_selection`, returns the handle.
6. Ask: *"Show me the redesigner manifest."* — CC reads `project://manifest` resource.

## 12. CI

- `pnpm -r run test` already recurses into new packages. No workflow changes required.
- Add `packages/mcp` + `packages/core` to `pnpm-workspace.yaml` (already glob-wildcarded — no edit needed if `packages/*` pattern is in place).
- Build order in CI matters: `@redesigner/core` must build before `@redesigner/vite` and `@redesigner/mcp`. pnpm + workspace links resolve this automatically.

## 13. Out of scope for this plan (tracked for later)

- Long-running daemon (`@redesigner/daemon`) — restores `DaemonBackend` for shim, WebSocket for extension.
- Chrome extension with hover-highlight picker.
- `@redesigner/cli` with `init` command (writes `.mcp.json` + vite config snippet).
- Windows CI restoration (deferred post-v0 from parent spec).
- Runtime props extraction via React fiber traversal.

## 14. Open questions for the plan phase

None blocking. All six approved during brainstorming:
- Scope (A + file-backed stub + atomic bootstrap): ✓ agreed
- `@redesigner/core` extraction: ✓ agreed
- Selection file schema (`{current, history}`): ✓ agreed
- Zod validation + JSON.parse wrap for malformed errors: ✓ agreed
- `id` relaxed to `string().min(1)`: ✓ agreed
- Tool descriptions document `selectionId = ComponentHandle.id`: ✓ agreed

Proceed to implementation plan.
