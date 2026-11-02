#!/usr/bin/env bash
# Puts the draw.io editor (the static web app of jgraph/drawio, Apache 2.0) in dist-drawio/, which the desktop app ships
# as resources/drawio and the board serves at /drawio, so diagrams open with no service to run and nothing sent out.
#
# The version is pinned by its tag and the commit it must point at; a moved tag fails the build. Only the files the
# embedded editor loads are kept (no Java servlet, no dev sources, no source maps, no cloud integrations).
#
# Upgrading: set DRAWIO_VERSION and DRAWIO_COMMIT from `git ls-remote --tags https://github.com/jgraph/drawio.git`
# (the `^{}` line is the commit), run this script, open a diagram in the app, and note it in the CHANGELOG.
# draw.io supports only its latest release (no backported fixes), so upgrade with each app release.
set -euo pipefail

DRAWIO_VERSION="32.6.9"
DRAWIO_COMMIT="3e707fd20b6930778d6f6bf6e4d0079b4bce366b"
REPO_URL="https://github.com/jgraph/drawio.git"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/dist-drawio"

if [[ -f "$OUT/VERSION" && "$(cat "$OUT/VERSION")" == "$DRAWIO_VERSION" && -f "$OUT/index.html" ]]; then
  echo "  ✓ draw.io $DRAWIO_VERSION already in dist-drawio/"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "  Fetching draw.io $DRAWIO_VERSION ..."
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$DRAWIO_VERSION" --filter=blob:none --sparse "$REPO_URL" "$WORK/drawio"
cd "$WORK/drawio"
got="$(git rev-parse HEAD)"
if [[ "$got" != "$DRAWIO_COMMIT" ]]; then
  echo "ERROR: tag v$DRAWIO_VERSION points at $got, expected $DRAWIO_COMMIT" >&2
  exit 1
fi
git sparse-checkout set src/main/webapp

rm -rf "$OUT"
cp -R src/main/webapp "$OUT"
cp LICENSE "$OUT/LICENSE"

cd "$OUT"
# Not loaded by the embedded editor: the Java servlet, the dev-mode sources (dev=1 only), the cloud and Office
# integrations, the viewer bundles (used from a remote host only), the service worker and source maps
rm -rf WEB-INF META-INF connect js/diagramly js/grapheditor mxgraph/src \
  js/integrate.min.js js/viewer.min.js js/viewer-static.min.js \
  service-worker.js teams.html onedrive3.html monday-app-association.json
rm -f workbox-*.js
find . -name '*.map' -type f -delete

echo "$DRAWIO_VERSION" > VERSION
cat > SOURCE.txt <<EOF
draw.io $DRAWIO_VERSION, the static web app from $REPO_URL
(tag v$DRAWIO_VERSION, commit $DRAWIO_COMMIT, folder src/main/webapp), licensed under the Apache License 2.0 (LICENSE).
draw.io is a trademark of draw.io Ltd and draw.io AG; this app is not affiliated with or endorsed by them.
Files left out: see desktop/scripts/fetch-drawio.sh.
EOF

for needed in index.html clear.html js/bootstrap.js js/main.js js/app.min.js js/PreConfig.js js/PostConfig.js; do
  [[ -f "$needed" ]] || { echo "ERROR: dist-drawio/$needed is missing" >&2; exit 1; }
done
echo "  ✓ draw.io $DRAWIO_VERSION in dist-drawio/ ($(find . -type f | wc -l | tr -d ' ') files)"
