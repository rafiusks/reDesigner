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
- No multi-project multiplexing per MCP session. One MCP server process per CC session per project. (Future multi-project support gets a new URI scheme — see §6.4.)

## 3. Architectural invariants

1. **Backend abstraction isolates transport.** MCP tool handlers call `backend.foo()`. `FileBackend` hits fs; future `DaemonBackend` hits HTTP loopback. No fs paths, no fs-specific semantics, and no file existence checks appear in MCP tool schemas, descriptions, resource payloads, or resource URIs. Swapping implementations is a one-file change in `backend.ts`.
2. **Tool schemas AND descriptions are frozen from v0.** All four selection tools register with their complete input/output schemas AND mode-invariant descriptions even though two of them return `null` in FileBackend mode. Per MCP community guidance (SEP-986/SEP-1575, 2026), tool descriptions are part of the contract — changing them alters how an LLM selects the tool. Descriptions must read identically whether FileBackend or DaemonBackend is serving them.
3. **Server-level SemVer signals behavior changes.** The MCP SDK's `Server({name, version})` handshake is the canonical version channel. Bump the server's SemVer when behavior of any tool changes (e.g., `get_computed_styles` starts returning real data with the daemon). Schema changes bump MAJOR; behavior-only changes bump MINOR. Per-tool SemVer was considered but rejected — `annotations.version` is not a standard MCP field (annotations are `{title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`), clients would ignore it. If the MCP spec adopts per-tool versioning later (SEP-986/SEP-1575 are still proposals at time of writing), we revisit.
4. **Selection file is the wire format.** The JSON shape of `.redesigner/selection.json` is identical to what the future daemon will receive over WebSocket from the Chrome extension, store in memory, and surface via its HTTP loopback. Design once.
5. **Validation errors surface as `McpError`.** Malformed JSON, Zod schema mismatches, read errors, and size violations all route through `toMcpError` and become `McpError(ErrorCode.InvalidRequest, ...)` — Claude Code sees actionable messages, not stack traces.
6. **Atomic writes, always.** ManifestWriter's bootstrap and flush paths both use temp-file + rename. No code path produces a partial manifest that a concurrent reader could observe. Startup sweep of stale tmp files runs BEFORE the first atomic write.
7. **Project resolution is explicit and bounded.** `--project` flag wins; else walk up from CWD with a hard HOME-directory ceiling. The matched project root must itself contain `package.json`. No silent scan into `/` or `~/.claude/` or `/tmp/`.
8. **Input sizes are bounded.** FileBackend rejects manifests > 10 MB and selection files > 1 MB before parsing. Prevents accidental OOM and blunts intentional DoS from a compromised plugin writer.

## 4. Package layout

```
packages/
├── core/                          NEW
│   ├── package.json                @redesigner/core; dep: zod (aligned with MCP SDK range)
│   ├── tsconfig.json
│   ├── tsup.config.ts              esm only
│   ├── src/
│   │   ├── index.ts                barrel: reader, types, schema
│   │   ├── reader.ts               moved verbatim from packages/vite/src/reader.ts
│   │   ├── types.ts                ComponentHandle, Manifest, ComponentRecord, LocRecord, SchemaVersion, SelectionFile
│   │   ├── schema.ts               Zod: ComponentHandleSchema, ManifestSchema, SelectionFileSchema
│   │   └── safeJsonParse.ts        JSON.parse wrapped + __proto__/constructor reviver
│   └── test/unit/
│       ├── reader.test.ts          moved from packages/vite
│       ├── schema.test.ts          NEW
│       └── safeJsonParse.test.ts   NEW
├── vite/                          MODIFIED
│   ├── src/
│   │   ├── reader.ts               REPLACED with re-export from @redesigner/core
│   │   ├── index.ts                re-exports types from @redesigner/core (stable external surface)
│   │   ├── core/types-public.ts    slims down; types live in @redesigner/core
│   │   └── integration/
│   │       └── manifestWriter.ts   bootstrap goes through atomic temp+rename
│   ├── package.json                exports field updated; adds dep: @redesigner/core workspace:*
│   └── test/integration/
│       └── atomic-bootstrap.test.ts   NEW: observer sees no partial manifest between start and first flush
└── mcp/                           NEW
    ├── package.json                @redesigner/mcp; bin: dist/cli.js; deps: @modelcontextprotocol/sdk, zod, @redesigner/core
    ├── tsconfig.json
    ├── tsup.config.ts
    ├── src/
    │   ├── cli.ts                  parse argv, resolveConfig, buildServer, stdio transport, graceful shutdown
    │   ├── server.ts               buildServer(backend): Server — registers 4 tools + 2 resources (pure; no fs)
    │   ├── backend.ts              Backend interface + FileBackend implementation
    │   ├── config.ts               resolveConfig(argv, cwd, env): ResolvedConfig
    │   └── errors.ts               toMcpError unified mapping
    └── test/
        ├── unit/
        │   ├── config.test.ts
        │   ├── backend.test.ts
        │   ├── server.test.ts      uses in-process MCP SDK Client; verifies frozen schemas
        │   └── server-isolation.test.ts   NEW: asserts server.ts issues zero fs calls given a mock Backend
        ├── integration/
        │   └── client.test.ts      spawns cli.ts, connects via @modelcontextprotocol/sdk Client over stdio
        ├── snapshots/
        │   └── schemas.snap.json   committed snapshot of tools + resources + schemas; changed → force review
        └── fixtures/
            └── minimal-project/
                ├── package.json
                └── .redesigner/
                    ├── manifest.json      generated + schema-validated in a pre-test hook
                    └── selection.json
```

