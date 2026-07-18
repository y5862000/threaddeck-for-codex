# Architecture

```text
Codex local state (~/.codex) ─┐
                              ├─ plugin.js ── localhost WebSocket ── Stream Deck
CodexBar CLI (usage only) ────┘       │
                                      └─ keybridge ── macOS keyboard/media APIs
```

ThreadDeck is intentionally small. A dependency-free Node.js process owns local state parsing, visual rendering, and Stream Deck events; one universal native helper handles the macOS input and audio operations Node cannot provide reliably.

## Runtime components

### Node.js plugin

`src/plugin.js` is the source of truth for the Stream Deck plugin. The build copies it to `com.yechan.threaddeck.sdPlugin/bin/plugin.js`.

It:

- connects to Stream Deck through the localhost plugin WebSocket;
- discovers pinned and recent tasks from conservative read-only views of Codex SQLite and JSON state;
- normalizes working, completed, queued, error, and idle states;
- tracks start/end timestamps and freezes completed durations;
- renders every ThreadDeck-owned 144 × 144 key as SVG;
- animates active reasoning cues and completion pulses;
- invokes CodexBar for the optional weekly quota value;
- delegates keyboard, media, and push-to-talk operations to `keybridge`.

No Codex file is opened for writing.

### Native helper

`native/keybridge.m` is compiled by `scripts/build-bridge.sh` for `arm64` and `x86_64`, then joined into one universal executable.

It:

- emits Codex shortcuts and Return;
- holds and releases push-to-talk modifiers across Stream Deck key-down/key-up events;
- sends app-switch and media-key events;
- finds processes currently producing Core Audio output;
- suspends those process IDs during dictation and resumes the same IDs on release.

The helper uses macOS system frameworks only. Stream Deck needs Accessibility permission for synthesized input.

### Neo profile

The editable profile source lives under `profiles/source/unpacked`. `scripts/build-profile.sh` creates the `.streamDeckProfile` archive referenced by the plugin manifest. Hardware UUIDs are removed before publication so importing the profile does not bind it to the author's device.

ThreadDeck owns the bundled previous-page actions and exposes a next-page action. They use Stream Deck's official `switchToProfile` command with a page index, so navigation remains native while those keys participate in plugin-rendered completion overlays. Elgato-owned app-launch actions remain native and do not receive ThreadDeck overlays.

## Data refresh and rendering

- Task metadata refreshes every 3 seconds while a task action is visible.
- Active task timers and animation frames render at device-appropriate intervals.
- Weekly usage refreshes every 60 seconds while the quota action is visible.
- macOS appearance is checked every 2 seconds and swaps the renderer between the existing dark and light palettes.
- Completion is detected by comparing the newly observed end timestamp with the previous task snapshot. ThreadDeck-owned keys receive a global pulse; the matching task key receives the longer task pulse.

The plugin caches the last image for each context and avoids sending unchanged frames.

## Documentation renderer

`scripts/render-docs.mjs` runs the same key-rendering functions in sanitized demo mode. It exports dark and light 4 × 2 feature overviews and exact individual-key PNGs. This keeps README images synchronized with the shipped interface without hand-redrawing controls.

## Stability boundary

The Stream Deck plugin protocol and profile manifest are public APIs. Codex files under `~/.codex` are not. Parsers therefore:

- accept missing or renamed optional fields;
- prefer stable IDs over titles;
- keep all access read-only;
- show a safe fallback instead of mutating state;
- isolate the private format boundary inside the task-reading functions.

A future public Codex App Server interface could replace the local parsers without changing the Stream Deck action and rendering layers.
