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
