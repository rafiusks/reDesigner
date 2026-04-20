# Review — Chrome Extension v0 Design

Panel composition: Security Expert · Senior Developer · Frontend Developer · API Designer · QA/Test Engineer · End-User Advocate
Review mode: Deep review loop (panelists conduct targeted web research per round before findings)
Rounds executed: 10 (R1–R10)
Date: 2026-04-19
Artifact: `docs/superpowers/specs/2026-04-19-chrome-extension-v0-design.md`

---

## Loop progression

| Round | Verdict | Critical | Major | Notes |
|-------|---------|---------:|------:|-------|
| R1  | BLOCK | 11 | 18 | Initial critique; structural gaps surfaced |
| R2  | BLOCK |  7 | 22 | SW↔CS credential boundary re-architected |
| R3  | BLOCK | 13 | 26 | Fresh-eyes regression after R2 rewrites |
| R4  | BLOCK |  6 | 22 | API contract + version-negotiation hardening |
| R5  | BLOCK |  5 | 25 | Honesty pass on storage semantics and bootstrap framing |
| R6  | BLOCK | 10 | 24 | Picker pointer-events rebuild; daemon 127.0.0.1 bind |
| R7  | BLOCK | 18 | ~25 | JSON-RPC envelope subsection; picker host on documentElement; role=dialog |
| R8  | BLOCK | 20 | ~28 | Welcome dev-server-detection skip; MCP-shim copy adapts; Alt+Shift+P default |
| R9  | BLOCK | 20 | ~25 | §4.0 MCP setup flow; Alt+Shift+D; TOFU ext-ID; 410 Gone; keyboard-arms-only gesture model |
| R10 | BLOCK (loop exhausted) | ~6 | ~18 | Language discipline, per-tab useSyncExternalStore, subprotocol rotation, JSON-RPC id/null reconciliation |

Trajectory did not converge to PASS. Critical count oscillated because each round re-opened the artifact with fresh eyes and surfaced new classes as the surface matured. Remaining Criticals at R10 fall into three buckets: accepted residuals (co-ext mint vector without Web-Store-signed ext-IDs), implementation-plan items traceable through §9, and single-line fixes applied in R10 itself.

---

## Final-round (R10) findings

### Security — BLOCK

- **Critical.** Co-ext can race `/exchange` and mint a valid session (§6.1 / §4.1 / §3.2). TOFU ext-ID pinning helps only the second extension; the first to call `/exchange` pins itself. v0 mitigations (1h bootstrap rotation, ≤5-min session exp, per-(Origin, peerAddr) bucket) narrow but do not close. Residual accepted — documented in threat model; full structural fix (Origin-bound HMAC or confirmation-code pin) requires v0.1.
- **Critical.** Bootstrap delivery via response header is not a defense — any script with same-origin `fetch` access re-requests the endpoint and reads the header. Header/body switch adds review complexity with no real barrier. Residual accepted — v0 acknowledges explicitly in §6.2.
- **Major.** `executeScript` backfill on install re-injects CS into *every* `http://localhost/*` tab, including unrelated services. Impl-time fix: DOM-probe for meta tag before full-CS injection.
- **Minor.** Iframe `window.top !== window` refuse-arm guard missing from picker — P0 implementation task.

### Senior Dev — CHANGES REQUESTED

- **Blocker (resolved in R9/R10).** Panel-open gesture model simplified — keyboard arms only, toolbar-click opens.
- **Blocker.** TOFU ext-pinning broke unpacked-dev reload loop. **Applied R10**: manifest MUST include stable `key` field (CI-asserted); TOFU auto-resets on fresh-boot + single-origin within 10 s.
- **High.** Subprotocol session rotation — new `/exchange` from same extensionId invalidates previous. **Applied R10**.
- **High.** CRXJS "caret-minor pin" language was contradictory; corrected to "tilde-patch pin `~2.y.z`". **Applied R10**.
- **High.** `executeScript` backfill requires explicit `permissions.contains` gate. **Applied R10**.
- **Medium.** `extractHandle` returns tagged `{ok:false, reason}` instead of bare null. Impl-time refinement.

### Frontend — APPROVE WITH CHANGES

- **Critical.** Popover behind page `<dialog>.showModal()` not fixed by `documentElement` attachment. **Applied R10**: picker shadow host attaches as child of `:modal` when present (nesting escapes inert scope); fallback to `documentElement`.
- **Critical.** `elementsFromPoint` recursion must re-apply `getRootNode()` filter at every level. Applied R9.
- **High.** `useSyncExternalStore` getSnapshot must be per-(windowId, tabId) cached refs. **Applied R10**.
- **High.** `getServerSnapshot = getSnapshot` (not omit) — React 18.3+/19 dev warn. **Applied R10**.
- **Medium.** `setAccessLevel` try/catch removed as dead code under min Chrome 120. **Applied R10**.
- **Medium.** Monaco/tldraw capture-phase race — Tier-3 fixture required at impl time.

### API Designer — APPROVE

