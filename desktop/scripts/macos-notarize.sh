#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="${ROOT_DIR}/src-tauri/target/release/bundle"
ENTITLEMENTS="${ROOT_DIR}/src-tauri/entitlements.plist"

APP_PATH="${APP_PATH:-}"
DMG_PATH="${DMG_PATH:-}"
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [ -z "$APP_PATH" ]; then
  APP_PATH="$(ls -td "${BUNDLE_DIR}/macos/"*.app 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$DMG_PATH" ]; then
  DMG_PATH="$(ls -td "${BUNDLE_DIR}/dmg/"*.dmg 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$APP_PATH" ] && [ -z "$DMG_PATH" ]; then
  echo "No app or dmg found under ${BUNDLE_DIR}."
  exit 1
fi

if [ -z "$SIGN_IDENTITY" ]; then
  echo "Set APPLE_SIGNING_IDENTITY to your Developer ID Application certificate."
  exit 1
fi

if [ -n "$APP_PATH" ]; then
  echo "Codesigning ${APP_PATH}"
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$APP_PATH"
fi

TARGET="${DMG_PATH:-$APP_PATH}"

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ] || [ -z "${APPLE_APP_PASSWORD:-}" ]; then
  echo "Set APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD for notarization."
  exit 1
fi

echo "Submitting for notarization: ${TARGET}"
xcrun notarytool submit "$TARGET" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "Stapling notarization ticket"
xcrun stapler staple "$TARGET"

echo "Notarization complete: ${TARGET}"
