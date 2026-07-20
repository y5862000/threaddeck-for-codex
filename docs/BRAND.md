# ThreadDeck brand guide

> [Korean brand guide](BRAND.ko.md)

## Positioning

**Name:** ThreadDeck for Codex<br>
**Short name:** ThreadDeck<br>
**English tagline:** Codex tasks, at a glance.<br>
**Korean tagline:** maintained in [`BRAND.ko.md`](BRAND.ko.md).

ThreadDeck is a local-first physical task dashboard. Brand language should emphasize glanceability, direct control, privacy, and the Stream Deck Neo form factor. Avoid presenting it as an official Codex or Elgato product.

## Original mark

The canonical mark is [`assets/plugin.svg`](../assets/plugin.svg). It combines a four-key grid with a mint-to-blue thread path. Use the supplied asset without redrawing, stretching, adding vendor logos, or placing text inside it.

Recommended clear space is one quarter of the mark's width on every side. At small sizes, use the mark alone; at larger sizes, pair it with the full project name.

## Color

The mark and product UI use the existing renderer palette:

| Role | Dark appearance | Light appearance |
|---|---:|---:|
| Canvas | `#000000` | `#F9F9F9` |
| Primary text | `#F2F6FA` | `#0D0D0D` |
| Secondary surface | `#2F2F2F` | `#ECECEC` |
| Thread green | `#10A37F` | `#10A37F` |
| Active blue | `#0285FF` | `#0285FF` |
| Warning | `#F5A524` | `#AC4F23` |

Purple appears only as an active reasoning-state cue. It is not the primary brand color.

## Typography

Use the system font stack already defined in `src/plugin.js`. Korean falls back to Apple SD Gothic Neo. ThreadDeck does not redistribute OpenAI Sans, SF Pro files, or any other proprietary font files.

## Documentation imagery

- Show the real renderer output created by `pnpm run render-docs`.
- Use sanitized titles and stable demonstration states.
- Keep the complete 4 × 2 grid visible for overview images.
- Use exact individual key renders for feature callouts; do not redraw controls or simulate hardware.
- For a bundled third-party action whose native artwork is not owned by this repository, use an explicitly labeled neutral guide instead of copying its icon or pretending the guide is runtime output.
- Show both light and dark appearance when discussing appearance support.
- Use the deterministic GIFs from `pnpm run render-animation` when motion or completion behavior matters.

## Naming and attribution

Use “ThreadDeck for Codex” on first mention and “ThreadDeck” afterward. Include the unofficial-project disclaimer anywhere a download is offered outside this repository. OpenAI, Codex, Elgato, and Stream Deck remain their owners' trademarks; see [NOTICE.md](../NOTICE.md).
