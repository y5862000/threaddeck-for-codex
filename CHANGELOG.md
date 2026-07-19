# Changelog

> [한국어 변경 기록](CHANGELOG.ko.md)

## Unreleased

- Added a dedicated Codex Fast mode toggle at Dashboard position `1,1`, replacing the bundled app-switcher key while keeping the app-switch action available for custom layouts. Dashboard task slot 1 now explicitly represents the current task or the last task whose switch ThreadDeck successfully confirmed.
- Made one physical press self-retry and verify local and Side Chat deep links before reporting success. Fast mode now re-reads the live composer state on every press, reconciles late native confirmation, refreshes while visible, and serializes composer-changing actions so a task switch cannot redirect the toggle.
- Made dictation release fail closed and self-healing: a new recording, auto-submit, and media resume now wait for confirmed inactive Codex audio; transient Stop/CoreAudio delays retry through one global generation-safe gate without ever pressing a changed Start control. Persistent unknown start probes no longer cancel a valid hold, rapid handoffs debounce media resume to remove the play/pause blip, and shutdown cleanup is idempotent.
- Made remote task activation single-flight: repeated presses for the same target share one navigation, a newer different target cancels the stale attempt, exact task UUIDs are preferred over normalized title fingerprints, known duplicate titles require strict UUID identity, and unified search is opened and filled at most once with lightweight adaptive readiness polling.
- Preserved task-key hold intent while a remote target and its composer become ready, added a visible preparing state, rejected auto-submit when the exact target composer cannot be verified, and prevented a slow released hold from deleting the next press.
- Replaced process freezing during push-to-talk with the normal macOS media play/pause command, issued asynchronously under a balanced multi-key lease so audio stops more cleanly and resumes only after the final recording owner releases.
- Kept the fast-service lightning cue visible for completed, stopped, idle, and error cards as well as working cards, and added interaction contracts covering the badge, remote fallback, hold races, target guard, and media lease.
- Reorganized the English and Korean user guides around installation and physical key gestures, corrected the overview animation to show the real task-key auto-submit path, and added reproducible GIFs for task hold-to-talk, dedicated-microphone draft dictation, the blue Send long-press state, and the bundled app launchers' long-press-to-quit behavior. Stream Deck action tooltips now spell out the same thresholds and release behavior.
- Excluded Codex subagent and guardian review rows from every task-button source using structural provenance (`thread_source`, `source.subagent`, and `agent_path`), with exact injected-title signatures as a legacy fallback. Hidden persistent IDs also cannot re-enter as temporary Side Chats.
- Mapped turn- and timestamp-validated remote reasoning summaries into privacy-safe intermediate phases such as Planning, Analyzing, Implementing, Verifying, Running, and Summarizing; waiting, error, and terminal states still take precedence, and stale or mismatched phases are hidden.
- Kept pinned/recent local tasks in the automatic list, included only explicitly pinned remote tasks in ordinary slots, allowed the exact current/last successfully switched remote task as the single slot-1 exception, and made those remote keys activate the correct computer through Codex's own sidebar or unified search.
- Stopped treating remote-summary recency timestamps as completion boundaries; completed durations now prefer explicit lifecycle ends or confirmed live `active` → `notLoaded` transitions, with transient disconnects ignored and unknown cold-start ends left unspecified.
- Replaced synthesized Codex row, composer-focus, dictation-stop, and Send mouse clicks with exact accessibility focus plus keyboard activation, so task keys are resolution-independent and no longer move the pointer. Long task-key holds now prepare composer focus asynchronously near the hold threshold instead of adding that work after the hold is recognized.
- Guaranteed the first completion pulse frame reaches every visible ThreadDeck-owned key, then reduced grouped animation traffic for reliable Neo updates.
- Made push-to-talk independent of the active keyboard input source, ended current app-scoped dictation through Codex's visible stop control on release, and detected failed audio starts.
- Retried transient task-list read failures and kept the last good list so a one-off error card cannot flash across the keys.
- Prefetched weekly quota on every visible ThreadDeck page and preserved the last good value, removing the multi-second wait when the quota page appears.
- Restored composer focus after dictation, submitted through Codex's visible Send control, verified that the draft cleared, and retried safely with Return when needed.
- Added actionable key feedback for missing Accessibility permission, duplicate remote titles, and unavailable remote tasks, plus regression checks for completion fan-out and voice event encoding.
- Split the monolithic plugin into dependency-free CommonJS domain and parser modules, and shared one global Codex state snapshot across each refresh instead of reading it independently for related views.
- Hardened asynchronous state handling with UTF-8-safe bounded log carry and rotation detection, typed remote-log parsing and reducers, last-good Side Chat snapshots, and global voice-submission session tokens that isolate late results from an earlier send or another task key.
- Added `node:test` fixture coverage and source-to-bundle byte-parity checks, and changed release packaging to build once and pack an exact staging copy so the verified artifact is shipped without dirtying its source directory.

## 0.2.0-beta — 2026-07-18

- Added hold-to-dictate on every task key: open the task, record while held, wait for transcription, and submit on release.
- Added temporary Side Chat monitoring with Desktop-session scoping and closed-chat suppression.
- Hardened completion detection with an observation overlap, startup grace, queue-advance pulses, and full plugin-owned key coverage.
- Added recording, transcribing, submitting, sent, and error visuals shared by the microphone and target task keys.
- Improved light-mode completion contrast, quota/feedback alignment, queue badge spacing, navigation centering, and animation smoothness.
- Added a deterministic animated GIF generated by the real renderer and complete Korean mirrors for project documentation.
- Replaced the bundled native back keys with ThreadDeck-owned previous-page actions, added a next-page action, and extended completion pulses to page navigation.
- Introduced the “Codex tasks, at a glance” brand system and original ThreadDeck usage guidelines.
- Added detailed English and Korean documentation with real dark/light renderer output and feature images.
- Documented the complete MIT-licensed source-to-artifact boundary, local privacy model, and runtime architecture.
- Added reproducible documentation rendering, dependency-license auditing, support guidance, and GitHub contribution templates.

## 0.1.0-beta — 2026-07-18

- Added a three-page Stream Deck Neo profile with a task dashboard, seven task slots plus page navigation, and a compact media/app page.
- Added live Codex task state, elapsed/completed timing, reasoning/service-tier animation, and completion pulses.
- Added a weekly quota ring backed by CodexBar.
- Added task navigation, new task, side chat, push-to-talk, send, app switcher, and media actions.
- Added system light/dark appearance support.
- Added a universal macOS native helper and local-only privacy model.
