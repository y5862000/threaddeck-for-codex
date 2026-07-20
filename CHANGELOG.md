# Changelog

> [한국어 변경 기록](CHANGELOG.ko.md)

## Unreleased

- Added a Dashboard reasoning-effort key in place of the bundled New Task slot while keeping New Task available for custom profiles. A short press paints the next track position immediately, then enumerates the current model's actual `Effort` submenu, moves one available step, and reconciles or rolls back after verification; direction reverses at either endpoint. The same key shows a small verified speed bolt and toggles Fast mode on a 0.6-second hold, while the dedicated Fast action toggles on a normal release.
- Added a lightweight active-window observer that updates the Dashboard Current Task within one second after a manual switch in Codex. Send, the dedicated microphone, Fast mode, and Side Chat now re-confirm that task at press time; Send and microphone focus its composer, and a new Side Chat records it as the parent. Side Chat creation now keeps a navigation lease until the new ephemeral task is discovered and focused, so microphone, Send, Fast, and reasoning controls cannot fall through to the previous task. This also fixes the dedicated microphone overlay following an older last-opened task.
- Added proactive permission and runtime health monitoring. ThreadDeck now checks macOS Accessibility, event-posting access, and a read-only Codex AX probe separately at startup and every 30 seconds; invokes the official macOS permission request with a cooldown when either authorization is missing; keeps a clear warning on visible keys; and acknowledges recovery automatically. Native commands now fail with distinct permission exit codes instead of silently succeeding when synthesized keys were discarded. Two repeated Codex or input-operation failures with healthy permissions raise a persistent diagnostic warning rather than disappearing as a brief key error.
- Repaired push-to-talk media pausing on current macOS builds whose global Now Playing APIs can report `paused` while audio is actually playing. ThreadDeck now resolves active Core Audio processes to GUI owners without an app allowlist, uses verified semantic pause/play controls, and resumes only the bundle IDs in a short-lived local lease. Apple Music plus Chrome and Safari YouTube were physically tested. An unresolved media-control failure raises a persistent `미디어 점검` warning instead of being silently ignored.
- Restored the exact Codex composer focus after every Fast mode transaction, dismissing a still-visible speed menu first and retrying through Chromium composer replacement so Send, dictation, and subsequent shortcuts work immediately.
- Added persistent unviewed-completion attention: the completed task keeps a slow green pulse across plugin restarts until successful navigation or an exact frontmost Codex-task match acknowledges it, while failed switches leave the alert intact.
- Changed the Dashboard key from Current / Last Switched to **Current Task**. It now follows the task selected in Codex's active window, including manual in-app switches, while retaining the stricter frontmost-task check for dictation and submission safety.

## 0.3.2-beta — 2026-07-19

- Collapsed Fast mode read, inversion, and selection into one native transaction, eliminating the repeated model-menu flashes that made a single physical press feel sluggish.
- Stopped treating a merely live CoreAudio process as proof that media is playing. Voice input now pauses only when macOS also confirms active playback, so already-paused music or video cannot be toggled back on; an unknown playback state leaves media untouched.
- Simplified the Fast mode key to an icon-only verified on/off state, kept text for attention states only, and redrew the lightning silhouette with a pointed apex so it no longer looks cropped.
- Made Fast mode refresh after task switches fully read-only, so it never opens the model picker. Because Codex renders the closed picker's bolt as an Accessibility-hidden SVG, ThreadDeck preserves the exact task's recorded `service_tier` and last verified value; the real menu opens only for an explicit Fast mode key press.

## 0.3.1-beta — 2026-07-19

- Fixed packaged installations that stripped the native `keybridge` executable bit. The Node entry point now repairs and verifies the helper before any plugin mode starts, a release test reproduces the installed `0666` layout, and the package fails closed if self-repair does not work.
- Updated Fast mode for the current Codex model menu. ThreadDeck now opens the exact accessibility-scoped selector with keyboard focus and Return when Chromium reports a successful but ineffective `AXPress`, recognizes Korean descriptive options such as `표준 기본 속도` and `빠름 1.5배 속도`, selects them without mouse coordinates, closes the menu with Escape, and confirms the resulting live state.
- Added compatible explicit `sharp` build approval for both the pinned pnpm 10 toolchain and newer pnpm clients.

