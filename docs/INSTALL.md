# Install ThreadDeck on another Mac

> [Korean installation guide](INSTALL.ko.md)

ThreadDeck ships as one bilingual Stream Deck plugin. The same download uses English when Stream Deck is in English and Korean when Stream Deck is in Korean; no separate language build is required.

## Before you start

- macOS 13 or later
- Stream Deck 7.4 or later
- Stream Deck Neo
- Codex Desktop installed as `com.openai.codex`

Apple silicon and Intel Macs use the same download. Each release also publishes
`com.yechan.threaddeck.streamDeckPlugin.sha256` if you want to verify the file before opening it.

The plugin automatically installs the recommended **ThreadDeck for Codex** Neo profile. A separate `threaddeck-for-codex-neo.streamDeckProfile` release asset is provided only for manual import, recovery, or creating an editable second copy; see the [profile guide](PROFILE.md).

## Install

1. Download `com.yechan.threaddeck.streamDeckPlugin` from [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases).
2. Double-click the file and approve installation in Stream Deck.
3. In Stream Deck, select the **ThreadDeck for Codex** profile. It is installed without replacing your current profile.
4. Open **System Settings → Privacy & Security → Accessibility**, allow **Stream Deck**, then quit and reopen Stream Deck completely.
5. Quit Codex and launch it normally once. ThreadDeck deliberately preserves a Codex process that was already open when the plugin started. After this later user-initiated launch, Codex may relaunch one additional time so ThreadDeck can attach its random loopback Micro bridge.
6. In **Codex → Settings → Keyboard Shortcuts**, set or confirm the fallback bindings:

| Codex function | Shortcut |
|---|---:|
| Start dictation | `Control+Shift+D` (`⌃⇧D`) |
| New task outside a project | `Option+Command+O` (`⌥⌘O`) |
| Open Side Chat | `Option+Command+S` (`⌥⌘S`) |

7. Hold the microphone key, speak, and release. Codex may request microphone permission on first use.

If **ThreadDeck for Codex** already appears in the profile menu, do not import the standalone profile unless you want a duplicate. An older profile named **Codex Neo** is a separate experimental copy and can be removed after you confirm the maintained profile works.

When the Micro bridge is connected, Effort, Fast mode, Side Chat, normal Send, New Task, push-to-talk, and six native task slots use Codex's own internal events. The shortcuts above remain important as a compatibility fallback. ThreadDeck's eight-card monitor, queues, goals, remote tasks, and non-Micro-slot navigation continue to use its existing read-only state and verified macOS adapter.

ThreadDeck does not need Screen Recording or Full Disk Access. The optional quota key needs [CodexBar](https://github.com/steipete/CodexBar); every other key works without it.

## If a key warns about setup

ThreadDeck checks Accessibility and keyboard-event access at startup and every 30 seconds. It requests missing macOS permission and keeps a short warning on the keys until the permission is healthy again.

The Effort/Fast key can also show **Restart Codex**. This is not an Accessibility failure: the current Codex generation simply predates the local renderer bridge. Quit and reopen Codex once. If the new normal launch still lacks the bridge, ThreadDeck performs at most one guarded relaunch for that process generation and then waits ten minutes before another recovery attempt. Set `THREADDECK_DISABLE_MICRO_BOOTSTRAP=1` before Stream Deck starts to disable that automatic recovery; legacy controls remain available.

From a source checkout, `pnpm run doctor` prints a read-only installation report, including whether the Codex Micro bridge is connected, needs a Codex restart, or is stopped. The doctor never starts, closes, or modifies either application. For user-facing fixes, see [Troubleshooting](TROUBLESHOOTING.md).

## Update or remove

- To update, install the newer `.streamDeckPlugin` file over the existing version.
- To remove it, right-click **ThreadDeck for Codex** in Stream Deck's plugin list and choose **Uninstall**. Your Codex data is never modified.
