# Review Panel — MCP Shim v0 Design

**Artifact:** `docs/superpowers/specs/2026-04-19-mcp-shim-v0-design.md`
**Panel:** Senior Developer, API Designer, Security Expert, QA / Test Engineer
**Mode:** Deep review loop (5 rounds, auto-apply-all-findings each round)
**Date:** 2026-04-19
**Verdict:** **PASS WITH CONDITIONS**

---

## Loop progression

| Round | Verdict before apply | 🔴 | 🟠 | 🟡 | 🔵 | Apply scope |
|---|---|---|---|---|---|---|
| 1 | REVISE AND RESUBMIT | 0 | 7 | 13 | 3 | All 23 |
| 2 | PASS WITH CONDITIONS | 0 | 2 | 6 | 1 | All 9 |
| 3 | PASS WITH CONDITIONS | 0 | 1 | 10 | 2 | All 13 |
| 4 | PASS WITH CONDITIONS | 0 | 2 | 5 | 2 | All 9 |
| 5 | PASS WITH CONDITIONS | 0 | 0 | 5 | 2 | All 7 |

Loop terminated at Round 5 (max rounds). Verdict settled to **PASS WITH CONDITIONS** — no Critical, no Major; Minor finding count is the basis for conditions.

---

## What changed along the way

The spec entered review as a reasonable sketch of an MCP shim over a file-backed Backend. It exited after five rounds materially more robust, with the following most-impactful changes:

1. **Rejected non-standard MCP patterns.** Round 1 proposed per-tool `annotations.version` (borrowed from SEP-986/SEP-1575 community proposals). Round 2 research confirmed the MCP SDK annotations standard has no version field; clients would silently ignore it. Replaced with server-level SemVer via `Server({name, version})`, which is SDK-supported and universally honored.

2. **Hardened file-resolution against symlink + planted-manifest attacks.** Round 1 identified walk-up traversal risks; Round 2 added `fs.realpathSync.native` canonicalization, Round 3 wrapped it in try/catch for deleted-cwd cases. The `package.json`-required-at-matched-root check blocks planted `.redesigner/` directories in unrelated parents.

3. **Defense-in-depth on JSON input.** `.strict()` applied recursively to all Zod schemas PLUS a `__proto__`/`constructor` stripping reviver in `safeJsonParse` — two independent layers of prototype-pollution defense. Size caps (10 MB manifest, 1 MB selection) enforced via `fs.stat` BEFORE read, preventing accidental OOM or DoS from a compromised plugin writer.

4. **Backend abstraction locked in with tests.** Round 2 strengthened `server-isolation.test.ts` to use a recording Proxy on a mock Backend plus a monkey-patched `node:fs` that throws on direct use — guaranteeing `server.ts` stays transport-agnostic when `DaemonBackend` ships later.

5. **Stable tool contracts.** Tool descriptions became mode-invariant (no "returns null in file-backed mode" language), so the same spec survives the daemon transition unchanged. A committed `schemas.snap.json` snapshot test forces deliberate review on any contract drift.

6. **Filled architectural gaps.** `buildFromRoot` was undefined in the initial spec; Round 4 resolved it and surfaced a v0 limitation (plugin `options.manifestPath` overrides need a matching `--manifest` CLI flag; auto-discovery deferred). Read-through caching with a 100ms mtime-keyed TTL added to FileBackend to handle burst tool calls from a single Claude Code turn.

7. **Correct dependency model.** Round 1 specified `zod` as `peerDependencies`; Round 2 research (Speakeasy, Zod library-authors guide) established this is only correct for externally-published libraries. For monorepo-internal packages, `dependencies` with pnpm hoisting is cleaner. Switched.

---

## Final review

### Senior Developer

**Research context:**
- MCP TypeScript SDK v1.x is the current production release; v2 anticipated Q1 2026
- SDK has a required peer on zod, internally uses `zod/v4` but stays back-compat with v3.25+
- `safeParse` is preferred over `.parse()` for control-flow validation — discriminated-union result avoids throw/catch overhead
- pnpm workspace hoisting deduplicates zod across workspace packages automatically; peer-dep only matters for externally-published libraries

**Findings**

🟡 **Minor — `context` param not runtime-asserted** (SE5-2)
- `toMcpError(err, context)` is documented as "relative-path identifier, never an absolute path" but nothing enforces this.
- A sloppy implementer could pass `selectionPath` (absolute) and leak the full filesystem location into an MCP error message surfaced to Claude Code.
- **Recommendation:** added an inline comment at the `toMcpError` definition; code review discipline. Not asserted at runtime to keep `errors.ts` dependency-free.

