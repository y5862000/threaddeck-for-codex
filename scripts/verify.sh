#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin"
BRIDGE="$PLUGIN_DIR/bin/keybridge"

for source in "$ROOT_DIR"/src/*.js; do
  bundled="$PLUGIN_DIR/bin/${source##*/}"
  [[ -f "$bundled" ]] || { echo "Missing bundled JavaScript: $bundled" >&2; exit 1; }
  node --check "$source"
  node --check "$bundled"
  cmp -s "$source" "$bundled" || {
    echo "Bundled JavaScript differs from source: ${source##*/}" >&2
    exit 1
  }
done
for bundled in "$PLUGIN_DIR"/bin/*.js(N); do
  [[ -f "$ROOT_DIR/src/${bundled##*/}" ]] || {
    echo "Stale bundled JavaScript: ${bundled##*/}" >&2
    exit 1
  }
done
node "$PLUGIN_DIR/bin/plugin.js" --verify-completion
node "$PLUGIN_DIR/bin/plugin.js" --verify-refresh-resilience
node "$PLUGIN_DIR/bin/plugin.js" --verify-usage-cache
node "$PLUGIN_DIR/bin/plugin.js" --verify-voice-submit
node "$PLUGIN_DIR/bin/plugin.js" --verify-interactions
pnpm run test
node "$ROOT_DIR/scripts/verify-docs.mjs"
jq -e . "$PLUGIN_DIR/manifest.json" >/dev/null

ARCHS="$(lipo -archs "$BRIDGE")"
[[ "$ARCHS" == *arm64* ]] || { echo "keybridge is missing arm64" >&2; exit 1; }
[[ "$ARCHS" == *x86_64* ]] || { echo "keybridge is missing x86_64" >&2; exit 1; }
"$BRIDGE" voice-event-selftest
"$BRIDGE" voice-release-selftest
"$BRIDGE" reasoning-state-selftest
"$BRIDGE" goal-state-selftest
"$BRIDGE" fast-mode-selftest
"$BRIDGE" thread-fingerprint-selftest
"$BRIDGE" focused-thread-geometry-selftest
"$BRIDGE" command-palette-selftest
"$BRIDGE" media-bundle-selftest
node - "$ROOT_DIR/native/keybridge.m" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");

function functionBody(name) {
  const start = source.indexOf(`static int ${name}(void)`);
  if (start < 0) throw new Error(`Missing native function: ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`Unterminated native function: ${name}`);
}

for (const name of ["print_codex_fast_mode_state", "print_codex_composer_state"]) {
  const body = functionBody(name);
  if (!body.includes("copy_codex_fast_mode_scan(false, &scan)")) {
    throw new Error(`${name} must use the closed passive composer scan`);
  }
  if (/fallback|activate_accessibility|perform_codex_accessibility|close_codex_intelligence_popover/.test(body)) {
    throw new Error(`${name} must never open or interact with the model picker`);
  }
}

const toggleBody = functionBody("toggle_codex_fast_mode");
if (!toggleBody.includes("restore_codex_composer_after_fast_mode()")
    || !toggleBody.includes("composer_focused=%d")) {
  throw new Error("Fast mode toggle must restore and report Codex composer focus");
}
NODE
echo "Passive composer reads are interaction-free."
echo "Fast mode composer-focus restoration is wired."
if grep -Eq 'CGEventCreateMouseEvent|CGWarpMouseCursorPosition|kCGEventLeftMouse(Down|Up)' "$ROOT_DIR/native/keybridge.m"; then
  echo "keybridge must not synthesize mouse events" >&2
  exit 1
fi
echo "Cursor-neutral accessibility activation check passed."

pnpm exec streamdeck validate "$PLUGIN_DIR" --no-update-check
node "$ROOT_DIR/scripts/audit-release.mjs"

echo "Verification passed."
