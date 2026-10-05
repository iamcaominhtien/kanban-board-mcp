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
if [ -f "$SERVER_DIR/.venv/Scripts/python.exe" ]; then
    VENV_PYTHON="$SERVER_DIR/.venv/Scripts/python.exe"
elif [ -f "$SERVER_DIR/.venv/bin/python" ]; then
    VENV_PYTHON="$SERVER_DIR/.venv/bin/python"
else
    echo "ERROR: Python venv not found at $SERVER_DIR/.venv"
    echo "Run: cd server && uv sync --no-dev && uv pip install pyinstaller"
    exit 1
fi

# Install pyinstaller in the venv if not present
"$VENV_PYTHON" -c "import PyInstaller" 2>/dev/null || "$VENV_PYTHON" -m pip install pyinstaller --quiet

mkdir -p "$OUTPUT_DIR"

echo ""
echo "--- Building kanban-server binary ---"
"$VENV_PYTHON" -m PyInstaller \
    --distpath "$OUTPUT_DIR" \
    --workpath "$DESKTOP_DIR/build/pyinstaller-work" \
    --noconfirm \
    "$DESKTOP_DIR/kanban-server.spec"

echo ""
echo "--- Building kanban-mcp-stdio binary ---"
"$VENV_PYTHON" -m PyInstaller \
    --distpath "$OUTPUT_DIR" \
    --workpath "$DESKTOP_DIR/build/pyinstaller-work" \
    --noconfirm \
    "$DESKTOP_DIR/kanban-mcp-stdio.spec"

echo ""
echo "=== Build complete ==="
echo "Binaries in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR/kanban-server" "$OUTPUT_DIR/kanban-mcp-stdio" 2>/dev/null || \
ls -lh "$OUTPUT_DIR/kanban-server.exe" "$OUTPUT_DIR/kanban-mcp-stdio.exe" 2>/dev/null