## 5. `@redesigner/core` migration

### 5.1 Types

Moved from `packages/vite/src/core/types-public.ts`. `RedesignerOptions` and `DaemonOptions` stay in `@redesigner/vite` — they're plugin-specific. Both packages continue to re-export the shared types so external consumers never notice.

### 5.2 Schemas

```ts
// core/src/schema.ts
import { z } from 'zod'

// selectionId safe-char constraint prevents future misuse if a daemon or
// browser extension ever builds fs/URL paths from an id field.
// User-editable by hand (no UUID requirement) but restricted to safe chars.
const SELECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export const ComponentHandleSchema = z.object({
  id: z.string().regex(SELECTION_ID_RE, 'id must match /^[A-Za-z0-9_-]{1,128}$/'),
  componentName: z.string().min(1).max(256),
  filePath: z.string().min(1).max(4096),
  lineRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  domPath: z.string().max(8192),
  parentChain: z.array(z.string().max(256)).max(64),
  timestamp: z.number().int().nonnegative(),
}).strict()

export const SelectionFileSchema = z.object({
  current: ComponentHandleSchema.nullable(),
  history: z.array(ComponentHandleSchema).max(1000),
}).strict()

export const ManifestSchema = z.object({
  // Full mirror of Manifest interface, .strict() at every level. No unknown keys accepted.
  // Detailed shape omitted here — see types.ts + existing reader tests.
}).strict()
```

Three hardening choices:
- **`.strict()` everywhere, applied recursively** — ManifestSchema, ComponentRecord, and LocRecord ALL use `.strict()` at each nested object level. Unknown keys anywhere in the tree are rejected.
- **Bounded string/array lengths** blunt accidental or malicious oversized inputs.
- **`SELECTION_ID_RE` regex** prevents path-traversal-like ids. Relaxed from `.uuid()` per the original brief (hand-editing ergonomics) but not wide open.

### 5.3 Safe JSON parser

```ts
// core/src/safeJsonParse.ts
export function safeJsonParse(raw: string): unknown {
  // Reviver strips __proto__ / constructor / prototype assignments to block
  // JSON-based prototype-pollution vectors before Zod even runs.
  return JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
    return value
  })
}
```

Both `FileBackend` and future `DaemonBackend` (when it parses HTTP responses) use this, not raw `JSON.parse`.

**Belt-and-braces with `.strict()`**: The reviver strips `__proto__` during parse, but downstream code that spreads or assigns the parsed object (e.g., `{...parsed}` or `Object.assign`) could re-expose a leaked reference if the reviver alone were used. In our path, the immediate consumer of `safeJsonParse` is `Zod.safeParse(obj)` — which iterates normally and, because every schema uses `.strict()`, REJECTS any `__proto__` / `constructor` key that the reviver somehow missed. Two independent defenses must both fail to expose prototype pollution.

### 5.4 Zod version alignment

