#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
APP_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"

APP_PATH="$(ls -td "$APP_DIR"/*.app 2>/dev/null | head -n 1 || true)"
if [ -z "$APP_PATH" ]; then
  echo "No .app bundle found in $APP_DIR"
  exit 1
fi

APP_NAME="$(basename "$APP_PATH" .app)"
mkdir -p "$OUT_DIR"

STAGING_DIR="$(mktemp -d)"
cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

OUT_PATH="$OUT_DIR/${APP_NAME}.dmg"
echo "Creating DMG at $OUT_PATH"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING_DIR" -ov -format UDZO "$OUT_PATH"

rm -rf "$STAGING_DIR"
echo "DMG created: $OUT_PATH"
