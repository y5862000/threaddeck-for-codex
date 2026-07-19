# Security and privacy

> [한국어 보안·개인정보 보호 안내](SECURITY.ko.md)

ThreadDeck runs locally. It has no telemetry, analytics, update server, remote API, or code that uploads Codex task metadata.

## Local access

- The plugin reads local Codex state under `~/.codex` and Codex Desktop logs to draw user task cards, reconstruct remote turn timing, and track temporary Side Chats. Remote cards come only from metadata already cached locally by Codex Desktop; ThreadDeck does not contact the remote Mac. Internal helper and review tasks are filtered before rendering. The plugin does not write to Codex database or session files.
- The optional quota ring starts the separately installed `codexbar` command and reads its JSON output.
- Keyboard and media actions are emitted by a small native helper and require macOS Accessibility permission for Stream Deck.
- Task navigation and composer controls use exact accessibility focus plus keyboard activation. When Codex exposes it, the helper matches the target task UUID in-process before falling back to privacy-safe title fingerprints; known duplicate titles require UUID identity. The helper does not synthesize mouse movement or coordinate clicks.
- The same helper counts visible Codex queue-action buttons. It outputs only FNV-1a fingerprints and counts for the current window title and button labels; queued message text is ignored and never crosses the helper boundary.
- For an exactly matched focused task, the helper may also return one fixed reasoning-level enum (`none` through `ultra`). Arbitrary accessibility text never crosses the helper boundary.
- Task-key push-to-talk compares only length/hash metadata for the focused editable field to detect when transcription has stabilized. The helper never returns dictated text to the plugin.
- Before push-to-talk, the helper checks whether a supported media app is actively producing Core Audio output and, if so, sends the normal macOS play/pause media command. ThreadDeck sends the matching resume command only when its final recording owner releases; it does not signal, freeze, or retain process IDs. Exit handlers release held modifiers and restore media only when ThreadDeck owns that pause.
- ThreadDeck writes a bounded local diagnostic trace to `~/Library/Logs/ThreadDeck/runtime.jsonl` (or `THREADDECK_TRACE_PATH`). It is truncated at 256 KiB and contains only timestamps, event/phase names, slot numbers, booleans, coarse results, and elapsed milliseconds. Task titles, task IDs, dictated or queued text, remote host names, accessibility text, and credentials are neither accepted nor written by this trace.

Read-only Codex file access does not mean the hardware is passive: when the user presses a key, ThreadDeck can intentionally open Codex UI, start or stop dictation, and submit the dictated message through the visible composer controls.

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
