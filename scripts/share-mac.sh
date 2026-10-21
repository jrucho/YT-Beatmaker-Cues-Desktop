#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP_NAME="YT Beatmaker Cues Desktop.app"

ARCH="${1:-}"
if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *)
      echo "Unsupported Mac architecture: $(uname -m)" >&2
      echo "Usage: pnpm share:mac [arm64|x64]" >&2
      exit 1
      ;;
  esac
fi

case "$ARCH" in
  arm64|aarch64)
    ARCH="arm64"
    OUT_DIR="$ROOT/desktop/out/mac-arm64"
    ;;
  x64|x86_64)
    ARCH="x64"
    OUT_DIR="$ROOT/desktop/out/mac"
    ;;
  *)
    echo "Usage: pnpm share:mac [arm64|x64]" >&2
    exit 1
    ;;
esac

DMG="$ROOT/release/YT-Beatmaker-Cues-Desktop-$VERSION-macOS-$ARCH.dmg"
MOUNT=""
cleanup() {
  if [[ -n "$MOUNT" ]]; then
    hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
    MOUNT=""
  fi
}
trap cleanup EXIT

if [[ -f "$DMG" ]]; then
  MOUNT="$(hdiutil attach "$DMG" -nobrowse -readonly | tail -1 | cut -f3-)"
  APP="$MOUNT/$APP_NAME"
  SOURCE="release/YT-Beatmaker-Cues-Desktop-$VERSION-macOS-$ARCH.dmg"
else
  APP="$OUT_DIR/$APP_NAME"
  SOURCE="desktop/out"
fi

if [[ ! -d "$APP" ]]; then
  echo "Missing $APP" >&2
  echo "Download the $ARCH DMG or build it with: pnpm installer:mac" >&2
  exit 1
fi

STAGE="$ROOT/release/share/YT-Beatmaker-Cues-Desktop-$VERSION-macOS-$ARCH"
ZIP="$STAGE.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
echo "Using $SOURCE"
ditto "$APP" "$STAGE/$APP_NAME"
cleanup

cat > "$STAGE/Install.command" <<'INSTALL'
#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="YT Beatmaker Cues Desktop.app"
SRC="$HERE/$APP_NAME"

if [[ ! -d "$SRC" ]]; then
  echo "Keep Install.command next to \"$APP_NAME\" and run it again."
  read -r -p "Press Return to close..."
  exit 1
fi

if [[ -w /Applications ]]; then
  DEST="/Applications/$APP_NAME"
else
  DEST="$HOME/Applications/$APP_NAME"
  mkdir -p "$HOME/Applications"
fi

osascript -e 'quit app "YT Beatmaker Cues Desktop"' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -cr "$DEST"

echo "Installed in $(dirname "$DEST")"
open "$DEST"
INSTALL
chmod +x "$STAGE/Install.command"

cat > "$STAGE/README.txt" <<README
YT Beatmaker Cues Desktop $VERSION - macOS $ARCH

USB DRIVE (no approval needed)
  1. Copy this folder, or just "$APP_NAME", to the USB drive.
  2. On the other Mac, drag the app into Applications and open it.

AIRDROP OR DOWNLOAD
  1. Send this folder (or the .zip) with AirDrop and unpack it.
  2. Run Install.command. It installs the app and removes macOS's
     download quarantine, so no Privacy & Security approval is needed.
     If double-clicking is blocked, open Terminal and run:
       bash "/path/to/Install.command"

The app is ad-hoc signed, not notarized, so macOS blocks copies that
still carry the download quarantine flag. The USB copy has no such flag,
and Install.command clears it for AirDrop copies.
README

xattr -cr "$STAGE"
ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ZIP"
xattr -cr "$ZIP"

echo "Folder: $STAGE"
echo "Zip:    $ZIP"
