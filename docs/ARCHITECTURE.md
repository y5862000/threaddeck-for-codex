# Architecture

```text
Codex local state (~/.codex) ─┐
                              ├─ plugin.js ── WebSocket ── Stream Deck
CodexBar CLI (usage only) ────┘       │
                                      └─ keybridge ── macOS keyboard/media events
```

`src/plugin.js` is a dependency-free Node.js Stream Deck plugin. It reads task metadata from local Codex SQLite/JSON files, renders 144 × 144 SVG key images, and sends those images through Stream Deck's localhost WebSocket API.

`native/keybridge.m` is compiled as a universal macOS binary. It emits shortcuts, holds push-to-talk keys, enumerates processes producing Core Audio output, and sends media-key events.

The packaged Neo profile lives under `profiles/source/unpacked`. `scripts/build-profile.sh` turns it into the `.streamDeckProfile` archive included by the plugin manifest.

## Stability boundary

The Stream Deck plugin protocol and profile manifest are public APIs. Codex's files under `~/.codex` are not. Parsers therefore use conservative fallbacks and should never write to Codex state.
