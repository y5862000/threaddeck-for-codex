# Architecture

> [Korean architecture guide](ARCHITECTURE.ko.md)

```text
Codex local state (~/.codex) ─┐
Codex Accessibility metadata ─┼─ src/plugin.js ── localhost WebSocket ── Stream Deck
CodexBar CLI (usage only) ────┘          │
                                         ├─ src/*.js domain modules
                                         └─ keybridge ── macOS input/audio/AX APIs
```

ThreadDeck keeps its runtime dependency-free. A Node.js process composes small CommonJS domain modules, visual rendering, and Stream Deck events; one universal native helper handles the macOS input and audio operations Node cannot provide reliably.

## Runtime components

### Node.js plugin

`src/plugin.js` is the composition and runtime entry point. It owns external I/O, caches, timers, SVG rendering, the Stream Deck WebSocket, and calls to the native helper. The build copies every top-level `src/*.js` module byte-for-byte to the matching `com.yechan.threaddeck.sdPlugin/bin/*.js` path. The manifest starts `bin/plugin.js`, which loads its sibling CommonJS modules.

It:

- connects to Stream Deck through the localhost plugin WebSocket;
- merges pinned and recent local SQLite tasks with only explicitly pinned cached remote summaries from Codex JSON state, deduplicating by conversation ID;
- normalizes working, completed, queued, error, and idle states;
- reconstructs remote starts from UUIDv7 turn IDs and freezes ends only from explicit lifecycle markers or confirmed live runtime transitions, never summary recency timestamps;
- normalizes remote reasoning-summary verbs into conservative intermediate phases in a separate turn-scoped, monotonic activity cache without exposing the source text;
- tracks the active Desktop session so closed temporary Side Chats do not reappear as ordinary tasks;
- renders every ThreadDeck-owned 144 × 144 key as SVG;
- animates active reasoning cues, queue-advance acknowledgements, and completion pulses;
- invokes CodexBar for the optional weekly quota value;
- delegates keyboard, media, and push-to-talk operations to `keybridge`;
- serializes push-to-talk media transitions behind an owner lease, so overlapping voice holds share one pause and only the final owner can resume playback;
- lets a held task key open that task, dictate a follow-up, detect transcription completion using text fingerprints, and submit it on release;
- gives each recording attempt a monotonically increasing session token, makes a new hold on any task key supersede the previous global composer session, and requires asynchronous transcription and submission callbacks to match that token before they can update the current session;
- routes remote opens through a target-scoped single flight: repeated presses for one task coalesce, a newer different target cancels stale work, accessible controls prefer exact UUID identity, unified search opens at most once, and a lightweight focused-header probe verifies that Codex activated the right task and host.

No Codex file is opened for writing.

### JavaScript module boundaries

The I/O-free modules under `src/` keep private Codex formats and deterministic policies out of the runtime coordinator:

| Module | Responsibility |
|---|---|
| `config.js` | Action UUIDs, timing constants, action maps, and stable fallback view state |
| `i18n.js` | English/Korean runtime copy, stable activity codes, and legacy-label migration |
| `runtime-info.js` | Stream Deck registration parsing, language selection, and platform capability boundary |
| `text.js` | Title normalization, NFC/NFD fingerprints, ambient-title filtering, and grapheme-aware layout helpers |
| `time.js` | UUIDv7 timestamps, recency normalization, duration formatting, and timing labels |
| `text-input.js` | Composer text-state parsing, comparison, and draft-reset detection |
| `queue-state.js` | Parsing accessibility fingerprints for localized queued-message controls and deriving queue counts |
| `thread-selection.js` | Local-first deduplication, explicit pinned-remote inclusion, recency ordering, and slot limits |
| `thread-privacy.js` | Structural subagent provenance checks and exact legacy injected-title fallbacks shared by every task source |
| `codex-state.js` | Parsing one Codex global-state snapshot into pinned IDs, prompt history, and normalized remote summary rows |
| `local-lifecycle.js` | Classifying local rollout activity and reducing JSONL events into lifecycle state |
| `remote-state.js` | Reducing remote lifecycle, activity, reasoning-effort, and runtime observations into display state |
| `log-lines.js` | UTF-8-safe append-only log framing, bounded partial-line carry, and file-rotation cursor validation |

