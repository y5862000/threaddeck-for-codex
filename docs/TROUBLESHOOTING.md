# Troubleshooting

> [Korean troubleshooting guide](TROUBLESHOOTING.ko.md)

## Start here

1. Update Codex Desktop, Stream Deck, and ThreadDeck to the latest versions you intend to test.
2. In **System Settings → Privacy & Security → Accessibility**, enable **Stream Deck**.
3. Quit Stream Deck completely and reopen it after changing Accessibility permission.
4. Confirm Codex has microphone permission and **Start dictation** is `Control+Shift+D`.
5. Keep Codex open with a composer visible while testing voice actions.

ThreadDeck does not require Screen Recording or Full Disk Access.

## The ThreadDeck profile is not visible

The Neo profile is installed with the plugin but is not forced over your current profile. Choose **ThreadDeck for Codex** from the profile selector at the top of the Stream Deck app. If it is missing, reinstall the latest `.streamDeckPlugin` package and restart Stream Deck.

## No shortcut, media, or remote-switch action works

ThreadDeck checks three layers independently at startup and every 30 seconds:

- **`Allow access`** — Stream Deck lacks macOS Accessibility authorization;
- **`Input access`** — macOS is discarding synthesized key events even if Accessibility appears enabled;
- **`Codex access`** — both preflights pass, but two consecutive read-only Codex AX probes fail;
- **`Check Codex` / `Check input`** — permissions pass, but the corresponding real operation failed twice within 30 seconds;
- **`Check media`** — an active media owner was found, but its state or pause command could not be confirmed.

For either missing permission, ThreadDeck invokes the official macOS request at most once per ten minutes and keeps the warning visible. It rechecks automatically and shows the Stream Deck success acknowledgement when access recovers. If a permission switch already looks enabled but `Codex access` remains, remove and re-add Stream Deck in the Accessibility list, then quit and reopen Stream Deck. A `Check` warning instead points to a Codex UI or shortcut compatibility problem that should be reported with the current versions.

## Task-key hold does not start recording

A task key has two paths:

- release before **0.55 seconds** to open the task only;
- keep holding past **0.55 seconds**; a slow remote switch may first show `Switching`, so continue holding until the card shows `Listening`, speak while held, then release to transcribe and auto-submit.

If the card shows an error, confirm Codex is available, its composer is visible, microphone permission is granted, and Start dictation is `Control+Shift+D`. ThreadDeck detects when Codex audio input never starts instead of leaving a false recording state.

The keyboard layout can stay Korean or another non-Latin input source. ThreadDeck sends a physical D with an explicit Latin `D`.

## The dedicated microphone leaves text but does not send it

That is the intended behavior. The microphone is a review-first push-to-talk key: press to record immediately, hold while speaking, and release to leave the transcript in the Codex composer. Use the Send key afterward, or hold a task key when you want automatic submission.

ThreadDeck does not use a media-app allowlist. It resolves each active Core Audio process to its GUI owner, activates only a visible semantic pause/play control it can verify, and uses the normal macOS media command only as a conservative fallback. The exact app bundles it paused are kept in a ten-minute local lease so release resumes only those apps after the final voice key is released. Apple Music, Chrome YouTube, and Safari YouTube are physically tested. It never freezes a process or stores a PID, title, URL, or media text. A browser session can still represent more than one tab. If `Check media` remains visible, bring the playing tab or app forward once and verify Stream Deck Accessibility permission.

## The Send key uses the wrong shortcut

Both actions happen on release:

- release before **0.6 seconds** → Return;
- keep holding until the key turns blue, then release → Command+Return.

If it never turns blue, remove and re-add the Send action or reinstall the latest plugin build.

## An app closes from the Media page

The four bundled app launchers use Elgato's Open Application action with long-press set to **Quit**. Tap briefly to open or focus Stream Deck, Music, Chrome, or Codex. Holding the launcher invokes Stream Deck's configured quit action. You can replace the app or change that long-press setting in Stream Deck.

