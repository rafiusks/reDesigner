# Selection Pipeline Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire SW → daemon `PUT /tabs/{tabId}/selection` through an awaited dispatcher so a user pick persists to the daemon, is readable via MCP `get_current_selection`, and covered by an end-to-end integration test.

**Architecture:** Six slices across `core`, `daemon`, `vite`, `ext`, `mcp`: (A) extId header on SW REST, (B) await-in-dispatcher PUT + new `persistSelection.ts` helper, (C) handle validation boundary, (D) MCP stdio roundtrip integration test, (E+E.1) schema forward-evolvability, (F) Chrome ext-ID regex correctness (`[a-z]` → `[a-p]`) across 7 daemon/vite/ext sites.

**Tech Stack:** pnpm workspace, Node 22, TypeScript 5, Zod 3/4 (major-pinned via `.zod-version`), Vitest 2, MV3 Chrome extension, `@modelcontextprotocol/sdk` 1.29.

**Scope reference:** `docs/superpowers/specs/2026-04-20-selection-pipeline-stage1-design.md` (670 lines; the SOURCE OF TRUTH — read it before starting any task).

**Branch:** work on a NEW branch off `main` **after** PR #18 (`fix/daemon-vite-token-sync`) is merged. Do NOT stack this on the PR #18 branch.

---

## Execution Strategy

**Model assignments** (rationale baked into each task): the plan uses Haiku for mechanical/find-replace work, Sonnet for integration-sensitive implementation, Opus for cross-cutting subprocess orchestration and performance instrumentation design.

**Parallelism (P-G groups):**
- **P-G1** (after T1 lands): T2, T3, T4 — modify independent files; no coordination required.
- **P-G2** (after T6 lands): T7, T8, T9 — all ext-only unit tests, different test files.
- **Sequential boundaries:** T1 blocks everything (schemas are imported broadly). T5 blocks T6 (helper must exist before router uses it). T6 blocks P-G2 (tests assert router+helper behavior). T10/T11/T12/T13 can run anywhere after their dependencies. T14 runs last (manual dogfood).

**Total:** 14 tasks. Aim: land T1-T13 in one PR titled `feat(ext+core+daemon+mcp): persist selection SW→daemon→MCP end-to-end`.

---

## Task 1: Core schema updates (Slice E + E.1 + new errors.ts)

**Model:** Sonnet — not mechanical (involves schema design decisions), but not architecturally risky.
**Parallel group:** N/A — blocks all downstream work.

**Files:**
- Modify: `packages/core/src/schemas/selection.ts`
- Create: `packages/core/src/schemas/errors.ts`
- Create: `packages/core/test/schemas/selection.test.ts`
- Create: `packages/core/test/schemas/errors.test.ts`
- Verify/modify: `packages/core/src/schemas/index.ts` (export new `errors` module)

- [ ] **Step 1: Write failing tests for selection schema changes**

Create `packages/core/test/schemas/selection.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { SelectionPutBodySchema, SelectionPutResponseSchema } from '../../src/schemas/selection.js'

const validHandle = {
  id: 'test-id-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: 1_700_000_000_000,
}

describe('SelectionPutBodySchema (Slice E + E.1)', () => {
  test('validates body WITH clientId', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      clientId: '00000000-0000-4000-8000-000000000001',
    })
    expect(r.success).toBe(true)
  })

  test('validates body WITHOUT clientId (now optional per Slice E)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle] })
    expect(r.success).toBe(true)
  })

  test('rejects body with foreign top-level field (.strict preserved)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle], foo: 1 })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe('unrecognized_keys')
    }
  })

  test('rejects malformed clientId (not UUIDv4)', () => {
    const r = SelectionPutBodySchema.safeParse({ nodes: [validHandle], clientId: 'not-a-uuid' })
    expect(r.success).toBe(false)
  })

  test('meta accepts unknown fields via catchall (Slice E.1)', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      meta: { source: 'picker', pickSeq: 42 },
    })
    expect(r.success).toBe(true)
  })

  test('meta rejects invalid source enum', () => {
    const r = SelectionPutBodySchema.safeParse({
      nodes: [validHandle],
      meta: { source: 'picker-v2' },
    })
    expect(r.success).toBe(false)
  })
})

describe('SelectionPutResponseSchema (Slice E.1 forward-evolution)', () => {
  test('validates known fields', () => {
    const r = SelectionPutResponseSchema.safeParse({ selectionSeq: 1, acceptedAt: 1_700_000_000_000 })
    expect(r.success).toBe(true)
  })

  test('accepts unknown future field via catchall AND preserves its value', () => {
    const r = SelectionPutResponseSchema.safeParse({
      selectionSeq: 1,
      acceptedAt: 1_700_000_000_000,
      futureField: 'x',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect((r.data as { futureField?: unknown }).futureField).toBe('x')
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @redesigner/core test schemas/selection`
Expected: tests fail because `clientId` is still required and `.strict()` is still in place.

- [ ] **Step 3: Apply schema changes in `packages/core/src/schemas/selection.ts`**

Replace the file with:

```ts
import { z } from 'zod'
import { ComponentHandleSchema } from '../schema'
import { UUID_V4_RE } from './primitives'

/**
 * `PUT /tabs/{tabId}/selection` request body.
 * v0 is single-select only — `nodes` has exactly 1 entry. The envelope shape
 * future-proofs multi-select (capability advertised as `multiSelect: false` in hello).
 *
 * clientId: optional per Slice E. The daemon does not consume it (grep-confirmed).
 * meta: .catchall(z.unknown()) per Slice E.1 so Stage 2 can add pickSeq etc. without
 *   a schema bump. source is enum-constrained to prevent log-drift.
 */
export const SelectionPutBodySchema = z
  .object({
    nodes: z.array(ComponentHandleSchema).min(1).max(1),
    clientId: z.string().regex(UUID_V4_RE, 'clientId must be a UUIDv4 string').optional(),
    meta: z
      .object({
        source: z.enum(['picker', 'mcp', 'dev']),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .strict()
export type SelectionPutBody = z.infer<typeof SelectionPutBodySchema>

/**
 * `PUT /tabs/{tabId}/selection` response body.
 * `selectionSeq` is daemon-side monotonic per tab, assigned at selectionState.apply
 * time; resets on daemon restart. `acceptedAt` is Unix-ms server clock at apply time.
 *
 * .catchall(z.unknown()) per Slice E.1: response schemas must be forward-compatible.
 * Stage 2 will add fields (e.g., server-echoed pickSeq). Clients ignore unknown keys.
 * .passthrough() is deprecated in Zod v4; .catchall is the idiomatic replacement.
 */
export const SelectionPutResponseSchema = z
  .object({
    selectionSeq: z.number().int().nonnegative(),
    acceptedAt: z.number().int().positive(),
  })
  .catchall(z.unknown())
export type SelectionPutResponse = z.infer<typeof SelectionPutResponseSchema>
```

- [ ] **Step 4: Create errors schema file**

Create `packages/core/src/schemas/errors.ts`:

```ts
import { z } from 'zod'

/**
 * Machine-parseable error bodies returned by the daemon for selected 4xx responses.
 *
 * Both shapes use `.catchall(z.unknown())` on the outer and `z.enum(...).or(z.string())`
 * on `reason` so Stage 2 can add new reason codes without breaking existing clients.
 * Tests pin the currently-known enum values; unknown values parse successfully.
 *
 * This preserves the liberal-in-what-you-accept principle symmetric with
 * SelectionPutResponseSchema. Consumed by daemon (producer) + MCP + ext rest.ts.
 */
export const AuthErrorSchema = z
  .object({
    error: z.literal('auth'),
    reason: z.enum(['extid-mismatch', 'token-unknown', 'token-tofu-fail']).or(z.string()),
  })
  .catchall(z.unknown())
export type AuthError = z.infer<typeof AuthErrorSchema>

export const CorsErrorSchema = z
  .object({
    error: z.literal('cors'),
    reason: z.enum(['malformed-origin', 'missing-origin']).or(z.string()),
  })
  .catchall(z.unknown())
export type CorsError = z.infer<typeof CorsErrorSchema>

export const ApiErrorSchema = z.discriminatedUnion('error', [AuthErrorSchema, CorsErrorSchema])
export type ApiError = z.infer<typeof ApiErrorSchema>
```

