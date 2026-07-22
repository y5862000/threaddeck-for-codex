#!/bin/zsh
set -u

USER_HOME="${HOME:-$(cd ~ && pwd)}"
INSTALLED_PLUGIN="$USER_HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.yechan.threaddeck.sdPlugin"
SOURCE_PLUGIN="$(cd "$(dirname "$0")/.." && pwd)/com.yechan.threaddeck.sdPlugin"
PLUGIN_DIR="$INSTALLED_PLUGIN"
[[ -d "$PLUGIN_DIR" ]] || PLUGIN_DIR="$SOURCE_PLUGIN"

failures=0
warnings=0

pass() { print "✓ $1"; }
warn() { print "! $1"; warnings=$((warnings + 1)); }
fail() { print "✗ $1"; failures=$((failures + 1)); }

print "ThreadDeck doctor"
print

mac_major="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
if [[ "$mac_major" == <-> && "$mac_major" -ge 13 ]]; then
  pass "macOS $(sw_vers -productVersion)"
else
  fail "macOS 13 or later is required"
fi

/usr/bin/open -Rb com.elgato.StreamDeck >/dev/null 2>&1 \
  && pass "Stream Deck is installed" \
  || fail "Stream Deck is not installed"
/usr/bin/open -Rb com.openai.codex >/dev/null 2>&1 \
  && pass "Codex Desktop is installed" \
  || fail "Codex Desktop is not installed"

codex_app_path="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' 2>/dev/null \
  | while IFS= read -r candidate; do
      [[ "$candidate" == *.app ]] || continue
      bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - \
        "$candidate/Contents/Info.plist" 2>/dev/null)"
      if [[ "$bundle_id" == "com.openai.codex" ]]; then
        print -r -- "$candidate"
        break
      fi
    done)"
if [[ -z "$codex_app_path" ]]; then
  for candidate in "/Applications/ChatGPT.app" "/Applications/Codex.app" \
      "$USER_HOME/Applications/ChatGPT.app" "$USER_HOME/Applications/Codex.app"; do
    bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - \
      "$candidate/Contents/Info.plist" 2>/dev/null)"
    if [[ "$bundle_id" == "com.openai.codex" ]]; then
      codex_app_path="$candidate"
      break
    fi
  done
fi
codex_process_command=""
if [[ -n "$codex_app_path" ]]; then
  while read -r process_ppid process_command; do
    if [[ "$process_ppid" == "1" && "$process_command" == "$codex_app_path/Contents/MacOS/"* ]]; then
      codex_process_command="$process_command"
      break
    fi
  done < <(/bin/ps -axo ppid=,command= 2>/dev/null)
fi

micro_bridge_state="$USER_HOME/Library/Application Support/ThreadDeck/codex-micro-bridge.json"
micro_port=""
if [[ -n "$codex_process_command"
      && "$codex_process_command" == *"--remote-debugging-address=127.0.0.1"* ]]; then
  micro_port="$(print -r -- "$codex_process_command" \
    | /usr/bin/sed -E 's/.*--remote-debugging-port(=| )([0-9]+).*/\2/')"
fi
if [[ "$micro_port" == <-> ]]; then
  version_ready="$(/usr/bin/curl --max-time 1 -fsS "http://127.0.0.1:$micro_port/json/version" 2>/dev/null)"
  targets_ready="$(/usr/bin/curl --max-time 1 -fsS "http://127.0.0.1:$micro_port/json/list" 2>/dev/null)"
  if [[ "$version_ready" == *"webSocketDebuggerUrl"*
        && "$targets_ready" == *'"url": "app://'* ]]; then
    pass "Codex Micro bridge is connected on loopback"
  else
    warn "Codex has loopback flags, but the Micro bridge is not ready yet"
  fi
elif [[ -n "$codex_process_command" ]]; then
  warn "Codex Micro bridge is not attached; quit and reopen Codex once after installing ThreadDeck"
else
  warn "Codex is not running; ThreadDeck will prepare the Micro bridge on the next launch"
fi
if [[ -f "$micro_bridge_state" && "$micro_port" != <-> ]]; then
  warn "A stale Micro bridge state file exists; ThreadDeck will replace it automatically"
fi

if [[ -d "$INSTALLED_PLUGIN" ]]; then
  pass "ThreadDeck is installed in Stream Deck"
else
  warn "ThreadDeck is not installed yet; checking the source build instead"
fi

manifest="$PLUGIN_DIR/manifest.json"
bridge="$PLUGIN_DIR/bin/keybridge"
executable_bridge=""
if [[ -f "$manifest" ]]; then
  version="$(/usr/bin/plutil -extract Version raw -o - "$manifest" 2>/dev/null)"
  [[ -n "$version" ]] && pass "ThreadDeck $version manifest is readable" || fail "ThreadDeck manifest is invalid"
else
  fail "ThreadDeck manifest is missing"
fi

if [[ -x "$bridge" ]]; then
  executable_bridge="$bridge"
  pass "Native helper is executable"
elif [[ -f "$bridge" ]]; then
  bridge_digest="$(/usr/bin/shasum -a 256 "$bridge" 2>/dev/null | /usr/bin/awk '{print $1}')"
  runtime_bridge="$USER_HOME/Library/Application Support/ThreadDeck/bin/keybridge-$bridge_digest"
  if [[ -n "$bridge_digest" && -x "$runtime_bridge" ]] \
      && /usr/bin/cmp -s "$bridge" "$runtime_bridge"; then
    executable_bridge="$runtime_bridge"
    pass "Native helper runtime copy matches the immutable bundle"
  else
    fail "Native helper runtime copy is missing or does not match; reopen Stream Deck once"
  fi
else
  fail "Native helper is missing"
fi

if [[ -n "$executable_bridge" ]]; then
  health="$($executable_bridge permission-health 2>/dev/null)"
  [[ "$health" == *"accessibility=1"* ]] \
    && pass "Accessibility is allowed" \
    || fail "Allow Stream Deck in System Settings → Privacy & Security → Accessibility"
  [[ "$health" == *"post_event=1"* ]] \
    && pass "Keyboard event posting is allowed" \
    || fail "Keyboard event posting is not allowed; toggle Stream Deck Accessibility off/on and reopen Stream Deck"
fi

if command -v codexbar >/dev/null 2>&1; then
  codexbar usage --format json >/dev/null 2>&1 \
    && pass "Optional CodexBar quota source is ready" \
    || warn "CodexBar is installed but Codex usage is not ready"
else
  warn "CodexBar is not installed; only the optional weekly quota key is unavailable"
fi

print
if (( failures > 0 )); then
  print "$failures required check(s) failed; $warnings optional warning(s)."
  exit 1
fi
print "All required checks passed; $warnings optional warning(s)."
