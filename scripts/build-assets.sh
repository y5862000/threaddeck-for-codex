#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/assets/plugin.svg"
IMAGES="$ROOT_DIR/com.yechan.threaddeck.sdPlugin/images"

mkdir -p "$IMAGES"
node "$ROOT_DIR/scripts/rasterize.mjs" "$SOURCE" "$IMAGES/plugin@2x.png" 512 512
node "$ROOT_DIR/scripts/rasterize.mjs" "$SOURCE" "$IMAGES/plugin.png" 256 256