### Native helper

`native/keybridge.m` is compiled by `scripts/build-bridge.sh` for `arm64` and `x86_64`, then joined into one universal executable.

It:

- emits Codex shortcuts and Return;
- holds and releases push-to-talk modifiers across Stream Deck key-down/key-up events;
- attaches an explicit Latin `D` to push-to-talk events while retaining the physical key code, making the shortcut independent of the active keyboard input source;
- sends app-switch and media-key events;
- resolves each active Core Audio process to its GUI owner without an app allowlist and verifies semantic pause/play controls;
- pauses those controls directly, uses the normal macOS media command only as a fallback, and records only bundle identifiers in a ten-minute local lease so release resumes the exact apps without retaining PIDs or media text;
- traverses the visible Codex accessibility tree once for the target UUID and normalized title fingerprints, activates only identity-safe pressable results, rejects title-only ambiguity in strict mode, verifies both the safety-critical frontmost task and the passive current task from the active Codex window header, and counts localized queue-action buttons without returning message text.

The helper uses macOS system frameworks only. Stream Deck needs Accessibility permission for synthesized input.

### Neo profile

The editable profile source lives under `profiles/source/unpacked`. `scripts/build-profile.sh` creates the `.streamDeckProfile` archive referenced by the plugin manifest. Hardware UUIDs are removed before publication so importing the profile does not bind it to the author's device.

ThreadDeck owns the bundled previous-page actions and exposes a next-page action. They use Stream Deck's official `switchToProfile` command with a page index, so navigation remains native while those keys participate in plugin-rendered completion overlays. Elgato-owned app-launch actions remain native and do not receive ThreadDeck overlays.

The Dashboard keeps Current Task at keypad position `0,1` and the combined Effort/Fast control at `1,1`. New Task, Side Chat, Send, microphone, quota, and back navigation fill the remaining slots. The dedicated Fast and app-switch actions remain available in the action list for custom profiles.

### Language and platform boundary

Stream Deck passes `application.language` and `application.platform` in its registration payload. ThreadDeck normalizes language once at startup, defaults unsupported languages to English, and renders stable domain activity codes through `src/i18n.js`. The same package also carries `en.json` and `ko.json` for action-list localization, so English and Korean never require separate plugin binaries.

The manifest deliberately declares only macOS today. `src/runtime-info.js` exposes the platform capability boundary, while all native input, Accessibility, audio, and active-app behavior remains behind `keybridge`. A future Windows port should implement that verified command contract as a platform adapter rather than scatter platform checks throughout the renderer and lifecycle reducers. See [Platform porting](PORTING.md).

## Data refresh and rendering

