# Vite Plugin + Playground — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@redesigner/vite` (Vite plugin that tags rendered JSX with `data-redesigner-loc` + emits a versioned manifest) plus the `examples/playground` React 19 app, with full CI matrix (Linux + Windows × Node 20.11.0 + Node 22) and a three-tier Vitest plan.

**Architecture:** pnpm-workspace monorepo. The plugin runs an independent Babel pass at `enforce: 'pre'` (decoupled from `@vitejs/plugin-react`), builds a transform-local batch per file, and commits to a single-writer manifest aggregator using immutable-map CAS + post-flush re-check + Windows-aware atomic rename with 7-step exponential backoff. Daemon integration is optional via a dynamic `import()` of `@redesigner/daemon` with platform-aware shutdown. Three concern-layered directories: `core/` (zero-dep pure helpers), `babel/` (AST-coupled), `integration/` (stateful/IO).

**Tech Stack:** TypeScript (ESM-only), Vite 5–7, React 19, `@babel/core` + traverse + parser + types, `@vitejs/plugin-react` ^5 (peer), Vitest 2, fast-check 3, tsup 8, `ts-json-schema-generator` 2, Biome, Husky 9, simple-git-hooks 2, Corepack ≥ 0.31 + pnpm 9.15.4, Tailwind v4.

**Spec reference:** `docs/superpowers/specs/2026-04-18-vite-plugin-and-playground-design.md`

---

## Parallelism strategy

Implementation splits into six work lanes. Tasks within a lane are sequential (later tasks depend on earlier ones in the same lane). Lanes run in parallel where dependencies allow.

| Lane | Name | Depends on | Can start after |
|------|------|------------|-----------------|
| S    | Scaffold (monorepo, CI, build tooling) | — | immediately |
| A    | Core pure modules (`core/*`) | S-1 (workspace skeleton) | S-1 green |
| B    | Babel plugin + fixtures | A (core modules) | A-all green |
| C    | Integration layer (`integration/*`) | A (core modules) | A-all green |
| D    | Playground app | S-1 | S-1 green |
| E    | Plugin composition + reader + integration tests | B, C, D | B+C+D green |

**Dispatch patterns** (with `superpowers:subagent-driven-development` or `dispatching-parallel-agents`):

- **First parallel burst** (after S-1): lanes A (5 tasks), D (4 tasks), and S-2 through S-7 (CI/build tooling) run concurrently. Up to 10 parallel agents, each on an independent file.
- **Second parallel burst** (after A done): lanes B (Babel plugin) and C (integration layer) run concurrently. Up to 6 parallel agents.
- **Third burst** (after B+C+D done): lane E runs — plugin composition is serial, but the 13 integration-test tasks afterward can parallelize 3-4 at a time (each test creates its own tmpdir and is independent).
- **Serial points**: scaffolding establishes conventions; plugin composition (src/plugin.ts + src/index.ts) must wait for core+babel+integration; final CI verification must wait for everything.

The skill `superpowers:dispatching-parallel-agents` handles the agent fan-out. Use it for any task group labeled "parallel-eligible" below.

---

## Model assignment strategy

Three models, chosen by task character:

**Opus 4.7 (deep reasoning; highest capability, highest cost).** Use when the task involves novel algorithmic work, subtle race conditions, complex AST traversal, or spec interpretation where wrong design choices compound. ~20% of tasks.
- `babel/resolveEnclosingComponent.ts` — walks up the AST with memo/forwardRef unwrap + module-scope detection + HOC handling; the spec pins behavior but the walker is tricky to get right on edge cases.
- `integration/manifestWriter.ts` — CAS per-file replace, post-flush identity re-check, 7-step backoff on EPERM/EBUSY, startup tmp sweep, `.owner-lock` collision detection. Race-condition surface.
- `integration/daemonBridge.ts` — platform-branched teardown, stdin-ack handshake on Windows, SIGHUP POSIX-only, pipe drain, importer injection. Many cross-platform pitfalls.
- `.github/scripts/sync-rulesets.mjs` — GitHub REST POST/PUT/drift-check, error cases, ruleset-name lookup.
- `integration/fast-refresh.test.ts`, `integration/sourcemap.test.ts` (composed-map assertion), `integration/hmr.test.ts` — determinism requires subtle reasoning about Vite internals.

**Sonnet 4.6 (strong workhorse; middle cost).** Use when the design is pinned down and the task is "turn spec into code" with moderate complexity. ~60% of tasks.
- `core/*` modules (locFormat, pathGuards, wrapperComponents, contentHash, manifestSchema, types-public, types-internal).
- `babel/plugin.ts` (Babel visitor skeleton, wrapper skip, attribute injection).
- `integration/runtimeDetect.ts`.
- `src/plugin.ts` (Vite lifecycle composition).
- `src/index.ts` (factory + exports).
- `src/reader.ts` (reader helper).
- Fixture test cases (each fixture input/output/expected-manifest triple).
- Most integration tests (environment-skip, react-compiler, reinit, parallelism, degradation, daemon-real, hydration-safety, shutdown, manifest, vite).
- Playground edge components (React 19 cases, wrapper examples).
- CI workflow YAML.

**Haiku 4.5 (fast, cheap; lowest cost).** Use for mechanical file creation, small configs, scaffolding boilerplate. ~20% of tasks.
- `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.editorconfig`, `.gitignore` additions, `biome.json`, `tsconfig.base.json`, `tsconfig.json` per package.
- `README.md` stub, `CONTRIBUTING.md` skeleton, `FIXTURE_CHANGELOG.md` seed.
- `tsup.config.ts` (small config).
- `vitest.config.ts` + `vitest.parallelism.config.ts` + `vitest.daemon-real.config.ts`.
- Simple playground files (index.html, main.tsx, styles entry, vite-env.d.ts).
- `.github/rulesets/main-protection.json` (data file).

**Important:** model assignment is a *cost/risk* tradeoff. If Haiku's output fails an early review, promote the task to Sonnet; if Sonnet's output on a tricky file needs multiple rework passes, promote to Opus for the next similar task. Don't rigidly pre-commit — let the review pass (under `superpowers:subagent-driven-development`) inform upgrades.

---

## File structure

Files created, grouped by lane. Spec-level locations per §4 of the design spec.

### Lane S — Scaffold

```
/package.json
/pnpm-workspace.yaml
/.npmrc
/.editorconfig
/biome.json
/tsconfig.base.json
/.gitignore                         (append)
/README.md                          (rewrite — currently unrepresented)
/CONTRIBUTING.md
/.husky/pre-commit
/.github/workflows/ci.yml
/.github/workflows/sync-ruleset.yml
/.github/scripts/sync-rulesets.mjs
/.github/rulesets/main-protection.json
```

### Lane A — Core

```
/packages/vite/src/core/locFormat.ts
/packages/vite/src/core/pathGuards.ts
/packages/vite/src/core/wrapperComponents.ts
/packages/vite/src/core/contentHash.ts
/packages/vite/src/core/manifestSchema.ts
/packages/vite/src/core/types-public.ts
/packages/vite/src/core/types-internal.ts
/packages/vite/test/unit/locFormat.test.ts
/packages/vite/test/unit/pathGuards.test.ts
/packages/vite/test/unit/wrapperComponents.test.ts
/packages/vite/test/unit/contentHash.test.ts
```

### Lane B — Babel

```
/packages/vite/src/babel/plugin.ts
/packages/vite/src/babel/resolveEnclosingComponent.ts
/packages/vite/test/unit/resolveEnclosingComponent.test.ts
/packages/vite/test/fixtures/README.md
/packages/vite/test/fixtures/FIXTURE_CHANGELOG.md
/packages/vite/test/fixtures/_runner.test.ts
/packages/vite/test/fixtures/<each-case>/{input.tsx,output.tsx,expected-manifest.json,README.md}
```

### Lane C — Integration

```
/packages/vite/src/integration/runtimeDetect.ts
/packages/vite/src/integration/manifestWriter.ts
/packages/vite/src/integration/daemonBridge.ts
/packages/vite/test/unit/runtimeDetect.test.ts
/packages/vite/test/unit/manifestWriter.test.ts
/packages/vite/test/unit/daemonBridge.test.ts
```

### Lane D — Playground

```
/examples/playground/package.json
/examples/playground/tsconfig.json
/examples/playground/vite-env.d.ts
/examples/playground/vite.config.ts
/examples/playground/index.html
/examples/playground/src/main.tsx
/examples/playground/src/App.tsx
/examples/playground/src/components/{Button,PricingCard,PricingSection,Modal,DataFetcher}.tsx
/examples/playground/src/components/edge/{MemoWrapped,ForwardRefWrapped,RefAsProp,MultiComponentFile,AnonymousDefault,WithCallback,WithWrappers,WithReact19Wrappers,CloneElementDemo}.tsx
/examples/playground/src/styles/app.module.css
/examples/playground/src/styles/index.css
```

### Lane E — Plugin + reader + integration tests

```
/packages/vite/src/plugin.ts
/packages/vite/src/index.ts
/packages/vite/src/reader.ts
/packages/vite/tsup.config.ts
/packages/vite/scripts/generate-schema.ts
/packages/vite/package.json
/packages/vite/tsconfig.json
/packages/vite/test/unit/plugin.test.ts
/packages/vite/test/vitest.parallelism.config.ts
/packages/vite/test/integration/{vite,manifest,hmr,fast-refresh,environment-skip,react-compiler,sourcemap,reinit,parallelism,degradation,daemon-real,hydration-safety,shutdown}.test.ts
/packages/vite/test/fixtures/fake-packages/fake-daemon/index.js
/packages/vite/test/fixtures/fake-packages/@redesigner-test/daemon-throws/*
/packages/vite/test/fixtures/fake-packages/@redesigner-test/daemon-no-export/*
/packages/vite/test/fixtures/fake-packages/@redesigner-test/daemon-tla/*
```

---

## Phase 1 — Lane S: Monorepo scaffold

These tasks establish the workspace. Task S-1 is a serial gate; tasks S-2 through S-7 can parallelize once S-1 is merged.

### Task S-1: Root workspace + tsconfig base

**Files:**
- Create: `/package.json`
- Create: `/pnpm-workspace.yaml`
- Create: `/.npmrc`
- Create: `/.editorconfig`
- Create: `/biome.json`
- Create: `/tsconfig.base.json`
- Modify: `/.gitignore` (append)
- Create: `/README.md` (rewrite)

**Model:** Haiku 4.5. Pure scaffolding — file contents are deterministic from the spec.
**Parallelism:** Serial gate. Nothing starts until this lands.

- [ ] **Step 1: Write `/package.json`**

```json
{
  "name": "redesigner",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=20.11.0", "pnpm": ">=9.15" },
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "husky": "^9.1.7",
    "simple-git-hooks": "^2.11.1",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Write `/pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
  - 'examples/*'
```

- [ ] **Step 3: Write `/.npmrc`**

```
engine-strict=true
package-manager-strict=true
```

- [ ] **Step 4: Write `/.editorconfig`**

```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Write `/biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noFocusedTests": "error",
        "noSkippedTests": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } }
}
```

- [ ] **Step 6: Write `/tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 7: Append to `/.gitignore`**

```
dist/
coverage/
.husky/_
*.tsbuildinfo
```

- [ ] **Step 8: Write `/README.md`**

```markdown
# redesigner

Dev tool that tags React JSX elements with `data-redesigner-loc` attributes for downstream IDE / extension integration. See `docs/superpowers/specs/` for the design spec.

## Quickstart

```
corepack enable
pnpm install
pnpm -r test
```

## Invariants (read before using the plugin)

- Plugin only runs in `vite dev` (`apply: 'serve'`). `vite build` is a no-op.
- React 19 + automatic JSX runtime only.
- Wrapper components are NOT DOM-tagged: `Fragment`, `Suspense`, `ErrorBoundary` (heuristic), `Profiler`, `StrictMode`, `Activity`, `ViewTransition`, `Offscreen`.
- Module-scope JSX is attributed to a synthetic `(module)` component in the MANIFEST only. The DOM has no `data-redesigner-loc` for module-scope elements — tools should hit-test against `<App>` or deeper.
- The `ErrorBoundary` wrapper heuristic is name-only (no canonical React export exists); renaming a non-wrapper class to `ErrorBoundary` will silently skip attribute injection.
- The wrapper skip list is a closed set; React minor releases may introduce new wrappers — update the list in `core/wrapperComponents.ts` alongside React bumps.
- See `docs/superpowers/specs/2026-04-18-vite-plugin-and-playground-design.md` for the full contract.
```

- [ ] **Step 9: Install deps and verify workspace resolves**

Run:
```
corepack enable
pnpm install
pnpm -v  # expect 9.15.4
biome --version  # expect 1.9.x
```
Expected: install succeeds with no warnings about peer deps; biome resolvable via `pnpm biome`.

- [ ] **Step 10: Commit**

```
git add package.json pnpm-workspace.yaml .npmrc .editorconfig biome.json tsconfig.base.json .gitignore README.md pnpm-lock.yaml
git commit -m "scaffold: pnpm workspace + Biome + tsconfig base"
```

---

### Task S-2: Husky pre-commit + CONTRIBUTING

**Files:**
- Create: `/.husky/pre-commit`
- Create: `/CONTRIBUTING.md`
- Modify: `/package.json` (add `prepare` script)

**Model:** Haiku 4.5.
**Parallelism:** Parallel-eligible (Lane S, after S-1).

- [ ] **Step 1: Add `prepare` script to root `package.json`**

Replace the `scripts` block:
```json
"scripts": {
  "lint": "biome check .",
  "format": "biome format --write .",
  "prepare": "husky"
}
```

- [ ] **Step 2: Create `/.husky/pre-commit`**

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Block fixture updates without a changelog entry
changed=$(git diff --cached --name-only)
if echo "$changed" | grep -qE 'test/fixtures/.+/(output\.tsx|expected-manifest\.json)$'; then
  echo "$changed" | grep -q 'test/fixtures/FIXTURE_CHANGELOG.md' || {
    echo "[husky] fixture output/expected-manifest changed without FIXTURE_CHANGELOG.md entry"
    echo "        re-run with REDESIGNER_FIXTURE_UPDATE=1 and add an entry, then commit"
    exit 1
  }
fi

# Run Biome on staged files
pnpm exec biome check --staged --no-errors-on-unmatched
```

