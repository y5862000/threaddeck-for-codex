# Security and privacy

> [Korean security and privacy guide](../docs/SECURITY.ko.md)

ThreadDeck runs locally. It has no telemetry, analytics, update server, remote API, or code that uploads Codex task metadata.

## Local access

- The plugin reads local Codex state under `~/.codex` and Codex Desktop logs to draw user task cards, reconstruct remote turn timing, and track temporary Side Chats. Remote cards come only from metadata already cached locally by Codex Desktop; ThreadDeck does not contact the remote Mac. Internal helper and review tasks are filtered before rendering. The plugin does not write to Codex database or session files.
- The optional quota ring starts the separately installed `codexbar` command and reads its JSON output.
- The preferred control adapter reuses a Chrome DevTools Protocol endpoint explicitly bound to loopback when the exact Codex process already owns one. Its read-only snapshot returns only active task identity, next-run Effort, Fast state, theme, six privacy-bounded Micro slots, and capability booleans; prompt, response, queued-message, and transcript text do not cross this boundary.
- If no persistent renderer endpoint exists, plugin startup may send `SIGUSR1` to the exact discovered Codex main PID so Node opens its default loopback inspector on port 9229. ThreadDeck refuses the route if another PID owns that listener and accepts only a loopback Node target. It uses that brief bootstrap to install an in-memory command server for only the main `app://-/index.html` renderer, then closes an inspector it opened before the first key press. Commands reuse a randomized Unix-domain socket with mode `0600`, bounded request frames, and a 256-bit token held only in process memory. Passive task monitoring never uses this socket. ThreadDeck does not activate, terminate, or relaunch Codex.
- A physical action may dispatch Codex's internal Micro command, HID, or push-to-talk event through that renderer. The Micro feature override is installed only in the current renderer memory immediately before a required action and disappears with that process. ThreadDeck does not patch application files, write Codex settings, or persist the override.
- `~/Library/Application Support/ThreadDeck/codex-micro-bootstrap-v1.json` and `codex-micro-bridge.json` store only process generation, persistent loopback port, health state, and numeric timestamps. ThreadDeck checks only listeners owned by the exact running Codex process and reconnects a verified persistent bridge when one exists. Neither the short-lived port 9229 session nor the prepared socket token is written to either state file.
- Keyboard and media actions are emitted by a small native helper and require macOS Accessibility permission for Stream Deck. Marketplace packages keep their distributed files immutable: ThreadDeck verifies the bundled helper bytes, stages a content-addressed executable copy under `~/Library/Application Support/ThreadDeck/bin`, and executes only that exact copy.
- Task navigation and composer controls use exact accessibility focus plus keyboard activation. When Codex exposes it, the helper matches the target task UUID in-process before falling back to privacy-safe title fingerprints; known duplicate titles require UUID identity. The helper does not synthesize mouse movement or coordinate clicks.
- The same helper counts visible Codex queue-action buttons. It outputs only FNV-1a fingerprints and counts for the current window title and button labels; queued message text is ignored and never crosses the helper boundary.
- For an exactly matched focused task, the helper may also return one fixed reasoning-level enum (`none` through `ultra`). Arbitrary accessibility text never crosses the helper boundary.
- Task-key push-to-talk compares only length/hash metadata for the focused editable field to detect when transcription has stabilized. The helper never returns dictated text to the plugin.
- Before push-to-talk, the helper resolves active Core Audio processes to their GUI owners without an app allowlist and activates only a verified semantic pause control. It falls back to the normal macOS media command only when needed. A temporary ten-minute lease stores only paused bundle identifiers so the final recording owner resumes those apps; it never stores a PID, title, URL, or media text and never signals or freezes a process. Exit handlers release held modifiers and restore media only when ThreadDeck owns that pause.
- ThreadDeck writes a bounded local diagnostic trace to `~/Library/Logs/ThreadDeck/runtime.jsonl` (or `THREADDECK_TRACE_PATH`). It is truncated at 256 KiB and contains only timestamps, event/phase names, slot numbers, booleans, coarse results, and elapsed milliseconds. Task titles, task IDs, dictated or queued text, remote host names, accessibility text, and credentials are neither accepted nor written by this trace.

Read-only Codex file access does not mean the hardware is passive: when the user presses a key, ThreadDeck can intentionally open Codex UI, start or stop dictation, and submit the dictated message through the visible composer controls.

CDP and the Node inspector are powerful local debugging interfaces. Binding them to loopback prevents remote-network access but does not protect them from another process already running as the same macOS user. Do not enable ThreadDeck on an account where untrusted local software runs. ThreadDeck rejects `0.0.0.0`, non-loopback WebSocket targets, stale ports, listeners owned by a different PID, and non-main renderer targets. Persistent ports never leave the mode-`0600` state file; the fixed bootstrap inspector port closes before normal button input. The prepared command socket is also same-user local control, but its pathname is randomized, its filesystem mode is `0600`, and its authentication token is never persisted.

The control plane falls back only after a definite pre-dispatch Micro-unavailable result. A timeout, disconnect, or failed verification after possible delivery is treated as ambiguous and is not replayed through keyboard or Accessibility automation. This fail-closed rule prevents duplicate submissions, task switches, and Fast toggles.

Because the plugin displays task titles, anyone who can see your Stream Deck may see sensitive project names. Do not use real private titles in issue screenshots.

## Supported versions

Security fixes target the latest published release. Please reproduce issues with the latest release before reporting them.

## Report a vulnerability privately

Use [GitHub Private Vulnerability Reporting](https://github.com/y5862000/threaddeck-for-codex/security/advisories/new). Do not open a public issue for a vulnerability.

Never upload any of the following:

- `~/.codex` databases or session files;
- API keys, tokens, cookies, or authorization headers;
- Stream Deck device serials or exported profiles that still contain hardware identifiers;
- screenshots containing private task titles or customer information.

For non-security questions, follow [SUPPORT.md](SUPPORT.md).
