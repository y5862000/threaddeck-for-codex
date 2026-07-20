# Platform porting guide

> [Korean porting guide](PORTING.ko.md)

ThreadDeck 0.4 targets macOS only. Its plugin protocol, task selection, renderer, English/Korean localization, and most lifecycle reducers are portable; the native Codex and media automation is not.

## Existing portability boundary

| Layer | Portable today | Platform-specific today |
|---|---|---|
| Stream Deck WebSocket and action UUIDs | Yes | Profile/device validation currently targets Neo |
| SVG key renderer and English/Korean copy | Yes | System appearance probe uses macOS `defaults` |
| Codex lifecycle, queue, goal, and task selection | Mostly | Local file/database locations follow Codex Desktop for macOS |
| User actions | Intent and result handling | `native/keybridge.m` uses macOS Accessibility, Core Audio, and synthesized key events |
| Packaging | Elgato `.streamDeckPlugin` | Manifest currently declares only `mac` |

`src/runtime-info.js` is the small registration boundary for Stream Deck language, platform, and capabilities. `src/i18n.js` keeps domain activity codes independent from the displayed language. A Windows port should add an adapter with equivalent verified outcomes instead of adding Windows branches throughout `src/plugin.js`.

## Minimum Windows adapter contract

A useful Windows contribution needs equivalents for:

1. locating Codex Desktop state and logs without writing to them;
2. identifying the active Codex task and exact composer;
3. opening local, remote, and Side Chat targets without screen coordinates;
4. dictation key-down/key-up, Send, Effort, and Fast mode with post-action verification;
5. active media pause/resume with ownership so ThreadDeck never resumes media it did not pause;
6. permission/health results that can drive the same persistent key warnings;
7. a Windows entry in the manifest and CI/package tests on a Windows runner.

The existing `keybridge` stdout formats and exit codes are the compatibility surface. Keep task metadata read-only and fail closed when identity or focus is ambiguous.

## Language is not a platform fork

Do not create separate English and Korean plugins. Stream Deck supplies `application.language`; the single runtime normalizes it to `en` or `ko`, while `en.json` and `ko.json` localize the Stream Deck action list. Additional platforms should reuse that same package-level language behavior.