- [ ] **Step 5: Write failing tests for errors schema**

Create `packages/core/test/schemas/errors.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ApiErrorSchema, AuthErrorSchema, CorsErrorSchema } from '../../src/schemas/errors.js'

describe('AuthErrorSchema', () => {
  test('validates known reason', () => {
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'extid-mismatch' }).success).toBe(true)
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'token-unknown' }).success).toBe(true)
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'token-tofu-fail' }).success).toBe(true)
  })

  test('accepts unknown reason (forward-compat via .or(z.string()))', () => {
    const r = AuthErrorSchema.safeParse({ error: 'auth', reason: 'future-reason-code' })
    expect(r.success).toBe(true)
  })

  test('accepts unknown top-level field via catchall', () => {
    const r = AuthErrorSchema.safeParse({ error: 'auth', reason: 'extid-mismatch', trace: 'x' })
    expect(r.success).toBe(true)
  })
})

describe('CorsErrorSchema', () => {
  test('validates known reasons', () => {
    expect(CorsErrorSchema.safeParse({ error: 'cors', reason: 'malformed-origin' }).success).toBe(true)
    expect(CorsErrorSchema.safeParse({ error: 'cors', reason: 'missing-origin' }).success).toBe(true)
  })
})

describe('ApiErrorSchema (discriminated union)', () => {
  test('routes by error field', () => {
    const auth = ApiErrorSchema.safeParse({ error: 'auth', reason: 'token-unknown' })
    expect(auth.success).toBe(true)
    const cors = ApiErrorSchema.safeParse({ error: 'cors', reason: 'malformed-origin' })
    expect(cors.success).toBe(true)
  })

  test('rejects unknown error discriminant', () => {
    expect(ApiErrorSchema.safeParse({ error: 'other', reason: 'x' }).success).toBe(false)
  })
})
```

- [ ] **Step 6: Export the new errors module**

Open `packages/core/src/schemas/index.ts` and add:

```ts
export * from './errors.js'
```

If `index.ts` uses a barrel pattern, follow the existing style.

- [ ] **Step 7: Run all core tests to verify green**

Run: `pnpm --filter @redesigner/core test`
Expected: all selection + errors tests pass.

- [ ] **Step 8: Rebuild core dist (downstream packages resolve via `dist/`)**

Run: `pnpm --filter @redesigner/core build`
Expected: clean build, `dist/schemas/errors.js` exists.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/schemas/selection.ts packages/core/src/schemas/errors.ts packages/core/src/schemas/index.ts packages/core/test/schemas/
git commit -m "feat(core): make clientId optional, add errors schema, forward-compat responses"
```

---

## Task 2: Daemon + vite + ext: Chrome ext-ID regex correctness fix (Slice F)

**Model:** Haiku — pure mechanical find-replace across 7 sites + 2 test fixture updates. Zero design decisions.
**Parallel group:** P-G1 — independent of T3, T4.

**Files (re-grep before starting, line numbers as-of 2026-04-20 may drift):**
- Modify: `packages/daemon/src/routes/exchange.ts` (EXT_ID_REGEX, CHROME_EXT_ORIGIN_REGEX)
- Modify: `packages/daemon/src/routes/revalidate.ts` (EXT_ID_REGEX, ORIGIN_REGEX)
- Modify: `packages/daemon/src/routes/cors.ts` (inline origin regex)
- Modify: `packages/daemon/src/server.ts` (inline extId validator)
- Modify: `packages/daemon/test/closeCodes.test.ts` (helper regex + EXT_ID_A fixture)
- Modify: `packages/vite/src/bootstrap.ts` (CHROME_EXT_ORIGIN_RE)
- Modify: `packages/ext/test/e2e/nightly/exchange-live.spec.ts` (TEST_EXT_ORIGIN constant)

- [ ] **Step 1: Re-grep to confirm sites (line numbers may have drifted)**

Run: `grep -rn "a-z\]{32}" packages/`
Expected: hits in the files listed above. If any site is not on the list, investigate — spec assumed 7 sites, don't silently miss one.

- [ ] **Step 2: Replace `[a-z]{32}` → `[a-p]{32}` in all daemon + vite source files**

For each file, swap the regex character class. Example — `packages/daemon/src/routes/exchange.ts`:

```ts
// Before:
const EXT_ID_REGEX = /^[a-z]{32}$/
export const CHROME_EXT_ORIGIN_REGEX = /^chrome-extension:\/\/([a-z]{32})$/

// After:
const EXT_ID_REGEX = /^[a-p]{32}$/
export const CHROME_EXT_ORIGIN_REGEX = /^chrome-extension:\/\/([a-p]{32})$/
```

Apply same pattern to `revalidate.ts`, `cors.ts`, `server.ts`, `bootstrap.ts`, and the helper regex in `closeCodes.test.ts`.

- [ ] **Step 3: Audit + fix test fixture extension IDs**

Any hard-coded 32-char extension ID that contains q-z must be replaced with an all-`a-p` string. Minimum audit:

- `packages/ext/test/e2e/nightly/exchange-live.spec.ts:40` — `TEST_EXT_ORIGIN` is `'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef'` (contains q-v). Replace with `'chrome-extension://abcdefghijklmnopabcdefghijklmnop'`.
- `packages/daemon/test/closeCodes.test.ts` — search for `EXT_ID_A` and any inline extension IDs. Replace q-z characters.
- Any other test files with 32-char lowercase strings in extension contexts: grep for `chrome-extension://[a-z]{32}` and audit each.

- [ ] **Step 4: Add daemon-side regression test for q-z-Origin rejection**

Open `packages/daemon/test/integration/exchange.test.ts` and add a case:

```ts
test('rejects Origin with q-z characters (not a valid Chrome ext ID)', async () => {
  const body = JSON.stringify({
    clientNonce: crypto.randomUUID(),
    bootstrapToken: <valid bootstrap token from setup>,
  })
  const res = await fetch(`${baseUrl}/__redesigner/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'chrome-extension://abcdefghijklmnopqrstuvwxyz123456',  // q-v fails [a-p]{32}
    },
    body,
    signal: AbortSignal.timeout(3000),
  })
  expect(res.status).toBe(403)
})

