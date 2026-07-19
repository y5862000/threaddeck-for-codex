# Open-source inventory

> [한국어 오픈소스 구성표](OPEN_SOURCE.ko.md)

ThreadDeck's implementation is fully published under the [MIT License](../LICENSE). This document makes the boundary between repository-owned source, generated artifacts, optional tools, and proprietary runtime applications explicit.

## Source-to-artifact map

| Source | Generated artifact | Build step |
|---|---|---|
| Top-level `src/*.js` modules | Matching `com.yechan.threaddeck.sdPlugin/bin/*.js` modules, copied byte-for-byte | `scripts/build.sh` |
| `native/keybridge.m` | Universal `com.yechan.threaddeck.sdPlugin/bin/keybridge` | `scripts/build-bridge.sh` |
| `profiles/source/unpacked/` | Bundled `.streamDeckProfile` archive | `scripts/build-profile.sh` |
| `assets/plugin.svg` | Plugin PNG assets | `scripts/build-assets.sh` |
| Actual key-rendering functions in `src/plugin.js` | `docs/media/neo-preview*` and feature PNGs | `scripts/render-docs.mjs` |
| Deterministic demo frames + `scripts/encode-gif.swift` | `docs/media/threaddeck-demo.gif` | `scripts/render-animation.mjs` |
| Plugin directory | `.streamDeckPlugin` installer | `pnpm run pack` |

Generated `bin/`, profile archives, and release installers are ignored by Git because they are reproducibly built from the source above. Verification compares every bundled JavaScript module with its source byte-for-byte and rejects missing or stale modules. Documentation PNGs and the GIF are tracked so GitHub visitors can see the interface without running the plugin; their source is the same renderer shipped in the plugin.

## Dependency boundary

- The runtime Node.js plugin uses only built-in Node modules.
- `@elgato/cli` is a development dependency used to validate and pack the plugin. It is MIT licensed and not bundled as application logic.
- [CodexBar](https://github.com/steipete/CodexBar) is an optional, separately installed MIT-licensed executable used only for quota data.
- Xcode Command Line Tools and macOS system frameworks compile and run the native helper.

## External proprietary applications

Codex Desktop and Stream Deck are required to use the plugin. They are proprietary external applications, are not redistributed here, and are not covered by ThreadDeck's MIT License. Their requirement does not hide any ThreadDeck source: every component authored for this plugin is present in this repository.

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
