#!/usr/bin/env bash
# Builds the two Rust programs of the desktop app and lays them out the way the installer expects:
#
#   dist-server/kanban-mcp-stdio/
#     kanban-server[.exe]     the HTTP server the app starts (`--runner` starts the AI runner)
#     kanban-mcp-stdio[.exe]  the stdio MCP server that AI clients start
#
# The folder keeps the stdio program's old name: MCP clients outside the app (Claude Desktop, VS Code, Cursor) store
# Resources/kanban-mcp-stdio/kanban-mcp-stdio as their command, and it must not move.
#
# Environment: CARGO_TARGET_DIR (where cargo builds; default <workspace>/target),
#              MACOS_UNIVERSAL=1 (macOS only: build arm64 and x86_64 and join them with lipo; default: this machine's
#              architecture, as the PyInstaller build did).
set -euo pipefail

# The Rust workspace, relative to the repository root. The one place this script names it.
SERVER_DIR="server"

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CARGO_DIR="$WORKSPACE_ROOT/$SERVER_DIR"
OUTPUT_DIR="$WORKSPACE_ROOT/dist-server"
BUNDLE_DIR="$OUTPUT_DIR/kanban-mcp-stdio"
TARGET_DIR="${CARGO_TARGET_DIR:-$CARGO_DIR/target}"
PACKAGES=(-p kanban-server -p kanban-mcp-stdio)

EXT=""
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

echo "=== Building the Rust server for Kanban Board Desktop App ==="
echo "Workspace: $CARGO_DIR"

command -v cargo >/dev/null || { echo "ERROR: cargo not found. Install Rust (https://rustup.rs)"; exit 1; }

# Start clean: an old folder (the PyInstaller bundle, with its _internal/) must not reach the package
rm -rf "$OUTPUT_DIR/kanban-server" "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

cd "$CARGO_DIR"
export CARGO_TARGET_DIR="$TARGET_DIR"

if [[ "$(uname -s)" == "Darwin" && "${MACOS_UNIVERSAL:-}" == "1" ]]; then
    echo ""
    echo "--- Building arm64 and x86_64, joining them with lipo ---"
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    for triple in aarch64-apple-darwin x86_64-apple-darwin; do
        cargo build --release --locked "${PACKAGES[@]}" --target "$triple"
    done
    for name in kanban-server kanban-mcp-stdio; do
        lipo -create -output "$BUNDLE_DIR/$name" \
            "$TARGET_DIR/aarch64-apple-darwin/release/$name" "$TARGET_DIR/x86_64-apple-darwin/release/$name"
    done
else
    echo ""
    echo "--- cargo build --release ---"
    cargo build --release --locked "${PACKAGES[@]}"
    for name in kanban-server kanban-mcp-stdio; do
        cp "$TARGET_DIR/release/$name$EXT" "$BUNDLE_DIR/$name$EXT"
    done
fi
cd "$WORKSPACE_ROOT"

# Smoke test: the built server must start, with its own temporary folders so it never touches the developer's data.
echo ""
echo "--- Smoke test: starting the built kanban-server ---"
SERVER_BIN="$BUNDLE_DIR/kanban-server$EXT"
SMOKE_DIR="$(mktemp -d)"
mkdir -p "$SMOKE_DIR/config" "$SMOKE_DIR/logs" "$SMOKE_DIR/workspace" "$SMOKE_DIR/uploads"
KANBAN_CONFIG_DIR="$SMOKE_DIR/config" \
KANBAN_DB_PATH="$SMOKE_DIR/smoke.db" \
KANBAN_LOG_DIR="$SMOKE_DIR/logs" \
KANBAN_WORKSPACE_ROOT="$SMOKE_DIR/workspace" \
KANBAN_UPLOADS_DIR="$SMOKE_DIR/uploads" \
    "$SERVER_BIN" > "$SMOKE_DIR/server.log" 2>&1 &
SERVER_PID=$!
READY=false
PORT=""
for _ in $(seq 1 60); do
    PORT="$(sed -n 's/^READY port=\([0-9][0-9]*\).*/\1/p' "$SMOKE_DIR/server.log" | head -n 1)"
    if [[ -n "$PORT" ]]; then READY=true; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
done
HEALTHY=false
if [[ "$READY" == true ]]; then
    for _ in $(seq 1 10); do
        if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then HEALTHY=true; break; fi
        sleep 1
    done
fi
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
if [[ "$READY" != true || "$HEALTHY" != true ]]; then
    echo "ERROR: the built kanban-server did not start (ready=$READY, health=$HEALTHY):"
    cat "$SMOKE_DIR/server.log"
    rm -rf "$SMOKE_DIR"
    exit 1
fi
rm -rf "$SMOKE_DIR"
echo "  ✓ kanban-server started (READY port=$PORT) and answered GET /health"

echo ""
echo "=== Build complete ==="
echo "Binaries in: $BUNDLE_DIR"
ls -lh "$BUNDLE_DIR"
du -sh "$BUNDLE_DIR"
