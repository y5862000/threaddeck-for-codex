# Architecture

> [한국어 구조 설명](ARCHITECTURE.ko.md)

```text
Codex local state (~/.codex) ─┐
Codex Accessibility metadata ─┼─ plugin.js ── localhost WebSocket ── Stream Deck
CodexBar CLI (usage only) ────┘       │
                                      └─ keybridge ── macOS input/audio/AX APIs
```

ThreadDeck is intentionally small. A dependency-free Node.js process owns local state parsing, visual rendering, and Stream Deck events; one universal native helper handles the macOS input and audio operations Node cannot provide reliably.

## Runtime components

### Node.js plugin

`src/plugin.js` is the source of truth for the Stream Deck plugin. The build copies it to `com.yechan.threaddeck.sdPlugin/bin/plugin.js`.

It:

- connects to Stream Deck through the localhost plugin WebSocket;
- merges pinned and recent local SQLite tasks with only explicitly pinned cached remote summaries from Codex JSON state, deduplicating by conversation ID;
- normalizes working, completed, queued, error, and idle states;
- reconstructs remote starts from UUIDv7 turn IDs and freezes ends only from explicit lifecycle markers or confirmed live runtime transitions, never summary recency timestamps;
- tracks the active Desktop session so closed temporary Side Chats do not reappear as ordinary tasks;
- renders every ThreadDeck-owned 144 × 144 key as SVG;
- animates active reasoning cues, queue-advance acknowledgements, and completion pulses;
- invokes CodexBar for the optional weekly quota value;
- delegates keyboard, media, and push-to-talk operations to `keybridge`.
- lets a held task key open that task, dictate a follow-up, detect transcription completion using text fingerprints, and submit it on release.
- opens remote tasks through Codex's own visible sidebar result when available, then falls back to the unified task search so Codex activates the result's host before navigation.

No Codex file is opened for writing.

### Native helper

`native/keybridge.m` is compiled by `scripts/build-bridge.sh` for `arm64` and `x86_64`, then joined into one universal executable.

It:

- emits Codex shortcuts and Return;
- holds and releases push-to-talk modifiers across Stream Deck key-down/key-up events;
- attaches an explicit Latin `D` to push-to-talk events while retaining the physical key code, making the shortcut independent of the active keyboard input source;
- sends app-switch and media-key events;
- finds processes currently producing Core Audio output;
- suspends those process IDs during dictation and resumes the same IDs on release.
- traverses the visible Codex accessibility tree to fingerprint task titles, select one unambiguous remote task result, and count localized queue-action buttons without returning message text.

The helper uses macOS system frameworks only. Stream Deck needs Accessibility permission for synthesized input.

### Neo profile

The editable profile source lives under `profiles/source/unpacked`. `scripts/build-profile.sh` creates the `.streamDeckProfile` archive referenced by the plugin manifest. Hardware UUIDs are removed before publication so importing the profile does not bind it to the author's device.

ThreadDeck owns the bundled previous-page actions and exposes a next-page action. They use Stream Deck's official `switchToProfile` command with a page index, so navigation remains native while those keys participate in plugin-rendered completion overlays. Elgato-owned app-launch actions remain native and do not receive ThreadDeck overlays.

## Data refresh and rendering

- Task metadata refreshes every 3 seconds while a task action is visible.
- Pinned local tasks and explicitly pinned remote summaries are placed first; only local tasks and Side Chats fill the remaining recent slots. A local record wins if the same conversation ID appears in both sources.
- The same refresh observes the open Codex task's queue count. Cached counts follow that task key and decrement when a queued turn starts.
- Active task timers and animation frames render at device-appropriate intervals.
- Weekly usage refreshes every 60 seconds while the quota action is visible.
- macOS appearance is checked every 2 seconds and swaps the renderer between the existing dark and light palettes.
- Completion is detected by comparing end timestamps with an overlapping observation window and a startup grace period. Queue decreases are also treated as a completed turn. The first global frame is fanned out to every visible ThreadDeck-owned key before later frames are split into device-safe groups; the matching task key receives the longer task pulse.

The plugin caches the last image for each context and avoids sending unchanged frames.

## Documentation renderer

`scripts/render-docs.mjs` runs the same key-rendering functions in sanitized demo mode. It exports dark and light 4 × 2 feature overviews and exact individual-key PNGs. `scripts/render-animation.mjs` renders a deterministic 72-frame state sequence and encodes it with the open-source Swift/ImageIO helper. This keeps README images and the GIF synchronized with the shipped interface without hand-redrawing controls.

## Stability boundary

The Stream Deck plugin protocol and profile manifest are public APIs. Codex files under `~/.codex` are not. Parsers therefore:

- accept missing or renamed optional fields;
- prefer stable IDs over titles;
- keep all access read-only;
- show a safe fallback instead of mutating state;
- isolate the private format boundary inside the task-reading functions.

A future public Codex App Server interface could replace the local parsers without changing the Stream Deck action and rendering layers.
