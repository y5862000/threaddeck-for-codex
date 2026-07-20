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
(
  cd "$ROOT_DIR/reference/codex-micro-protocol"
  shasum -a 256 -c UPSTREAM.sha256
  node --test test/*.mjs
)
node "$ROOT_DIR/scripts/verify-docs.mjs"
node "$ROOT_DIR/scripts/sync-localizations.mjs" --check
jq -e . "$PLUGIN_DIR/manifest.json" >/dev/null
jq -e . "$PLUGIN_DIR/en.json" >/dev/null
jq -e . "$PLUGIN_DIR/ko.json" >/dev/null

ARCHS="$(lipo -archs "$BRIDGE")"
[[ "$ARCHS" == *arm64* ]] || { echo "keybridge is missing arm64" >&2; exit 1; }
[[ "$ARCHS" == *x86_64* ]] || { echo "keybridge is missing x86_64" >&2; exit 1; }
"$BRIDGE" voice-event-selftest
"$BRIDGE" voice-release-selftest
"$BRIDGE" reasoning-state-selftest
"$BRIDGE" reasoning-effort-selftest
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

function functionBodyFromSignature(signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing native function signature: ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`Unterminated native function: ${signature}`);
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

for (const signature of [
  "static bool step_codex_reasoning_track(",
  "static bool copy_codex_reasoning_control_scan("
]) {
  const body = functionBodyFromSignature(signature);
  if (body.includes("tap_key(KEY_TAB") || body.includes("tap_key(KEY_RETURN")) {
    throw new Error(`${signature} must not guess a focus target with Tab/Return`);
  }
}

if (source.includes("open_accessibility_popup_with_down")) {
  throw new Error("Reasoning control must not infer an adjacent popup button from geometry");
}

const reasoningStepBody = functionBodyFromSignature(
  "static int step_codex_reasoning_effort("
);
if (!reasoningStepBody.includes('strcmp(expected_reasoning, "ultra") == 0')
    || !reasoningStepBody.includes("confirm_codex_ultra_full_access_warning(1.1)")) {
  throw new Error("Ultra confirmation must be scoped to an exact Ultra effort request");
}
const ultraConfirmationBody = functionBodyFromSignature(
  "static CodexUltraConfirmationResult confirm_codex_ultra_full_access_warning("
);
if (!ultraConfirmationBody.includes("CODEX_ULTRA_WARNING_TITLE")
    || !ultraConfirmationBody.includes("CODEX_ULTRA_WARNING_BODY")
    || !ultraConfirmationBody.includes("scan.full_access_button_count == 1")
    || !ultraConfirmationBody.includes("scan.continue_button_count == 1")
    || !ultraConfirmationBody.includes(
      "activate_accessibility_element_with_return(scan.full_access_button)"
    )) {
  throw new Error("Ultra confirmation must exact-match and activate only Use Full access");
}

for (const contract of [
  "AXIsProcessTrustedWithOptions(options)",
  "CGPreflightPostEventAccess()",
  "CGRequestPostEventAccess()",
  'strcmp(argv[1], "permission-health") == 0',
  'strcmp(argv[1], "permission-request") == 0',
  "command_permission_gate(argv[1])"
]) {
  if (!source.includes(contract)) {
    throw new Error(`Missing permission-health contract: ${contract}`);
  }
}
NODE
echo "Passive composer reads are interaction-free."
echo "Fast mode composer-focus restoration is wired."
echo "Reasoning control fallbacks cannot activate the adjacent microphone."
echo "Permission health and official macOS re-request are wired."
if grep -Eq 'CGEventCreateMouseEvent|CGWarpMouseCursorPosition|kCGEventLeftMouse(Down|Up)' "$ROOT_DIR/native/keybridge.m"; then
  echo "keybridge must not synthesize mouse events" >&2
  exit 1
fi
echo "Cursor-neutral accessibility activation check passed."

pnpm exec streamdeck validate "$PLUGIN_DIR" --no-update-check
node "$ROOT_DIR/scripts/audit-release.mjs"

echo "Verification passed."
