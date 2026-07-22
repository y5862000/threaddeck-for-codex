# Security and privacy

> [Korean security and privacy guide](SECURITY.ko.md)

ThreadDeck runs locally. It has no telemetry, analytics, update server, remote API, or code that uploads Codex task metadata.

## Local access

- The plugin reads local Codex state under `~/.codex` and Codex Desktop logs to draw user task cards, reconstruct remote turn timing, and track temporary Side Chats. Remote cards come only from metadata already cached locally by Codex Desktop; ThreadDeck does not contact the remote Mac. Internal helper and review tasks are filtered before rendering. The plugin does not write to Codex database or session files.
- The optional quota ring starts the separately installed `codexbar` command and reads its JSON output.
- The preferred control adapter connects to a random Chrome DevTools Protocol port explicitly bound to `127.0.0.1`. It validates the endpoint and main `app://` renderer before use. Its read-only snapshot returns only active task identity, next-run Effort, Fast state, theme, six privacy-bounded Micro slots, and capability booleans; prompt, response, queued-message, and transcript text do not cross this boundary.
- A physical action may dispatch Codex's internal Micro command, HID, or push-to-talk event through that renderer. The Micro feature override is installed only in the current renderer memory immediately before a required action and disappears with that process. ThreadDeck does not patch application files, write Codex settings, or persist the override.
- `~/Library/Application Support/ThreadDeck/codex-micro-bootstrap-v1.json` and `codex-micro-bridge.json` store only process generation, loopback port, health/cooldown state, recovery attempt markers, and numeric timestamps. The first already-running Codex process is preserved; a later normal launch may receive one rate-limited guarded relaunch to attach the loopback bridge. Set `THREADDECK_DISABLE_MICRO_BOOTSTRAP=1` to disable this recovery.
- Keyboard and media actions are emitted by a small native helper and require macOS Accessibility permission for Stream Deck. Marketplace packages keep their distributed files immutable: ThreadDeck verifies the bundled helper bytes, stages a content-addressed executable copy under `~/Library/Application Support/ThreadDeck/bin`, and executes only that exact copy.
- Task navigation and composer controls use exact accessibility focus plus keyboard activation. When Codex exposes it, the helper matches the target task UUID in-process before falling back to privacy-safe title fingerprints; known duplicate titles require UUID identity. The helper does not synthesize mouse movement or coordinate clicks.
- The same helper counts visible Codex queue-action buttons. It outputs only FNV-1a fingerprints and counts for the current window title and button labels; queued message text is ignored and never crosses the helper boundary.
- For an exactly matched focused task, the helper may also return one fixed reasoning-level enum (`none` through `ultra`). Arbitrary accessibility text never crosses the helper boundary.
- Task-key push-to-talk compares only length/hash metadata for the focused editable field to detect when transcription has stabilized. The helper never returns dictated text to the plugin.
- Before push-to-talk, the helper resolves active Core Audio processes to their GUI owners without an app allowlist and activates only a verified semantic pause control. It falls back to the normal macOS media command only when needed. A temporary ten-minute lease stores only paused bundle identifiers so the final recording owner resumes those apps; it never stores a PID, title, URL, or media text and never signals or freezes a process. Exit handlers release held modifiers and restore media only when ThreadDeck owns that pause.
- ThreadDeck writes a bounded local diagnostic trace to `~/Library/Logs/ThreadDeck/runtime.jsonl` (or `THREADDECK_TRACE_PATH`). It is truncated at 256 KiB and contains only timestamps, event/phase names, slot numbers, booleans, coarse results, and elapsed milliseconds. Task titles, task IDs, dictated or queued text, remote host names, accessibility text, and credentials are neither accepted nor written by this trace.

Read-only Codex file access does not mean the hardware is passive: when the user presses a key, ThreadDeck can intentionally open Codex UI, start or stop dictation, and submit the dictated message through the visible composer controls.

CDP is a powerful local debugging interface. Binding it to loopback prevents remote-network access but does not protect it from another process already running as the same macOS user. Do not enable ThreadDeck on an account where untrusted local software runs. ThreadDeck rejects `0.0.0.0`, non-loopback WebSocket targets, stale ports, and non-`app://` targets, and it never publishes the port outside its mode-`0600` local state file.

The control plane falls back only after a definite pre-dispatch Micro-unavailable result. A timeout, disconnect, or failed verification after possible delivery is treated as ambiguous and is not replayed through keyboard or Accessibility automation. This fail-closed rule prevents duplicate submissions, task switches, and Fast toggles.

Because the plugin displays task titles, anyone who can see your Stream Deck may see sensitive project names. Do not use real private titles in issue screenshots.

## Supported versions

Security fixes target the latest published beta. Please reproduce issues with the latest release before reporting them.

## Report a vulnerability privately

Use [GitHub Private Vulnerability Reporting](https://github.com/y5862000/threaddeck-for-codex/security/advisories/new). Do not open a public issue for a vulnerability.

Never upload any of the following:

- `~/.codex` databases or session files;
- API keys, tokens, cookies, or authorization headers;
- Stream Deck device serials or exported profiles that still contain hardware identifiers;
- screenshots containing private task titles or customer information.

For non-security questions, follow [SUPPORT.md](SUPPORT.md).
