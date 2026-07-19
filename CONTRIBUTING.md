# Contributing

> [한국어 기여 안내](CONTRIBUTING.ko.md)

Thanks for helping improve ThreadDeck. Small, focused pull requests are easiest to review and safest for a hardware workflow.

## Before you start

- Search existing issues and pull requests.
- For a user-facing behavior change, open a feature request first and describe the Stream Deck model, page, and expected interaction.
- Never attach a real `~/.codex` database, session file, access token, device serial, or screenshot containing private task titles.
- Do not add OpenAI or Elgato logos, proprietary fonts, or copied product assets. Follow [docs/BRAND.md](docs/BRAND.md).

## Development setup

You need macOS, Node.js 20+, pnpm, Xcode Command Line Tools, Stream Deck 7.4+, Stream Deck Neo, and Codex Desktop.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check
```

`pnpm run build` compiles the universal native helper, copies every top-level `src/*.js` module byte-for-byte to the matching plugin `bin/*.js` path, and builds the distributable profile. `pnpm run test` runs the I/O-free parser and policy contracts with Node's built-in test runner. `pnpm run check` repeats those tests, verifies source-to-bundle byte parity with no missing or stale JavaScript modules, and validates the inline runtime contracts, JSON, both helper architectures, the Stream Deck manifest, documentation, and the release privacy audit.

To build an installer:

```sh
pnpm run pack
```

Packaging uses an exact temporary staging copy, so the Stream Deck packer's manifest normalization does not modify the verified plugin directory.

To regenerate documentation screenshots from the real key renderer:

```sh
pnpm run render-docs
pnpm run render-animation
```

## Project boundaries

1. Keep the plugin macOS-only unless the native bridge and every local data source are implemented for another platform.
2. Treat every file under `~/.codex` as an unstable, read-only implementation detail. Missing fields must fail gracefully.
3. Keep the runtime plugin dependency-free unless a dependency clearly reduces risk or maintenance.
4. Preserve Elgato-owned default navigation and app actions; do not replace or delete them from user profiles.
5. Keep text readable on a physical 144 × 144 key. Test at device size, not only in a large preview.
6. Keep light and dark appearances behaviorally equivalent.

## Pull request checklist

- Run `pnpm run build`, `pnpm run test`, `pnpm run audit`, and `pnpm run check`.
- If you add or rename a top-level `src/*.js` module, confirm the build produces the matching byte-identical `bin/*.js` module and removes any stale bundled name.
- Describe the tested macOS, Stream Deck software, Stream Deck model, and Codex versions.
- Include before/after photos or generated key renders for visual changes, with private titles removed.
- Update English and Korean README content together when public behavior changes.
- Add a changelog entry for user-visible fixes or features.

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE).
