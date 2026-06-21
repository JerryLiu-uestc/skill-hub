#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Skill Hub.app"
SOURCE_APP="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME"
TARGET_APP="/Applications/$APP_NAME"

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Missing built app bundle: $SOURCE_APP" >&2
  echo "Run: npm run build:app" >&2
  exit 1
fi

osascript -e 'tell application "Skill Hub" to quit' >/dev/null 2>&1 || true
sleep 1

TMP_APP="/Applications/.Skill Hub.app.tmp"
rm -rf "$TMP_APP"
cp -R "$SOURCE_APP" "$TMP_APP"
rm -rf "$TARGET_APP"
mv "$TMP_APP" "$TARGET_APP"
xattr -dr com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1 || true
open "$TARGET_APP"

echo "Installed and opened $TARGET_APP"

