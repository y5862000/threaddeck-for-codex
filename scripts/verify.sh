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
"$BRIDGE" side-chat-composer-selftest
"$BRIDGE" command-palette-selftest
"$BRIDGE" media-bundle-selftest
node - "$ROOT_DIR/native/keybridge.m" "$ROOT_DIR/src/plugin.js" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const pluginSource = fs.readFileSync(process.argv[3], "utf8");

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
  "static bool open_codex_reasoning_options(",
  "static bool copy_codex_reasoning_control_scan("
]) {
  const body = functionBodyFromSignature(signature);
  if (body.includes("tap_key(KEY_TAB") || body.includes("tap_key(KEY_RETURN")) {
    throw new Error(`${signature} must not guess a focus target with Tab/Return`);
  }
}

for (const signature of [
  "static int step_codex_reasoning_effort(",
  "static int set_codex_reasoning_effort("
]) {
  const body = functionBodyFromSignature(signature);
  if (!body.includes("open_codex_reasoning_options(&scan)")
      || body.includes("kAXIncrementAction")
      || body.includes("kAXDecrementAction")
      || body.includes("kAXValueAttribute")) {
    throw new Error(`${signature} must use Codex's exact option list, never the compact slider`);
  }
}

if (source.includes("open_accessibility_popup_with_down")) {
  throw new Error("Reasoning control must not infer an adjacent popup button from geometry");
}

const sideChatFocusBody = functionBodyFromSignature(
  "static bool focus_codex_side_chat_composer_if_visible("
);
if (!sideChatFocusBody.includes("codex_composer_controls_target_side_chat")
    || !sideChatFocusBody.includes("controls.window_size.width * 0.58")) {
  throw new Error("Provisional Side Chat focus must stay inside the verified right-side composer");
}

const reasoningStepBody = functionBodyFromSignature(
  "static int step_codex_reasoning_effort("
);
if (!reasoningStepBody.includes('strcmp(expected_reasoning, "ultra") == 0')
    || !reasoningStepBody.includes("confirm_codex_ultra_full_access_warning(1.1)")) {
  throw new Error("Ultra confirmation must be scoped to an exact Ultra effort request");
}
if (!reasoningStepBody.includes("codex_reasoning_option_csv(&options")
    || !reasoningStepBody.includes("codex_reasoning_target_option(")
    || !reasoningStepBody.includes("step_count")) {
  throw new Error("Reasoning step must scan and traverse the current exact option list");
}

const effortUpdateStart = pluginSource.indexOf("function performReasoningEffortChange(");
const effortUpdateEnd = pluginSource.indexOf("\nfunction incrementReasoningPending(", effortUpdateStart);
if (effortUpdateStart < 0 || effortUpdateEnd < 0) {
  throw new Error("Missing JavaScript reasoning update transaction");
}
const effortUpdateBody = pluginSource.slice(effortUpdateStart, effortUpdateEnd);
if (!effortUpdateBody.includes('["reasoning-effort-step", stepDirection, String(count)]')
    || !effortUpdateBody.includes("confirmed?.availableEfforts")
    || effortUpdateBody.includes("reasoning-effort-set")) {
  throw new Error("Reasoning updates must send step counts and trust only native-scanned options");
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
