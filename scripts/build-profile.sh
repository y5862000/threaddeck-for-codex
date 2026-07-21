#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PARENT="$ROOT_DIR/profiles/source/unpacked"
SOURCE_PROFILE="$SOURCE_PARENT/BD0CCFE2-385C-472C-A7A9-57205644D475.sdProfile"
OUTPUT_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin/profiles"
OUTPUT="$OUTPUT_DIR/threaddeck-neo.streamDeckProfile"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/threaddeck-profile.XXXXXX")"
STAGED_PROFILE="$STAGING_DIR/$(basename "$SOURCE_PROFILE")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

mkdir -p "$OUTPUT_DIR"
for existing in "$OUTPUT_DIR"/*.streamDeckProfile(N); do
  unlink "$existing"
done

ditto "$SOURCE_PROFILE" "$STAGED_PROFILE"
node "$ROOT_DIR/scripts/prepare-profile.mjs" \
  "$STAGED_PROFILE" \
  "$ROOT_DIR/com.yechan.threaddeck.sdPlugin/manifest.json"

(
  cd "$STAGING_DIR"
  /usr/bin/zip -X -q -r "$OUTPUT" "$(basename "$STAGED_PROFILE")"
)
