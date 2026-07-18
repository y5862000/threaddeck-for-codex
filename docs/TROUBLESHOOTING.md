# Troubleshooting

> [한국어 문제 해결](TROUBLESHOOTING.ko.md)

## The quota key has no number

Install CodexBar and confirm that `codexbar usage --format json` works in Terminal. The plugin searches `CODEXBAR_PATH`, `~/.local/bin/codexbar`, `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, and finally your process `PATH`.

## Shortcuts or push-to-talk do not work

Open **System Settings → Privacy & Security → Accessibility** and allow **Stream Deck**. Quit and reopen Stream Deck after changing the permission.

For task-key dictation, keep holding the task key while speaking. Releasing it ends recording; ThreadDeck then waits for Codex transcription to stabilize and submits the ordinary follow-up. If the key shows an error, confirm Codex's push-to-talk shortcut is `Control+Shift+D` and the message editor is visible.

## Task cards are empty

Open Codex Desktop and create at least one task. If a Codex update changed its local database format, collect the Stream Deck plugin log without including task titles or session contents and open an issue.

## The queue badge does not appear

Open the task in Codex so its queue is visible, and confirm Stream Deck has Accessibility permission. ThreadDeck observes queue actions only in the currently open Codex task, then retains the count on that task key. The initial release recognizes Korean and English Codex UI labels.

## A closed Side Chat briefly reappears

Update to the latest beta. ThreadDeck scopes temporary Side Chats to the current Codex App Server session and remembers close events across transient state-file rewrites. If one still returns, include the Codex and ThreadDeck versions in an issue, but do not attach Desktop logs or real task titles.

## The wrong appearance is shown

ThreadDeck follows the system appearance every two seconds. For debugging, launch Stream Deck with `THREADDECK_APPEARANCE=dark` or `THREADDECK_APPEARANCE=light`.

## Custom Codex data location

Set `CODEX_HOME`, or override individual paths with `THREADDECK_STATE_DB`, `THREADDECK_GLOBAL_STATE`, `THREADDECK_SESSION_INDEX`, and `THREADDECK_PROCESS_REGISTRY`.