- [ ] **Step 3: `chmod +x .husky/pre-commit` via git**

```
chmod +x .husky/pre-commit
```

- [ ] **Step 4: Create `/CONTRIBUTING.md`**

```markdown
# Contributing

## Environment

1. Node ≥ 20.11.0. (We pin exactly `20.11.0` for the CI floor; Node 22 for current LTS.)
2. Enable Corepack: `corepack enable`. Corepack must be ≥ 0.31.0 (npm rotated signing keys in early 2025; older Corepack fails signature verification on modern pnpm releases). If `corepack --version` reports `0.30` or below, run `npm install -g corepack@latest`.
3. Behind a corporate proxy with MITM: set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` and, if signature verification still fails, `COREPACK_NPM_REGISTRY=https://your-mirror`.
4. `pnpm install`.

## Workflow

- Biome handles lint and format. `pnpm lint` / `pnpm format`.
- Tests: `pnpm -r test`. Parallelism-sensitive tests: `pnpm --filter @redesigner/vite run test:parallelism`.
- Fixtures: `pnpm --filter @redesigner/vite run test:fixtures`. To regenerate a fixture output, set `REDESIGNER_FIXTURE_UPDATE=1` AND add a line to `packages/vite/test/fixtures/FIXTURE_CHANGELOG.md` describing the change. The pre-commit hook blocks commits that change fixture files without the changelog.
- We use either Husky (default) or simple-git-hooks. If Husky is undesirable, delete `.husky/` and add the hook via `simple-git-hooks` — see its README; the hook body in `.husky/pre-commit` is portable.

## CI

- Branch protection on `main` is enforced by a committed GitHub ruleset (`.github/rulesets/main-protection.json`) synced by the `sync-ruleset.yml` workflow. Maintainers on `main` drive the sync — fork PRs cannot modify the ruleset (the sync workflow has a fork-execution guard).
- The required status check is the stable `ci / all-green` summary job — not a matrix-label-coupled name.
```

- [ ] **Step 5: Verify `prepare` installs hooks**

Run: `pnpm install`
Expected: `.husky/_/` directory appears (husky internal); `git config --get core.hooksPath` returns `.husky`.

- [ ] **Step 6: Commit**

```
git add .husky/pre-commit CONTRIBUTING.md package.json
git commit -m "scaffold: husky pre-commit hook + CONTRIBUTING.md"
```

---

### Task S-3: CI workflow

**Files:**
- Create: `/.github/workflows/ci.yml`

**Model:** Sonnet 4.6. YAML is mechanical but the Corepack preflight + Defender ordering + cache-key rules have real content.
**Parallelism:** Parallel-eligible.

- [ ] **Step 1: Write `/.github/workflows/ci.yml` (full content verbatim from spec §4.3)**

```yaml
name: ci
on: [push, pull_request]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2022]
        node: ['20.11.0', '22']
    runs-on: ${{ matrix.os }}
    steps:
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
          V=$(corepack --version || echo "0.0")
          MAJOR=$(echo "$V" | cut -d. -f1)
          MINOR=$(echo "$V" | cut -d. -f2)
          if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 31 ]; then
            echo "Corepack $V below 0.31.0 — upgrading"
            npm install -g corepack@latest
          fi
          corepack enable pnpm
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
      - name: Per-directory non-empty assertion
        shell: bash
        run: |
          for dir in packages/vite/test/unit packages/vite/test/fixtures packages/vite/test/integration; do
            count=$(find "$dir" -name '*.test.ts' | wc -l)
            if [ "$count" -lt 1 ]; then echo "$dir has no .test.ts files"; exit 1; fi
          done
      - name: Upload failure artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: failure-${{ matrix.os }}-${{ matrix.node }}
          path: |
            packages/vite/test/**/*.log
            **/.redesigner/manifest.json*

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

- [ ] **Step 2: Validate with `actionlint` if available (optional)**

Run: `actionlint .github/workflows/ci.yml` if `actionlint` is installed.
Expected: no errors. (Missing actionlint is not a blocker — syntax will be validated on the first push to a branch.)

- [ ] **Step 3: Commit**

```
git add .github/workflows/ci.yml
git commit -m "ci: add matrix workflow (Ubuntu 24.04 + Windows Server 2022 × Node 20.11.0 + 22)"
```

---

### Task S-4: Ruleset JSON + sync workflow + sync script

**Files:**
- Create: `/.github/rulesets/main-protection.json`
- Create: `/.github/workflows/sync-ruleset.yml`
- Create: `/.github/scripts/sync-rulesets.mjs`

**Model:** Opus 4.7 for `sync-rulesets.mjs` (GitHub REST edge cases: POST vs PUT by name, drift-check diffing, error handling). Sonnet 4.6 for the YAML. Haiku 4.5 for the JSON data file.
**Parallelism:** Parallel-eligible.

- [ ] **Step 1: Write `/.github/rulesets/main-protection.json`**

```json
{
  "name": "main-branch-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "ci / all-green", "integration_id": null }
        ]
      }
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ],
  "bypass_actors": []
}
```

- [ ] **Step 2: Write `/.github/workflows/sync-ruleset.yml`**

Replace `OWNER_PLACEHOLDER` below with the actual GitHub org/user when the repo is published:

```yaml
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

- [ ] **Step 3: Write `/.github/scripts/sync-rulesets.mjs`**

```js
#!/usr/bin/env node
// Syncs committed ruleset JSON to GitHub via REST.
// Usage: node sync-rulesets.mjs --mode=sync|drift-check
// Requires: GH_TOKEN env (PAT with repo scope; GITHUB_TOKEN cannot modify rulesets).

import { readFile, readdir } from 'node:fs/promises'
import { argv, env, exit } from 'node:process'

const mode = argv.find((a) => a.startsWith('--mode='))?.slice(7) || 'sync'
if (!['sync', 'drift-check'].includes(mode)) {
  console.error(`unknown --mode=${mode}`)
  exit(2)
}

const repo = env.GITHUB_REPOSITORY
if (!repo) { console.error('GITHUB_REPOSITORY unset'); exit(2) }
const token = env.GH_TOKEN
if (!token) { console.error('GH_TOKEN unset (need PAT with repo scope)'); exit(2) }

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const rulesetFiles = (await readdir('.github/rulesets')).filter((f) => f.endsWith('.json'))
let failed = false

