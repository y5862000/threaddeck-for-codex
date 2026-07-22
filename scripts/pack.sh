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
# release proves that the packaged source remains immutable while an exact
# executable copy is staged outside the DRM-protected plugin bundle.
ARTIFACT="$ROOT_DIR/release/com.yechan.threaddeck.streamDeckPlugin"
CHECKSUM="$ARTIFACT.sha256"
EXTRACTED_DIR="$STAGING_DIR/extracted"
RUNTIME_CACHE="$STAGING_DIR/runtime-cache"
mkdir -p "$EXTRACTED_DIR"
/usr/bin/unzip -q "$ARTIFACT" -d "$EXTRACTED_DIR"
EXTRACTED_PLUGIN="$EXTRACTED_DIR/$PLUGIN_NAME"
chmod 0666 "$EXTRACTED_PLUGIN/bin/keybridge"
THREADDECK_KEYBRIDGE_CACHE_DIR="$RUNTIME_CACHE" \
  node "$EXTRACTED_PLUGIN/bin/plugin.js" --verify-keybridge-permission >/dev/null
[[ ! -x "$EXTRACTED_PLUGIN/bin/keybridge" ]] || {
  echo "Packaged keybridge was modified in place, which violates DRM immutability" >&2
  exit 1
}
runtime_bridges=("$RUNTIME_CACHE"/keybridge-*(N))
(( ${#runtime_bridges[@]} == 1 )) || {
  echo "Packaged plugin did not stage exactly one KeyBridge runtime copy" >&2
  exit 1
}
RUNTIME_KEY_BRIDGE="${runtime_bridges[1]}"
[[ -x "$RUNTIME_KEY_BRIDGE" ]] || {
  echo "Staged KeyBridge runtime copy is not executable" >&2
  exit 1
}
/usr/bin/cmp -s "$EXTRACTED_PLUGIN/bin/keybridge" "$RUNTIME_KEY_BRIDGE" || {
  echo "Staged KeyBridge runtime copy differs from the packaged source" >&2
  exit 1
}
echo "Immutable packaged KeyBridge staging passed."
(cd "$ROOT_DIR/release" && shasum -a 256 "${ARTIFACT##*/}") > "$CHECKSUM"
echo "Wrote ${CHECKSUM#$ROOT_DIR/}"
