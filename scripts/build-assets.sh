#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/assets/plugin.svg"
IMAGES="$ROOT_DIR/com.yechan.threaddeck.sdPlugin/images"

mkdir -p "$IMAGES"
sips -s format png "$SOURCE" --out "$IMAGES/plugin@2x.png" >/dev/null
sips -z 144 144 "$IMAGES/plugin@2x.png" --out "$IMAGES/plugin.png" >/dev/null
