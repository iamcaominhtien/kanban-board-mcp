#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check Node.js version (electron@34 requires Node 20+)
node --version | grep -qE "^v(2[0-9]|[3-9][0-9])" || { echo "ERROR: Node.js 20+ required. Current: $(node --version)"; exit 1; }

echo "=== Kanban Board Desktop Build Script ==="
echo ""

# Step 1: Build React UI
echo "Step 1/3: Building React UI..."
cd "$REPO_ROOT/ui"
npm install
npm run build
echo "  ✓ UI built to ui/dist/"

# Step 2: Build Python binaries
echo ""
echo "Step 2/3: Building Python binaries..."
"$REPO_ROOT/desktop/scripts/build-python.sh"

# Step 3: Package with electron-builder
echo ""
echo "Step 3/3: Packaging Electron app..."
cd "$REPO_ROOT/desktop"
npm install
npm run dist
echo "  ✓ Package created in dist-desktop/"

echo ""
echo "=== Build complete ==="
ls -lh "$REPO_ROOT/dist-desktop/" 2>/dev/null || true
