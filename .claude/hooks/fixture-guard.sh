#!/usr/bin/env bash
# PreToolUse hook: block hand-edits to Biome-ignored fixture outputs.
# Fixtures at packages/vite/test/fixtures/**/output.tsx and
# expected-manifest.json must be regenerated via the snapshot runner, not
# edited by hand — the pre-commit hook enforces an accompanying
# FIXTURE_CHANGELOG.md entry too. Catching this at PreToolUse saves a
# round-trip of edit → pre-commit rejection.

set -u
input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

case "$file_path" in
  */packages/vite/test/fixtures/*/output.tsx \
  | */packages/vite/test/fixtures/*/expected-manifest.json)
    >&2 cat <<'MSG'
Refusing to hand-edit a Biome-ignored fixture output.

Regenerate with:
  REDESIGNER_FIXTURE_UPDATE=1 pnpm --filter @redesigner/vite run test:fixtures

Then add a line to packages/vite/test/fixtures/FIXTURE_CHANGELOG.md
describing the regeneration. The pre-commit hook blocks fixture edits
without a changelog entry.
MSG
    exit 2
    ;;
esac

exit 0
