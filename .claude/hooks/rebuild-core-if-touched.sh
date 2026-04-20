#!/usr/bin/env bash
# PostToolUse hook: rebuild @redesigner/core or @redesigner/daemon when
# their source is edited. Downstream packages (vite, mcp) resolve these via
# dist/, not source — without this, typecheck/tests see stale exports.

set -u
input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

case "$file_path" in
  */packages/core/src/*)
    cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
    pnpm --filter @redesigner/core build --silent >/dev/null 2>&1 || true
    ;;
  */packages/daemon/src/*)
    cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
    pnpm --filter @redesigner/daemon build --silent >/dev/null 2>&1 || true
    ;;
esac

exit 0
