# Codex Micro protocol reference snapshot

> [Korean reference notes](README.ko.md)

This directory is a research-only, pinned subset of
[`mpociot/codex-micro-stream-deck-emulator`](https://github.com/mpociot/codex-micro-stream-deck-emulator)
at commit [`7093bd48f0bcb953f623b40c727470e545b48df3`](https://github.com/mpociot/codex-micro-stream-deck-emulator/tree/7093bd48f0bcb953f623b40c727470e545b48df3).
The selected upstream files are byte-for-byte copies; `package.json`, this README, and
`UPSTREAM.sha256` are ThreadDeck-owned scaffolding.

## Why this subset is kept

The useful boundary is the dependency-free, transport-neutral protocol core:

- `framing.js` handles fixed 64-byte HID reports and the asymmetric bare-JSON/newline framing;
- `protocol.js` records the discovered Codex Micro identity, RPC methods, key events, and effects;
- `emulator.js`, `link.js`, and `transports/loopback.js` demonstrate a small event-driven state
  machine separated from physical I/O;
- `states.js` and `keycaps.js` preserve a dated semantic reference for status colors and command
  names without redistributing proprietary artwork;
- the two tests provide hardware-free framing and end-to-end contracts that can seed a future
  ThreadDeck transport refactor.

## Deliberately excluded

The ChatGPT process-injection shim, launch scripts, native virtual-HID helper, Stream Deck hardware
backend, renderer, mappings, and media assets are not copied. The shim is update-fragile, the native
helper needs a restricted Apple entitlement, and the hardware backend conflicts with ThreadDeck's
official Stream Deck plugin architecture. ThreadDeck should not acquire those operational risks just
to reuse the protocol-layer design.

## Integration boundary

Nothing in `src/`, the Stream Deck plugin bundle, profile, or release artifact imports this directory.
It is not a supported runtime dependency. During a future refactor, port the transport/state-machine
patterns and their tests into ThreadDeck-owned modules, then verify them against the current Codex
version instead of assuming this private protocol snapshot remains stable.

Verify the preserved snapshot with:

```sh
cd reference/codex-micro-protocol
shasum -a 256 -c UPSTREAM.sha256
node --test test/*.mjs
```

The copied files remain under Marcel Pociot's MIT License in `LICENSE.upstream`.
