import { EventEmitter } from "node:events";

/**
 * In-memory transport pair for tests and hardware-free development. Two
 * endpoints cross-wired: whatever one writes, the other receives as a `report`.
 *
 * Use `LoopbackTransport.pair()` to get `[deviceSide, hostSide]`. Attach the
 * emulator's {@link Link} to `deviceSide`; drive `hostSide` to simulate the
 * ChatGPT app.
 */
export class LoopbackTransport extends EventEmitter {
  constructor() {
    super();
    /** @type {LoopbackTransport|null} */
    this.peer = null;
  }

  static pair() {
    const a = new LoopbackTransport();
    const b = new LoopbackTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  write(buf) {
    // Deliver asynchronously to mimic real IO ordering.
    const peer = this.peer;
    if (!peer) return;
    queueMicrotask(() => peer.emit("report", Buffer.from(buf)));
  }
}
