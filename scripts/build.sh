#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin"

mkdir -p "$PLUGIN_DIR/bin"
install -m 0644 "$ROOT_DIR/src/plugin.js" "$PLUGIN_DIR/bin/plugin.js"

"$ROOT_DIR/scripts/build-assets.sh"
"$ROOT_DIR/scripts/build-bridge.sh"
"$ROOT_DIR/scripts/build-profile.sh"

echo "Built $PLUGIN_DIR"
