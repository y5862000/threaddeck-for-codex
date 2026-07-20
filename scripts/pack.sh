#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="com.yechan.threaddeck.sdPlugin"
PLUGIN_DIR="$ROOT_DIR/$PLUGIN_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/threaddeck-pack.XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

# The Stream Deck packer normalizes manifest formatting in place. Package an
# exact staging copy so a release never dirties the verified source tree.
ditto "$PLUGIN_DIR" "$STAGING_DIR/$PLUGIN_NAME"
cd "$ROOT_DIR"
pnpm exec streamdeck pack "$STAGING_DIR/$PLUGIN_NAME" \
  --output "$ROOT_DIR/release" \
  --force \
  --no-update-check

# The packer writes a FAT-compatible ZIP and therefore does not preserve the
# native helper's executable bit. Exercise the installed layout so every
# release proves that the Node entry point repairs keybridge before first use.
ARTIFACT="$ROOT_DIR/release/com.yechan.threaddeck.streamDeckPlugin"
CHECKSUM="$ARTIFACT.sha256"
EXTRACTED_DIR="$STAGING_DIR/extracted"
mkdir -p "$EXTRACTED_DIR"
/usr/bin/unzip -q "$ARTIFACT" -d "$EXTRACTED_DIR"
EXTRACTED_PLUGIN="$EXTRACTED_DIR/$PLUGIN_NAME"
chmod 0666 "$EXTRACTED_PLUGIN/bin/keybridge"
node "$EXTRACTED_PLUGIN/bin/plugin.js" --verify-keybridge-permission >/dev/null
[[ -x "$EXTRACTED_PLUGIN/bin/keybridge" ]] || {
  echo "Packaged plugin did not repair keybridge permissions" >&2
  exit 1
}
echo "Packaged keybridge permission repair passed."
(cd "$ROOT_DIR/release" && shasum -a 256 "${ARTIFACT##*/}") > "$CHECKSUM"
echo "Wrote ${CHECKSUM#$ROOT_DIR/}"