`@redesigner/core` lists `zod` in `dependencies` (not `peerDependencies`) with a range that matches `@modelcontextprotocol/sdk`'s requirement — currently `"zod": "^3.25.0 || ^4.0.0"`. Rationale:

- `@redesigner/core` is internal to this monorepo at v0. External consumers don't install it directly; they consume `@redesigner/vite` or `@redesigner/mcp`. peerDependencies is the right choice when you want to let external consumers "bring their own Zod" — not applicable here.
- pnpm's workspace hoisting deduplicates zod across all workspace packages automatically. No duplicate-import hazard in practice.
- Keeping `dependencies` means `pnpm install` works without extra peer-dep warnings and nothing silently skips the install.

If `@redesigner/core` is ever published for external consumption, revisit: switch to peerDependencies at that point per Zod's library-authors guidance.

If MCP SDK v2 (anticipated Q1 2026) tightens its zod range, we bump the dep once in core and the workspace follows.

### 5.5 Reader re-export from `@redesigner/vite`

`packages/vite/src/reader.ts` becomes:
```ts
export { readManifest, SUPPORTED_MAJOR } from '@redesigner/core'
```

`packages/vite/package.json` `exports` entry for `./reader` stays pointed at `./dist/reader.js`. The tsup build emits a dist file that re-exports from core. External consumers of `@redesigner/vite/reader` see no change.

### 5.6 Package boundary

`@redesigner/core` runtime dependencies: `zod` only (as peer). No babel, no vite, no node:fs beyond what reader.ts needs. It must stay a small, frozen-over-time kernel.

## 6. MCP shim (`@redesigner/mcp`)

### 6.1 Backend interface

```ts
// backend.ts
export interface Backend {
  getManifest(): Promise<Manifest>
  getCurrentSelection(): Promise<ComponentHandle | null>
  /** Pre-condition: n is a validated integer in [1, 100]. Backend does NOT re-validate. */
  getRecentSelections(n: number): Promise<ComponentHandle[]>
  /** Pre-condition: selectionId matches SELECTION_ID_RE (tool input schema enforces). */
  getComputedStyles(selectionId: string): Promise<Record<string, string> | null>
  /** Pre-condition: selectionId matches SELECTION_ID_RE; depth is integer in [0, 10]. */
  getDomSubtree(selectionId: string, depth: number): Promise<unknown | null>
  getConfig(): Promise<ConfigResource>
}
```

Input validation happens ONCE at the MCP tool layer (via Zod input schemas on tool registration). Backend implementations trust their inputs. This keeps `DaemonBackend` simple later — it just forwards.

### 6.2 FileBackend behaviors

| Method | Behavior |
|---|---|
| `getManifest()` | fs.stat → reject if size > 10 MB → read → `safeJsonParse` → `ManifestSchema.safeParse` → return parsed or McpError |
| `getCurrentSelection()` | fs.stat → if ENOENT return `null`; else reject if size > 1 MB → read → `safeJsonParse` → `SelectionFileSchema.safeParse` → return `parsed.current` |
| `getRecentSelections(n)` | same read path; returns `parsed.history.slice(0, n)` |
| `getComputedStyles(id)` | returns `null` in this Backend (no browser) |
| `getDomSubtree(id, depth)` | returns `null` in this Backend (no browser) |
| `getConfig()` | returns `ConfigResource` synthesized from resolveConfig — see §6.4 for shape |

**Read-through caching**: FileBackend caches the last successful `getManifest()` and `getCurrentSelection()` / `getRecentSelections()` reads with a 100ms TTL. Rationale:

- A single conversational turn in Claude Code can trigger several tool calls in rapid succession (e.g., `get_current_selection` + `get_computed_styles` + `get_dom_subtree` all referencing the same id). Re-reading + re-parsing + re-validating for each call is wasteful.
- 100ms is short enough that users never perceive staleness (the manifest changes only on rebuild; selection.json changes on manual edit or, later, extension push).
- Cache key includes `fs.stat().mtimeMs` — if mtime changes mid-TTL, cache invalidates.
- No cache for `getComputedStyles` / `getDomSubtree` in FileBackend since they return null.

