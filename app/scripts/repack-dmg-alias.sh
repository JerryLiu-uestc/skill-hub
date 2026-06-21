#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/Skill Hub.app"
DMG_DIR="$BUNDLE_DIR/dmg"
DMG_PATH="$DMG_DIR/Skill Hub_0.1.0_aarch64.dmg"
CREATE_DMG="$DMG_DIR/bundle_dmg.sh"
BACKGROUND="$ROOT_DIR/src-tauri/assets/dmg-background.png"
ICON="$ROOT_DIR/src-tauri/icons/icon.icns"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Missing app bundle: $APP_PATH" >&2
  exit 1
fi

if [[ ! -x "$CREATE_DMG" ]]; then
  echo "Missing generated create-dmg script: $CREATE_DMG" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

STAGING="$WORK_DIR/staging"
mkdir -p "$STAGING"
cp -R "$APP_PATH" "$STAGING/Skill Hub.app"

osascript <<OSA >/dev/null
set targetFolder to POSIX file "/Applications" as alias
set outFolder to POSIX file "$STAGING" as alias
tell application "Finder"
  make new alias file to targetFolder at outFolder with properties {name:"Applications"}
end tell
OSA

rm -f "$DMG_PATH"

"$CREATE_DMG" \
  --volname "Skill Hub" \
  --volicon "$ICON" \
  --background "$BACKGROUND" \
  --window-size 680 420 \
  --icon "Skill Hub.app" 190 220 \
  --icon "Applications" 500 220 \
  --hide-extension "Skill Hub.app" \
  "$DMG_PATH" \
  "$STAGING"