- Task metadata refreshes every 3 seconds while any ThreadDeck-owned action is visible.
- SQLite rows, remote summaries, and Side Chats pass through one privacy boundary before selection. Subagent provenance is rejected structurally before any sidebar title override; exact guardian and ambient prompt signatures remain a fallback for older metadata. A separate persistent-ID read prevents a hidden subagent from being reclassified through prompt history as a Side Chat.
- Each task refresh creates one read of the Codex global-state file and shares that same promise with the pinned-ID, remote-summary, and Side Chat prompt-history parsers. All three therefore observe the same file generation; if that read fails, each consumer applies its existing safe fallback instead of mixing fields from separate reads. Side Chat discovery supplements prompt history with an incremental reduction of successful desktop-log `thread/fork` → `thread/inject_items` pairs, preserving the exact parent and every distinct ephemeral UUID even when prompt history omits a sibling. An exact `thread/unsubscribe` closes only its matching UUID. The discovery state and byte cursors reset at the app-server session boundary, while a transient state-file rewrite retains the last verified rows.
- Pinned local tasks and explicitly pinned remote summaries are placed first; only local tasks and Side Chats fill the remaining recent slots. A local record wins if the same conversation ID appears in both sources.
- While the Dashboard is visible, a lightweight 750 ms active-window observer runs alongside the full state refresh so an in-app manual switch reaches the Current Task key in under a second. Send, the dedicated microphone, reasoning effort, Fast mode, and Side Chat force the same identity check immediately before acting; Send and microphone focus that composer, while Side Chat records the verified current task as its parent. Before a new Side Chat UUID exists, a separate provisional lease may focus only a geometrically verified right-side composer for the dedicated microphone; its request timestamp is replaced by the real UUID on discovery. The full refresh associates each queued-message control with its enclosing row and nearest task-pane header, so cached counts follow the owning main task or Side Chat key and decrement independently when that queued turn starts.
- A reasoning-effort press opens Codex's composer menu through Accessibility, enters the `Effort` submenu, enumerates only the options exposed by the current model, and activates the adjacent available option. Direction is retained per task and reverses at the first or last visible option. The transaction verifies the resulting effort and restores composer focus without mouse coordinates. Fast mode uses the same composer-state lease but requires a 600 ms hold before it can change speed, keeping the two controls physically distinct.
- Remote Desktop logs are tailed with a per-file byte offset and bounded raw-byte carry. Only complete UTF-8 lines are reduced, so a long reasoning-summary line or a multibyte character split across two polls is completed on the next poll. File identity and a boundary fingerprint detect rotation, truncation, and rapid same-path replacement before the cursor is reused.
- Active task timers and animation frames render at device-appropriate intervals.
- Weekly usage refreshes every 60 seconds while a ThreadDeck-owned action is visible, keeping the quota value warm before its page appears.
- macOS appearance is checked every 2 seconds and swaps the renderer between the existing dark and light palettes.
- Completion is detected by comparing end timestamps with an overlapping observation window and a startup grace period; queue observations fence stale handoffs but never create completion evidence by themselves. The first global frame is fanned out to every visible ThreadDeck-owned key before later frames are split into device-safe groups. The matching task key receives the longer initial pulse, then a lower-bandwidth breathing cue that persists locally until successful navigation or an exact frontmost Codex-task match acknowledges it.

The plugin caches the last image for each context and avoids sending unchanged frames.

## Build and verification boundaries

`scripts/build.sh` mirrors every top-level JavaScript source module into the plugin's `bin/` directory without transforming it and removes stale bundled JavaScript modules. `scripts/verify.sh` syntax-checks both copies and compares each pair byte-for-byte.

`pnpm run test` runs the I/O-free module contracts under `test/` with Node's built-in `node:test` runner. The runtime entry point retains small inline contract modes for behavior that depends on its coordinated context and caches: completion fan-out, refresh resilience, usage caching, voice submission, fast-mode rendering, remote-switch single-flight/search limits, stale-hold guards, and serialized media ownership. The full `pnpm run check` path runs both groups along with native-helper, manifest, documentation, and release checks.

## Documentation renderer

`scripts/render-docs.mjs` runs the same key-rendering functions in sanitized demo mode. It exports dark and light 4 × 2 feature overviews and exact individual-key PNGs. `scripts/render-animation.mjs` renders a deterministic 72-frame overview that steps the reasoning track, arms and enables Fast mode, dictates into a task, advances its queue, and fans out completion feedback; it also renders focused task hold-to-talk, dedicated-microphone, Send long-press, and app-launcher guide sequences. The shared `scripts/rasterize.mjs` helper uses the development-only Sharp dependency to rasterize SVGs deterministically; the repository-owned Swift/ImageIO helper encodes GIFs. ThreadDeck key states remain production renderer output with bilingual timelines around them. The Elgato-owned app-launcher behavior is represented by an explicitly neutral guide key rather than copied native artwork. Neither Sharp nor the documentation encoder is included in the runtime plugin.

## Stability boundary

The Stream Deck plugin protocol and profile manifest are public APIs. Codex files under `~/.codex` are not. Parsers therefore:

- accept missing or renamed optional fields;
- prefer stable IDs over titles;
- keep all access read-only;
- show a safe fallback instead of mutating state;
- isolate the private format boundary inside the task-reading functions.

A future public Codex App Server interface could replace the local parsers without changing the Stream Deck action and rendering layers.
