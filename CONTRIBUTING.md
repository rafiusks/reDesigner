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
