#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_DIR="$WORKSPACE_ROOT/desktop"
SERVER_DIR="$WORKSPACE_ROOT/server"
OUTPUT_DIR="$WORKSPACE_ROOT/dist-python"

# Must run from workspace root so relative paths in spec files resolve correctly
cd "$WORKSPACE_ROOT"

echo "=== Building Python binaries for Kanban Board Desktop App ==="
echo "Workspace: $WORKSPACE_ROOT"

# Activate Python venv (Windows uses Scripts/, Unix uses bin/)
if [[ -f "$SERVER_DIR/.venv/Scripts/python.exe" ]]; then
    VENV_PYTHON="$SERVER_DIR/.venv/Scripts/python.exe"
elif [[ -f "$SERVER_DIR/.venv/bin/python" ]]; then
    VENV_PYTHON="$SERVER_DIR/.venv/bin/python"
else
    echo "ERROR: Python venv not found at $SERVER_DIR/.venv"
    echo "Run: cd server && uv sync --no-dev && uv pip install pyinstaller"
    exit 1
fi

# Install pyinstaller in the venv if not present
"$VENV_PYTHON" -c "import PyInstaller" 2>/dev/null || (command -v uv >/dev/null && uv pip install pyinstaller --directory "$SERVER_DIR") || "$VENV_PYTHON" -m pip install pyinstaller --quiet

mkdir -p "$OUTPUT_DIR"

# Start clean: an old kanban-server/ folder (two-folder layout) must not reach the package
rm -rf "$OUTPUT_DIR/kanban-server" "$OUTPUT_DIR/kanban-mcp-stdio"

echo ""
echo "--- Building kanban-server + kanban-mcp-stdio (one folder, shared _internal/) ---"
"$VENV_PYTHON" -m PyInstaller \
    --distpath "$OUTPUT_DIR" \
    --workpath "$DESKTOP_DIR/build/pyinstaller-work" \
    --noconfirm \
    "$DESKTOP_DIR/kanban-backend.spec"

# Smoke test: the built server must start. A data file left out of the spec only shows here, never in a checkout
# (3.27.0 shipped without the slides skill's folder and the app could not open).
echo ""
echo "--- Smoke test: starting the built kanban-server ---"
SERVER_BIN="$OUTPUT_DIR/kanban-mcp-stdio/kanban-server"
[[ -f "$SERVER_BIN.exe" ]] && SERVER_BIN="$SERVER_BIN.exe"
SMOKE_DIR="$(mktemp -d)"
KANBAN_DB_PATH="$SMOKE_DIR/smoke.db" "$SERVER_BIN" > "$SMOKE_DIR/server.log" 2>&1 &
SERVER_PID=$!
READY=false
for _ in $(seq 1 60); do
    if grep -q "^READY " "$SMOKE_DIR/server.log"; then READY=true; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
done
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
if [[ "$READY" != true ]]; then
    echo "ERROR: the built kanban-server did not start:"
    cat "$SMOKE_DIR/server.log"
    rm -rf "$SMOKE_DIR"
    exit 1
fi
rm -rf "$SMOKE_DIR"
echo "  ✓ kanban-server started (READY)"

echo ""
echo "=== Build complete ==="
echo "Binaries in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR/kanban-mcp-stdio" 2>/dev/null || true
du -sh "$OUTPUT_DIR/kanban-mcp-stdio" 2>/dev/null || true