Every `safeParse` uses Zod's discriminated-union result (`{success, data} | {success, error}`) — no try/catch around Zod. JSON parsing is wrapped because `safeJsonParse` can still throw on genuine SyntaxError. The wrapping pattern:

```ts
let obj: unknown
try { obj = safeJsonParse(raw) }
catch (err) { throw toMcpError(err, 'reading .redesigner/selection.json') }
const parsed = SelectionFileSchema.safeParse(obj)
if (!parsed.success) throw toMcpError(parsed.error, 'reading .redesigner/selection.json')
return parsed.data
```

### 6.3 MCP tools

All four registered with full input/output schemas AND mode-invariant descriptions from v0. The descriptions make no reference to which Backend is serving them.

Input columns below are Zod expressions for brevity; the MCP SDK serializes these into standard JSON Schema in `tools/list` responses. Claude Code's input validation runs against the JSON Schema form BEFORE the SDK dispatches to our Backend — so FileBackend never sees malformed input.

| Tool | Input schema (Zod) | Output |
|---|---|---|
| `get_current_selection` | `z.object({}).strict()` | `ComponentHandle \| null` |
| `list_recent_selections` | `z.object({n: z.number().int().min(1).max(100)}).strict()` | `ComponentHandle[]` |
| `get_computed_styles` | `z.object({selectionId: z.string().regex(SELECTION_ID_RE)}).strict()` | `Record<string, string> \| null` |
| `get_dom_subtree` | `z.object({selectionId: z.string().regex(SELECTION_ID_RE), depth: z.number().int().min(0).max(10)}).strict()` | `unknown \| null` |

Descriptions (mode-invariant; these are part of the frozen contract):

- `get_current_selection`: *"Returns the currently selected component, or null if nothing is currently selected."*
- `list_recent_selections`: *"Returns up to the n most-recent selections, newest first. Returns an empty array if no selections have been made."*
- `get_computed_styles`: *"Returns computed CSS styles for the selection referenced by `selectionId` (the `id` field of a `ComponentHandle` returned by `get_current_selection` or `list_recent_selections`). Returns null if the style information is not currently available."*
- `get_dom_subtree`: *"Returns a serialized DOM subtree rooted at the selection referenced by `selectionId` (the `id` field of a `ComponentHandle` returned by `get_current_selection` or `list_recent_selections`), up to `depth` levels deep. Returns null if the subtree is not currently available."*

Tool versioning rides on the SERVER-level `Server({name, version})` string per current MCP SDK design. A behavior change in any tool (FileBackend → DaemonBackend activating styles/subtree) bumps server MINOR; a schema change bumps server MAJOR. Per-tool `annotations.version` is NOT emitted — the MCP SDK annotations standard (`{title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`) has no version field, so clients would ignore it. If the MCP spec adopts per-tool versioning (SEP-986/SEP-1575), revisit.

### 6.4 MCP resources

| URI | Name | Description | MIME | Payload |
|---|---|---|---|---|
| `redesigner://project/manifest` | `Project Manifest` | Full component manifest produced by the Vite plugin | `application/json` | full `Manifest` from `getManifest()` |
| `redesigner://project/config` | `Project Configuration` | Detected framework, project name, MCP server version | `application/json` | `ConfigResource` — see below |

Resource `name` and `description` are part of the frozen contract (schema-snapshot test locks them in). Mode-invariant; don't reference Backend specifics.

URI scheme rationale: `redesigner://project/...` commits explicitly to single-project-per-session for v0. These URIs are session-local identifiers; two concurrent CC sessions in different project dirs each use the same URI inside their own MCP server process — there's no cross-server coordination. Future multi-project-in-one-session support (if ever needed) adds a project identifier segment without breaking v0 URIs: `redesigner://projects/{id}/...`. YAGNI until multi-project is a real requirement.