## Task cards are empty

Open Codex Desktop and create at least one task. Local pinned and recent user tasks should fill the list. If a Codex update changed its local database format, include only version information and a privacy-sanitized Stream Deck plugin log in an issue.

## A remote task is missing

ThreadDeck intentionally excludes unpinned remote history. To show one remote task:

1. open that computer in Codex once so Desktop caches its summary;
2. explicitly pin the task in Codex;
3. wait for the next ThreadDeck refresh.

Unpinning it removes it from the hardware list. Internal helper and review tasks are always excluded.

## A remote task does not open

Remote selection requires Stream Deck Accessibility permission. ThreadDeck activates the exact Codex sidebar or unified-search result from the keyboard; it does not use screen coordinates.

Repeated presses for the same task share one in-flight switch. ThreadDeck prefers an exact task UUID exposed by Codex, tries the accessible sidebar control first, and only if it is unavailable opens unified search once. A lightweight focused-header probe waits adaptively for the verified result. A newer press for a different task cancels the stale switch; known duplicate titles are never opened through title-only fallback.

- **Accessibility** — permission is missing.
- **Duplicate title** — more than one remote result has the exact title. Rename or unpin one.
- **Check remote** — Codex no longer exposes that cached computer or task. Open the computer in Codex again.

## A remote duration looks unknown

ThreadDeck does not treat cached summary timestamps as completion events. If it did not observe a trustworthy terminal marker or live end transition, it shows an unknown duration instead of fabricating a short value. Open the task while it is active for the best live timing coverage.

## `Could not read status` flashes or replaces the list

Update to the latest beta. ThreadDeck retries short transient reads and keeps the last good task list. A startup error is shown only after three consecutive failures before any valid list has loaded. If the message persists, restart Codex and Stream Deck and report their versions without real task titles.

## Only the completed task key pulses

Update to the latest build. The first completion frame is sent to every visible ThreadDeck-owned key before later frames are grouped. Elgato-owned actions such as the four app launchers on the Media page keep native rendering and cannot receive the overlay.

## The queue badge does not appear

Open the task in Codex so its queued actions are visible and confirm Accessibility permission. ThreadDeck observes the currently open task, then retains that privacy-safe count on its key. Korean and English Codex accessibility labels are recognized; queued message contents are not read.

## A closed Side Chat reappears

Update to the latest beta. Temporary Side Chats are scoped to the current Codex App Server session, and close events survive transient state-file rewrites. Persistent task IDs, including archived IDs, are blocked from re-entering through prompt history as Side Chats.

## The quota key has no number

Install CodexBar and confirm this works in Terminal:

```sh
codexbar usage --format json
```

ThreadDeck searches `CODEXBAR_PATH`, `~/.local/bin/codexbar`, `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, and then `PATH`. It prefetches quota on every visible ThreadDeck page and keeps the last successful value during a transient failure.

## The wrong light or dark appearance is shown

ThreadDeck follows system appearance every two seconds. For debugging, launch Stream Deck with `THREADDECK_APPEARANCE=dark` or `THREADDECK_APPEARANCE=light`.

## Custom Codex data location

Set `CODEX_HOME`, or override individual paths with `THREADDECK_STATE_DB`, `THREADDECK_GLOBAL_STATE`, `THREADDECK_SESSION_INDEX`, and `THREADDECK_PROCESS_REGISTRY`.

## Reporting a problem safely

Include macOS, Codex Desktop, Stream Deck, ThreadDeck, and device model versions plus the exact key and gesture used. The privacy-safe ThreadDeck trace is `~/Library/Logs/ThreadDeck/runtime.jsonl`; it contains no task titles or IDs and is capped at 256 KiB. Do not attach raw Codex Desktop logs, session files, database files, real task titles, remote host names, or device identifiers. See [Security and privacy](../SECURITY.md).