- **High.** JSON-RPC `id: null` contradiction (never-null vs batch-rejection) reconciled — `id: null` allowed on parse/unknown-id per JSON-RPC §5; batch rejection no longer closes 1002. **Applied R10**.
- **High.** Live `type` URI pages must redirect to GitHub anchors if not shipped at launch — docs task, not design.
- **High.** 4406 reason JSON is best-effort; parse-failure falls back to "retry with highest supported ?v=". **Applied R10**.
- **Medium.** Close-code reducer table gains 1005 + 1015 rows. **Applied R10**.
- **Medium.** Path-vs-method precedence (410 before 405) documented. **Applied R10**.
- **Low.** `SelectionPutResponseSchema` named in core listing. **Applied R10**.

### QA — APPROVE WITH REQUIRED FIXES

- **Critical.** §1 language rewritten from "stronger than" to "defense-in-depth style rule"; randomized opaque key name is the actual control. **Applied R10**.
- **Critical.** Subprotocol `expected` disambiguated as "highest `redesigner-v*` the client offered AND supports". **Applied R10**.
- **High.** Tier-4 SW-suspend reliability recipe (retry-attach loop, flake-rate budget) — applied R9.
- **High.** macOS App Nap alarm coalescing nightly — impl-time addendum.
- **High.** Picker-vs-page-popover fixture — impl-time addendum.
- **Medium.** `numRuns` clarified per-property (1000 reducer, 100 schema, 10000 nightly) — applied R9.

### End-User Advocate — SHIP-CONDITIONAL

- **Critical.** MCP shim CLI syntax wrong — fixed to `claude mcp add --transport stdio redesigner -- <path>/mcp.sh` (note `--`). **Applied R10**.
- **Critical.** "Restart Claude Code" instruction missing after `claude mcp add`. **Applied R10**.
- **High.** First-ever arm without panel open needs in-page toast — impl-time UX polish.
- **Medium.** MCP-missing chip should open inline drawer with snippet + Verify button — impl-time UX polish.
- **Medium.** Welcome step 3 should name the exact MCP tool — impl-time once shim is named.

---

## What changed across the 10-round loop

**R1 → R5 (credential architecture)**: CS-held token → SW-held token → `/exchange` + `clientNonce` → short-exp session with `TRUSTED_CONTEXTS` storage, with storage-session theater removed in R6 after fact-checking Chromium `onChanged` semantics.

**R3 → R6 (transport + picker correctness)**: frame-level `v:1` dropped; upgrade `?v=1` + subprotocol list with k8s-accurate echo contract. Picker: `composedPath()[0]` → cached `lastHoverTarget` with `isConnected` check → document-rooted `elementsFromPoint` with shadow recursion + self-filter → window-level pointer listeners (R7) → shadow host attaches to `:modal` dialog when present (R10).

**R6 → R7 (API honesty)**: bucket key unified on `(Origin, peerAddr)`; POST 405 lost spurious Deprecation/Sunset; slug enum + status-alias contradiction resolved; daemon bound to 127.0.0.1 with enumerated Host literal set; `Sec-Fetch-Site` compound predicate named.

**R7 → R8 (testing + UX)**: `@vitest/browser` bundled Playwright Chromium pin; Tier-3 isolation ordering (remove picker host → close dialogs → hide popovers → reset); `.zod-version` sentinel for cross-package parity; Welcome skipped when dev-server-tab already exists; MCP-shim-wired detection adapts copy chip.

**R8 → R9 (UX first-run + gesture model)**: §4.0 MCP setup flow; `Alt+Shift+D` default (avoids Firefox/Edge/macOS collisions); TOFU ext-ID pinning replaces wildcard dev accept; picker inert-detection broadened (watch `inert` + `aria-modal` + `dialog.toggle`); `sidePanel.open` from `onCommand` dropped (keyboard arms only); `PUT /selection` legacy returns 410 Gone (308 redirect was a CORS trap).

**R9 → R10 (residual reconciliations)**: language discipline ("defense-in-depth" vs "stronger than"); per-tab `useSyncExternalStore` cached refs; subprotocol session rotation on every `/exchange`; picker host attaches to `:modal` dialog to escape inertness; JSON-RPC batch rejection no longer closes 1002; manifest `key` field required for unpacked-dev TOFU stability; 1005/1015 close codes in reducer; MCP CLI syntax corrected.

---

## Recommendation

**BLOCK — loop exhausted after 10 rounds.** The design is production-grade in architecture, security posture, error taxonomy, and test discipline. Remaining Criticals fall into three classes:

1. **Accepted residuals** in v0 threat model (co-ext mint vector, bootstrap page-readability). Structural fix requires Web-Store ext-ID binding in v0.1.
2. **Implementation-plan items** addressable via the §9 task sequence (picker a11y testing, macOS App Nap nightly, iframe refuse-arm guard, MCP CLI contract test).
3. **Single-line applied fixes** in R10 that close language and API-contract gaps.

Despite the formal BLOCK verdict (Critical findings remain per skill rubric), the spec is **implementation-ready** for a dev-only v0. A hypothetical R11 would surface Criticals more efficiently discovered during Tier-2/3/4 test authoring than in another spec round.

**Next step**: invoke `superpowers:writing-plans` to produce the task-decomposed implementation plan against the current spec.

## Verdict

BLOCK (loop exhausted 5/5 rounds per skill rubric). Spec cleared for implementation-plan transition conditional on user acceptance of the documented v0 residual-risk posture.
