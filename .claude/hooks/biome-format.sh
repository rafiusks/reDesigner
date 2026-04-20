#!/usr/bin/env bash
# PostToolUse hook: biome-format edited/written TS(X) files under packages/.
# Lint-on-save in editor form — keeps CI `biome check .` green on every
# Edit/Write round-trip, and preserves indentation/line-ending consistency
# that is easy to drift when Claude edits multiple files in a row.
#
# Silent on success; only emits output if biome itself errors.

set -u
input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

case "$file_path" in
  */packages/*/src/*.ts \
  | */packages/*/src/*.tsx \
  | */packages/*/test/*.ts \
  | */packages/*/test/*.tsx)
    cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
    # Bail quietly if biome isn't on PATH (e.g., fresh clone, deps not installed).
    command -v pnpm >/dev/null 2>&1 || exit 0
    # Skip fixtures — Biome ignores them and formatting them would churn the
    # file against its .biomeignore rule.
    case "$file_path" in
      */test/fixtures/*) exit 0 ;;
    esac
    # `biome format --write` returns non-zero only on internal error, not on
    # reformats. Silently succeed either way.
    pnpm exec biome format --write "$file_path" >/dev/null 2>&1 || true
    ;;
esac

exit 0
