# Open-source inventory

> [Korean open-source inventory](OPEN_SOURCE.ko.md)

ThreadDeck's implementation is fully published under the [MIT License](../LICENSE). This document makes the boundary between repository-owned source, generated artifacts, optional tools, and proprietary runtime applications explicit.

## Source-to-artifact map

| Source | Generated artifact | Build step |
|---|---|---|
| Top-level `src/*.js` modules | Matching `com.yechan.threaddeck.sdPlugin/bin/*.js` modules, copied byte-for-byte | `scripts/build.sh` |
| `native/keybridge.m` | Universal `com.yechan.threaddeck.sdPlugin/bin/keybridge` | `scripts/build-bridge.sh` |
| `profiles/source/unpacked/` | Bundled `.streamDeckProfile` archive | `scripts/build-profile.sh` |
| `assets/plugin.svg` | Plugin PNG assets | `scripts/build-assets.sh` |
| Actual key-rendering functions in `src/plugin.js` | `docs/media/neo-preview*` and feature PNGs | `scripts/render-docs.mjs` |
| Deterministic overview and gesture frames + `scripts/encode-gif.swift` | `docs/media/threaddeck-overview.gif`, task hold-to-talk, microphone hold, Send long-press, and neutral app-launcher guide GIFs | `scripts/render-animation.mjs` |
| Plugin directory | `.streamDeckPlugin` installer | `pnpm run pack` |

Generated `bin/`, profile archives, and release installers are ignored by Git because they are reproducibly built from the source above. Verification compares every bundled JavaScript module with its source byte-for-byte and rejects missing or stale modules. Documentation PNGs and GIFs are tracked so GitHub visitors can see the interface without running the plugin. ThreadDeck key artwork comes from the shipped renderer, with explanatory timelines around focused animations. The app-launcher GIF uses a neutral guide key because the bundled launchers and their real artwork are owned by Stream Deck.

## Dependency boundary

- The runtime Node.js plugin uses only built-in Node modules.
- `@elgato/cli` is a development dependency used to validate and pack the plugin. It is MIT licensed and not bundled as application logic.
- `sharp` is a development-only dependency used by `scripts/rasterize.mjs` to turn repository-owned SVGs into plugin and documentation PNGs. It and its platform packages are build tools and are not bundled in the runtime plugin. The exact Darwin `@img/sharp-libvips-*` 1.2.4 build packages carry `LGPL-3.0-or-later`; the license audit scopes its exception to those package names and that version while Sharp remains a development dependency, rather than allowing LGPL dependencies generally.
- [CodexBar](https://github.com/steipete/CodexBar) is an optional, separately installed MIT-licensed executable used only for quota data.
- Xcode Command Line Tools and macOS system frameworks compile and run the native helper.

## External proprietary applications

Codex Desktop and Stream Deck are required to use the plugin. They are proprietary external applications, are not redistributed here, and are not covered by ThreadDeck's MIT License. Their requirement does not hide any ThreadDeck source: every component authored for this plugin is present in this repository.

## Research-only upstream snapshot

`reference/codex-micro-protocol/` preserves a byte-for-byte subset of
[`mpociot/codex-micro-stream-deck-emulator`](https://github.com/mpociot/codex-micro-stream-deck-emulator)
at commit `7093bd48f0bcb953f623b40c727470e545b48df3`. The copied protocol, framing,
state catalogue, loopback transport, and tests remain under Marcel Pociot's MIT License, included
next to the snapshot as `LICENSE.upstream`. ThreadDeck-owned provenance notes, checksums, and package
scaffolding distinguish the copied files from local additions.

This reference is not imported by `src/`, built into the plugin, or included in release artifacts.
The process-injection shim, virtual-HID helper, hardware backend, renderer, and upstream media assets
were deliberately not copied.

## Runtime renderer-bridge attribution

`src/micro-cdp.js` and `src/micro-bootstrap.js` adapt the loopback CDP target-selection,
Codex Micro renderer-event, and feature-activation approach from
[`dazer1234/codex-stream-deck`](https://github.com/dazer1234/codex-stream-deck), especially
`src/codex-micro-renderer-bridge.ts` and `launcher/runtime-override.ts`.
Copyright (c) 2026 Dazer; used under the MIT License.

ThreadDeck rewrites that architecture as dependency-free CommonJS, adds its own first-session
preservation, generation-scoped recovery, privacy-bounded read-only snapshot, six-plus-eight task
hybrid, and no-replay fallback contract. Codex Deck's UI, media, session-ownership layer, and hardware
backend are not copied. The complete upstream license is preserved in
`reference/codex-deck/LICENSE.upstream` and ships inside every plugin installer as
`licenses/codex-deck-MIT.txt`.

## Reproducible verification

On a compatible Mac:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run audit
pnpm run check
pnpm run pack
```

The release audit rejects personal paths, hardware identifiers, secrets, proprietary font files, legacy private identifiers, and accidentally copied vendor assets. A separate dependency audit fails when a license outside the reviewed permissive allowlist appears. CI runs the same build and verification path on every push and pull request.

## Contributions and forks

You may use, modify, distribute, sublicense, and sell copies under the MIT License, subject to its copyright and license notice. The ThreadDeck project name and third-party product names should not be used to imply endorsement. See [BRAND.md](BRAND.md) and [NOTICE.md](../NOTICE.md).
