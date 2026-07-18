# Contributing

Small, focused pull requests are welcome. Before submitting one:

1. Keep the plugin macOS-only unless the native bridge and data sources are implemented for another platform.
2. Do not add private Codex data, device serials, third-party fonts, or product logos.
3. Run `pnpm install`, `pnpm run build`, and `pnpm run check` on macOS.
4. Describe which Stream Deck model and Stream Deck software version you tested.
5. Treat the local Codex file formats as unstable implementation details and fail gracefully when fields are absent.

The interface is currently Korean-first. Please keep user-visible strings concise enough for a 144 × 144 Stream Deck key.
