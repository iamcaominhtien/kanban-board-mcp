#!/usr/bin/env bash
# PostToolUse hook: format and lint the file Claude just edited. Errors go to stderr (exit 2) so Claude sees and fixes them.
# Rust: rustfmt runs here on the one file; clippy checks a whole crate, so this only notes the crate and
# rust-clippy.sh (the Stop hook) runs clippy once, at the end of the turn, on every crate noted.
input=$(cat)
{ read -r f; read -r session; } < <(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path","")); print(d.get("session_id","none"))')
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
[ -f "$f" ] || exit 0
case "$f" in
  # the files a skill hands out (scripts, templates): kept byte for byte, checked against contract/golden/skills.json
  "$root"/server/crates/*/assets/*) ;;
  "$root"/server/crates/*/*.rs|"$root"/server/bins/*/*.rs|"$root"/server/crates/*/Cargo.toml|"$root"/server/bins/*/Cargo.toml)
    rel=${f#"$root"/server/}
    crate=$(printf '%s' "$rel" | cut -d/ -f2)
    mkdir -p "${TMPDIR:-/tmp}/kanban-clippy" && echo "$crate" >> "${TMPDIR:-/tmp}/kanban-clippy/$session"
    case "$f" in
      *.rs) out=$(rustfmt --edition 2024 "$f" 2>&1) || { echo "$out" >&2; exit 2; } ;;
    esac
    ;;
  "$root"/ui/src/*.ts|"$root"/ui/src/*.tsx)
    cd "$root/ui" || exit 0
    [ -x node_modules/.bin/prettier ] || exit 0
    node_modules/.bin/prettier --write "$f" >/dev/null 2>&1
    out=$(node_modules/.bin/eslint --quiet "$f" 2>&1) || { echo "$out" >&2; exit 2; }
    ;;
esac
exit 0
