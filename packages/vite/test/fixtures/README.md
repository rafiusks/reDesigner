<!-- human -->
# Fixtures

Each fixture is a directory with `input.tsx`, `output.tsx`, `expected-manifest.json`, and a one-paragraph `README.md`. The runner parses `input.tsx`, runs our Babel plugin, diffs against `output.tsx` (code) and `expected-manifest.json` (aggregator batch).

## Regenerating

```
REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test
```

MUST add a line to `FIXTURE_CHANGELOG.md` describing the change. Pre-commit hook and CI both enforce.

## fixtures/ vs playground/edge/

These are NOT the same cases as the playground. Fixtures pin transform-level IO; the playground exercises runtime behavior end-to-end. Do not unify.
