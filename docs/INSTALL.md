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

## Install

1. Download `com.yechan.threaddeck.streamDeckPlugin` from [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases).
2. Double-click the file and approve installation in Stream Deck.
3. In Stream Deck, select the **ThreadDeck for Codex** profile. It is installed without replacing your current profile.
4. Open **System Settings → Privacy & Security → Accessibility**, allow **Stream Deck**, then quit and reopen Stream Deck completely.
5. In **Codex → Settings → Keyboard Shortcuts**, set or confirm:

| Codex function | Shortcut |
|---|---:|
| Start dictation | `Control+Shift+D` (`⌃⇧D`) |
| New task outside a project | `Option+Command+O` (`⌥⌘O`) |
| Open Side Chat | `Option+Command+S` (`⌥⌘S`) |

6. Hold the microphone key, speak, and release. Codex may request microphone permission on first use.

ThreadDeck does not need Screen Recording or Full Disk Access. The optional quota key needs [CodexBar](https://github.com/steipete/CodexBar); every other key works without it.

## If a key warns about setup

ThreadDeck checks Accessibility and keyboard-event access at startup and every 30 seconds. It requests missing macOS permission and keeps a short warning on the keys until the permission is healthy again.

From a source checkout, `pnpm run doctor` prints a read-only installation report. For user-facing fixes, see [Troubleshooting](TROUBLESHOOTING.md).

## Update or remove

- To update, install the newer `.streamDeckPlugin` file over the existing version.
- To remove it, right-click **ThreadDeck for Codex** in Stream Deck's plugin list and choose **Uninstall**. Your Codex data is never modified.
