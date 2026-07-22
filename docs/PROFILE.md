# Recommended Stream Deck Neo profile

> [Korean profile guide](PROFILE.ko.md)

ThreadDeck ships one editable, three-page profile designed for the eight-key **Stream Deck Neo**. Its name in the Stream Deck profile menu is **ThreadDeck for Codex**.

![Recommended ThreadDeck for Codex dashboard on Stream Deck Neo](media/neo-preview.png)

## Get the profile

The recommended path is to install `com.yechan.threaddeck.streamDeckPlugin` from [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases). The plugin installs this profile automatically without replacing the profile you currently use.

The release pipeline also exports `threaddeck-for-codex-neo.streamDeckProfile` as a separate asset for recovery, manual import, or an editable second copy. The standalone profile still requires the ThreadDeck plugin for its Codex actions.

> [!NOTE]
> If **ThreadDeck for Codex** already appears in the profile menu, do not import the standalone file unless you intentionally want a duplicate. Older experimental profiles such as **Codex Neo** can remain installed, but they are not the maintained recommended profile.

## Page 1 — Dashboard

| Weekly quota | New task | Side Chat | Send |
|---|---|---|---|
| Current task | Effort + Fast | Microphone | Previous page |

This is the recommended everyday page: monitor the task selected in Codex, set the next response's Effort/Fast state, dictate, and send without changing pages.

## Page 2 — Tasks

| Top Task 1 | Top Task 2 | Top Task 3 | Top Task 4 |
|---|---|---|---|
| Top Task 5 | Top Task 6 | Top Task 7 | Previous page |

`Top Task 8` remains available in the ThreadDeck action list for custom layouts. The separate Current Task action is deliberately kept on the Dashboard.

## Page 3 — Media and apps

| Previous track | Rewind | Play/Pause | Codex |
|---|---|---|---|
| Stream Deck | Music | Chrome | Previous page |

The four app launchers are Elgato's editable **Open Application** actions. Change or remove them in Stream Deck if your preferred apps differ. ThreadDeck-owned media and page keys continue to receive the coordinated completion effect.

## Customize safely

- Duplicate the profile in Stream Deck before making a large rearrangement.
- Keep at least one Previous/Next Page action if you retain multiple pages.
- The profile source is hardware-UUID-free and lives under [`profiles/source/unpacked`](../profiles/source/unpacked).
- The release audit verifies the Neo model and every recommended key coordinate before publishing.
