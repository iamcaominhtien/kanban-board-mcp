#!/usr/bin/env bash
# Keeps the CodeGraph code index ready for AI sessions (Claude Code, Copilot, ...).
#   codegraph.sh ensure   install the pinned CLI if needed, then build or sync the index (never fails the caller)
#   codegraph.sh serve    ensure the index exists, then run the MCP server on stdio (used by .mcp.json / .vscode/mcp.json)
#   codegraph.sh run ...  run the pinned CLI, e.g. `codegraph.sh run callers resolveOrigin`
# The CLI lives in ~/.cache/codegraph-cli, so no sudo or global npm prefix is needed.
set -uo pipefail

VERSION="1.6.2" # bump here to upgrade; ensure reinstalls on mismatch
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
home="${CODEGRAPH_HOME:-$HOME/.cache/codegraph-cli}"
bin="$home/node_modules/.bin/codegraph"
export CODEGRAPH_TELEMETRY="${CODEGRAPH_TELEMETRY:-0}"

log() { echo "codegraph: $*" >&2; }

installed_version() {
  grep -m1 '"version"' "$home/node_modules/@colbymchenry/codegraph/package.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/'
}

ensure_cli() {
  [ -x "$bin" ] && [ "$(installed_version)" = "$VERSION" ] && return 0
  command -v npm >/dev/null || { log "npm not found, cannot install"; return 1; }
  log "installing @colbymchenry/codegraph@$VERSION"
  mkdir -p "$home" && npm install --silent --no-audit --no-fund --prefix "$home" "@colbymchenry/codegraph@$VERSION" >&2
}

ensure_index() {
  cd "$root" || return 1
  if [ -f .codegraph/codegraph.db ]; then
    timeout 120 "$bin" sync -q >&2
  else
    log "building the initial index (about 15s)"
    timeout 300 "$bin" init -y >&2
  fi
}

case "${1:-ensure}" in
  ensure)
    ensure_cli && ensure_index || log "setup failed, AI tools will fall back to grep/read"
    exit 0
    ;;
  serve)
    ensure_cli || { log "CLI unavailable"; exit 1; }
    ensure_index || log "index not refreshed, serving what exists"
    cd "$root" && exec "$bin" serve --mcp --path "$root"
    ;;
  run)
    shift
    ensure_cli || exit 1
    cd "$root" && exec "$bin" "$@"
    ;;
  *)
    echo "usage: $0 ensure|serve|run ..." >&2
    exit 2
    ;;
esac
