#!/usr/bin/env bash
# Build the .mcpb bundle Claude Desktop installs on a double click.
#
# It is a zip holding the compiled server, its production dependencies and the
# manifest. Dependencies are vendored because Desktop does not run npm: whatever
# is in the zip is what runs.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
OUT="desktop-extension/midjourney-${VERSION}.mcpb"
BUILD="desktop-extension/build"

npm run build

rm -rf "$BUILD"
mkdir -p "$BUILD/server"

cp -R dist/* "$BUILD/server/"
cp desktop-extension/manifest.json "$BUILD/manifest.json"
cp README.md LICENSE "$BUILD/"

node -e "
const pkg = require('./package.json');
require('fs').writeFileSync('$BUILD/package.json', JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  type: 'module',
  dependencies: pkg.dependencies,
}, null, 2));
"

( cd "$BUILD" && npm install --omit=dev --no-audit --no-fund --silent )

rm -f "$OUT"
( cd "$BUILD" && zip -qr "../../$OUT" . -x '*.DS_Store' )

echo "$OUT  $(du -h "$OUT" | cut -f1)"
