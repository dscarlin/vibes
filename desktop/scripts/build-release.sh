#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
API_URL="${API_URL:-https://api.vibesplatform.ai}"
DOMAIN="${DOMAIN:-vibesplatform.ai}"

echo "Building desktop web assets..."
API_URL="$API_URL" DOMAIN="$DOMAIN" UPGRADE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/build-web.js"

echo "Building Tauri bundle..."
if [ "$(uname -s)" = "Darwin" ]; then
  (cd "$ROOT_DIR" && cargo tauri build --bundles app)
  "$ROOT_DIR/scripts/build-dmg.sh"
else
  (cd "$ROOT_DIR" && cargo tauri build)
fi

if [ "${NOTARIZE_MACOS:-}" = "1" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "Notarizing macOS build..."
    (cd "$ROOT_DIR" && ./scripts/macos-notarize.sh)
  else
    echo "NOTARIZE_MACOS=1 set, but not running on macOS. Skipping notarization."
  fi
fi

if [ "${WINDOWS_SIGN:-}" = "1" ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if [ -z "${WINDOWS_SIGN_TARGET:-}" ]; then
        WINDOWS_SIGN_TARGET="$(ls -td "$ROOT_DIR/src-tauri/target/release/bundle/msi/"*.msi 2>/dev/null | head -n 1 || true)"
        export WINDOWS_SIGN_TARGET
      fi
      if [ -z "${WINDOWS_SIGN_TARGET:-}" ]; then
        echo "WINDOWS_SIGN_TARGET not found. Set it to the .msi or .exe you want to sign."
        exit 1
      fi
      echo "Signing Windows bundle..."
      powershell -ExecutionPolicy Bypass -File "$ROOT_DIR/scripts/windows-sign.ps1"
      ;;
    *)
      echo "WINDOWS_SIGN=1 set, but not running on Windows. Skipping Windows signing."
      ;;
  esac
fi

DOWNLOAD_DIR="$REPO_ROOT/downloads"
mkdir -p "$DOWNLOAD_DIR"

copy_latest() {
  local dir="$1"
  local ext="$2"
  local latest=""
  if [ ! -d "$dir" ]; then
    return 0
  fi
  while IFS= read -r -d '' file; do
    if [ -z "$latest" ] || [ "$file" -nt "$latest" ]; then
      latest="$file"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name "*${ext}" -print0)
  if [ -n "$latest" ]; then
    cp -f "$latest" "$DOWNLOAD_DIR/"
    echo "Copied $(basename "$latest") to $DOWNLOAD_DIR"
  fi
}

copy_latest "$ROOT_DIR/src-tauri/target/release/bundle/dmg" ".dmg"
copy_latest "$ROOT_DIR/src-tauri/target/release/bundle/msi" ".msi"
copy_latest "$ROOT_DIR/src-tauri/target/release/bundle/appimage" ".AppImage"

echo "Bundle output: $ROOT_DIR/src-tauri/target/release/bundle"
