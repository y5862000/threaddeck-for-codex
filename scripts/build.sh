#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin"

mkdir -p "$PLUGIN_DIR/bin"
for bundled in "$PLUGIN_DIR"/bin/*.js(N); do
  [[ -f "$ROOT_DIR/src/${bundled##*/}" ]] || rm -f "$bundled"
done
for source in "$ROOT_DIR"/src/*.js; do
  install -m 0644 "$source" "$PLUGIN_DIR/bin/${source##*/}"
done

"$ROOT_DIR/scripts/build-assets.sh"
"$ROOT_DIR/scripts/build-bridge.sh"
"$ROOT_DIR/scripts/build-profile.sh"

echo "Built $PLUGIN_DIR"
