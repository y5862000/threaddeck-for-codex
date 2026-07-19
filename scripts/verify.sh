#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin"
BRIDGE="$PLUGIN_DIR/bin/keybridge"

node --check "$ROOT_DIR/src/plugin.js"
node --check "$PLUGIN_DIR/bin/plugin.js"
node "$ROOT_DIR/src/plugin.js" --verify-completion
node "$ROOT_DIR/src/plugin.js" --verify-refresh-resilience
node "$ROOT_DIR/src/plugin.js" --verify-thread-selection
node "$ROOT_DIR/src/plugin.js" --verify-usage-cache
node "$ROOT_DIR/src/plugin.js" --verify-voice-submit
node "$ROOT_DIR/scripts/verify-docs.mjs"
jq -e . "$PLUGIN_DIR/manifest.json" >/dev/null

ARCHS="$(lipo -archs "$BRIDGE")"
[[ "$ARCHS" == *arm64* ]] || { echo "keybridge is missing arm64" >&2; exit 1; }
[[ "$ARCHS" == *x86_64* ]] || { echo "keybridge is missing x86_64" >&2; exit 1; }
"$BRIDGE" voice-event-selftest

pnpm exec streamdeck validate "$PLUGIN_DIR" --no-update-check
node "$ROOT_DIR/scripts/audit-release.mjs"

echo "Verification passed."
