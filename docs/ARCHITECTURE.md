# Architecture

> [Korean architecture guide](ARCHITECTURE.ko.md)

```text
Codex local state (~/.codex) ───────────────┐
Codex renderer (random 127.0.0.1 CDP) ──────┼─ src/plugin.js ── localhost WebSocket ── Stream Deck
Codex Accessibility metadata ───────────────┤          │
CodexBar CLI (usage only) ──────────────────┘          ├─ control-plane.js
                                                       ├─ micro-cdp.js (preferred)
                                                       ├─ src/*.js domain modules
                                                       └─ keybridge (legacy + macOS audio/AX)
```

ThreadDeck keeps its runtime dependency-free. A Node.js process composes small CommonJS domain modules, visual rendering, Stream Deck events, and an optional Codex Micro renderer adapter; one universal native helper retains the macOS input, audio, Accessibility, and compatibility operations Node cannot provide reliably.

The control plane is Micro-first but not Micro-only. It may fall back to the legacy adapter only after a definite pre-dispatch `unavailable` result. A timeout, disconnect, or verification failure after possible delivery is ambiguous and is never replayed through Accessibility, preventing double Fast toggles, duplicate submissions, or two task switches.

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
- routes user controls through `control-plane.js`, using Codex Micro first and the existing native adapter only when no Micro event could have been delivered;
- preserves the separate eight-task monitor while mapping exact identities found in Codex's six native Micro slots to direct `AG00`–`AG05` switching.

No Codex file is opened for writing.

### JavaScript module boundaries

The I/O-free modules under `src/` keep private Codex formats and deterministic policies out of the runtime coordinator:

| Module | Responsibility |
|---|---|
| `config.js` | Action UUIDs, timing constants, action maps, and stable fallback view state |
| `i18n.js` | English/Korean runtime copy, stable activity codes, and legacy-label migration |
| `runtime-info.js` | Stream Deck registration parsing, language selection, and platform capability boundary |
| `control-plane.js` | Micro-first command routing, read-only health caching, and no-replay fallback semantics |
| `micro-cdp.js` | Loopback renderer discovery, privacy-bounded read-only snapshots, native Micro commands, PTT, Effort encoder events, and six-slot switching |
| `micro-bootstrap.js` | First-session preservation, one guarded recovery relaunch, random loopback-port state, and opt-out handling |
| `reasoning-options.js` | Read-only Codex desktop configuration/model-cache parsing and the globally visible Effort catalog |
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

The helper uses macOS system frameworks only. Stream Deck needs Accessibility permission for synthesized input. Micro-native Effort, Fast, Side Chat, normal Send, New Task, PTT, and six-slot switching do not require synthesized shortcuts once the renderer bridge is connected; the helper remains authoritative for media handling, composer verification, queues, remote/non-slot navigation, long Send, and compatibility fallback.

### Codex Micro renderer adapter

`src/micro-cdp.js` accepts only a debugger endpoint explicitly bound to `127.0.0.1`, validates both `/json/version` and the main `app://` renderer target, then communicates over the loopback CDP WebSocket. Its periodic snapshot is mutation-free and returns only the active task identity, next-run Effort, Fast state, theme, six privacy-bounded slot rows, and capability booleans. It does not return prompt, response, queued-message, or transcript text.

Mutating Micro activation is lazy: only the first physical control that needs HID/PTT installs an in-memory renderer feature-gate override and announces a connected Micro device. Official keycap commands drive Fast, Side Chat, Send, and New Task; host PTT events drive microphone input; Effort invokes the same internal `composer.openModelPicker` power-selection command that Codex dispatches for `ENC_CW`/`ENC_CC` with `act: 2`; and `AG00`–`AG05` drive exact native slots. The override exists only in that renderer process.

After an `AG00`–`AG05` delivery, ThreadDeck verifies the canonical destination UUID from either the active composer identity or the exact Micro slot marked `selected`. The selected-slot signal is authoritative when the composer DOM is one frame behind; a bounded retry window still rejects an unconfirmed delivery. Only that verified result updates Current Task and acknowledges a persisted unread completion.

`src/micro-bootstrap.js` never interrupts the Codex generation that was already running when ThreadDeck first observes it. After the user later closes and normally reopens Codex, a stable unbridged generation may receive one guarded relaunch with a random loopback port. Attempts are generation-scoped and rate-limited for ten minutes; `THREADDECK_DISABLE_MICRO_BOOTSTRAP=1` disables recovery. Only process-generation, port, health, cooldown, and timestamp data are stored under `~/Library/Application Support/ThreadDeck`.

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
- While the Dashboard is visible, a lightweight 750 ms observer combines the read-only Micro active identity with the existing Accessibility window probe, so a manual in-app switch reaches Current Task and every dependent control in under a second. Send, microphone, Effort, Fast, and Side Chat re-confirm the same identity before acting. Before a new Side Chat UUID exists, the existing provisional lease may focus only a geometrically verified right-side composer; it is replaced by the real UUID on discovery. Queue controls remain associated with their enclosing task pane so main-task and Side Chat counts decrement independently.
- At plugin startup and after a Codex App Server or renderer generation change, ThreadDeck reads `config.toml` and `models_cache.json` to prime the visible Effort catalog, then reconciles it with the read-only Micro composer value. Every tap starts a 320 ms eased track transition and rapid input keeps repainting without waiting for Codex. Ordinary Micro-reachable levels settle for 90 ms and dispatch only the final internal encoder traversal. `Max`, `Ultra`, or a verified encoder result that skipped the requested level instead waits for the 1.1-second pause, opens the exact `Advanced` picker, rescans the live account/model options, selects the exact target, handles only the fixed Ultra Full-access warning, and restores composer focus. Direction reverses at either endpoint. A 600 ms hold fires Fast immediately through the native command and cannot dispatch again on release.
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

Codex App Server now has an experimental per-thread Effort update method, but Codex Desktop owns a private stdio child process with no supported external attachment transport. A separately started server can update its own resumed thread state but cannot synchronize the task already loaded in Desktop. ThreadDeck therefore does not run a shadow server or write Codex session files. The current renderer bridge is explicitly an undocumented compatibility layer: capability discovery, one-shot fallback, and the stable `control-plane.js` interface allow a future supported transport—or a Windows adapter—to replace it without changing the Stream Deck renderer or task reducers.
