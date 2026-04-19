#!/usr/bin/env bash
# PostToolUse hook: rebuild @redesigner/core when its source is edited.
# Vite and mcp resolve core via packages/core/dist/, not source — without
# this, downstream typecheck/tests see stale exports.

set -u
input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

case "$file_path" in
  */packages/core/src/*)
    cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
    pnpm --filter @redesigner/core build --silent >/dev/null 2>&1 || true
    ;;
esac

exit 0
