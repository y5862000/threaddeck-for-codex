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

if [[ -d "$INSTALLED_PLUGIN" ]]; then
  pass "ThreadDeck is installed in Stream Deck"
else
  warn "ThreadDeck is not installed yet; checking the source build instead"
fi

manifest="$PLUGIN_DIR/manifest.json"
bridge="$PLUGIN_DIR/bin/keybridge"
if [[ -f "$manifest" ]]; then
  version="$(/usr/bin/plutil -extract Version raw -o - "$manifest" 2>/dev/null)"
  [[ -n "$version" ]] && pass "ThreadDeck $version manifest is readable" || fail "ThreadDeck manifest is invalid"
else
  fail "ThreadDeck manifest is missing"
fi

if [[ -x "$bridge" ]]; then
  pass "Native helper is executable"
  health="$($bridge permission-health 2>/dev/null)"
  [[ "$health" == *"accessibility=1"* ]] \
    && pass "Accessibility is allowed" \
    || fail "Allow Stream Deck in System Settings → Privacy & Security → Accessibility"
  [[ "$health" == *"post_event=1"* ]] \
    && pass "Keyboard event posting is allowed" \
    || fail "Keyboard event posting is not allowed; toggle Stream Deck Accessibility off/on and reopen Stream Deck"
else
  fail "Native helper is missing or not executable"
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
