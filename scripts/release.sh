#!/bin/bash
# Tenon release: build the app, then publish a GitHub release with the DMG.
# Requires gh CLI authenticated (gh auth login) and the origin remote pushed.
set -euo pipefail
cd "$(dirname "$0")/../apps/desktop"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "==> building icons + app"
node ../../scripts/gen-icons.mjs
npx electron-vite build
export https_proxy="${https_proxy:-http://127.0.0.1:15236}" http_proxy="${http_proxy:-http://127.0.0.1:15236}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
npx electron-builder --mac

echo "==> publishing GitHub release $TAG"
gh release create "$TAG" \
  release/Tenon-"$VERSION"-arm64.dmg \
  release/Tenon-"$VERSION"-arm64-mac.zip \
  --title "$TAG" \
  --notes "Tenon $VERSION" \
  --repo wscnv93/Tenon
echo "==> done: https://github.com/wscnv93/Tenon/releases/tag/$TAG"