🟡 **Minor — cache test coverage gap**
- §6.2 adds a 100ms mtime-keyed cache but §10.2 needed explicit cases for cache hit, miss, and mtime-invalidation.
- **Recommendation:** added three cache-behavior test cases to `backend.test.ts`.

🟡 **Minor — atomic-bootstrap test should not rely on polling**
- A reader thread polling `manifest.json` at 1ms intervals is inherently flaky.
- **Recommendation:** rewrote test as observation-based — monkey-patches `fs.writeFileSync` / `renameSync` / `openSync` to record the call sequence, then asserts the recorded sequence shows no direct write to `manifest.json`. Eliminates timing dependence.

### API Designer

**Research context:**
- MCP tool annotations standard fields: `{title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}` — NO version field
- Tool descriptions are part of the contract; changing description wording alters LLM tool-selection probability (Nordic APIs, Merge.dev, SEP-986/SEP-1575 proposals)
- Server-level `Server({name, version})` is the canonical per-session version channel
- Resource URIs: MCP convention is `<scheme>://<host>/<path>`; single-host semantics are fine

**Findings**

🟡 **Minor — `ConfigResource.mcpProtocolVersion` is redundant**
- The MCP SDK already exposes the protocol version during the `initialize` handshake; clients know this without reading our resource.
- **Recommendation:** retained for documentation value. Informational redundancy is cheap and helps humans reading the resource directly.

🔵 **Suggestion — `list_recent_selections` at n=0**
- Schema requires n ≥ 1, so n=0 never reaches the Backend. Tool description correctly says "up to n", which remains accurate.
- **Recommendation:** no change needed.

### Security Expert

**Research context:**
- CVE-2026-31802 (tar library) reinforces that Windows drive-relative paths + symlink expansion are still exploitable in 2026
- `fs.rename` is atomic on the same filesystem; cross-filesystem (EXDEV) needs fallback — reference impl: npm/write-file-atomic
- Prototype pollution vectors documented across recent 2026 CVEs (defu, flatted) — `.strict()` Zod rejection + reviver strip is the layered pattern
- secure-json-parse (fastify) is the canonical drop-in for JSON parse with pollution protection

**Findings**

🟡 **Minor — EACCES/EPERM surface as `InvalidRequest`**
- Permission errors on our own files aren't really client-invalid; they're server-side filesystem state.
- Using `ErrorCode.InvalidRequest` could mislead Claude Code into retrying with different arguments when the problem is configuration.
- **Recommendation:** debatable — kept as `InvalidRequest` for consistency with other file-access failures. Revisit if a user encounters actual confusion.

No other security findings this round. Prior rounds locked in: realpath canonicalization, HOME ceiling, matched-root `package.json` requirement, size caps pre-read, `.strict()` recursively, reviver-based pollution defense.

### QA / Test Engineer

**Research context:**
- `@modelcontextprotocol/inspector` is a REPL / interactive debugger — NOT a scripted test harness
- Correct programmatic integration test uses `@modelcontextprotocol/sdk`'s `Client` class + `StdioClientTransport` as a child process
- No native in-process transport in the SDK stdlib; spawn subprocess + connect via Client is the SDK-blessed pattern

**Findings**

🟡 **Minor — atomic-bootstrap test location**
- §10.4 places `atomic-bootstrap.test.ts` under `packages/vite/test/integration/` but the test exercises only ManifestWriter internals — arguably a unit test.
- **Recommendation:** implementer's call; integration is defensible because it observes full bootstrap + first write as a sequence.

🟡 **Minor — cache-invalidation test (now covered)**
- Round 5 added the cases; covered.

🔵 **Suggestion — property-based testing follow-up**
- `zod-fast-check` + `fast-check` would thoroughly exercise the schema-error-mapping boundaries.
- **Recommendation:** tracked in §13 as out-of-scope for v0; worth revisiting when schema-space grows.

---

## Severity-weighted verdict

| Severity | Count | Weight |
|---|---|---|
| 🔴 Critical | 0 | none |
| 🟠 Major | 0 | none |
| 🟡 Minor | 5 | conditions |
| 🔵 Suggestion | 2 | advisory |

**Verdict: PASS WITH CONDITIONS**

Conditions (all Minor — address during implementation, not spec revision):
1. Include the three cache behavior tests called out in §10.2.
2. Include the explicit location test for `atomic-bootstrap` (wherever it lands).
3. Include the `FileTooLargeError` class definition in `errors.ts` as spec'd.
4. Commit `schemas.snap.json` with the initial snapshot as part of the first mcp package build.
5. Add the pre-test `beforeAll` hook that validates fixtures against schemas.

---

## Next step

Spec is ready for implementation. Run the writing-plans skill to convert it into a task-by-task plan.
