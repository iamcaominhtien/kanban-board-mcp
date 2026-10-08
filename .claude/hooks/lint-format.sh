#!/usr/bin/env bash
# PostToolUse hook: format and lint the file Claude just edited. Lint errors go to stderr (exit 2) so Claude sees and fixes them.
f=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))')
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
[ -f "$f" ] || exit 0
case "$f" in
  "$root"/server/*.py)
    ruff="$root/server/.venv/bin/ruff"; [ -x "$ruff" ] || ruff=ruff
    cd "$root/server" || exit 0
    "$ruff" format "$f" >/dev/null 2>&1
    out=$("$ruff" check --fix "$f" 2>&1) || { echo "$out" >&2; exit 2; }
    ;;
  "$root"/ui/src/*.ts|"$root"/ui/src/*.tsx)
    cd "$root/ui" || exit 0
    [ -x node_modules/.bin/prettier ] || exit 0
    node_modules/.bin/prettier --write "$f" >/dev/null 2>&1
    out=$(node_modules/.bin/eslint --quiet "$f" 2>&1) || { echo "$out" >&2; exit 2; }
    ;;
esac
exit 0