## 0.3.0-beta — 2026-07-19

- Added a separately selectable **Top Task 1** action (`com.yechan.threaddeck.thread.top1`) without repurposing the existing Current / Last action. The bundled Tasks page now starts with Top Task 1, while the Dashboard keeps Current / Last and Fast mode; both task actions retain tap-to-open and hold-to-dictate behavior.
- Repaired remote reasoning-intensity and service-speed reconciliation. Exact task-and-turn-scoped composer observations now survive remote refreshes without treating the ambiguous summary `mode` field as speed, and the Fast/standard action icon no longer falls into unavailable merely because the old always-visible control is absent.
- Separated queue observation from completion detection: editing, deleting, or dequeuing a waiting prompt no longer starts the green task or whole-deck pulse. A pulse now requires a fresh final-turn end marker with a stable empty queue; delayed remote old-turn markers are fenced at the queue handoff, while the eventual queued turn can still pulse when it actually finishes.
- Added the Lucide Goal target to unfinished-goal task cards and switched their timer from the latest turn to Codex's accumulated goal time. Local goals use the read-only goal database; focused remote goals use privacy-safe fixed-label Accessibility detection and a seven-day objective-free cache. Active time alone advances, blocked/paused/limited/complete/stopped/error/idle states freeze at one immutable value, token-budget rows retain their badge, and a new automatic continuation can resume a provisional cutoff.
- Added a dedicated Codex Fast mode toggle at Dashboard position `1,1`, replacing the bundled app-switcher key while keeping the app-switch action available for custom layouts. The Dashboard's Current / Last key explicitly represents the current task or the last task whose switch ThreadDeck successfully confirmed.
- Made one physical press self-retry and verify local and Side Chat deep links before reporting success. Fast mode now re-reads the live composer state on appearance, after a verified task switch, and on every press; it reconciles late native confirmation and serializes composer-changing actions so a task switch cannot redirect the toggle.
- Made dictation release fail closed and self-healing: a new recording, auto-submit, and media resume now wait for confirmed inactive Codex audio; transient Stop/CoreAudio delays retry through one global generation-safe gate without ever pressing a changed Start control. Persistent unknown start probes no longer cancel a valid hold, rapid handoffs debounce media resume to remove the play/pause blip, and shutdown cleanup is idempotent.
- Made remote task activation single-flight: repeated presses for the same target share one navigation, a newer different target cancels the stale attempt, exact task UUIDs are preferred over normalized title fingerprints, known duplicate titles require strict UUID identity, and unified search is opened and filled at most once with lightweight adaptive readiness polling.
- Preserved task-key hold intent while a remote target and its composer become ready, added a visible preparing state, rejected auto-submit when the exact target composer cannot be verified, and prevented a slow released hold from deleting the next press.
- Replaced process freezing during push-to-talk with the normal macOS media play/pause command, issued asynchronously under a balanced multi-key lease so audio stops more cleanly and resumes only after the final recording owner releases.
- Kept the fast-service lightning cue visible for working, stopped, idle, and error cards while hiding it on completed cards so the check remains the single terminal signal, and added interaction contracts covering the badge, remote fallback, hold races, target guard, and media lease.
- Reorganized the English and Korean user guides around installation and physical key gestures, corrected the overview animation to show the real task-key auto-submit path, and added reproducible GIFs for task hold-to-talk, dedicated-microphone draft dictation, the blue Send long-press state, and the bundled app launchers' long-press-to-quit behavior. Stream Deck action tooltips now spell out the same thresholds and release behavior.
- Excluded Codex subagent and guardian review rows from every task-button source using structural provenance (`thread_source`, `source.subagent`, and `agent_path`), with exact injected-title signatures as a legacy fallback. Hidden persistent IDs also cannot re-enter as temporary Side Chats.
- Mapped turn- and timestamp-validated remote reasoning summaries into privacy-safe intermediate phases such as Planning, Analyzing, Implementing, Verifying, Running, and Summarizing; waiting, error, and terminal states still take precedence, and stale or mismatched phases are hidden.
- Kept pinned/recent local tasks in the automatic list, included only explicitly pinned remote tasks in ordinary Top Task slots, allowed the exact current/last successfully switched remote task as the separate Current / Last exception, and made those remote keys activate the correct computer through Codex's own sidebar or unified search.
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