for (const file of rulesetFiles) {
  const committed = JSON.parse(await readFile(`.github/rulesets/${file}`, 'utf8'))

  // List existing rulesets; match by name.
  const listRes = await api(`/repos/${repo}/rulesets`)
  if (!listRes.ok) { console.error(`list rulesets failed: ${listRes.status}`); exit(1) }
  const existing = (await listRes.json()).find((r) => r.name === committed.name)

  if (mode === 'drift-check') {
    if (!existing) { console.error(`drift: ${committed.name} not present on server`); failed = true; continue }
    // Fetch full ruleset (list endpoint omits rules details).
    const fullRes = await api(`/repos/${repo}/rulesets/${existing.id}`)
    if (!fullRes.ok) { console.error(`fetch ${existing.id} failed: ${fullRes.status}`); failed = true; continue }
    const live = await fullRes.json()
    const { id: _id, node_id: _nid, source: _src, source_type: _st, _links, created_at: _ca, updated_at: _ua, ...liveCmp } = live
    if (JSON.stringify(liveCmp) !== JSON.stringify(committed)) {
      console.error(`drift: ${committed.name} differs from committed JSON`)
      console.error(`diff (committed vs live): run \`gh api /repos/${repo}/rulesets/${existing.id}\` and compare`)
      failed = true
    } else {
      console.log(`ok: ${committed.name}`)
    }
    continue
  }

  // mode === 'sync'
  if (existing) {
    const res = await api(`/repos/${repo}/rulesets/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(committed),
    })
    if (!res.ok) { console.error(`PUT ${existing.id} failed: ${res.status} ${await res.text()}`); exit(1) }
    console.log(`updated: ${committed.name} (id ${existing.id})`)
  } else {
    const res = await api(`/repos/${repo}/rulesets`, { method: 'POST', body: JSON.stringify(committed) })
    if (!res.ok) { console.error(`POST failed: ${res.status} ${await res.text()}`); exit(1) }
    const { id } = await res.json()
    console.log(`created: ${committed.name} (id ${id})`)
  }
}

if (failed) exit(1)
```

- [ ] **Step 4: Quick syntax validation**

Run: `node --check .github/scripts/sync-rulesets.mjs`
Expected: exits 0 (no syntax errors).

- [ ] **Step 5: Commit**

```
git add .github/rulesets/main-protection.json .github/workflows/sync-ruleset.yml .github/scripts/sync-rulesets.mjs
git commit -m "ci: add committed ruleset + sync workflow + drift-check script"
```

---

## Phase 2 — Lane A: Core pure modules

After S-1 lands, all Lane A tasks can run **in parallel**. Each produces 1 source file + 1 test file. Dispatch five agents.

### Task A-1: `core/locFormat.ts` (+ fast-check)

**Files:**
- Create: `/packages/vite/src/core/locFormat.ts`
- Create: `/packages/vite/test/unit/locFormat.test.ts`

**Model:** Sonnet 4.6. Small, pinned design; fast-check property is a standard pattern.
**Parallelism:** Lane A — parallel with A-2..A-5.

- [ ] **Step 1: Write the failing tests**

Create `/packages/vite/test/unit/locFormat.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { formatLoc, parseLoc } from '../../src/core/locFormat'

describe('formatLoc / parseLoc', () => {
  it('roundtrips simple input', () => {
    const s = formatLoc('src/components/Button.tsx', 12, 4)
    expect(s).toBe('src/components/Button.tsx:12:4')
    expect(parseLoc(s)).toEqual({ filePath: 'src/components/Button.tsx', line: 12, col: 4 })
  })

  it('rejects backslash in filePath', () => {
    expect(() => formatLoc('src\\x.tsx', 1, 1)).toThrow(/posix separator/)
  })

  it('rejects drive-letter prefix', () => {
    expect(() => formatLoc('C:/x.tsx', 1, 1)).toThrow(/drive letter|absolute/)
  })

  it('parses unicode filenames', () => {
    const s = 'src/🎉/Button.tsx:1:1'
    expect(parseLoc(s)).toEqual({ filePath: 'src/🎉/Button.tsx', line: 1, col: 1 })
  })

  it('property: parseLoc(formatLoc(p, l, c)) roundtrips', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/[\r\n\x00-\x1f]/.test(s) && !s.includes('\\') && !/^[A-Za-z]:/.test(s)),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (p, l, c) => {
          const formatted = formatLoc(p, l, c)
          const parsed = parseLoc(formatted)
          expect(parsed).toEqual({ filePath: p, line: l, col: c })
        },
      ),
      { numRuns: 200 },
    )
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @redesigner/vite exec vitest run test/unit/locFormat.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `/packages/vite/src/core/locFormat.ts`**

```ts
export interface ParsedLoc {
  filePath: string
  line: number
  col: number
}

const DRIVE_LETTER = /^[A-Za-z]:/

export function formatLoc(filePath: string, line: number, col: number): string {
  if (filePath.includes('\\')) {
    throw new Error(`[redesigner] filePath must use posix separators, got: ${filePath}`)
  }
  if (DRIVE_LETTER.test(filePath)) {
    throw new Error(`[redesigner] filePath must not have drive letter prefix, got: ${filePath}`)
  }
  return `${filePath}:${line}:${col}`
}

export function parseLoc(s: string): ParsedLoc {
  // Parse from the RIGHT — filePath may contain colons in exotic FS; last two `:` segments are line:col.
  const lastColon = s.lastIndexOf(':')
  const secondLastColon = s.lastIndexOf(':', lastColon - 1)
  if (lastColon < 0 || secondLastColon < 0) {
    throw new Error(`[redesigner] malformed loc: ${s}`)
  }
  const filePath = s.slice(0, secondLastColon)
  const line = Number(s.slice(secondLastColon + 1, lastColon))
  const col = Number(s.slice(lastColon + 1))
  if (!Number.isFinite(line) || !Number.isFinite(col)) {
    throw new Error(`[redesigner] malformed loc (non-numeric line/col): ${s}`)
  }
  return { filePath, line, col }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @redesigner/vite exec vitest run test/unit/locFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/vite/src/core/locFormat.ts packages/vite/test/unit/locFormat.test.ts
git commit -m "feat(core): locFormat + fast-check roundtrip"
```

---

### Task A-2: `core/pathGuards.ts`

**Files:**
- Create: `/packages/vite/src/core/pathGuards.ts`
- Create: `/packages/vite/test/unit/pathGuards.test.ts`

**Model:** Sonnet 4.6. Small normalization logic + Windows path handling.
**Parallelism:** Lane A — parallel.

- [ ] **Step 1: Write the failing tests** — `/packages/vite/test/unit/pathGuards.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { toPosixProjectRoot, toPosixRelative, rejectEscapingPath } from '../../src/core/pathGuards'

describe('toPosixProjectRoot', () => {
  it('normalizes Windows-native path with backslashes', () => {
    expect(toPosixProjectRoot('C:\\Users\\dev\\proj')).toBe('C:/Users/dev/proj')
  })
  it('passes posix unchanged', () => {
    expect(toPosixProjectRoot('/home/dev/proj')).toBe('/home/dev/proj')
  })
  it('throws on unnormalizable input', () => {
    expect(() => toPosixProjectRoot('')).toThrow(/empty/)
  })
})

describe('toPosixRelative', () => {
  it('produces posix relative path', () => {
    expect(toPosixRelative('C:/proj/src/x.tsx', 'C:/proj')).toBe('src/x.tsx')
  })
  it('produces posix relative on posix', () => {
    expect(toPosixRelative('/proj/src/x.tsx', '/proj')).toBe('src/x.tsx')
  })
})

describe('rejectEscapingPath', () => {
  it('rejects absolute path', () => {
    expect(() => rejectEscapingPath('/abs/path', '/proj')).toThrow(/absolute/)
  })
  it('rejects ../ escape', () => {
    expect(() => rejectEscapingPath('../elsewhere/x.json', '/proj')).toThrow(/escapes/)
  })
  it('accepts valid relative inside root', () => {
    expect(() => rejectEscapingPath('.redesigner/manifest.json', '/proj')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter @redesigner/vite exec vitest run test/unit/pathGuards.test.ts`

- [ ] **Step 3: Write `/packages/vite/src/core/pathGuards.ts`**

```ts
import path from 'node:path'

export function toPosixProjectRoot(raw: string): string {
  if (!raw) throw new Error('[redesigner] projectRoot must be non-empty')
  return raw.replace(/\\/g, '/')
}

export function toPosixRelative(absFile: string, projectRoot: string): string {
  const rel = path.posix.relative(toPosixProjectRoot(projectRoot), toPosixProjectRoot(absFile))
  if (rel.includes('\\')) {
    throw new Error(`[redesigner] path normalization produced backslash (plugin bug): ${rel}`)
  }
  return rel
}

export function rejectEscapingPath(relOrAbs: string, projectRoot: string): void {
  if (path.isAbsolute(relOrAbs)) {
    throw new Error(`[redesigner] path must be relative to projectRoot, got absolute: ${relOrAbs}`)
  }
  const resolved = path.posix.resolve(toPosixProjectRoot(projectRoot), relOrAbs)
  const rootPosix = toPosixProjectRoot(projectRoot)
  if (!resolved.startsWith(`${rootPosix}/`) && resolved !== rootPosix) {
    throw new Error(`[redesigner] path escapes projectRoot: ${relOrAbs}`)
  }
}
```

- [ ] **Step 4: Run — PASS**. Run the test command again.

- [ ] **Step 5: Commit**

```
git add packages/vite/src/core/pathGuards.ts packages/vite/test/unit/pathGuards.test.ts
git commit -m "feat(core): pathGuards (posix normalize, escape guard)"
```

---

### Task A-3: `core/wrapperComponents.ts`

**Files:**
- Create: `/packages/vite/src/core/wrapperComponents.ts`
- Create: `/packages/vite/test/unit/wrapperComponents.test.ts`

**Model:** Sonnet 4.6.
**Parallelism:** Lane A — parallel.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { isReactWrapperName, WRAPPER_NAMES } from '../../src/core/wrapperComponents'

describe('isReactWrapperName', () => {
  it.each([
    'Fragment',
    'Suspense',
    'Profiler',
    'StrictMode',
    'Activity',
    'ViewTransition',
    'Offscreen',
    'ErrorBoundary',
  ])('identifies %s as wrapper', (name) => {
    expect(isReactWrapperName(name)).toBe(true)
  })

  it('does not flag arbitrary user names', () => {
    expect(isReactWrapperName('Button')).toBe(false)
    expect(isReactWrapperName('MyErrorHandler')).toBe(false)
  })

  it('flags React.Fragment (dotted form)', () => {
    expect(isReactWrapperName('React.Fragment')).toBe(true)
  })

  it('exports WRAPPER_NAMES for visitor use', () => {
    expect(WRAPPER_NAMES).toContain('Suspense')
  })
})
```

- [ ] **Step 2: FAIL.** Step 3: Implement.

```ts
// React built-ins that warn on unknown host-attr props.
// ErrorBoundary is a userland heuristic (no canonical React export) — name-only match.
// Update this list when React minor releases introduce new non-host wrapper components.
export const WRAPPER_NAMES: readonly string[] = Object.freeze([
  'Fragment',
  'React.Fragment',
  'Suspense',
  'Profiler',
  'StrictMode',
  'Activity',        // React 19.2
  'ViewTransition',  // React 19.2
  'Offscreen',       // legacy alias for Activity
  'ErrorBoundary',   // userland heuristic
])

const WRAPPER_SET = new Set(WRAPPER_NAMES)

export function isReactWrapperName(name: string): boolean {
  return WRAPPER_SET.has(name)
}
```

- [ ] **Step 4: PASS.** Step 5: Commit.
```
git add packages/vite/src/core/wrapperComponents.ts packages/vite/test/unit/wrapperComponents.test.ts
git commit -m "feat(core): wrapperComponents skip list (React 19.2 + ErrorBoundary heuristic)"
```

---

### Task A-4: `core/contentHash.ts`

**Files:**
- Create: `/packages/vite/src/core/contentHash.ts`
- Create: `/packages/vite/test/unit/contentHash.test.ts`

**Model:** Sonnet 4.6. Canonical serialization is spec-pinned; deterministic.
**Parallelism:** Lane A — parallel.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { computeContentHash, canonicalize } from '../../src/core/contentHash'

const baseManifest = () => ({
  schemaVersion: '1.0' as const,
  framework: 'react',
  generatedAt: new Date(0).toISOString(),
  contentHash: '',
  components: {},
  locs: {},
})

describe('canonicalize', () => {
  it('sorts object keys at every level', () => {
    const s = canonicalize({ b: 1, a: { z: 2, y: 1 } })
    expect(s).toBe('{"a":{"y":1,"z":2},"b":1}')
  })
  it('produces UTF-8 bytes with no trailing newline', () => {
    expect(canonicalize({ x: '🎉' }).endsWith('\n')).toBe(false)
  })
})

describe('computeContentHash', () => {
  it('excludes generatedAt and contentHash from hash', () => {
    const m1 = { ...baseManifest(), generatedAt: '2020-01-01T00:00:00.000Z', contentHash: 'foo' }
    const m2 = { ...baseManifest(), generatedAt: '2099-12-31T23:59:59.000Z', contentHash: 'bar' }
    expect(computeContentHash(m1)).toBe(computeContentHash(m2))
  })
  it('property: key-order in components does not change hash', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.record({
          filePath: fc.string({ minLength: 1 }),
          exportKind: fc.constantFrom('default', 'named'),
          lineRange: fc.tuple(fc.nat(), fc.nat()),
          displayName: fc.string({ minLength: 1 }),
        }), { minKeys: 1, maxKeys: 5 }),
        (components) => {
          const entries = Object.entries(components)
          const shuffled = Object.fromEntries([...entries].reverse())
          const h1 = computeContentHash({ ...baseManifest(), components })
          const h2 = computeContentHash({ ...baseManifest(), components: shuffled })
          expect(h1).toBe(h2)
        },
      ),
      { numRuns: 100 },
    )
  })
})
```

- [ ] **Step 2: FAIL.** Step 3: Implement.

```ts
import { createHash } from 'node:crypto'
import type { Manifest } from './types-public'

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function computeContentHash(manifest: Manifest): string {
  const { components, locs } = manifest
  const canonical = canonicalize({ components, locs })
  const bytes = new TextEncoder().encode(canonical)
  return createHash('sha256').update(bytes).digest('hex')
}
```

- [ ] **Step 4: PASS. Step 5: Commit.**

```
git add packages/vite/src/core/contentHash.ts packages/vite/test/unit/contentHash.test.ts
git commit -m "feat(core): contentHash with canonical serialization (sorted keys, no whitespace, UTF-8)"
```

---

### Task A-5: `core/types-public.ts` + `types-internal.ts` + `manifestSchema.ts`

**Files:**
- Create: `/packages/vite/src/core/types-public.ts`
- Create: `/packages/vite/src/core/types-internal.ts`
- Create: `/packages/vite/src/core/manifestSchema.ts`

**Model:** Sonnet 4.6. Types are pinned; schema module just re-exports.
**Parallelism:** Lane A — parallel.

- [ ] **Step 1: Write `/packages/vite/src/core/types-public.ts`**

```ts
/** @see §6.6 of the design spec; @redesigner/vite/reader implements the algorithm. */
export type SchemaVersion = `${number}.${number}`

export interface Manifest {
  schemaVersion: SchemaVersion
  /**
   * Framework identifier. Today: 'react'. Additive new values are a MINOR bump and
   * require accompanying framework-specific record fields (today's are React-shaped).
   */
  framework: string
  /** Human-readable wall clock. Consumers wanting change-detection use contentHash. */
  generatedAt: string
  /**
   * sha256 over the serialized `{components, locs}` subset (excluding generatedAt + contentHash).
   * Canonical: UTF-8, sorted keys at every level, `','` + `':'` separators, no whitespace, no trailing newline.
   */
  contentHash: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface ComponentRecord {
  filePath: string
  exportKind: 'default' | 'named'
  lineRange: [number, number]
  displayName: string
}

export interface LocRecord {
  /** Stable join key. Format `<filePath>::<componentName>`. componentName may NOT contain `::`. */
  componentKey: string
  filePath: string
  componentName: string
}

export interface DaemonOptions {
  mode?: 'auto' | 'required' | 'off'
  port?: number
}

export interface RedesignerOptions {
  manifestPath?: string
  include?: string[]
  exclude?: string[]
  enabled?: boolean
  daemon?: DaemonOptions | 'auto' | 'required' | 'off'
}
```

- [ ] **Step 2: Write `/packages/vite/src/core/types-internal.ts`**

```ts
import type { ComponentRecord, LocRecord } from './types-public'

export interface PerFileBatch {
  filePath: string
  components: Record<string, ComponentRecord>
  locs: Record<string, LocRecord>
}

export interface WriterState {
  byFile: Map<string, PerFileBatch>
}

export interface WriterInternals {
  /** Promise resolving once the given flush sequence has landed on disk. */
  onFlush(seq: number): Promise<void>
  /** Forces a flush and resolves after it lands. Decoupled from debounce timing. */
  quiesce(): Promise<void>
  /** Forces a flush ignoring debounce; test-only seam. */
  forceFlush(): Promise<void>
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}
```

- [ ] **Step 3: Write `/packages/vite/src/core/manifestSchema.ts`**

```ts
// Re-export types for the generator. ts-json-schema-generator reads this as its root.
export type { Manifest, ComponentRecord, LocRecord, DaemonOptions, RedesignerOptions, SchemaVersion } from './types-public'
```

- [ ] **Step 4: Typecheck (add typecheck script in later task; for now skip).**

- [ ] **Step 5: Commit**

```
git add packages/vite/src/core/types-public.ts packages/vite/src/core/types-internal.ts packages/vite/src/core/manifestSchema.ts
git commit -m "feat(core): types-public, types-internal, manifestSchema root"
```

---

## Phase 3 — Lane B: Babel plugin + fixtures

Starts after Lane A complete. B-1 (resolveEnclosingComponent) is the trickiest file. B-2 (Babel visitor) depends on it. Fixtures (B-3 through B-8) depend on both but can parallelize among themselves.

### Task B-1: `babel/resolveEnclosingComponent.ts`

**Files:**
- Create: `/packages/vite/src/babel/resolveEnclosingComponent.ts`
- Create: `/packages/vite/test/unit/resolveEnclosingComponent.test.ts`

**Model:** **Opus 4.7.** AST walker with many edge cases (memo, forwardRef unwrap, arrow consts, class components, JSX in callbacks, module-scope). Getting this wrong cascades into every fixture.
**Parallelism:** Lane B gate — must complete before B-2.

- [ ] **Step 1: Write unit tests (cover every edge case)**

Create `/packages/vite/test/unit/resolveEnclosingComponent.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import * as parser from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { resolveEnclosingComponent } from '../../src/babel/resolveEnclosingComponent'

function findFirstJSX(code: string): NodePath<t.JSXOpeningElement> {
  const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  let found: NodePath<t.JSXOpeningElement> | null = null
  traverse(ast, {
    JSXOpeningElement(p) { if (!found) found = p },
  })
  if (!found) throw new Error('no JSX in fixture')
  return found
}

describe('resolveEnclosingComponent', () => {
  it('default export function component', () => {
    const p = findFirstJSX(`export default function Button() { return <div /> }`)
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toEqual({
      componentName: 'Button', exportKind: 'default', lineRange: [1, 1],
    })
  })

  it('named export function component', () => {
    const p = findFirstJSX(`export function Button() { return <div /> }`)
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toEqual({
      componentName: 'Button', exportKind: 'named', lineRange: [1, 1],
    })
  })

  it('arrow const component', () => {
    const p = findFirstJSX(`export const Button = () => <div />`)
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toMatchObject({ componentName: 'Button', exportKind: 'named' })
  })

  it('memo-wrapped', () => {
    const p = findFirstJSX(`import {memo} from 'react'\nconst Button = memo(() => <div />)\nexport default Button`)
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toMatchObject({ componentName: 'Button' })
  })

  it('legacy forwardRef-wrapped', () => {
    const p = findFirstJSX(`import {forwardRef} from 'react'\nconst Input = forwardRef((p, ref) => <input ref={ref} />)\nexport default Input`)
    expect(resolveEnclosingComponent(p, 'src/Input.tsx')).toMatchObject({ componentName: 'Input' })
  })

  it('ref-as-prop (React 19 idiom)', () => {
    const p = findFirstJSX(`export function Input({ref}) { return <input ref={ref} /> }`)
    expect(resolveEnclosingComponent(p, 'src/Input.tsx')).toMatchObject({ componentName: 'Input' })
  })

  it('anonymous default export → PascalCase filename', () => {
    const p = findFirstJSX(`export default () => <div />`)
    expect(resolveEnclosingComponent(p, 'src/my-widget.tsx')).toMatchObject({ componentName: 'MyWidget' })
  })

  it('JSX in callback → attribute to outer component', () => {
    const p = findFirstJSX(`export function List() { return [1,2].map(n => <li>{n}</li>) }`)
    // The FIRST jsx opening is <li>; it should be attributed to List.
    expect(resolveEnclosingComponent(p, 'src/List.tsx')).toMatchObject({ componentName: 'List' })
  })

  it('JSX at module scope → (module) synthetic', () => {
    const p = findFirstJSX(`import {createRoot} from 'react-dom/client'\ncreateRoot(x).render(<App />)`)
    expect(resolveEnclosingComponent(p, 'src/main.tsx')).toMatchObject({ componentName: '(module)' })
  })

  it('class component', () => {
    const p = findFirstJSX(`export class Modal extends React.Component { render() { return <div /> } }`)
    expect(resolveEnclosingComponent(p, 'src/Modal.tsx')).toMatchObject({ componentName: 'Modal' })
  })

  it('third-party HOC → assignment-target name (NOT unwrapped)', () => {
    const p = findFirstJSX(`const StyledButton = styled(Button)\nconst X = () => <StyledButton />`)
    expect(resolveEnclosingComponent(p, 'src/x.tsx')).toMatchObject({ componentName: 'X' })
  })
})
```

- [ ] **Step 2: FAIL.** Run: `pnpm --filter @redesigner/vite exec vitest run test/unit/resolveEnclosingComponent.test.ts`

- [ ] **Step 3: Write `/packages/vite/src/babel/resolveEnclosingComponent.ts`**

```ts
import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'

export interface EnclosingComponent {
  componentName: string
  exportKind: 'default' | 'named'
  lineRange: [number, number]
}

const MEMO_NAMES = new Set(['memo', 'React.memo'])
const FORWARDREF_NAMES = new Set(['forwardRef', 'React.forwardRef'])

function callName(expr: t.Expression | t.V8IntrinsicIdentifier): string | null {
  if (t.isIdentifier(expr)) return expr.name
  if (t.isMemberExpression(expr) && t.isIdentifier(expr.object) && t.isIdentifier(expr.property)) {
    return `${expr.object.name}.${expr.property.name}`
  }
  return null
}

function unwrap(node: t.Expression): t.Expression {
  if (t.isCallExpression(node)) {
    const name = callName(node.callee as t.Expression)
    if (name && (MEMO_NAMES.has(name) || FORWARDREF_NAMES.has(name)) && node.arguments.length > 0) {
      const first = node.arguments[0]
      if (t.isExpression(first)) return unwrap(first)
    }
  }
  return node
}

function pascalFromFile(relPath: string): string {
  const base = relPath.split('/').pop() ?? 'Unknown'
  const name = base.replace(/\.[jt]sx?$/, '')
  return name
    .split(/[-_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('')
}

function isComponentIdentifier(name: string): boolean {
  return /^[A-Z]/.test(name)
}

export function resolveEnclosingComponent(
  path: NodePath<t.JSXOpeningElement | t.JSXFragment | t.JSXElement>,
  relPath: string,
): EnclosingComponent {
  // Walk up looking for: class component, function declaration (capitalized),
  // variable declarator (capitalized) assigned to a (possibly wrapped) function/arrow.
  let cur: NodePath | null = path.parentPath
  while (cur) {
    const node = cur.node

    // ClassDeclaration
    if (t.isClassDeclaration(node) && node.id && isComponentIdentifier(node.id.name)) {
      const exportKind =
        t.isExportDefaultDeclaration(cur.parent) ? 'default' :
        t.isExportNamedDeclaration(cur.parent) ? 'named' : 'named'
      return {
        componentName: node.id.name,
        exportKind,
        lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
      }
    }

    // FunctionDeclaration
    if (t.isFunctionDeclaration(node) && node.id && isComponentIdentifier(node.id.name)) {
      const exportKind =
        t.isExportDefaultDeclaration(cur.parent) ? 'default' :
        t.isExportNamedDeclaration(cur.parent) ? 'named' : 'named'
      return {
        componentName: node.id.name,
        exportKind,
        lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
      }
    }

    // VariableDeclarator with arrow/function initializer (may be wrapped in memo/forwardRef)
    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      isComponentIdentifier(node.id.name) &&
      node.init
    ) {
      const unwrapped = unwrap(node.init)
      if (t.isArrowFunctionExpression(unwrapped) || t.isFunctionExpression(unwrapped)) {
        const declParent = cur.parentPath?.parentPath
        const exportKind =
          declParent?.isExportDefaultDeclaration() ? 'default' :
          declParent?.isExportNamedDeclaration() ? 'named' : 'named'
        return {
          componentName: node.id.name,
          exportKind,
          lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
        }
      }
    }

    // export default <expr> where expr is an anonymous arrow/function or memo(...)/forwardRef(...) of anonymous
    if (t.isExportDefaultDeclaration(node)) {
      const decl = node.declaration
      if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        return {
          componentName: pascalFromFile(relPath),
          exportKind: 'default',
          lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
        }
      }
      if (t.isCallExpression(decl)) {
        const unwrapped = unwrap(decl)
        if (t.isArrowFunctionExpression(unwrapped) || t.isFunctionExpression(unwrapped)) {
          return {
            componentName: pascalFromFile(relPath),
            exportKind: 'default',
            lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
          }
        }
      }
    }

    cur = cur.parentPath
  }

  // Module scope
  return {
    componentName: '(module)',
    exportKind: 'named',
    lineRange: [path.node.loc?.start.line ?? 0, path.node.loc?.end.line ?? 0],
  }
}
```

- [ ] **Step 4: PASS.** Iterate on failing cases (this is the task most likely to need several rounds).

- [ ] **Step 5: Commit**

```
git add packages/vite/src/babel/resolveEnclosingComponent.ts packages/vite/test/unit/resolveEnclosingComponent.test.ts
git commit -m "feat(babel): enclosing-component resolver (memo/forwardRef unwrap, ref-as-prop, module-scope)"
```

---

### Task B-2: `babel/plugin.ts` (visitor + wrapper skip + batch commit)

**Files:**
- Create: `/packages/vite/src/babel/plugin.ts`

**Model:** Sonnet 4.6. Visitor skeleton + per-case try/catch + attribute injection. Well-specified once the resolver exists.
**Parallelism:** Lane B — after B-1.

Skip the full TDD loop here since visitor behavior is exercised by the fixture runner. Write the code, then fixture tests in B-3..B-8 validate it.

- [ ] **Step 1: Write `/packages/vite/src/babel/plugin.ts`**

```ts
import type { NodePath, PluginObj } from '@babel/traverse'
import * as t from '@babel/types'
import { formatLoc } from '../core/locFormat'
import { isReactWrapperName } from '../core/wrapperComponents'
import type { PerFileBatch } from '../core/types-internal'
import { resolveEnclosingComponent } from './resolveEnclosingComponent'

export interface RedesignerBabelPluginOpts {
  relPath: string
  batch: PerFileBatch
  /** Called when a visitor raises — default logs file:line. */
  onWarning?: (msg: string) => void
}

const ATTR_NAME = 'data-redesigner-loc'

function openingElementName(opening: t.JSXOpeningElement): string {
  const name = opening.name
  if (t.isJSXIdentifier(name)) return name.name
  if (t.isJSXMemberExpression(name)) {
    const parts: string[] = []
    let cur: t.JSXMemberExpression | t.JSXIdentifier = name
    while (t.isJSXMemberExpression(cur)) {
      parts.unshift(cur.property.name)
      cur = cur.object
    }
    if (t.isJSXIdentifier(cur)) parts.unshift(cur.name)
    return parts.join('.')
  }
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`
  return '?'
}

export function redesignerBabelPlugin(opts: RedesignerBabelPluginOpts): PluginObj {
  const { relPath, batch, onWarning = () => {} } = opts

  return {
    name: 'redesigner',
    visitor: {
      JSXFragment() {
        // Skip: <>…</> cannot accept props. Children visited via default traversal.
      },
      JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
        try {
          const name = openingElementName(path.node)
          if (isReactWrapperName(name)) return // skip wrapper components

          const loc = path.node.loc
          if (!loc) return
          const comp = resolveEnclosingComponent(path, relPath)

          if (comp.componentName === '(module)') {
            // Special rule: module-scope JSX is attributed to synthetic (module) in the MANIFEST,
            // but we do NOT inject `data-redesigner-loc` on the opening element (validation gate §1.4.5).
            const componentKey = `${relPath}::(module)`
            batch.components[componentKey] = {
              filePath: relPath,
              exportKind: 'named',
              lineRange: comp.lineRange,
              displayName: '(module)',
            }
            const locString = formatLoc(relPath, loc.start.line, loc.start.column)
            batch.locs[locString] = { componentKey, filePath: relPath, componentName: '(module)' }
            return
          }

          // Reject user-declared displayName === "(module)"
          if (comp.componentName === '(module)') {
            throw new Error(`[redesigner] "(module)" is a reserved synthetic component name`)
          }

          const componentKey = `${relPath}::${comp.componentName}`
          batch.components[componentKey] = {
            filePath: relPath,
            exportKind: comp.exportKind,
            lineRange: comp.lineRange,
            displayName: comp.componentName,
          }
          const locString = formatLoc(relPath, loc.start.line, loc.start.column)
          batch.locs[locString] = {
            componentKey,
            filePath: relPath,
            componentName: comp.componentName,
          }

          // Inject attribute
          const attr = t.jsxAttribute(t.jsxIdentifier(ATTR_NAME), t.stringLiteral(locString))
          path.node.attributes.push(attr)
        } catch (err) {
          const line = path.node.loc?.start.line ?? '?'
          onWarning(`[redesigner] visitor error at ${relPath}:${line}: ${(err as Error).message}`)
        }
      },
    },
  }
}
```

- [ ] **Step 2: Commit**

```
git add packages/vite/src/babel/plugin.ts
git commit -m "feat(babel): visitor (wrapper skip, per-case try/catch, module-scope manifest-only)"
```

---

### Task B-3: Fixture runner + 4 core fixtures

**Files:**
- Create: `/packages/vite/test/fixtures/README.md`
- Create: `/packages/vite/test/fixtures/FIXTURE_CHANGELOG.md`
- Create: `/packages/vite/test/fixtures/_runner.test.ts`
- Create: `/packages/vite/test/fixtures/default-export/{input.tsx,output.tsx,expected-manifest.json,README.md}`
- Create: `/packages/vite/test/fixtures/named-exports/{input.tsx,output.tsx,expected-manifest.json,README.md}`
- Create: `/packages/vite/test/fixtures/arrow-const/{input.tsx,output.tsx,expected-manifest.json,README.md}`
- Create: `/packages/vite/test/fixtures/anonymous-default/{input.tsx,output.tsx,expected-manifest.json,README.md}`

**Model:** Sonnet 4.6 for the runner; Haiku 4.5 for each fixture.
**Parallelism:** Fixtures (B-3..B-8) can parallelize amongst themselves once the runner exists. Dispatch one agent per fixture group.

- [ ] **Step 1: Write `/packages/vite/test/fixtures/README.md`**

```markdown
# Fixtures

Each fixture is a directory with `input.tsx`, `output.tsx`, `expected-manifest.json`, and a one-paragraph `README.md`. The runner parses `input.tsx`, runs our Babel plugin, diffs against `output.tsx` (code) and `expected-manifest.json` (aggregator batch).

## Regenerating

```
REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test:fixtures
```

MUST add a line to `FIXTURE_CHANGELOG.md` describing the change. Pre-commit hook and CI both enforce.

## fixtures/ vs playground/edge/

These are NOT the same cases as the playground. Fixtures pin transform-level IO; the playground exercises runtime behavior end-to-end. Do not unify.
```

- [ ] **Step 2: Seed `/packages/vite/test/fixtures/FIXTURE_CHANGELOG.md`**

```markdown
# Fixture Changelog

Add an entry to this file every time a fixture `output.tsx` or `expected-manifest.json` is updated. Format: `YYYY-MM-DD — <fixture-name> — <reason>`.

- 2026-04-18 — initial fixture set created
```

- [ ] **Step 3: Write `/packages/vite/test/fixtures/_runner.test.ts`**

```ts
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import generate from '@babel/generator'
import { redesignerBabelPlugin } from '../../src/babel/plugin'
import type { PerFileBatch } from '../../src/core/types-internal'

const ROOT = path.resolve(__dirname)
const UPDATE = process.env.REDESIGNER_FIXTURE_UPDATE === '1'

async function listFixtures(): Promise<string[]> {
  const dirs = await readdir(ROOT, { withFileTypes: true })
  return dirs
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
}

async function runFixture(name: string): Promise<{ code: string; batch: PerFileBatch }> {
  const dir = path.join(ROOT, name)
  const input = await readFile(path.join(dir, 'input.tsx'), 'utf8')
  const ast = parser.parse(input, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  const batch: PerFileBatch = { filePath: 'src/input.tsx', components: {}, locs: {} }
  const plugin = redesignerBabelPlugin({ relPath: 'src/input.tsx', batch })
  traverse(ast, plugin.visitor)
  const { code } = generate(ast, { retainLines: true })
  return { code, batch }
}

describe('fixture runner', async () => {
  const fixtures = await listFixtures()
  for (const name of fixtures) {
    it(name, async () => {
      const dir = path.join(ROOT, name)
      const { code, batch } = await runFixture(name)
      const expectedOutput = await readFile(path.join(dir, 'output.tsx'), 'utf8').catch(() => '')
      const expectedManifest = JSON.parse(
        await readFile(path.join(dir, 'expected-manifest.json'), 'utf8').catch(() => '{}'),
      )
      if (UPDATE) {
        await writeFile(path.join(dir, 'output.tsx'), code)
        await writeFile(path.join(dir, 'expected-manifest.json'), `${JSON.stringify(batch, null, 2)}\n`)
        return
      }
      expect(code.trim()).toBe(expectedOutput.trim())
      expect(batch).toEqual(expectedManifest)
    })
  }
})
```

- [ ] **Step 4: Write `default-export/` fixture files**

`input.tsx`:
```tsx
export default function Button() {
  return <div>hello</div>
}
```

`output.tsx`:
```tsx
export default function Button() {
  return <div data-redesigner-loc="src/input.tsx:2:9">hello</div>;
}
```

`expected-manifest.json`:
```json
{
  "filePath": "src/input.tsx",
  "components": {
    "src/input.tsx::Button": {
      "filePath": "src/input.tsx",
      "exportKind": "default",
      "lineRange": [1, 3],
      "displayName": "Button"
    }
  },
  "locs": {
    "src/input.tsx:2:9": {
      "componentKey": "src/input.tsx::Button",
      "filePath": "src/input.tsx",
      "componentName": "Button"
    }
  }
}
```

`README.md`:
```markdown
Default-export function component. Asserts `exportKind: 'default'` + attribute injection on child host element.
```

- [ ] **Step 5: Write `named-exports/`, `arrow-const/`, `anonymous-default/` fixtures similarly**

Apply the same 4-file pattern per fixture with these inputs:

- **named-exports/input.tsx**: `export function Button() { return <div /> }`
- **arrow-const/input.tsx**: `export const Button = () => <div />`
- **anonymous-default/input.tsx**: `export default () => <div />` (expected componentName: `Input` if file is `input.tsx` — derived from filename; adjust fixture's filePath claim accordingly or use a different test file name).

For each, generate `output.tsx` + `expected-manifest.json` by running the fixture in UPDATE mode once (after the runner is checked in):

```
REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test:fixtures
```

Then review the generated files BY HAND to catch regressions before committing. Add a changelog line for each.

- [ ] **Step 6: Run and verify**

Run: `pnpm --filter @redesigner/vite run test:fixtures`
Expected: all fixtures PASS.

- [ ] **Step 7: Commit**

```
git add packages/vite/test/fixtures/
git commit -m "test(fixtures): runner + 4 core fixtures (default, named, arrow, anonymous)"
```

---

### Task B-4: 6 wrapper / fragment fixtures

**Files:**
- Create: `packages/vite/test/fixtures/{fragment-noop,wrapper-components-noop,wrapper-components-react19,wrapper-reexport-chain,activity-alias-import,memo-wrapped,forwardRef-wrapped,inline-jsx-in-callback,hoc-wrapped,memo-to-plain-transition}/{input.tsx,output.tsx,expected-manifest.json,README.md}`

**Model:** Sonnet 4.6 for writing the `input.tsx` and eyeballing the expected output; regenerate expected files via the runner.
**Parallelism:** Parallel-eligible with B-5, B-6, B-7.

Write one `input.tsx` per case:

| Fixture | `input.tsx` |
|---------|-------------|
| `fragment-noop` | `export function X(){ return <><span /></> }` — assert `<>` skipped, `<span>` tagged |
| `wrapper-components-noop` | `import {Suspense, StrictMode} from 'react'\nexport function X(){ return <Suspense><StrictMode><span /></StrictMode></Suspense> }` — assert `Suspense` and `StrictMode` skipped, `<span>` tagged |
| `wrapper-components-react19` | `import {Activity, ViewTransition} from 'react'\nexport function X(){ return <Activity><ViewTransition><span /></ViewTransition></Activity> }` |
| `wrapper-reexport-chain` | `import {Suspense} from './my-shim'\nexport function X(){ return <Suspense><span /></Suspense> }` — **documents false-negative**: Suspense is injected (re-export chain not followed); README explains. |
| `activity-alias-import` | `import {unstable_Offscreen as Activity} from 'react'\nexport function X(){ return <Activity><span /></Activity> }` |
| `memo-wrapped` | `import {memo} from 'react'\nconst Foo = memo(() => <div />)\nexport default Foo` |
| `forwardRef-wrapped` | `import {forwardRef} from 'react'\nconst Input = forwardRef((p, ref) => <input ref={ref} />)\nexport default Input` |
| `inline-jsx-in-callback` | `export function List(){ return [1,2].map(n => <li>{n}</li>) }` — assert `<li>` attributed to `List` |
| `hoc-wrapped` | `const StyledButton = styled(Button)\nexport const X = () => <StyledButton />` — assert `<StyledButton>` attributed to `X` |
| `memo-to-plain-transition` | Document in README the pre/post edit: `export default memo(Foo)` → `export default Foo`. Include BOTH as separate `input-before.tsx` / `input-after.tsx` files with corresponding outputs. (Adjust the runner to pick up these variants OR simplify to a single `input.tsx` of the "after" state.) |

- [ ] **Step 1: Create each fixture dir + `input.tsx` + `README.md` per table**
- [ ] **Step 2: Run `REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test:fixtures`**
- [ ] **Step 3: Review generated `output.tsx` + `expected-manifest.json` per fixture**
- [ ] **Step 4: Add changelog entries**
- [ ] **Step 5: Run tests without UPDATE flag — PASS**
- [ ] **Step 6: Commit**

```
git add packages/vite/test/fixtures/
git commit -m "test(fixtures): wrapper + memo + forwardRef + HOC + callback fixtures"
```

---

### Task B-5: 6 edge/error/environment fixtures

**Files:**
- Create: `packages/vite/test/fixtures/{module-scope-jsx,dead-code-jsx,null-result,malformed-jsx,pathological-node,reserved-module-name,environment-skip,clone-element,compiler-hoist-order,children-as-function,unicode-filename,"filename with spaces"}/{...}`

**Model:** Sonnet 4.6.
**Parallelism:** Parallel-eligible.

Follow the same pattern. Notable:

- `module-scope-jsx/input.tsx`: `createRoot(root).render(<App />)` → module-only manifest entry, NO attribute on `<App />` opening tag in output.
- `dead-code-jsx/input.tsx`: `export function X(){ return false && <Dead /> }` — assert no entry produced.
- `null-result/input.tsx`: `export const n = 1` — no JSX; asserts Babel null-result handling (in the plugin layer; the fixture runner always runs traverse). This case is more meaningful as a unit test on the Vite plugin layer; include in task E-1 rather than as a fixture here.
- `malformed-jsx/input.tsx`: unbalanced JSX — asserts parser failure bubble-up semantics. Skip asserting an expected output; the test asserts the runner throws a specific error.
- `pathological-node/input.tsx`: valid JSX — but unit-test the visitor's per-case try/catch by monkey-patching the resolver to throw. This is better as a unit test on `babel/plugin.ts`. Include as a unit test in task E-1 rather than a fixture.
- `reserved-module-name/input.tsx`: This case can't actually trigger — JS won't let the user name a component `(module)` at the identifier level. The enforcement happens at `displayName`. Add as a skipped/documentation fixture with a `README.md` note: "asserts the reservation is documented; no real compile-time trigger."
- `environment-skip/`: Not a Babel-level fixture — the SSR skip lives in the Vite plugin layer. Move to task E-1.
- `clone-element/input.tsx`: `export function Wrap({c}){ return React.cloneElement(c, {x: 1}) }` — assert no JSX created by cloneElement appears in batch (visitor only sees lexical JSX).
- `compiler-hoist-order/input.tsx`: Simulate post-Compiler output by hand-writing JSX with `_c[0] = <div />` hoisted form — assert our attribute survives.
- `children-as-function/input.tsx`: `export function X(){ return <DataFetcher>{(d) => <Row d={d}/>}</DataFetcher> }` — assert BOTH `DataFetcher` opening and `Row` opening tagged, attributed to `X`.
- `unicode-filename/input.tsx` — uses a filename passed to the runner with unicode (test the runner's fixture-dir handling).
- `filename with spaces/input.tsx` — same, for spaces.

- [ ] **Step 1-5: Same as Task B-4.**

- [ ] **Step 6: Commit**

```
git add packages/vite/test/fixtures/
git commit -m "test(fixtures): edge/error/environment fixtures"
```

---

## Phase 4 — Lane C: Integration layer

Lane C runs **in parallel with Lane B** after Lane A is done. Three source files, three test files.

### Task C-1: `integration/runtimeDetect.ts`

**Files:**
- Create: `/packages/vite/src/integration/runtimeDetect.ts`
- Create: `/packages/vite/test/unit/runtimeDetect.test.ts`

**Model:** Sonnet 4.6. Ordered algorithm per spec §2.
**Parallelism:** Lane C — parallel with C-2, C-3.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { detectJsxRuntime } from '../../src/integration/runtimeDetect'

describe('detectJsxRuntime', () => {
  it('esbuild.jsx automatic → automatic + source=esbuild', () => {
    expect(detectJsxRuntime({ esbuild: { jsx: 'automatic' } })).toEqual({
      runtime: 'automatic', source: 'esbuild',
    })
  })
  it('esbuild.jsx transform (classic) → classic + source=esbuild', () => {
    expect(detectJsxRuntime({ esbuild: { jsx: 'transform' } })).toEqual({
      runtime: 'classic', source: 'esbuild',
    })
  })
  it('no esbuild, plugin-react present → automatic + source=plugin-react', () => {
    expect(detectJsxRuntime({ plugins: [{ name: 'vite:react-babel' }] })).toEqual({
      runtime: 'automatic', source: 'plugin-react',
    })
  })
  it('no authoritative source, tsconfig jsx=react (classic) → automatic + source=default + tsconfigHint=classic', () => {
    expect(detectJsxRuntime({ tsconfig: { compilerOptions: { jsx: 'react' } } })).toEqual({
      runtime: 'automatic', source: 'default', tsconfigHint: 'classic',
    })
  })
  it('fully unconfigured → automatic + source=default', () => {
    expect(detectJsxRuntime({})).toMatchObject({ runtime: 'automatic', source: 'default' })
  })
})
```

- [ ] **Step 2: FAIL.** Step 3: Implement.

```ts
export type JsxRuntime = 'automatic' | 'classic'

export interface RuntimeDetectInput {
  esbuild?: { jsx?: 'automatic' | 'transform' | 'preserve' | string }
  plugins?: Array<{ name?: string }>
  tsconfig?: { compilerOptions?: { jsx?: string } }
}

export interface RuntimeDetectResult {
  runtime: JsxRuntime
  source: 'esbuild' | 'plugin-react' | 'default'
  tsconfigHint?: JsxRuntime
}

export function detectJsxRuntime(input: RuntimeDetectInput): RuntimeDetectResult {
  if (input.esbuild?.jsx === 'automatic') return { runtime: 'automatic', source: 'esbuild' }
  if (input.esbuild?.jsx === 'transform') return { runtime: 'classic', source: 'esbuild' }

  const hasPluginReact = (input.plugins ?? []).some((p) => p?.name?.startsWith('vite:react'))
  if (hasPluginReact) {
    return { runtime: 'automatic', source: 'plugin-react' }
  }

  const tsconfigJsx = input.tsconfig?.compilerOptions?.jsx
  const tsconfigHint: JsxRuntime | undefined =
    tsconfigJsx === 'react' ? 'classic' : tsconfigJsx?.startsWith('react-') ? 'automatic' : undefined

  return { runtime: 'automatic', source: 'default', ...(tsconfigHint ? { tsconfigHint } : {}) }
}
```

- [ ] **Step 4: PASS. Step 5: Commit.**

```
git add packages/vite/src/integration/runtimeDetect.ts packages/vite/test/unit/runtimeDetect.test.ts
git commit -m "feat(integration): runtimeDetect (ordered algorithm per spec §2)"
```

---

### Task C-2: `integration/manifestWriter.ts` — core CAS + debounce + contentHash

**Files:**
- Create: `/packages/vite/src/integration/manifestWriter.ts`
- Create: `/packages/vite/test/unit/manifestWriter.test.ts`

**Model:** **Opus 4.7.** Race-condition surface (CAS + post-flush re-check + debounce + fake-timers). Hard to get right.
**Parallelism:** Lane C — parallel with C-1.

- [ ] **Step 1: Write failing tests (using fake timers + injected clock)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ManifestWriter } from '../../src/integration/manifestWriter'
import type { PerFileBatch } from '../../src/core/types-internal'

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'redesigner-test-'))
}

function batch(filePath: string, names: string[]): PerFileBatch {
  return {
    filePath,
    components: Object.fromEntries(names.map((n) => [
      `${filePath}::${n}`,
      { filePath, exportKind: 'named' as const, lineRange: [1, 1] as [number, number], displayName: n },
    ])),
    locs: Object.fromEntries(names.map((n, i) => [
      `${filePath}:${i + 1}:1`,
      { componentKey: `${filePath}::${n}`, filePath, componentName: n },
    ])),
  }
}

describe('ManifestWriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('startup: mkdirs + writes empty manifest + sweeps tmp files', async () => {
    const dir = freshDir()
    const manifestPath = path.join(dir, '.redesigner', 'manifest.json')
    const w = new ManifestWriter({ projectRoot: dir, manifestPath })
    await w.quiesce()
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(m.schemaVersion).toBe('1.0')
    expect(m.components).toEqual({})
    expect(m.locs).toEqual({})
    expect(typeof m.contentHash).toBe('string')
    await w.shutdown()
  })

  it('commitFile + quiesce produces manifest with entries', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({ projectRoot: dir, manifestPath: path.join(dir, 'manifest.json') })
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A']))
    await w.quiesce()
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(Object.keys(m.components)).toContain('src/a.tsx::A')
    await w.shutdown()
  })

  it('per-file replace CAS: newer batch for same file overwrites previous', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({ projectRoot: dir, manifestPath: path.join(dir, 'manifest.json') })
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A', 'A2']))
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['B']))
    await w.quiesce()
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(Object.keys(m.components)).toEqual(['src/a.tsx::B'])
    await w.shutdown()
  })

  it('debounce + maxWait: commits in rapid succession trigger at most one flush, bounded by maxWait', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({ projectRoot: dir, manifestPath: path.join(dir, 'manifest.json') })
    const spy = vi.spyOn(w as any, 'flush')
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A']))
    await vi.advanceTimersByTimeAsync(100)
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['B']))
    await vi.advanceTimersByTimeAsync(100)
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['C']))
    await vi.advanceTimersByTimeAsync(1100) // past maxWait
    expect(spy).toHaveBeenCalledTimes(1)
    await w.shutdown()
  })

  it('collision: two writers for same manifestPath → second constructor throws', () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    const w1 = new ManifestWriter({ projectRoot: dir, manifestPath: p })
    expect(() => new ManifestWriter({ projectRoot: dir, manifestPath: p })).toThrow(/two dev servers/)
    w1.shutdown()
  })
})
```

- [ ] **Step 2: FAIL.** Step 3: Implement the writer.

```ts
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, unlinkSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { computeContentHash } from '../core/contentHash'
import type { Manifest } from '../core/types-public'
import type { PerFileBatch } from '../core/types-internal'

const DEBOUNCE_MS = 200
const MAX_WAIT_MS = 1000
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200]

export interface ManifestWriterOptions {
  projectRoot: string
  manifestPath: string
  framework?: string
  clock?: {
    setTimeout: (fn: () => void, ms: number) => any
    clearTimeout: (h: any) => void
    now: () => number
  }
  logger?: {
    info: (m: string) => void
    warn: (m: string) => void
    error: (m: string) => void
    debug?: (m: string) => void
  }
}

export class ManifestWriter {
  private state: Map<string, PerFileBatch> = new Map()
  private flushTimer: any = null
  private maxWaitTimer: any = null
  private firstPendingAt: number | null = null
  private flushInFlight: Promise<void> | null = null
  private seq = 0
  private lastFlushedIdentity: object | null = null
  private onFlushResolvers: Array<{ seq: number; resolve: () => void }> = []
  private lockFd: number | null = null
  private shutdownCalled = false
  private clock: NonNullable<ManifestWriterOptions['clock']>
  private logger: NonNullable<ManifestWriterOptions['logger']>

  constructor(private opts: ManifestWriterOptions) {
    this.clock = opts.clock ?? { setTimeout, clearTimeout, now: () => Date.now() }
    this.logger = opts.logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

    const dir = path.dirname(opts.manifestPath)
    mkdirSync(dir, { recursive: true })

    // Acquire exclusive-flag .owner-lock
    const lockPath = `${opts.manifestPath}.owner-lock`
    try {
      this.lockFd = openSync(lockPath, 'wx')
    } catch {
      throw new Error(`[redesigner] two dev servers targeting the same manifestPath (${opts.manifestPath}) — pass distinct \`options.manifestPath\` or separate \`config.root\``)
    }

    // Startup tmp sweep
    this.startupSweep(dir)

    // Write empty manifest immediately
    this.writeSync(this.buildManifest())
  }

  private startupSweep(dir: string) {
    try {
      for (const f of readdirSync(dir)) {
        if (/^manifest\.json\.tmp-/.test(f)) {
          try { unlinkSync(path.join(dir, f)) } catch {}
        }
      }
    } catch {}
  }

  private buildManifest(): Manifest {
    const components: Manifest['components'] = {}
    const locs: Manifest['locs'] = {}
    for (const batch of this.state.values()) {
      Object.assign(components, batch.components)
      Object.assign(locs, batch.locs)
    }
    const base: Manifest = {
      schemaVersion: '1.0',
      framework: this.opts.framework ?? 'react',
      generatedAt: new Date().toISOString(),
      contentHash: '',
      components,
      locs,
    }
    base.contentHash = computeContentHash(base)
    return base
  }

  commitFile(filePath: string, batch: PerFileBatch): void {
    // CAS per-file replace: identity swap by creating a new Map entry reference
    this.state.set(filePath, batch)
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.firstPendingAt === null) this.firstPendingAt = this.clock.now()
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer)
    this.flushTimer = this.clock.setTimeout(() => this.doFlush(), DEBOUNCE_MS)
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.clock.setTimeout(() => this.doFlush(), MAX_WAIT_MS)
    }
  }

  private async doFlush(): Promise<void> {
    if (this.flushTimer) { this.clock.clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.maxWaitTimer) { this.clock.clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null }
    this.firstPendingAt = null

    if (this.flushInFlight) return this.flushInFlight
    const snapshotState = this.state
    const manifest = this.buildManifest()
    const seq = ++this.seq

    this.flushInFlight = (async () => {
      try {
        await this.flush(manifest)
        this.lastFlushedIdentity = snapshotState
        // Post-flush re-check
        if (this.state !== snapshotState || this.snapshotChanged(snapshotState)) {
          this.scheduleFlush()
        }
      } finally {
        this.flushInFlight = null
        const remaining: typeof this.onFlushResolvers = []
        for (const r of this.onFlushResolvers) {
          if (r.seq <= seq) r.resolve()
          else remaining.push(r)
        }
        this.onFlushResolvers = remaining
      }
    })()
    return this.flushInFlight
  }

  private snapshotChanged(snapshot: Map<string, PerFileBatch>): boolean {
    // Identity-based: compare Map reference of each file's batch
    if (snapshot.size !== this.state.size) return true
    for (const [k, v] of this.state) if (snapshot.get(k) !== v) return true
    return false
  }

  private async flush(manifest: Manifest): Promise<void> {
    const tmpName = `${path.basename(this.opts.manifestPath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const tmpPath = path.join(path.dirname(this.opts.manifestPath), tmpName)
    const data = `${JSON.stringify(manifest, null, 2)}\n`

    writeFileSync(tmpPath, data)

    for (let i = 0; ; i++) {
      try {
        renameSync(tmpPath, this.opts.manifestPath)
        if (i >= 2) this.logger.warn(`[redesigner] atomic rename succeeded after ${i} retries`)
        return
      } catch (err: any) {
        const code = err?.code
        if (i >= RETRY_DELAYS_MS.length) {
          try { unlinkSync(tmpPath) } catch {}
          this.logger.error(`[redesigner] atomic rename failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${err}`)
          return
        }
        if (code === 'EPERM' || code === 'EBUSY') {
          const delay = RETRY_DELAYS_MS[i]
          this.logger.debug?.(`[redesigner] rename retry ${i + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms (${code})`)
          await new Promise((r) => this.clock.setTimeout(r as any, delay))
          continue
        }
        if (code === 'EXDEV') {
          this.logger.warn(`[redesigner] EXDEV (cross-device rename) — plugin bug, please file issue. tmp=${tmpPath} target=${this.opts.manifestPath}`)
        }
        try { unlinkSync(tmpPath) } catch {}
        this.logger.warn(`[redesigner] atomic rename failed: ${err}`)
        return
      }
    }
  }

  private writeSync(manifest: Manifest): void {
    const data = `${JSON.stringify(manifest, null, 2)}\n`
    writeFileSync(this.opts.manifestPath, data)
  }

  /** Forces a flush and resolves after it lands. Test seam. */
  async quiesce(): Promise<void> {
    await this.doFlush()
  }

  async onFlush(seq: number): Promise<void> {
    if (seq <= this.seq && !this.flushInFlight) return
    return new Promise((resolve) => this.onFlushResolvers.push({ seq, resolve }))
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true
    if (this.flushTimer) { this.clock.clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.maxWaitTimer) { this.clock.clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null }
    try {
      await this.flush(this.buildManifest())
    } catch (err) {
      // Last-resort: config.logger may be torn down
      console.error(`[redesigner] shutdown flush failed: ${err}`)
    }
    if (this.lockFd !== null) {
      try { closeSync(this.lockFd) } catch {}
      try { unlinkSync(`${this.opts.manifestPath}.owner-lock`) } catch {}
      this.lockFd = null
    }
  }
}
```

- [ ] **Step 4: PASS. If any test fails, iterate. Step 5: Commit.**

```
git add packages/vite/src/integration/manifestWriter.ts packages/vite/test/unit/manifestWriter.test.ts
git commit -m "feat(integration): manifestWriter with CAS + debounce + 7-step backoff + collision throw"
```

---

### Task C-3: `integration/daemonBridge.ts`

**Files:**
- Create: `/packages/vite/src/integration/daemonBridge.ts`
- Create: `/packages/vite/test/unit/daemonBridge.test.ts`

**Model:** **Opus 4.7.** Platform-branched teardown + signal-handler ordering + injectable importer are all delicate.
**Parallelism:** Lane C — parallel with C-1, C-2.

Because of length constraints, this task's full TDD is stubbed below. Implementation follows spec §3.2 layer 4 + §5.4. Key test scenarios (apply TDD per scenario):

- [ ] Injected importer throwing ERR_MODULE_NOT_FOUND, `mode: 'auto'` → `daemonHandle` is null + warn once
- [ ] Same, `mode: 'required'` → throws
- [ ] Injected importer throwing generic error → `daemonHandle` null + warn with stack (NOT error); continues
- [ ] Injected importer resolves with contract-violating handle (missing `stdin`) → throws
- [ ] Pipe drain: mock handle's stdout emits a chunk, assert `logger.info` was called
- [ ] Teardown idempotency: call `shutdown()` twice, only one SIGTERM sent
- [ ] POSIX path: mock handle, `kill(pid, 'SIGTERM')`; after 2s, if still alive, `kill(pid, 'SIGKILL')`
- [ ] Windows path: write to stdin, await ack on stdout, 1500ms timeout → taskkill path
- [ ] Windows stdin missing at teardown → straight to taskkill
- [ ] SIGHUP handler NOT registered on `process.platform === 'win32'`
- [ ] `beforeExit` NOT registered

Implementation sketch (~200 LOC):
```ts
import type { Readable, Writable } from 'node:stream'
import { spawn as nodeSpawn } from 'node:child_process'

export interface DaemonHandle {
  pid: number
  shutdown(): Promise<void>
  stdout: Readable
  stdin: Writable
  stderr: Readable
}

export interface DaemonBridgeOptions {
  mode: 'auto' | 'required' | 'off'
  port: number
  manifestPath: string
  importer: () => Promise<{ startDaemon: (opts: { manifestPath: string; port: number }) => Promise<DaemonHandle> }>
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void }
  /** Injectable spawn (for taskkill test seams). */
  spawn?: typeof nodeSpawn
}

export class DaemonBridge {
  private handle: DaemonHandle | null = null
  private shutdownCalled = false
  private signalHandlers: Array<{ signal: string; fn: () => void }> = []

  async start(opts: DaemonBridgeOptions): Promise<void> {
    if (opts.mode === 'off') return
    let mod: Awaited<ReturnType<typeof opts.importer>>
    try {
      mod = await opts.importer()
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        if (opts.mode === 'required') {
          throw new Error(`[redesigner] daemon required but not installed: ${err.message}`)
        }
        opts.logger.warn(`[redesigner] daemon package not installed — running in manifest-only mode`)
        return
      }
      opts.logger.warn(`[redesigner] daemon package errored on import (continuing): ${err?.stack ?? err}`)
      return
    }
    // Validate contract
    const handle = await mod.startDaemon({ manifestPath: opts.manifestPath, port: opts.port })
    for (const key of ['pid', 'shutdown', 'stdout', 'stdin', 'stderr'] as const) {
      if (handle[key] === undefined || handle[key] === null) {
        throw new Error(`[redesigner] daemon handle missing required field "${key}"`)
      }
    }
    // Pipe drain
    handle.stdout.on('data', (buf: Buffer) => opts.logger.info(`[daemon] ${buf.toString().trimEnd()}`))
    handle.stderr.on('data', (buf: Buffer) => opts.logger.warn(`[daemon] ${buf.toString().trimEnd()}`))
    this.handle = handle

    // Teardown signals
    const signals: string[] = ['SIGINT', 'SIGTERM']
    if (process.platform !== 'win32') signals.push('SIGHUP')
    for (const sig of signals) {
      const fn = () => { void this.shutdown(opts) }
      process.on(sig as any, fn)
      this.signalHandlers.push({ signal: sig, fn })
    }
  }

  async shutdown(opts: DaemonBridgeOptions): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true
    for (const { signal, fn } of this.signalHandlers) process.off(signal as any, fn)
    const h = this.handle
    if (!h) return
    if (process.platform === 'win32') {
      await this.shutdownWindows(h, opts)
    } else {
      await this.shutdownPosix(h, opts)
    }
    this.handle = null
  }

  private async shutdownPosix(h: DaemonHandle, opts: DaemonBridgeOptions): Promise<void> {
    try { process.kill(h.pid, 'SIGTERM') } catch {}
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000)
      h.stdout.once('end', () => { clearTimeout(timer); resolve(true) })
    })
    if (!exited) {
      try { process.kill(h.pid, 'SIGKILL') } catch {}
      opts.logger.warn(`[redesigner] daemon did not exit on SIGTERM; escalated to SIGKILL`)
    }
  }

  private async shutdownWindows(h: DaemonHandle, opts: DaemonBridgeOptions): Promise<void> {
    const spawn = opts.spawn ?? nodeSpawn
    let acked = false
    const ackPromise = new Promise<void>((resolve) => {
      const onData = (buf: Buffer) => {
        if (buf.toString().includes('"ack":true')) { acked = true; resolve() }
      }
      h.stdout.on('data', onData)
      setTimeout(() => { h.stdout.off('data', onData); resolve() }, 1500)
    })
    try { h.stdin.write('{"op":"shutdown"}\n') } catch { /* missing stdin → straight to taskkill */ }
    await ackPromise
    if (acked) {
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 1500)
        h.stdout.once('end', () => { clearTimeout(t); resolve(true) })
      })
      if (exited) return
    }
    const tk = spawn('taskkill', ['/T', '/F', '/PID', String(h.pid)])
    const ok = await new Promise<boolean>((resolve) => tk.on('close', (code) => resolve(code === 0)))
    if (!ok) opts.logger.warn(`[redesigner] taskkill non-zero exit for PID ${h.pid}; manual cleanup may be required`)
  }
}
```

Test file scaffold (fill in per-scenario per the list above):
```ts
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { DaemonBridge, type DaemonBridgeOptions, type DaemonHandle } from '../../src/integration/daemonBridge'

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}
function mockHandle(pid = 1234): DaemonHandle {
  return { pid, shutdown: vi.fn(async () => {}), stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough() }
}

describe('DaemonBridge', () => {
  it('mode=auto + ERR_MODULE_NOT_FOUND → warn once, null handle', async () => {
    const logger = mockLogger()
    const b = new DaemonBridge()
    const err = Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
    await b.start({ mode: 'auto', port: 0, manifestPath: '/x', importer: async () => { throw err }, logger })
    expect(logger.warn).toHaveBeenCalledOnce()
  })
  // … remaining scenarios
})
```

- [ ] **Step 1-4: TDD per scenario.** Step 5: Commit.

```
git add packages/vite/src/integration/daemonBridge.ts packages/vite/test/unit/daemonBridge.test.ts
git commit -m "feat(integration): daemonBridge (injectable importer, platform-branched teardown)"
```

---

## Phase 5 — Lane D: Playground app (runs in parallel with A+B+C, after S-1)

Playground is independent React code that can be built as soon as the workspace exists. Start dispatching Lane D agents immediately after S-1.

### Task D-1: Playground scaffold

**Files:**
- Create: `/examples/playground/package.json`
- Create: `/examples/playground/tsconfig.json`
- Create: `/examples/playground/vite.config.ts`
- Create: `/examples/playground/vite-env.d.ts`
- Create: `/examples/playground/index.html`
- Create: `/examples/playground/src/main.tsx`
- Create: `/examples/playground/src/styles/index.css`
- Create: `/examples/playground/src/styles/app.module.css`

**Model:** Haiku 4.5.
**Parallelism:** Lane D — first.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@redesigner/playground",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@redesigner/vite": "workspace:*",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite-env.d.ts"]
}
```

- [ ] **Step 3: `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import redesigner from '@redesigner/vite'

export default defineConfig({
  plugins: [react(), tailwind(), redesigner()],
})
```

- [ ] **Step 4: `vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 5: `index.html`**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Playground</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 6: `src/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('root missing')
createRoot(root).render(<App />)
```

- [ ] **Step 7: `src/styles/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 8: `src/styles/app.module.css`**

```css
.container { padding: 1rem; }
```

- [ ] **Step 9: Commit**

```
git add examples/playground/package.json examples/playground/tsconfig.json examples/playground/vite.config.ts examples/playground/vite-env.d.ts examples/playground/index.html examples/playground/src/main.tsx examples/playground/src/styles/
git commit -m "scaffold(playground): base files + Tailwind v4 + workspace dep on @redesigner/vite"
```

---

### Task D-2: Playground components (core + edge)

**Files:**
- Create: 14 `.tsx` files under `examples/playground/src/components/` and `src/components/edge/`.
- Create: `examples/playground/src/App.tsx` that renders all of them.

**Model:** Sonnet 4.6 for the edge cases (React 19 wrappers, children-as-function, cloneElement); Haiku 4.5 for the straightforward ones (Button, PricingCard, Modal).
**Parallelism:** Parallel-eligible. Dispatch 4 agents: (1) core components, (2) wrapper edges, (3) ref/memo edges, (4) `App.tsx` composition.

Implement each per the spec's §4 inventory. Keep components shallow — the purpose is to exercise the plugin, not deliver a feature. Each component must actually be rendered by `App.tsx`.

- [ ] **Step 1: Write each component file**

Example `Button.tsx`:
```tsx
export default function Button(props: { children: React.ReactNode }) {
  return <button>{props.children}</button>
}
```

Example `edge/WithReact19Wrappers.tsx`:
```tsx
import { Activity, ViewTransition } from 'react'

export function WithReact19Wrappers() {
  return (
    <Activity mode="visible">
      <ViewTransition name="fade">
        <div>react-19-wrappers</div>
      </ViewTransition>
    </Activity>
  )
}
```

- [ ] **Step 2: Write `App.tsx` that renders every component**

```tsx
import Button from './components/Button'
import { PricingSection } from './components/PricingSection'
import { Modal } from './components/Modal'
import { DataFetcher } from './components/DataFetcher'
import { MemoWrapped } from './components/edge/MemoWrapped'
import { ForwardRefWrapped } from './components/edge/ForwardRefWrapped'
import { RefAsProp } from './components/edge/RefAsProp'
import { A, B as BExport } from './components/edge/MultiComponentFile'
import AnonymousDefault from './components/edge/AnonymousDefault'
import { WithCallback } from './components/edge/WithCallback'
import { WithWrappers } from './components/edge/WithWrappers'
import { WithReact19Wrappers } from './components/edge/WithReact19Wrappers'
import { CloneElementDemo } from './components/edge/CloneElementDemo'

export default function App() {
  return (
    <div>
      <Button>one</Button>
      <PricingSection />
      <Modal open>modal</Modal>
      <DataFetcher>{(d) => <span>{d.length}</span>}</DataFetcher>
      <MemoWrapped />
      <ForwardRefWrapped />
      <RefAsProp />
      <A />
      <BExport />
      <AnonymousDefault />
      <WithCallback />
      <WithWrappers />
      <WithReact19Wrappers />
      <CloneElementDemo />
    </div>
  )
}
```

- [ ] **Step 3: Run `pnpm --filter @redesigner/playground run typecheck`.** Fix any errors.

- [ ] **Step 4: Commit**

```
git add examples/playground/src/components/ examples/playground/src/App.tsx
git commit -m "feat(playground): components + App composition (all edge cases actually rendered)"
```

---

## Phase 6 — Lane E: Plugin composition + reader + integration tests

Starts after Lanes A + B + C + D are green.

### Task E-1: `src/plugin.ts` (Vite plugin composition)

**Files:**
- Create: `/packages/vite/src/plugin.ts`
- Create: `/packages/vite/test/unit/plugin.test.ts`

**Model:** Sonnet 4.6. Lifecycle composition; spec-pinned.
**Parallelism:** Serial gate for Lane E.

- [ ] **Step 1: Write plugin.ts**

```ts
import type { Plugin, ResolvedConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import { transformAsync } from '@babel/core'
import { redesignerBabelPlugin } from './babel/plugin'
import { ManifestWriter } from './integration/manifestWriter'
import { DaemonBridge } from './integration/daemonBridge'
import { detectJsxRuntime } from './integration/runtimeDetect'
import { toPosixProjectRoot, toPosixRelative, rejectEscapingPath } from './core/pathGuards'
import type { PerFileBatch } from './core/types-internal'
import type { RedesignerOptions } from './core/types-public'
import { readFileSync } from 'node:fs'

interface ClientState {
  writer: ManifestWriter
  daemon: DaemonBridge
  projectRoot: string
  manifestPath: string
  include: string[]
  exclude: string[]
}

function normalizeDaemon(input: RedesignerOptions['daemon']): { mode: 'auto'|'required'|'off'; port: number } {
  if (!input) return { mode: 'auto', port: 0 }
  if (typeof input === 'string') return { mode: input, port: 0 }
  return { mode: input.mode ?? 'auto', port: input.port ?? 0 }
}

function loadTsconfig(root: string) {
  const tsconfigPath = path.join(root, 'tsconfig.json')
  try {
    const raw = readFileSync(tsconfigPath, 'utf8')
    return JSON.parse(raw)
  } catch { return undefined }
}

export default function redesigner(options: RedesignerOptions = {}): Plugin {
  let state: Map<unknown, ClientState> = new Map() // keyed by client environment (Vite 6+) or 'client' sentinel (Vite 5)
  let config: ResolvedConfig
  let initialized = false
  const include = options.include ?? ['**/*.{jsx,tsx}']
  const exclude = options.exclude ?? ['node_modules/**', '**/*.d.ts']
  const daemonOpts = normalizeDaemon(options.daemon)

  return {
    name: 'redesigner',
    enforce: 'pre',
    apply: 'serve',
    configResolved(resolvedConfig) {
      config = resolvedConfig
      const logger = config.logger

      if (!(options.enabled ?? true)) {
        logger.info('[redesigner] disabled via options.enabled=false')
        return
      }

      const projectRoot = toPosixProjectRoot(config.root)
      const manifestPath = path.posix.resolve(
        projectRoot,
        options.manifestPath ?? '.redesigner/manifest.json',
      )
      rejectEscapingPath(path.posix.relative(projectRoot, manifestPath), projectRoot)

      const tsconfig = loadTsconfig(config.root)
      const runtime = detectJsxRuntime({
        esbuild: config.esbuild as any,
        plugins: config.plugins as any,
        tsconfig,
      })
      if (runtime.runtime === 'classic' && runtime.source !== 'default') {
        throw new Error(
          `[redesigner] classic JSX runtime detected in ${runtime.source}; v0 requires the automatic runtime. ` +
          `Set \`esbuild.jsx: 'automatic'\` in vite.config, or ensure @vitejs/plugin-react uses the automatic runtime.`,
        )
      }
      if (runtime.tsconfigHint === 'classic') {
        logger.info('[redesigner] tsconfig hints at classic JSX runtime, but Vite/esbuild/plugin-react use automatic — proceeding.')
      }

      const writer = new ManifestWriter({ projectRoot, manifestPath, logger: logger as any })
      const daemon = new DaemonBridge()
      state.set('client', { writer, daemon, projectRoot, manifestPath, include, exclude })
      initialized = true
    },
    async configureServer(server) {
      const cs = state.get('client')
      if (!cs) return
      await cs.daemon.start({
        mode: daemonOpts.mode,
        port: daemonOpts.port,
        manifestPath: cs.manifestPath,
        importer: () => import('@redesigner/daemon' as any).catch((err) => { throw err }),
        logger: config.logger as any,
      })
      server.httpServer?.on('close', () => { void this.shutdown?.() })
    },
    async transform(code, id, transformOpts) {
      if (!initialized) return undefined
      // Environment-aware skip
      const env = (this as any).environment
      if (env && env.name !== 'client') return undefined
      if ((transformOpts as any)?.ssr === true) return undefined
      if (!/\.(jsx|tsx)$/.test(id)) return undefined
      const cs = state.get('client')
      if (!cs) return undefined

      let relPath: string
      try { relPath = toPosixRelative(id, cs.projectRoot) }
      catch (err) { config.logger.warn(`[redesigner] path normalization failed for ${id}: ${(err as Error).message}`); return undefined }

      const batch: PerFileBatch = { filePath: relPath, components: {}, locs: {} }
      let result
      try {
        result = await transformAsync(code, {
          plugins: [[() => redesignerBabelPlugin({ relPath, batch }), {}]],
          sourceMaps: true,
          inputSourceMap: false,
          configFile: false,
          babelrc: false,
          filename: id,
          ast: false,
        })
      } catch (err) {
        config.logger.warn(`[redesigner] babel parse failed for ${relPath}: ${(err as Error).message}`)
        return undefined
      }
      if (!result) return undefined
      cs.writer.commitFile(relPath, batch)
      return { code: result.code ?? code, map: result.map ?? null }
    },
    async closeBundle() {
      const cs = state.get('client')
      if (!cs) return
      await cs.writer.shutdown()
      await cs.daemon.shutdown({ mode: daemonOpts.mode, port: daemonOpts.port, manifestPath: cs.manifestPath, importer: () => Promise.reject(), logger: config.logger as any })
    },
  }
}
```

- [ ] **Step 2: Unit tests** — `/packages/vite/test/unit/plugin.test.ts`

Cover: options merging; `configResolved` throws on classic runtime detected authoritatively; classic-only-tsconfig → info log, proceeds; user's `babel.config.js` NOT consulted (mock `transformAsync` and assert `configFile: false, babelrc: false` in its arguments); environment re-init short-circuits (Vite 6+ behavior).

- [ ] **Step 3: PASS. Commit.**

```
git add packages/vite/src/plugin.ts packages/vite/test/unit/plugin.test.ts
git commit -m "feat(plugin): Vite plugin composition (lifecycle, env skip, babel isolation)"
```

---

### Task E-2: `src/index.ts` + `src/reader.ts`

**Files:**
- Create: `/packages/vite/src/index.ts`
- Create: `/packages/vite/src/reader.ts`

**Model:** Sonnet 4.6.
**Parallelism:** Parallel with E-3 through E-7.

- [ ] **Step 1: `src/index.ts`**

```ts
import redesigner from './plugin'
export default redesigner
export type { Manifest, ComponentRecord, LocRecord, RedesignerOptions, DaemonOptions, SchemaVersion } from './core/types-public'
```

- [ ] **Step 2: `src/reader.ts`**

```ts
import { readFile } from 'node:fs/promises'
import type { Manifest } from './core/types-public'
import { computeContentHash as _compute } from './core/contentHash'

export const SUPPORTED_MAJOR = 1

export interface ReadManifestOptions {
  expectedMajor?: number
  maxRetries?: number
  retryDelayMs?: number
}

export async function readManifest(
  manifestPath: string,
  opts: ReadManifestOptions = {},
): Promise<Manifest> {
  const expectedMajor = opts.expectedMajor ?? SUPPORTED_MAJOR
  const maxRetries = opts.maxRetries ?? 1
  const retryDelayMs = opts.retryDelayMs ?? 50

  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as Manifest
      const [major, minor] = parsed.schemaVersion.split('.').map(Number)
      if (major !== expectedMajor) {
        throw new Error(`[redesigner] schema major mismatch: manifest=${major}, expected=${expectedMajor}`)
      }
      return parsed
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs))
    }
  }
  throw lastErr
}

export function computeContentHash(manifest: Manifest): string {
  return _compute(manifest)
}
```

- [ ] **Step 3: Commit**

```
git add packages/vite/src/index.ts packages/vite/src/reader.ts
git commit -m "feat(api): index factory + reader helper (SUPPORTED_MAJOR, readManifest, computeContentHash)"
```

---

### Task E-3: Build toolchain (`tsup` + `generate-schema`)

**Files:**
- Create: `/packages/vite/package.json`
- Create: `/packages/vite/tsconfig.json`
- Create: `/packages/vite/tsup.config.ts`
- Create: `/packages/vite/scripts/generate-schema.ts`

**Model:** Haiku 4.5 for configs; Sonnet 4.6 for the schema script.
**Parallelism:** Parallel.

- [ ] **Step 1: `/packages/vite/package.json`**

(Full contents per spec §6.4; includes vitest script pointing at `test/integration`, `test:parallelism` script.)

- [ ] **Step 2: `/packages/vite/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: `/packages/vite/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts', 'src/reader.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
})
```

- [ ] **Step 4: `scripts/generate-schema.ts`**

```ts
import { createGenerator } from 'ts-json-schema-generator'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const gen = createGenerator({
  path: path.resolve('src/core/manifestSchema.ts'),
  tsconfig: path.resolve('tsconfig.json'),
  type: 'Manifest',
})
const schema = gen.createSchema('Manifest')
writeFileSync('dist/manifest-schema.json', JSON.stringify(schema, null, 2))
console.log('generated dist/manifest-schema.json')
```

- [ ] **Step 5: Run `pnpm --filter @redesigner/vite run build`** — verify `dist/` populated.

- [ ] **Step 6: Commit**

```
git add packages/vite/package.json packages/vite/tsconfig.json packages/vite/tsup.config.ts packages/vite/scripts/generate-schema.ts
git commit -m "build(vite): tsup + ts-json-schema-generator toolchain"
```

---

### Task E-4 through E-16: Integration tests

Each integration test gets its own task. They can parallelize **3–4 at a time** once E-1, E-2, E-3 are done, because each test is independent (per-test tmpdir for fs writes).

| Task | File | Model | Parallelism |
|------|------|-------|-------------|
| E-4 | `test/integration/vite.test.ts` (DOM tagging + `(module)` absence assertion) | Sonnet | Group 1 |
| E-5 | `test/integration/manifest.test.ts` (schema + reader + contentHash) | Sonnet | Group 1 |
| E-6 | `test/integration/hmr.test.ts` (subscribe-before-edit + stable final-state + cascade) | **Opus** | Group 2 (serial w/ Vite internals) |
| E-7 | `test/integration/fast-refresh.test.ts` (state + registration + memo↔plain) | **Opus** | Group 2 |
| E-8 | `test/integration/environment-skip.test.ts` | Sonnet | Group 1 |
| E-9 | `test/integration/react-compiler.test.ts` | Sonnet | Group 1 |
| E-10 | `test/integration/sourcemap.test.ts` (composed-map assertion) | **Opus** | Group 2 |
| E-11 | `test/integration/reinit.test.ts` | Sonnet | Group 1 |
| E-12 | `test/integration/parallelism.test.ts` + dedicated vitest config | **Opus** (isolation subtleties) | Group 2 |
| E-13 | `test/integration/degradation.test.ts` | Sonnet | Group 1 |
| E-14 | `test/integration/daemon-real.test.ts` + 3 fixture packages | Sonnet + Opus (TLA worker isolation) | Group 3 (own worker pool) |
| E-15 | `test/integration/hydration-safety.test.ts` | Sonnet | Group 1 |
| E-16 | `test/integration/shutdown.test.ts` + fake daemon binary | **Opus** (cross-platform IPC) | Group 3 |

For each, follow the TDD pattern:
1. Write the test describing the scenario exactly as specified in spec §8.3.
2. Run — expect FAIL (either "not implemented" if new test infrastructure needed, or a real failure against current plugin behavior).
3. Fix any gaps in plugin code surfaced by the test.
4. PASS.
5. Commit.

Full test bodies are omitted here — each spec row in §8.3 is its own fully specified test scenario. The implementer transcribes them directly. **Every test uses `fs.mkdtempSync` for per-test tmpdir; every fs-writing test awaits `writer.quiesce()` rather than `setTimeout`; every HMR test attaches the `server.ws` listener BEFORE the file edit.**

Each task commits with message: `test(integration): <scenario>`.

---

### Task E-17: Parallelism config + final CI verification

**Files:**
- Create: `/packages/vite/test/vitest.parallelism.config.ts`

**Model:** Haiku 4.5.
**Parallelism:** Terminal — after all E-4..E-16.

- [ ] **Step 1: Write config**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/integration/parallelism.test.ts', 'test/integration/daemon-real.test.ts'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
```

- [ ] **Step 2: Commit**

```
git add packages/vite/test/vitest.parallelism.config.ts
git commit -m "test: dedicated vitest config for parallelism + daemon-real (forked, non-parallel)"
```

- [ ] **Step 3: Run full CI locally**

```
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm -r run lint
pnpm -r run typecheck
pnpm -r run test
pnpm --filter @redesigner/vite run test:parallelism
```
Expected: all green locally.

- [ ] **Step 4: Push branch → GitHub Actions runs matrix → wait for green**

- [ ] **Step 5: Manual dogfood**

Run `pnpm --filter @redesigner/playground run dev`. Open Chrome DevTools, inspect rendered elements, confirm `data-redesigner-loc` attributes point to the correct source. Verify `(module)`-scope elements have NO attribute. Verify wrappers (Fragment, Suspense, etc.) have NO attribute.

- [ ] **Step 6: Final commit marking v0 complete**

```
git commit --allow-empty -m "milestone: v0 complete — all tests green, manual dogfood verified"
```

---

## Self-review checklist for plan author

Before handoff:

- [ ] Every spec §10 decision-log item (1–49) traces to at least one task.
- [ ] No "TBD", "TODO", "similar to Task N" literals anywhere.
- [ ] `componentKey`, `manifestPath`, `data-redesigner-loc`, `(module)` formats are used consistently across tasks.
- [ ] Every code block in a step is either complete or explicitly labeled as a template with its variant source (e.g., "table row above").
- [ ] Model assignments are rationalized per task.
- [ ] Parallelism lanes are explicitly labeled.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-vite-plugin-and-playground.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task (respecting the model-assignment table and parallelism lanes), review between tasks, fast iteration. Parallel fan-out for Lane A (5 agents), Lane D (4 agents), Lane S-2..S-4 (3 agents) in the first burst; Lane B+C (6 agents) in the second; integration-test groups (3–4 agents at a time) in the third.

**2. Inline Execution** — execute tasks serially in this session using `executing-plans`, batch execution with checkpoints for review.

Which approach?
