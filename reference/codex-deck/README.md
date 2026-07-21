# Codex Deck attribution

ThreadDeck's optional Codex Micro renderer bridge adapts the loopback CDP target-selection,
renderer-event, and feature-activation approach from
[`dazer1234/codex-stream-deck`](https://github.com/dazer1234/codex-stream-deck), especially:

- `src/codex-micro-renderer-bridge.ts`
- `launcher/runtime-override.ts`

The ThreadDeck implementation is dependency-free CommonJS, uses its own guarded bootstrap and
fallback policy, and does not copy Codex Deck's UI, media, session-ownership layer, or hardware
backend. The upstream MIT license is preserved in `LICENSE.upstream`.