test('accepts Origin with only a-p characters', async () => {
  const body = JSON.stringify({
    clientNonce: crypto.randomUUID(),
    bootstrapToken: <valid bootstrap token>,
  })
  const res = await fetch(`${baseUrl}/__redesigner/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',  // all a-p
    },
    body,
    signal: AbortSignal.timeout(3000),
  })
  expect(res.status).toBe(200)
})
```

- [ ] **Step 5: Run all daemon tests**

Run: `pnpm --filter @redesigner/daemon test`
Expected: previously-passing tests still pass; two new regex-audit tests pass.

- [ ] **Step 6: Run vite tests**

Run: `pnpm --filter @redesigner/vite test`
Expected: all pass.

- [ ] **Step 7: Run ext tests**

Run: `pnpm --filter @redesigner/ext test`
Expected: all pass; TEST_EXT_ORIGIN string was updated in e2e nightly spec.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon packages/vite packages/ext/test/e2e/nightly/exchange-live.spec.ts
git commit -m "fix(daemon+vite+ext): correct Chrome ext-ID regex to [a-p]{32} (Slice F)"
```

---

## Task 3: Daemon — verify PUT response shape + wire 401/403 reason codes

**Model:** Sonnet — integration between existing auth code + new error shape.
**Parallel group:** P-G1 — independent files from T2, T4.

**Files:**
- Verify/modify: `packages/daemon/src/routes/selection.ts` (confirm `{selectionSeq, acceptedAt}` response)
- Modify: `packages/daemon/src/server.ts` (401 body for auth failure — reason codes from `@redesigner/core`)
- Modify: `packages/daemon/src/routes/cors.ts` OR wherever 403 is emitted (403 body with `malformed-origin` / `missing-origin` reason)
- Modify: `packages/daemon/src/routes/exchange.ts` (existing root-token + extId interaction — confirm debug log on mismatch)
- Create-or-modify: `packages/daemon/test/integration/selection.test.ts`

- [ ] **Step 1: Verify current response shape matches spec**

Read `packages/daemon/src/routes/selection.ts:115` area (`handleSelectionPut`). Confirm the response body is `{ selectionSeq: result.selectionSeq, acceptedAt }`. If not, correct it to match `SelectionPutResponseSchema` from core. No functional change expected — this is a verification step.

- [ ] **Step 2: Write a daemon integration test pinning response shape + clientId optionality**

Create/modify `packages/daemon/test/integration/selection.test.ts`:

```ts
import crypto from 'node:crypto'
import { describe, expect, test } from 'vitest'
// ... import createDaemonServer + test harness setup matching exchange.test.ts

describe('PUT /tabs/:tabId/selection (Slice E compat)', () => {
  test('accepts body WITH clientId, returns {selectionSeq, acceptedAt}', async () => {
    const body = {
      nodes: [validHandle],
      clientId: crypto.randomUUID(),
    }
    const res = await fetch(`${baseUrl}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rootAuthToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    expect(res.status).toBe(200)
    const parsed = await res.json()
    expect(parsed).toHaveProperty('selectionSeq')
    expect(parsed).toHaveProperty('acceptedAt')
    expect(typeof parsed.selectionSeq).toBe('number')
    expect(typeof parsed.acceptedAt).toBe('number')
  })

  test('accepts body WITHOUT clientId (Slice E made it optional)', async () => {
    const body = { nodes: [validHandle] }
    const res = await fetch(`${baseUrl}/tabs/1/selection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootAuthToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    expect(res.status).toBe(200)
  })

  test('rejects body with foreign top-level field (.strict still enforced)', async () => {
    const body = { nodes: [validHandle], foo: 1 }
    const res = await fetch(`${baseUrl}/tabs/1/selection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootAuthToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 3: Wire 401 body with reason codes**

Find where the daemon emits 401 for session-auth failure (likely in `server.ts` near the bearer check). Change the response body from `{ error: 'unauthorized' }` (or whatever it is) to a machine-parseable shape:

```ts
import { AuthErrorSchema } from '@redesigner/core/schemas'

// On extId-mismatch failure:
sendJson(res, 401, { error: 'auth', reason: 'extid-mismatch' })

// On unknown bearer (no session, no root match):
sendJson(res, 401, { error: 'auth', reason: 'token-unknown' })
```

If no clear fail-path exists today, wrap the existing auth-fail logic so both paths emit the reason codes.

- [ ] **Step 4: Wire 403 body for malformed/missing origin**

In `cors.ts` (or wherever 403 is emitted for bad origin):

```ts
// Malformed (present but not [a-p]{32}):
sendJson(res, 403, { error: 'cors', reason: 'malformed-origin' })

// Missing (expected but absent):
sendJson(res, 403, { error: 'cors', reason: 'missing-origin' })
```

- [ ] **Step 5: Add integration test pinning each reason code**

Add to `packages/daemon/test/integration/exchange.test.ts`:

```ts
test('401 body has error=auth, reason=token-unknown for bogus bearer', async () => {
  const res = await fetch(`${baseUrl}/manifest`, {
    headers: { Authorization: 'Bearer bogus-token-12345' },
  })
  expect(res.status).toBe(401)
  const body = await res.json()
  expect(body.error).toBe('auth')
  expect(body.reason).toBe('token-unknown')
})

test('403 body has error=cors, reason=malformed-origin for q-z Origin', async () => {
  const res = await fetch(`${baseUrl}/__redesigner/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
    },
    body: JSON.stringify({ clientNonce: crypto.randomUUID(), bootstrapToken: 'x' }),
  })
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toBe('cors')
  expect(body.reason).toBe('malformed-origin')
})
```

- [ ] **Step 6: Run daemon tests**

Run: `pnpm --filter @redesigner/daemon test`
Expected: all tests pass.

- [ ] **Step 7: Rebuild daemon dist**

Run: `pnpm --filter @redesigner/daemon build`

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src packages/daemon/test
git commit -m "feat(daemon): emit machine-parseable reason codes for 401/403 errors"
```

---

## Task 4: Ext rest.ts — extId header plumbing + timeoutMs threading (Slice A)

**Model:** Sonnet — straightforward plumbing, but requires test updates.
**Parallel group:** P-G1 — independent files from T2, T3.

**Files:**
- Modify: `packages/ext/src/sw/rest.ts`
- Modify: `packages/ext/test/sw/rest.test.ts`

- [ ] **Step 1: Write failing tests**

Open `packages/ext/test/sw/rest.test.ts` and add:

```ts
describe('putSelection X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({ selectionSeq: 1, acceptedAt: Date.now() }),
        { status: 200 },
      )
    })
    await putSelection({
      httpUrl: 'http://localhost:9999',
      tabId: 1,
      sessionToken: 'test-session',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
      body: { nodes: [validHandle] },
    })
    expect(capturedHeaders?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({ selectionSeq: 1, acceptedAt: Date.now() }),
        { status: 200 },
      )
    })
    await putSelection({
      httpUrl: 'http://localhost:9999',
      tabId: 1,
      sessionToken: 'test-session',
      body: { nodes: [validHandle] },
    })
    expect(capturedHeaders?.has('X-Redesigner-Ext-Id')).toBe(false)
  })

  test('threads timeoutMs through AbortSignal.timeout', async () => {
    // Mock fetch to hang; assert it aborts within the custom timeout window.
    // Use vi.useFakeTimers for deterministic timeout verification.
    // (Implementer: pick the concrete test pattern matching existing rest.test.ts fixtures)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @redesigner/ext test sw/rest`
Expected: new tests fail because `RestArgs` doesn't have `extId` yet.

- [ ] **Step 3: Extend RestArgs and makeJsonHeaders in rest.ts**

```ts
// packages/ext/src/sw/rest.ts

export interface RestArgs {
  httpUrl: string
  timeoutMs?: number
  /**
   * Chrome extension ID. Sent as X-Redesigner-Ext-Id header when defined.
   * The daemon's session-auth fallback uses this when Origin is stripped by
   * Chrome (observed as Sec-Fetch-Site: none on privileged-context fetches).
   * Required 32-char [a-p] string; not validated here (caller responsibility).
   */
  extId?: string
}

function makeJsonHeaders(bearer?: string, extId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`
  if (extId !== undefined) headers['X-Redesigner-Ext-Id'] = extId
  return headers
}
```

- [ ] **Step 4: Update putSelection to thread extId + timeoutMs through**

Find the existing `putSelection` function and update its `fetch` call site:

```ts
export async function putSelection(
  args: RestArgs & { tabId: number; sessionToken: string; body: SelectionPutBody },
): Promise<SelectionPutResponse> {
  if (!Number.isInteger(args.tabId) || args.tabId < 0) {
    throw new DaemonRestError(0, 'invalid-params', 'tabId must be a non-negative integer', null)
  }
  const url = resolveUrl(`/tabs/${args.tabId}/selection`, args.httpUrl)
  const bodyParsed = SelectionPutBodySchema.safeParse(args.body)
  if (!bodyParsed.success) {
    const detail = bodyParsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(0, 'invalid-params', detail, args.body)
  }
  const res = await doFetch(
    url,
    {
      method: 'PUT',
      credentials: 'omit',
      cache: 'no-store',
      headers: makeJsonHeaders(args.sessionToken, args.extId),   // <-- threaded
      body: JSON.stringify(args.body),
    },
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  await requireOk(res)
  const body = await readJson(res)
  const parsed = SelectionPutResponseSchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(res.status, 'invalid-response', detail, body)
  }
  return parsed.data
}
```

Apply the same `extId` threading to `postExchange` and `getHealth` for consistency, even though they'll only start using it at call sites in later tasks.

- [ ] **Step 5: Run tests to verify green**

Run: `pnpm --filter @redesigner/ext test sw/rest`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/ext/src/sw/rest.ts packages/ext/test/sw/rest.test.ts
git commit -m "feat(ext): add extId header to SW REST calls (Slice A)"
```

---

## Task 5: Ext — new `persistSelection.ts` helper (Slice B.1)

**Model:** Sonnet — new file with validation + auth + fetch plumbing. Not mechanical.
**Parallel group:** N/A — blocks T6.
**Dependencies:** T1 (core schemas), T4 (rest.ts extId arg).

**Files:**
- Create: `packages/ext/src/sw/persistSelection.ts`
- Create: `packages/ext/test/sw/persistSelection.test.ts`

- [ ] **Step 1: Write failing tests (happy path + bail cases)**

Create `packages/ext/test/sw/persistSelection.test.ts`. Key cases (see spec §Slice D testing strategy for full matrix):

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { persistSelection } from '../../src/sw/persistSelection.js'
import type { PersistSelectionDeps, TabHandshake, TabSession } from '../../src/sw/persistSelection.js'
import * as rest from '../../src/sw/rest.js'

const validHandle = {
  id: 'id1', componentName: 'Pricing',
  filePath: 'src/X.tsx', lineRange: [1, 2] as [number, number],
  domPath: 'body', parentChain: [], timestamp: 1,
}

function makeDeps(): PersistSelectionDeps {
  return {
    tabHandshakes: new Map<number, TabHandshake>(),
    tabSessions: new Map<number, TabSession>(),
    extId: 'abcdefghijklmnopabcdefghijklmnop',
  }
}

describe('persistSelection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  test('bails with warn when no handshake for tab', async () => {
    const deps = makeDeps()
    await persistSelection(1, validHandle, deps)
    expect(warnSpy).toHaveBeenCalledWith(
      '[redesigner:sw] persistSelection: no handshake for tab',
      { tabId: 1 },
    )
  })

  test('bails with warn when handle fails schema', async () => {
    const deps = makeDeps()
    deps.tabHandshakes.set(1, {
      wsUrl: 'ws://x', httpUrl: 'http://x', bootstrapToken: 't', editor: 'vscode',
      registeredAtEpochMs: Date.now(),
    })
    await persistSelection(1, { not: 'a handle' }, deps)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('handle schema mismatch'),
      expect.objectContaining({ tabId: 1 }),
    )
  })

  test('happy path: validates, ensures session, calls putSelection', async () => {
    const putSpy = vi.spyOn(rest, 'putSelection').mockResolvedValue({ selectionSeq: 1, acceptedAt: 1 })
    const deps = makeDeps()
    deps.tabHandshakes.set(1, {
      wsUrl: 'ws://x', httpUrl: 'http://localhost:9999', bootstrapToken: 'btok',
      editor: 'vscode', registeredAtEpochMs: Date.now(),
    })
    deps.tabSessions.set(1, { sessionToken: 'sess', exp: Date.now() + 600_000 })
    await persistSelection(1, validHandle, deps)
    expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({
      httpUrl: 'http://localhost:9999',
      tabId: 1,
      sessionToken: 'sess',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
      body: { nodes: [validHandle] },
      timeoutMs: 2000,
    }))
  })

  test('never rethrows when putSelection throws', async () => {
    vi.spyOn(rest, 'putSelection').mockRejectedValue(new Error('daemon down'))
    const deps = makeDeps()
    deps.tabHandshakes.set(1, {
      wsUrl: 'ws://x', httpUrl: 'http://x', bootstrapToken: 't', editor: 'vscode',
      registeredAtEpochMs: Date.now(),
    })
    deps.tabSessions.set(1, { sessionToken: 's', exp: Date.now() + 600_000 })
    await expect(persistSelection(1, validHandle, deps)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PUT failed'),
      expect.objectContaining({ message: 'daemon down', tabId: 1 }),
    )
  })

  test('never rethrows when ensureSession throws non-Error value', async () => {
    // Throw a string — tests the "non-Error" path mentioned in spec testing strategy
  })

  test('emits [redesigner:perf] log with elapsedMs + pickSeq + cold + kind', async () => {
    // Assert console.log was called with prefix '[redesigner:perf] persistSelection'
    // AND structured payload with the listed fields
  })

  test('back-to-back dispatchers both resolve; each has distinct pickSeq; each elapsedMs reflects own work', async () => {
    // See spec Slice B.2 "Unit test required" — pins concurrent dispatch independence
  })

  test('schema-divergence property: ComponentHandleSchema ⇒ SelectionPutBodySchema validity', async () => {
    // For a small generated set of valid ComponentHandles,
    // assert SelectionPutBodySchema.safeParse({nodes:[x]}).success
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (file doesn't exist yet)**

Run: `pnpm --filter @redesigner/ext test sw/persistSelection`
Expected: import fails.

- [ ] **Step 3: Create the helper**

```ts
// packages/ext/src/sw/persistSelection.ts

import { ComponentHandleSchema } from '@redesigner/core'
import { putSelection } from './rest.js'

export interface TabHandshake {
  wsUrl: string
  httpUrl: string
  bootstrapToken: string
  editor: string
  registeredAtEpochMs: number   // Date.now() at register-handler entry (Slice B.1)
}

export interface TabSession {
  sessionToken: string
  exp: number
}

export interface PersistSelectionDeps {
  tabHandshakes: Map<number, TabHandshake>
  tabSessions: Map<number, TabSession>
  extId: string   // chrome.runtime.id, injected at deps-build time
}

// SW-local monotonic dispatch counter. Seeded from Date.now() at module load.
// Masked to 24 bits — purpose is log correlation, not uniqueness.
let pickSeq: number = Date.now() & 0xffffff

const PUT_TIMEOUT_MS = 2000

export async function persistSelection(
  tabId: number,
  rawHandle: unknown,
  deps: PersistSelectionDeps,
): Promise<void> {
  const localPickSeq = ++pickSeq
  const startPerf = Date.now()

  const hs = deps.tabHandshakes.get(tabId)
  if (hs === undefined) {
    console.warn('[redesigner:sw] persistSelection: no handshake for tab', { tabId })
    // Cold-start race instrumentation: if register hasn't landed but a pick did,
    // that's the race. We don't have hs.registeredAtEpochMs so we can't compute a
    // delta — log the suspicion on-entry so operators can correlate with register events.
    console.warn('[redesigner:race] pick arrived before register', { tabId })
    return
  }

  // Cold-start race: if register JUST fired (<100ms ago) AND this is the first pick,
  // flag as a suspected race. Uses Date.now() (wall-clock, survives SW wakes).
  const deltaMs = Date.now() - hs.registeredAtEpochMs
  if (deltaMs < 100) {
    console.warn('[redesigner:race] pick within 100ms of register', { tabId, deltaMs })
  }

  const parsed = ComponentHandleSchema.safeParse(rawHandle)
  if (!parsed.success) {
    console.warn('[redesigner:sw] persistSelection: handle schema mismatch', {
      tabId,
      issues: parsed.error.issues,
    })
    return
  }
  const handle = parsed.data

  let cold = false
  try {
    const cached = deps.tabSessions.get(tabId)
    let sessionToken: string
    if (cached !== undefined && cached.exp - Date.now() > 60_000) {
      sessionToken = cached.sessionToken
    } else {
      cold = true
      // ensureSession — inline here or imported from existing helper.
      // Existing messageRouter.ts has an ensureSession helper; re-use it or extract
      // to a shared module if it doesn't live in a helper-accessible place.
      sessionToken = await ensureSession(tabId, hs, deps)
    }

    await putSelection({
      httpUrl: hs.httpUrl,
      tabId,
      sessionToken,
      extId: deps.extId,
      body: { nodes: [handle] },
      timeoutMs: PUT_TIMEOUT_MS,
    })

    const elapsedMs = Date.now() - startPerf
    console.log('[redesigner:perf] persistSelection', {
      tabId,
      pickSeq: localPickSeq,
      elapsedMs,
      kind: 'ok',
      cold,
    })
  } catch (err) {
    const elapsedMs = Date.now() - startPerf
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[redesigner:sw] persistSelection: PUT failed', { tabId, message })
    console.log('[redesigner:perf] persistSelection', {
      tabId,
      pickSeq: localPickSeq,
      elapsedMs,
      kind: 'fail',
      cold,
    })
    // NEVER rethrow — panel UX already completed in routeMessage, and the router's
    // sendResponse must run unconditionally.
  }
}

// NOTE: ensureSession currently lives in messageRouter.ts. Either:
//  (a) import it from there (introduces a cycle risk — test carefully), or
//  (b) extract to packages/ext/src/sw/ensureSession.ts and both modules import it.
// Option (b) is cleaner; implementer to assess.
async function ensureSession(
  tabId: number,
  hs: TabHandshake,
  deps: PersistSelectionDeps,
): Promise<string> {
  // See Slice B.1 "Session contract". Calls postExchange, caches in deps.tabSessions.
  // Implementation extracted from messageRouter.ts.
  throw new Error('TODO: extract ensureSession from messageRouter.ts')
}
```

- [ ] **Step 4: Extract `ensureSession` to its own module**

Create `packages/ext/src/sw/ensureSession.ts` with the function currently inline in `messageRouter.ts`. Both `messageRouter.ts` and `persistSelection.ts` import from it. Update `messageRouter.ts` to use the import.

- [ ] **Step 5: Update the persistSelection.ts stub to import ensureSession**

Replace the stub with `import { ensureSession } from './ensureSession.js'`.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @redesigner/ext test sw/persistSelection`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/ext/src/sw/persistSelection.ts packages/ext/src/sw/ensureSession.ts packages/ext/src/sw/messageRouter.ts packages/ext/test/sw/persistSelection.test.ts
git commit -m "feat(ext): add persistSelection helper with perf instrumentation + race detection"
```

---

## Task 6: Ext — wire await-in-dispatcher + registeredAtEpochMs (Slice B)

**Model:** Sonnet — modifies two existing files with careful ordering semantics.
**Parallel group:** N/A — blocks P-G2.
**Dependencies:** T5.

**Files:**
- Modify: `packages/ext/src/sw/messageRouter.ts`
- Modify: `packages/ext/src/sw/index.ts`

- [ ] **Step 1: Update `register` handler in messageRouter.ts to capture `registeredAtEpochMs`**

Find the `register` branch in `routeMessage`. When populating `tabHandshakes`:

```ts
deps.tabHandshakes.set(tabId, {
  wsUrl: m.wsUrl,
  httpUrl: m.httpUrl,
  bootstrapToken: m.bootstrapToken,
  editor: m.editor,
  registeredAtEpochMs: Date.now(),   // Slice B.1 — cold-start race instrumentation
})
```

- [ ] **Step 2: Update TabHandshake interface**

`TabHandshake` already lives in `messageRouter.ts` (exported). Add `registeredAtEpochMs: number` to the interface. `persistSelection.ts` re-exports the interface-from-messageRouter or defines its own — pick one canonical home to avoid drift.

- [ ] **Step 3: Replace `selection` branch handler with await-in-dispatcher pattern**

```ts
import { persistSelection } from './persistSelection.js'

// Inside async routeMessage(...)
if (type === 'selection') {
  const rawHandle = (msg as { handle?: unknown }).handle
  if (typeof tabId === 'number' && typeof windowId === 'number') {
    // Panel push — try/finally guarantees await persistSelection runs even if
    // push and its catch handler both throw. See spec Risk #7.
    try {
      try {
        const maybePromise = deps.panelPort.push(windowId, tabId, { selection: rawHandle ?? null })
        Promise.resolve(maybePromise).catch((err: unknown) => {
          console.warn('[redesigner:sw] panelPort.push rejected', {
            name: err instanceof Error ? err.name : 'unknown',
            message: err instanceof Error ? err.message : String(err),
          })
        })
      } catch (err) {
        console.warn('[redesigner:sw] panelPort.push threw', {
          name: err instanceof Error ? err.name : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      // Persist PUT runs unconditionally.
      // INVARIANT: total async work must stay under Chrome's 5-minute per-event cap.
      await persistSelection(tabId, rawHandle, deps)
    }
  }
  // Swallow sendResponse errors — port may have been invalidated by SW idle-termination
  // during the await. Log for triage.
  try {
    sendResponse({ ok: true })
  } catch (err) {
    console.warn('[redesigner:sw] sendResponse threw (port likely closed)', {
      tabId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return
}
```

- [ ] **Step 4: Update `sw/index.ts` to pass `extId` into deps**

```ts
// In sw/index.ts, deps construction:
const deps = {
  panelPort,
  tabHandshakes,
  tabSessions,
  extId: chrome.runtime.id,   // Slice B.1 — extId injected once, not read inside persistSelection
}
```

Update the `MessageRouterDeps` interface in messageRouter.ts to include `extId: string`.

- [ ] **Step 5: Run ext tests**

Run: `pnpm --filter @redesigner/ext test`
Expected: existing tests pass; new persistSelection + messageRouter tests pass.

- [ ] **Step 6: Verify the hydrate-regex guard in `sw/index.ts` still holds**

The top-level listener must stay non-async + `return true`. Run:

```bash
grep -A 5 "chrome.runtime.onMessage.addListener" packages/ext/src/sw/index.ts
```

Confirm no `async` before the callback and `return true` is still present.

- [ ] **Step 7: Commit**

```bash
git add packages/ext/src/sw/messageRouter.ts packages/ext/src/sw/index.ts
git commit -m "feat(ext): await persistSelection in routeMessage; track register timestamp"
```

---

## Task 7: Ext — messageRouter unit test (parallel-group P-G2)

**Model:** Haiku — test file creation, mechanical assertions.
**Parallel group:** P-G2.
**Dependencies:** T6.

**Files:**
- Create-or-modify: `packages/ext/test/sw/messageRouter.test.ts`

- [ ] **Step 1: Write tests**

```ts
// packages/ext/test/sw/messageRouter.test.ts
import { describe, expect, test, vi } from 'vitest'
import { routeMessage } from '../../src/sw/messageRouter.js'
import * as persistSelectionModule from '../../src/sw/persistSelection.js'

describe('routeMessage selection branch (Slice B)', () => {
  test('awaits persistSelection before calling sendResponse', async () => {
    let persistResolved = false
    vi.spyOn(persistSelectionModule, 'persistSelection').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      persistResolved = true
    })
    const sendResponse = vi.fn()
    const deps = makeDeps()   // helper — tabHandshakes pre-populated for tab 1
    await routeMessage(
      { type: 'selection', handle: validHandle },
      { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender,
      sendResponse,
      deps,
    )
    expect(persistResolved).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true })
    // Ordering: persist resolved BEFORE sendResponse fired
    expect(sendResponse).toHaveBeenCalledTimes(1)
  })

  test('register handler stamps registeredAtEpochMs', async () => {
    const before = Date.now()
    const deps = makeDeps()
    await routeMessage(
      {
        type: 'register',
        wsUrl: 'ws://x', httpUrl: 'http://x',
        bootstrapToken: 'btok', editor: 'vscode',
      },
      { tab: { id: 7, windowId: 1, url: 'http://example.com' } } as chrome.runtime.MessageSender,
      vi.fn(),
      deps,
    )
    const hs = deps.tabHandshakes.get(7)
    expect(hs).toBeDefined()
    expect(hs!.registeredAtEpochMs).toBeGreaterThanOrEqual(before)
    expect(hs!.registeredAtEpochMs).toBeLessThanOrEqual(Date.now())
  })

  test('throwing panelPort.push does NOT suppress persistSelection', async () => {
    const persistSpy = vi.spyOn(persistSelectionModule, 'persistSelection').mockResolvedValue()
    const deps = makeDeps()
    deps.panelPort.push = vi.fn(() => { throw new Error('panel exploded') })
    await routeMessage(
      { type: 'selection', handle: validHandle },
      { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender,
      vi.fn(),
      deps,
    )
    expect(persistSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @redesigner/ext test sw/messageRouter
git add packages/ext/test/sw/messageRouter.test.ts
git commit -m "test(ext): assert routeMessage awaits persistSelection + timestamps register"
```

---

## Task 8: Ext — static source guard for sw/index.ts listener (parallel-group P-G2)

**Model:** Haiku — pure string/regex assertions over source file.
**Parallel group:** P-G2.

**Files:**
- Create: `packages/ext/test/sw/index-listener.test.ts`

- [ ] **Step 1: Write guard**

```ts
// packages/ext/test/sw/index-listener.test.ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('sw/index.ts onMessage listener shape (static guard)', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../src/sw/index.ts'),
    'utf8',
  )

  test('onMessage addListener callback is NOT async', () => {
    // Regex: "chrome.runtime.onMessage.addListener(" followed by optional whitespace
    // then NOT the literal "async".
    const asyncListener = /chrome\.runtime\.onMessage\.addListener\(\s*async/
    expect(source).not.toMatch(asyncListener)
  })

  test('onMessage addListener is present and followed within 30 lines by return true', () => {
    const startIdx = source.indexOf('chrome.runtime.onMessage.addListener(')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    const window = source.slice(startIdx).split('\n').slice(0, 30).join('\n')
    expect(window).toMatch(/return\s+true/)
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @redesigner/ext test sw/index-listener
git add packages/ext/test/sw/index-listener.test.ts
git commit -m "test(ext): static guard preserving non-async onMessage + return true"
```

---

## Task 9: Ext rest.ts — additional header absence test (parallel-group P-G2)

**Model:** Haiku.
**Parallel group:** P-G2.

This was largely addressed in T4. If T4's test file didn't cover the `extId: undefined` absence case or timeoutMs wiring, add them now. Otherwise skip to the commit.

- [ ] Verify T4's `rest.test.ts` covers: (a) header present when extId supplied, (b) header absent when extId undefined, (c) timeoutMs threads through. Add any missing case.

---

## Task 10: MCP integration test (Slice D)

**Model:** Opus — subprocess orchestration, PID-reuse mitigation, process-group kill, StdioClientTransport assembly, test-env fixture creation. Most complex task.
**Parallel group:** N/A — runs independently of ext-internal tests but depends on T1 (core), T3 (daemon), and @redesigner/mcp built dist.
**Dependencies:** T1, T3. Requires `pnpm --filter @redesigner/mcp build` to have run before test execution.

**Files:**
- Create: `packages/mcp/test/integration/selection-roundtrip.test.ts`
- Verify: `packages/mcp/tsconfig.json` (integration tests compile)

- [ ] **Step 1: Confirm SDK exports**

Check: `packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js` exports `StdioClientTransport`. If the SDK version differs, adjust import.

- [ ] **Step 2: Write the test**

```ts
// packages/mcp/test/integration/selection-roundtrip.test.ts

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createDaemonServer } from '../../../daemon/src/server.js'
// ... plus whatever minimal RouteContext setup the existing exchange.test.ts uses

const DIST_CLI = resolve(import.meta.dirname, '../../dist/cli.js')

describe('MCP selection roundtrip (Slice D)', () => {
  let childPid: number | null = null
  let childProc: ReturnType<typeof spawn> | null = null
  let tmpProjectRoot: string | null = null
  let daemon: Awaited<ReturnType<typeof createDaemonServer>> | null = null
  let client: Client | null = null

  beforeAll(() => {
    vi.setConfig({ testTimeout: 20_000 })
    if (!existsSync(DIST_CLI) && process.env.REDESIGNER_MCP_BUILD_IN_TEST === '1') {
      // Use argv-array spawn form (never exec with string interpolation).
      const r = spawn('pnpm', ['--filter', '@redesigner/mcp', 'build'], { stdio: 'inherit' })
      // Wait synchronously (spawnSync would be cleaner — implementer to choose).
    }
  })

  // Dual guards: `exit` catches worker force-terminate (vitest #3077 — beforeExit
  // does NOT fire under tinypool kill). beforeExit catches graceful idle exit.
  const killGuard = () => {
    if (childPid === null) return
    try {
      process.kill(-childPid, 0)   // liveness probe (signal 0 = test only)
      process.kill(-childPid, 'SIGKILL')
    } catch {
      /* ESRCH — child already reaped or pid reassigned */
    }
    childPid = null
  }
  beforeAll(() => {
    process.on('beforeExit', killGuard)
    process.on('exit', killGuard)
  })
  afterAll(() => {
    process.off('beforeExit', killGuard)
    process.off('exit', killGuard)
  })

  test('get_current_selection returns handle written via daemon PUT',
    { timeout: 20_000 },
    async (ctx) => {
      if (!existsSync(DIST_CLI)) {
        ctx.skip(
          'run `pnpm --filter @redesigner/mcp build` first, or set REDESIGNER_MCP_BUILD_IN_TEST=1',
        )
      }

      try {
        // 1. Fake projectRoot with the files MCP expects.
        tmpProjectRoot = await mkdtemp(path.join(tmpdir(), 'redesigner-mcp-roundtrip-'))
        mkdirSync(path.join(tmpProjectRoot, '.redesigner'), { recursive: true })
        writeFileSync(
          path.join(tmpProjectRoot, 'package.json'),
          JSON.stringify({ name: 'fake-playground', version: '0.0.0' }),
        )
        // Stub manifest containing the component we'll PUT a selection for.
        // Matches handleSelectionPut's staleManifest check in selection.ts.
        const stubManifest = {
          version: '1',
          contentHash: 'x',
          components: {
            PricingCard: {
              name: 'PricingCard',
              filePath: 'src/components/PricingCard.tsx',
              lineRange: [1, 100],
            },
          },
        }
        writeFileSync(
          path.join(tmpProjectRoot, '.redesigner/manifest.json'),
          JSON.stringify(stubManifest),
        )

        // 2. createDaemonServer with fresh authToken on ephemeral port.
        const authToken = crypto.randomBytes(32).toString('base64url')
        const rootToken = Buffer.from(crypto.randomBytes(32))
        const bootstrapToken = crypto.randomBytes(32).toString('base64url')
        // ... construct RouteContext following exchange.test.ts pattern.
        daemon = await createDaemonServer({
          port: 0,   // ephemeral
          token: Buffer.from(authToken, 'utf8'),
          bootstrapToken: Buffer.from(bootstrapToken, 'utf8'),
          rootToken,
          ctx: /* RouteContext with manifestWatcher pointed at tmpProjectRoot/.redesigner/manifest.json */,
        })
        const addr = daemon.server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        const daemonUrl = `http://localhost:${port}`

        // 3. Write the handoff file MCP will discover. Path derivation MUST match
        //    packages/mcp/src/daemonBackend.ts resolveHandoffPath exactly. Replicate
        //    (don't import — daemonBackend.ts is internal). Use same projectRoot
        //    → same sha256-slice(0,16) → same path.
        //
        //    Platform-specific paths (match daemonBackend.ts:73-87 as of 2026-04-20):
        //      linux:   $XDG_RUNTIME_DIR (or os.tmpdir()/redesigner-<uid>) /redesigner/<hash>/daemon-v1.json
        //      darwin:  os.tmpdir()/com.redesigner.<uid>/<hash>/daemon-v1.json
        //      win32:   ($LOCALAPPDATA or ~/AppData/Local)/redesigner/<uid>/<hash>/daemon-v1.json
        //
        //    Test is likely run on linux+darwin only — implementer picks the
        //    matching branch and asserts in beforeAll that process.platform !== 'win32'
        //    (skip on win32 since full-harness integration is out of CI scope anyway).
        const realRoot = /* realpathSync of tmpProjectRoot */ tmpProjectRoot
        const projectHash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 16)
        const uid = String(process.getuid?.() ?? 'w')
        const handoffPath = process.platform === 'darwin'
          ? path.join(tmpdir(), `com.redesigner.${uid}`, projectHash, 'daemon-v1.json')
          : path.join(
              process.env.XDG_RUNTIME_DIR ?? path.join(tmpdir(), `redesigner-${uid}`),
              'redesigner', projectHash, 'daemon-v1.json',
            )
        mkdirSync(path.dirname(handoffPath), { recursive: true })
        const handoff = {
          serverVersion: '0.0.0',
          instanceId: crypto.randomUUID(),
          pid: process.pid,
          host: 'localhost',
          port,
          token: authToken,
          projectRoot: tmpProjectRoot,
        }
        writeFileSync(handoffPath, JSON.stringify(handoff))

        // 4. PUT selection with the root authToken directly (no /exchange flow).
        const selectionBody = {
          nodes: [{
            id: 'sel-1',
            componentName: 'PricingCard',
            filePath: 'src/components/PricingCard.tsx',
            lineRange: [3, 42] as [number, number],
            domPath: 'body > div',
            parentChain: ['App'],
            timestamp: Date.now(),
          }],
        }
        const putRes = await fetch(`${daemonUrl}/tabs/1/selection`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(selectionBody),
          signal: AbortSignal.timeout(3000),
        })
        expect(putRes.status).toBe(200)

        // 5. Spawn MCP ourselves (not via StdioClientTransport's internal spawn)
        //    so we own the process group + child handle.
        childProc = spawn(
          'node',
          [DIST_CLI, '--project', tmpProjectRoot],
          { detached: true, stdio: ['pipe', 'pipe', 'inherit'] },
        )
        childPid = childProc.pid ?? null
        expect(childPid).toBeTruthy()

        const transport = new StdioClientTransport({
          // Spec note: the SDK's StdioClientTransport constructor expects certain
          // stream/command shapes; implementer to adapt to the exact 1.29 API.
          // The cleanest pattern if the SDK supports it: pass already-open streams.
          // Otherwise: use the command+args form but accept that `detached` is lost;
          // in that case, rely on `once(childProc, 'exit')` reap alone (no process-group kill).
        })
        client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
        await client.connect(transport)

        // 6. Call the tool.
        const currentRes = await client.callTool({
          name: 'get_current_selection',
          arguments: {},
        })
        expect(currentRes).toBeDefined()
        // Parse the tool response content; assert the handle matches.
        const textBlock = (currentRes.content as Array<{ type: string; text?: string }>)[0]
        expect(textBlock?.type).toBe('text')
        const parsed = JSON.parse(textBlock!.text!)
        expect(parsed.componentName).toBe('PricingCard')
        expect(parsed.filePath).toBe('src/components/PricingCard.tsx')

        // 7. Call list_recent_selections.
        const recentRes = await client.callTool({
          name: 'list_recent_selections',
          arguments: { n: 10 },
        })
        // Assert in a soft-gather style so a get_current failure doesn't mask
        // list_recent output (spec Slice D note on combining asserts).
        const recentText = (recentRes.content as Array<{ type: string; text?: string }>)[0]?.text
        const recentParsed = JSON.parse(recentText ?? '[]')
        expect(recentParsed.length).toBeGreaterThanOrEqual(1)
        expect(recentParsed[0].componentName).toBe('PricingCard')

      } finally {
        try { await client?.close() } catch {}
        if (childPid !== null && childProc !== null) {
          const reaped = await Promise.race([
            once(childProc, 'exit').then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
          ])
          if (!reaped) {
            try { process.kill(-childPid, 'SIGKILL') } catch {}
          }
          childPid = null
        }
        try { daemon?.close() } catch {}
        if (tmpProjectRoot !== null) await rm(tmpProjectRoot, { recursive: true, force: true })
      }
    },
  )
})
```

- [ ] **Step 3: Ensure daemon + core + mcp are all built**

Run: `pnpm -r build`
Expected: all packages produce `dist/` artifacts.

- [ ] **Step 4: Run the integration test**

Run: `pnpm --filter @redesigner/mcp test selection-roundtrip`
Expected: test passes within 20s timeout. On failure, audit SDK transport shape — the pseudocode for transport construction depends on the SDK's exact 1.29 API.

- [ ] **Step 5: Verify no orphan mcp processes**

Run (after test): `pgrep -f 'redesigner-mcp\|dist/cli.js' || echo 'no orphans'`
Expected: `no orphans`.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/test/integration/selection-roundtrip.test.ts
git commit -m "test(mcp): end-to-end selection roundtrip via daemon + stdio client"
```

