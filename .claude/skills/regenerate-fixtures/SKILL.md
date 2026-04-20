---
name: regenerate-fixtures
description: Regenerate Vite plugin golden fixtures (output.tsx + expected-manifest.json) and add a required FIXTURE_CHANGELOG.md entry. Use when a legitimate change to the Vite plugin's code-transform has made existing fixture outputs stale.
disable-model-invocation: true
---

# Regenerate Vite Plugin Fixtures

Fixtures at `packages/vite/test/fixtures/**/{output.tsx,expected-manifest.json}` are Biome-ignored and tsc-excluded. The pre-commit hook blocks any change to them without an accompanying `packages/vite/test/fixtures/FIXTURE_CHANGELOG.md` entry.

## Steps

1. Run the snapshot runner:

```bash
REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test:fixtures
```

2. Review the diff in `git status -- packages/vite/test/fixtures/` to confirm only the intended fixtures changed. If unexpected fixtures moved, stop and investigate — the code-transform change may have a wider blast radius than expected.

3. Append a line to `packages/vite/test/fixtures/FIXTURE_CHANGELOG.md` using this format:

```
<YYYY-MM-DD>: <one-line why>. Affected: <fixture-dir-list>. Driver commit: <short SHA or PR#>.
```

Example:

```
2026-04-21: handle null-safe optional chaining in selectors. Affected: optional-chain, nested-conditionals. Driver commit: abc1234.
```

4. Stage both the fixture diff and the changelog entry together — the pre-commit hook matches them in a single commit.

## Why

Fixtures encode golden outputs of the AST transform. Hand-editing them bypasses the rebuild-from-source invariant; the CI fixture-update guard also fails a three-dot diff that includes fixture changes without a changelog entry. See `CLAUDE.md` line about fixture regeneration for the underlying constraint.