`ConfigResource` shape — symbolic only, no absolute filesystem paths (invariant #1):

```ts
interface ConfigResource {
  framework: 'react'
  projectName: string          // package.json "name" if present; else basename(projectRoot)
  manifestRelativePath: string // reflects options.manifestPath from the vite plugin; default ".redesigner/manifest.json"
  viteConfigPresent: boolean   // true if vite.config.{ts,js,mjs} exists at project root
  serverVersion: string        // SemVer of @redesigner/mcp; clients watch this for behavior changes
  mcpProtocolVersion: string   // the MCP protocol version this server speaks
}
```

DaemonBackend can fill this identically when it ships — no transport-specific fields.

### 6.5 Frozen-schema enforcement (snapshot test)

`test/snapshots/schemas.snap.json` is the canonical serialization of:
- `tools/list` response (each tool's name, description, version, input schema, output schema)
- `resources/list` response (each resource's URI, name, mime type, description)

A test runs at CI time: spin up the server with a mock Backend, call `tools/list` and `resources/list`, JSON.stringify the result with sorted keys, compare against the committed snapshot. Mismatch fails CI and forces reviewer attention. Updating the snapshot is a deliberate commit (like a public API change).

## 7. Config resolution algorithm

```ts
// config.ts
export function resolveConfig(argv: {project?: string}, cwd: string, env: NodeJS.ProcessEnv): ResolvedConfig {
  const home = env.HOME ?? env.USERPROFILE ?? null

  if (argv.project) {
    let p: string
    try { p = fs.realpathSync.native(path.resolve(argv.project)) }
    catch (err) {
      throw new Error(`[redesigner/mcp] --project path does not exist or cannot be read: ${argv.project}`)
    }
    assertHasManifest(p)   // throws with actionable message if .redesigner/manifest.json missing
    return buildFromRoot(p)
  }

  // Canonicalize cwd via realpath before walking. Defeats symlink trickery
  // where e.g. /tmp/attacker symlinks to the user's real project dir.
  let cur: string
  try { cur = fs.realpathSync.native(path.resolve(cwd)) }
  catch (err) {
    throw new Error(`[redesigner/mcp] cwd does not exist or cannot be read: ${cwd}`)
  }
  while (true) {
    // Hard ceiling: never walk past HOME.
    if (home && cur === home) break
    // Hard ceiling: never walk past fs root.
    const parent = path.dirname(cur)
    if (parent === cur) break

    if (existsSync(path.join(cur, '.redesigner', 'manifest.json'))) {
      // Required: the matched directory must itself look like a package root.
      // This rejects attacker-planted /tmp/.redesigner/manifest.json scenarios.
      if (!existsSync(path.join(cur, 'package.json'))) {
        cur = parent
        continue
      }
      const resolved = buildFromRoot(cur)
      process.stderr.write(`[redesigner/mcp] resolved project root: ${resolved.projectRoot}\n`)
      return resolved
    }

    // Boundary: stop if we've hit an enclosing package.json that has no .redesigner.
    // Prevents escaping a repo into a parent monorepo or unrelated package root.
    if (existsSync(path.join(cur, 'package.json')) && cur !== cwd) break
    cur = parent
  }

  throw new Error(
    '[redesigner/mcp] no .redesigner/manifest.json found walking up from cwd (stopped at HOME or repo boundary). ' +
    'Run `vite dev` in a project with @redesigner/vite installed, or pass --project <path>.',
  )
}
```

Defenses against path-traversal-style attacks:
- `fs.realpathSync.native` canonicalization at walk start — an attacker symlinking `/tmp/evil → /home/user/project` cannot escape real-path containment. Wrapped in try/catch so a deleted cwd produces a clean error, not an uncaught crash.
- HOME ceiling stops the walk from reaching `/` or `/tmp/`.
- `package.json` required AT the matched root (not just as a boundary stop) — an attacker-planted `.redesigner/` in a parent dir without a `package.json` is ignored.
- Resolved root logged to stderr at startup so the user can spot a wrong match.

`assertHasManifest(p)`: helper that `existsSync(path.join(p, '.redesigner/manifest.json'))`; throws `[redesigner/mcp] no .redesigner/manifest.json found at ${p} — did you run 'vite dev' in this project?` otherwise.

Returns `ResolvedConfig`:

```ts
interface ResolvedConfig {
  projectRoot: string           // absolute — internal use only, never surfaced via MCP
  manifestPath: string          // absolute — internal use only
  manifestRelativePath: string  // relative to projectRoot — safe to surface via ConfigResource
  selectionPath: string         // absolute — internal use only
  packageJson: {name?: string}  // parsed `name` used for ConfigResource.projectName
  viteConfigPresent: boolean
  serverVersion: string         // from packages/mcp/package.json "version"
}
```

`buildFromRoot(projectRoot: string): ResolvedConfig` reads `projectRoot/package.json` (tolerating absent or malformed — falls back to `basename(projectRoot)` for the name), detects `vite.config.{ts,js,mjs}` presence, computes `manifestPath = path.join(projectRoot, manifestRelativePath)` where `manifestRelativePath` comes from:

1. `--manifest <path>` CLI flag (if passed), relative to `projectRoot`, else
2. `.redesigner/manifest.json` (the plugin's default).

**Known limitation for v0**: if the user overrides `options.manifestPath` in `vite.config.ts`, the MCP server does NOT automatically discover the override. The user must pass `--manifest <relative-path>` to the MCP server, matching the plugin option. A follow-up could have the plugin write `.redesigner/mcp-config.json` at Vite-start time so MCP auto-detects; deferred until someone actually overrides the path in a real project.

Absolute paths (`manifestPath`, `selectionPath`, `projectRoot`) are internal to FileBackend. They are never serialized into MCP tool outputs or resources — invariant #1. Only `manifestRelativePath` and `projectName` reach the wire.

## 8. Validation + error surface

Unified mapping in `errors.ts`:

```ts
import type { ZodError } from 'zod'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'

export class FileTooLargeError extends Error {
  constructor(public readonly limitBytes: number, public readonly actualBytes: number) {
    super(`file exceeds ${limitBytes}-byte limit (actual ${actualBytes})`)
    this.name = 'FileTooLargeError'
  }
}

export function toMcpError(err: unknown, context: string): McpError {
  // context is intended to be a short relative-path identifier, never an absolute path.
  // (Enforced by discipline + code review; not asserted at runtime to keep errors.ts dependency-free.)
  if (err instanceof SyntaxError) {
    return new McpError(ErrorCode.InvalidRequest, `${context}: malformed JSON — ${err.message}`)
  }
  if (isZodError(err)) {
    const first = err.issues[0]
    return new McpError(ErrorCode.InvalidRequest,
      `${context}: ${first.path.join('.') || '(root)'} — ${first.message}`)
  }
  const nodeErr = err as NodeJS.ErrnoException
  if (nodeErr?.code === 'ENOENT') {
    return new McpError(ErrorCode.InvalidRequest, `${context}: file not found`)
  }
  if (nodeErr?.code === 'EACCES' || nodeErr?.code === 'EPERM') {
    return new McpError(ErrorCode.InvalidRequest, `${context}: permission denied`)
  }
  // Size violations throw a custom error class from FileBackend — see below.
  if (err instanceof FileTooLargeError) {
    return new McpError(ErrorCode.InvalidRequest, `${context}: file exceeds size limit (${err.limitBytes} bytes)`)
  }
  return new McpError(ErrorCode.InternalError, `${context}: ${String(err)}`)
}

function isZodError(err: unknown): err is ZodError {
  return typeof err === 'object' && err !== null && 'issues' in err && Array.isArray((err as {issues: unknown}).issues)
}
```

`context` is a short RELATIVE-path identifier like `"reading selection.json"` or `"reading manifest.json"` — absolute filesystem paths don't appear in error messages surfaced to Claude Code. This blunts information disclosure via prompt-inspectable tool errors.

## 9. ManifestWriter atomic bootstrap

Current `packages/vite/src/integration/manifestWriter.ts` constructor order:
1. mkdir + openSync lock
2. `startupSweep` (delete stale `manifest.json.tmp-*` files from prior runs)
3. direct `writeSync` of initial manifest

Changes:
1. Extract the atomic temp-file + rename loop from `flush()` into `private atomicWrite(manifest: Manifest): void` — shared code path.
2. Constructor calls `atomicWrite(this.buildManifest())` instead of `writeSync`.
3. `startupSweep` MUST run before `atomicWrite` — otherwise the sweep could race with the constructor's own tmp file. Invariant documented in code.
4. Remove the private `writeSync` method — no non-atomic write paths remain.

Optional refinement (not required for v0): swap to `write-file-atomic` (npm reference implementation) to reduce hand-rolled surface. Skip for now — existing implementation is proven through HMR + parallelism tests.

**Known residual fragility (deferred)**: the `.owner-lock` file created via `openSync(lockPath, 'wx')` is not auto-recovered if the process crashes mid-run. A stale lock requires manual `rm .redesigner/manifest.json.owner-lock`. Fix options for a follow-up: PID-based liveness check on lock-file acquisition failure, or switch to `proper-lockfile`. Surfaced during v0 dogfood; captured here so it's not forgotten.

## 10. Testing strategy

### 10.1 `@redesigner/core`

- `reader.test.ts` — moved as-is from vite package.
- `schema.test.ts` — for each of `ComponentHandleSchema`, `SelectionFileSchema`, `ManifestSchema`:
  - Happy path (valid fixture)
  - Missing required field
  - Wrong type
  - Extra unknown key (must reject due to `.strict()`)
  - Exceeds bounded length
- `safeJsonParse.test.ts` — asserts `__proto__`, `constructor`, and `prototype` keys are dropped; otherwise identical to `JSON.parse`.

### 10.2 `@redesigner/mcp` unit

- `config.test.ts`:
  - `--project` precedence wins over cwd walk
  - `--project /nonexistent` → actionable error, not uncaught crash
  - `--project <valid dir without .redesigner>` → `assertHasManifest` error with "did you run 'vite dev'" hint
  - Walk-up finds root with `.redesigner/` + `package.json`
  - Walk-up IGNORES a `.redesigner/` that lacks sibling `package.json` (attacker scenario)
  - Walk-up stops at HOME (with `HOME` env stub)
  - Walk-up stops at fs root when HOME is absent
  - Walk-up stops at first non-matching enclosing `package.json` (monorepo-parent boundary)
  - Two `.redesigner/` at nested levels: nearest wins
  - Symlinked parent dirs: fs.realpath normalization applied; logical containment preserved
  - Deleted cwd → clean error surface
  - Nothing found → throws with actionable message
- `backend.test.ts` — FileBackend with tmpdir fixtures:
  - Missing selection.json → `{current: null, history: []}`
  - Valid file → correct parse (golden-fixture test)
  - Malformed JSON → McpError InvalidRequest
  - Schema mismatch → McpError InvalidRequest with path in message
  - File > 1 MB (selection) / > 10 MB (manifest) → McpError InvalidRequest before read
  - Zero-byte file → McpError InvalidRequest (SyntaxError from JSON.parse(''))
  - EACCES → McpError InvalidRequest "permission denied"
  - Symlink to outside project root → follow + read (behavior matches fs default), but resolved-path is logged for audit
  - Caching: two rapid `getCurrentSelection` calls (< 100ms apart) → exactly one `fs.stat` + one `readFile` observed
  - Caching: two calls > 100ms apart → two reads observed
  - Cache invalidation: within TTL, change the file's mtime → next call re-reads rather than serving stale data
- `server.test.ts` — constructs server with an in-memory fake `Backend`:
  - `tools/list` returns exactly 4 tools with correct versions + schemas + descriptions
  - `resources/list` returns exactly 2 resources
  - Each tool round-trip: input validation, correct backend call, response shape
- `server-isolation.test.ts` — isolation invariant (#1):
  - Wraps a fake Backend in a recording Proxy that logs every method called
  - Monkey-patches `node:fs` to throw on any direct call during server operation
  - Executes every tool + resource; asserts the recorded Backend calls match the expected set AND that no fs call was attempted directly by `server.ts`
  - Proxy + fs-stub combination guarantees server.ts is a pure transport layer
- `schema-snapshot.test.ts`:
  - Serializes tools/list + resources/list output with sorted keys
  - Compares byte-for-byte against `snapshots/schemas.snap.json`
  - Mismatch fails with instruction: "Schema change detected. If intentional, bump server version in package.json, add a CHANGELOG.md entry describing the contract change, and regenerate snapshot via `pnpm --filter @redesigner/mcp run test:update-snapshot`"
  - `test:update-snapshot` script declared in `packages/mcp/package.json` (regenerates the committed snapshot — a deliberate commit)

### 10.3 `@redesigner/mcp` integration

- `client.test.ts` — spawns `cli.ts` via tsx in a child process with `--project <fixture>`:
  - Connects using `@modelcontextprotocol/sdk`'s `Client` class over stdio transport (SDK-native, not the Inspector UI — the Inspector is a REPL, not a programmatic test harness)
  - Captures child-process stderr and asserts the `[redesigner/mcp] resolved project root: <fixture>` log line fires — locks in observability
  - `tools/list` end-to-end
  - `get_current_selection` end-to-end (returns hand-authored fixture handle)
  - `resources/read redesigner://project/manifest` end-to-end
  - Unknown tool name → MCP "tool not found" error (locks in SDK's default rejection)
  - Graceful shutdown (SIGTERM → exit 0)

### 10.4 `@redesigner/vite` regression

- `atomic-bootstrap.test.ts` — new test (observation-based, not poll-based to avoid flakiness):
  - Monkey-patch `node:fs` via a thin wrapper that records every `writeFileSync` / `renameSync` / `openSync` call in order
  - Construct `ManifestWriter`, wait for bootstrap to complete
  - Assert the recorded sequence never writes directly to `manifest.json` — only `manifest.json.tmp-*` followed by a rename to `manifest.json`
  - Lock-in invariant: no non-atomic write path exists, regardless of timing

### 10.5 Property-based testing (optional, tracked for follow-up)

Consider `fast-check` + `zod-fast-check` for schemas: generate arbitrary inputs, assert valid inputs parse and invalid inputs always produce `McpError` (never crash the server). Deferred to a follow-up iteration — not blocking v0.

### 10.6 Fixture

`packages/mcp/test/fixtures/minimal-project/`:
- `README.md` — "Synthetic data only. Use names like `FooComponent`, `BarPage` — never real user code references. Committed fixtures are public."
- `package.json` — minimal (`{"name":"mcp-test-fixture","private":true}`)
- `.redesigner/manifest.json` — committed golden file; two components, three locs
- `.redesigner/selection.json` — one `current` + two `history` entries, all referencing manifest ids
- Pre-test hook: a vitest `beforeAll` in `client.test.ts` that loads the two fixture files, runs them through `ManifestSchema.safeParse` and `SelectionFileSchema.safeParse`, and throws a loud error if either fails. A fixture that drifts from the schema surfaces as a fast, clear test failure — not as a downstream assertion mystery.

## 11. Dogfood sequence (post-merge)

1. Build: `pnpm -r build`.
2. In `examples/playground/`, hand-write `.mcp.json`:
   ```json
   {"mcpServers":{"redesigner":{"command":"node","args":["../../packages/mcp/dist/cli.js"]}}}
   ```
3. `pnpm --filter @redesigner/playground run dev` → produces `.redesigner/manifest.json`.
4. Hand-edit `examples/playground/.redesigner/selection.json` with a ComponentHandle whose `id` matches the regex `[A-Za-z0-9_-]{1,128}` and whose fields reference real manifest entries.
5. Open Claude Code in `examples/playground/`, accept the workspace trust prompt. Check stderr for `[redesigner/mcp] resolved project root: <path>` — confirm it's the playground root.
6. Ask: *"What's currently selected in redesigner?"* — CC calls `get_current_selection`, returns the handle.
7. Ask: *"Show me the redesigner manifest."* — CC reads `redesigner://project/manifest`.
8. Break selection.json deliberately (invalid id chars, extra field, oversized) → confirm Claude Code sees a useful McpError, not a crash.

## 12. CI

- `pnpm -r run test` recurses into new packages. No workflow changes required.
- Workspace glob already covers `packages/*` — new packages picked up automatically.
- Build order: pnpm resolves `@redesigner/core` → `@redesigner/vite` + `@redesigner/mcp` via workspace links. CI step `pnpm -r build` already handles the DAG.
- Schema snapshot test runs as part of the default suite; a mismatched snapshot is a hard fail.

## 13. Out of scope for this plan (tracked for later)

- Long-running daemon (`@redesigner/daemon`) — introduces `DaemonBackend` for shim + WebSocket for extension.
- Chrome extension with hover-highlight picker.
- `@redesigner/cli` with `init` command.
- Windows CI restoration (deferred post-v0 from parent spec).
- Runtime props extraction via React fiber traversal.
- Property-based tests (§10.5).
- Migrate ManifestWriter to `write-file-atomic` if the hand-rolled implementation ever develops bugs.

## 14. Open questions

None. All design choices from the brainstorming phase plus the Round 1 review are incorporated.

Proceed to implementation plan.
