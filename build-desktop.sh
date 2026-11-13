#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check Node.js version (electron@34 requires Node 20+)
node --version | grep -qE "^v(2[0-9]|[3-9][0-9])" || { echo "ERROR: Node.js 20+ required. Current: $(node --version)"; exit 1; }

echo "=== Kanban Board Desktop Build Script ==="
echo ""

# Step 1: Build React UI
echo "Step 1/4: Building React UI..."
cd "$REPO_ROOT/ui"
npm install
npm run build
echo "  ✓ UI built to ui/dist/"

# Step 2: The draw.io editor the app ships (pinned version, trimmed)
echo ""
echo "Step 2/4: Fetching the draw.io editor..."
"$REPO_ROOT/desktop/scripts/fetch-drawio.sh"

# Step 3: Build the Rust server and the stdio MCP server
echo ""
echo "Step 3/4: Building the Rust server..."
"$REPO_ROOT/desktop/scripts/build-server.sh"

# Step 4: Package with electron-builder
echo ""
echo "Step 4/4: Packaging Electron app..."
cd "$REPO_ROOT/desktop"
npm install
npm run dist
echo "  ✓ Package created in dist-desktop/"

echo ""
echo "=== Build complete ==="
ls -lh "$REPO_ROOT/dist-desktop/" 2>/dev/null || true