---

## Task 11: Dogfood performance script + CI fixture

**Model:** Opus — script design, methodology nuance (percentile calculation, at-most-K-of-N gate).
**Parallel group:** N/A — independent; can run anytime after T6.

**Files:**
- Create: `packages/ext/scripts/dogfood-perf.ts`
- Create: `packages/ext/test/fixtures/dogfood-perf-sample.log`
- Modify: `packages/ext/package.json` (add `dogfood:perf` script)

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
// packages/ext/scripts/dogfood-perf.ts

import { readFileSync } from 'node:fs'

interface PerfEntry {
  tabId: number
  pickSeq: number
  elapsedMs: number
  kind: 'ok' | 'fail'
  cold: boolean
}

const INPUT = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')

// Accept two formats:
//  (a) chrome.storage.session dump — a JSON array of entries
//  (b) DevTools console "Save as" — one "[redesigner:perf] persistSelection {...}" per line
function parseEntries(raw: string): PerfEntry[] {
  raw = raw.trim()
  if (raw.startsWith('[')) {
    return JSON.parse(raw) as PerfEntry[]
  }
  const lines = raw.split('\n').filter((l) => l.includes('[redesigner:perf]'))
  return lines.map((line) => {
    const braceIdx = line.indexOf('{')
    if (braceIdx === -1) throw new Error(`malformed perf line: ${line}`)
    return JSON.parse(line.slice(braceIdx)) as PerfEntry
  })
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

const entries = parseEntries(INPUT).filter((e) => e.kind === 'ok')
const warm = entries.filter((e) => !e.cold).map((e) => e.elapsedMs).sort((a, b) => a - b)
const cold = entries.filter((e) => e.cold).map((e) => e.elapsedMs).sort((a, b) => a - b)

console.log(`warm N=${warm.length}, cold N=${cold.length}`)

let failed = false

// Warm: median < 150 AND max < 500
if (warm.length >= 30) {
  const med = percentile(warm, 0.5)
  const max = warm[warm.length - 1] ?? 0
  console.log(`  warm median=${med}ms max=${max}ms p95=${percentile(warm, 0.95)}ms`)
  if (med >= 150) {
    console.error(`  FAIL: warm median ${med}ms >= 150ms`)
    failed = true
  }
  if (max >= 500) {
    console.error(`  FAIL: warm max ${max}ms >= 500ms`)
    failed = true
  }
} else {
  console.warn(`  warm sample too small (N=${warm.length} < 30) — gate skipped`)
}

// Cold: median < 1200 AND at-most-2-of-20 exceed 3000
if (cold.length >= 20) {
  const med = percentile(cold, 0.5)
  const exceedCount = cold.filter((e) => e > 3000).length
  console.log(`  cold median=${med}ms exceed-3000=${exceedCount}/${cold.length}`)
  if (med >= 1200) {
    console.error(`  FAIL: cold median ${med}ms >= 1200ms`)
    failed = true
  }
  if (exceedCount > 2) {
    console.error(`  FAIL: cold exceed-3000 ${exceedCount} > 2`)
    failed = true
  }
} else {
  console.warn(`  cold sample too small (N=${cold.length} < 20) — gate skipped`)
}

process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Create the CI fixture**

Create `packages/ext/test/fixtures/dogfood-perf-sample.log` with synthetic entries that PASS the gate. Example (abbreviated — generate 30 warm + 20 cold):

```
[redesigner:perf] persistSelection {"tabId":1,"pickSeq":1,"elapsedMs":45,"kind":"ok","cold":false}
[redesigner:perf] persistSelection {"tabId":1,"pickSeq":2,"elapsedMs":52,"kind":"ok","cold":false}
... (28 more warm with elapsedMs in 30-180 range)
[redesigner:perf] persistSelection {"tabId":1,"pickSeq":100,"elapsedMs":850,"kind":"ok","cold":true}
[redesigner:perf] persistSelection {"tabId":1,"pickSeq":101,"elapsedMs":950,"kind":"ok","cold":true}
... (18 more cold with elapsedMs in 600-1500 range, with 1-2 near 3000)
```

- [ ] **Step 3: Add npm script**

In `packages/ext/package.json`:

```json
"scripts": {
  "dogfood:perf": "tsx scripts/dogfood-perf.ts"
}
```

Add a CI-gate test that runs the script against the committed fixture:

```ts
// packages/ext/test/scripts/dogfood-perf.test.ts
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('dogfood-perf CI gate', () => {
  test('committed fixture passes the gate', () => {
    const fixture = resolve(import.meta.dirname, '../fixtures/dogfood-perf-sample.log')
    expect(() => {
      execFileSync('tsx', ['scripts/dogfood-perf.ts', fixture], {
        cwd: resolve(import.meta.dirname, '../..'),
      })
    }).not.toThrow()
  })
})
```

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @redesigner/ext test scripts/dogfood-perf
git add packages/ext/scripts packages/ext/test/fixtures packages/ext/test/scripts packages/ext/package.json
git commit -m "feat(ext): dogfood perf gate script + CI fixture"
```

---

## Task 12: CLAUDE.md doc updates

**Model:** Haiku — text updates.
**Parallel group:** Independent; anytime.

**Files:**
- Modify: `packages/mcp/CLAUDE.md`
- Modify: `packages/ext/CLAUDE.md` (document ordering-inversion quirk)

- [ ] **Step 1: `packages/mcp/CLAUDE.md` — prebuild-before-test contract**

Append (following the project's terse plain-text convention):

```
Integration tests in test/integration/ require dist/cli.js to exist before running. CI pipeline MUST run pnpm -r build before pnpm -r test. Opt-in REDESIGNER_MCP_BUILD_IN_TEST=1 triggers in-test rebuild via spawnSync (never shell exec). test/integration/selection-roundtrip.test.ts spawns the CLI as a detached child process group; PID captured for SIGKILL fallback; dual beforeExit+exit guards handle Vitest tinypool force-terminate (vitest#3077). StdioClientTransport.close() only sends SIGTERM (SDK#579); reap via once(childProc,'exit') with 1s ceiling before process-group SIGKILL.
```

- [ ] **Step 2: `packages/ext/CLAUDE.md` — known quirks section**

Append:

```
Known quirk (v0): panel↔daemon ordering inversion under rapid concurrent picks. User picks A then B within ~100ms → panel shows B (synchronous dispatch order) but daemon may settle on A (PUT arrival order, last-write-wins via selectionState.apply). Triage any "stale daemon selection" bug report against this first. Stage 2 resolves via pickSeq in meta + daemon-side reject-out-of-order.
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/CLAUDE.md packages/ext/CLAUDE.md
git commit -m "docs: prebuild-before-test contract + ordering-inversion quirk"
```

---

## Task 13: Full-repo smoke — build + test green

**Model:** Haiku — validation step.
**Parallel group:** N/A — runs after T1-T12.

- [ ] **Step 1: Full repo build**

Run: `pnpm -r build`
Expected: all packages build cleanly.

- [ ] **Step 2: Full repo test**

Run: `pnpm -r test`
Expected: all packages pass. Counts should be approximately: daemon 560+, vite 191+, ext 335+ (new persistSelection + messageRouter + index-listener tests), core +5-10 (new schema tests), mcp +1 (new integration test, skipped if dist not built — but beforeAll hint ensures build).

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck` (or per-package)
Expected: no TS errors.

- [ ] **Step 4: Biome lint/format**

Run: `pnpm -r lint`
Expected: clean. If the pre-commit hook fires, `pnpm biome check --write .` to normalize.

- [ ] **Step 5: If anything red, fix + commit**

Debug per failure. Common suspects: schema imports across core's dist boundary (rebuild core), Vitest timeout config for MCP integration (check testTimeout), or missing build dependency.

- [ ] **Step 6: If green, no separate commit needed — previous tasks already committed.**

---

## Task 14: Manual dogfood verification

**Model:** N/A — human-operated.
**Parallel group:** N/A — runs last.

**Dependencies:** T1-T13 all green.

**Prerequisites:** `fix/daemon-vite-token-sync` (PR #18) merged to main; this branch rebased on main.

- [ ] **Step 1: Start playground**

```bash
cd packages/playground
pnpm dev
```

Wait for vite + daemon startup. Note daemon URL.

- [ ] **Step 2: Load the built extension**

Open `chrome://extensions` → toggle Developer mode → "Load unpacked" → select `packages/ext/dist`.

- [ ] **Step 3: Verify register + panel wire**

Open `http://localhost:5173` (or playground's URL). Open side panel via the ext action button. Panel should render "Detected: http://localhost:5173" (from existing Task 28 wiring).

- [ ] **Step 4: Pick a component**

Trigger the picker (keyboard chord or the panel's Pick button, whichever is wired). Click on PricingCard in the playground. Panel's SelectionCard should render `PricingCard src/components/PricingCard.tsx:<line>`.

- [ ] **Step 5: Verify daemon saw the PUT**

In a separate terminal:

```bash
curl -s -H "Authorization: Bearer <authToken-from-daemon-logs>" http://localhost:<daemon-port>/selection | jq
```

Expected: JSON with `.current` matching the PricingCard handle.

- [ ] **Step 6: Run MCP and query**

```bash
pnpm --filter @redesigner/mcp exec redesigner-mcp --project $(pwd)/packages/playground &
# In another terminal, feed stdio JSON-RPC:
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_current_selection","arguments":{}}}' | pnpm --filter @redesigner/mcp exec redesigner-mcp --project $(pwd)/packages/playground
```

Expected: response with handle matching what's shown in the panel.

- [ ] **Step 7: Capture `[redesigner:perf]` logs for gate verification**

Open the SW's DevTools (chrome://extensions → inspect SW). Perform 30 warm picks (rapid clicks on visible components). Then use `chrome://serviceworker-internals` → Stop — perform 20 cold picks, each preceded by a Stop click on the SW.

Export logs via DevTools Application → Storage → Session Storage → `__redesigner_perfLog` → copy JSON.

- [ ] **Step 8: Run dogfood:perf against live data**

```bash
pbpaste > /tmp/perf-live.log
pnpm --filter @redesigner/ext run dogfood:perf /tmp/perf-live.log
```

Expected: exit 0 with warm + cold stats matching the Performance Budget.

- [ ] **Step 9: If any budget row fails, investigate + iterate**

This is expected for v0 — numbers may need tuning. The spec allows dogfood-verification to be a follow-on commit (not blocking merge per Rollout step 3/4).

- [ ] **Step 10: Push branch and open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat(ext+core+daemon+mcp): persist selection SW→daemon→MCP end-to-end" ...
```

Include in PR body: dogfood results (screenshots of SelectionCard + panel, curl output from /selection, MCP roundtrip output, dogfood:perf stats).

---

## Success Criteria (mirrors spec §Success Criteria)

- `pnpm -r run build && pnpm -r run test` green (T13).
- `pnpm --filter @redesigner/mcp test` includes `selection-roundtrip` and passes within 20s (T10).
- Manual dogfood: pick → panel → daemon → MCP roundtrip verified live (T14).
- `[redesigner:perf]` medians match Performance Budget per `dogfood:perf` script (T14 step 8).
- No regressions in daemon/exchange/vite/ext suites.
- `packages/mcp/CLAUDE.md` documents prebuild-before-test contract (T12).
- Slice F regex fix is green across daemon + vite + ext (T2).
