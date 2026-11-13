#!/usr/bin/env bash
# Stop hook: clippy (warnings are errors, as in CI) on the server crates Claude edited during this turn, which
# lint-format.sh noted. Problems go to stderr with exit 2, so Claude fixes them before it stops. After 3 blocked stops
# in a row it lets Claude stop (and keeps the crates noted for the next turn), so a lint it cannot fix does not loop.
input=$(cat)
session=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id","none"))')
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
state="${TMPDIR:-/tmp}/kanban-clippy/$session"
[ -s "$state" ] || exit 0
command -v cargo >/dev/null || exit 0
crates=$(sort -u "$state")
args=()
for c in $crates; do
  [ -f "$root/server/crates/$c/Cargo.toml" ] || [ -f "$root/server/bins/$c/Cargo.toml" ] && args+=(-p "$c")
done
[ ${#args[@]} -gt 0 ] || { rm -f "$state" "$state.tries"; exit 0; }
cd "$root/server" || exit 0
if out=$(cargo clippy "${args[@]}" --all-targets --message-format=short -- -D warnings 2>&1); then
  rm -f "$state" "$state.tries"
  exit 0
fi
tries=$(( $(cat "$state.tries" 2>/dev/null || echo 0) + 1 ))
echo "$tries" > "$state.tries"
[ "$tries" -le 3 ] || { rm -f "$state.tries"; exit 0; }
{
  echo "cargo clippy ${args[*]} --all-targets -- -D warnings failed (attempt $tries of 3):"
  printf '%s\n' "$out" | grep -E '^(error|warning)|^[^ ].*\.rs:[0-9]+:[0-9]+: ' | head -40
} >&2
exit 2
