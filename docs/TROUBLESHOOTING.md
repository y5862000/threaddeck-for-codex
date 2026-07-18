# Troubleshooting

## The quota key has no number

Install CodexBar and confirm that `codexbar usage --format json` works in Terminal. The plugin searches `CODEXBAR_PATH`, `~/.local/bin/codexbar`, `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, and finally your process `PATH`.

## Shortcuts or push-to-talk do not work

Open **System Settings → Privacy & Security → Accessibility** and allow **Stream Deck**. Quit and reopen Stream Deck after changing the permission.

## Task cards are empty

Open Codex Desktop and create at least one task. If a Codex update changed its local database format, collect the Stream Deck plugin log without including task titles or session contents and open an issue.

## The wrong appearance is shown

ThreadDeck follows the system appearance every two seconds. For debugging, launch Stream Deck with `THREADDECK_APPEARANCE=dark` or `THREADDECK_APPEARANCE=light`.

## Custom Codex data location

Set `CODEX_HOME`, or override individual paths with `THREADDECK_STATE_DB`, `THREADDECK_GLOBAL_STATE`, `THREADDECK_SESSION_INDEX`, and `THREADDECK_PROCESS_REGISTRY`.
