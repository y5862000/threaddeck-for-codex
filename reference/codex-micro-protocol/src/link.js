import { Reassembler, encode, Channel } from "./framing.js";

/**
 * Binds a {@link CodexMicroEmulator} to a transport. The transport speaks raw
 * 64-byte HID reports; the link handles framing so the emulator only ever sees
 * complete RPC lines.
 *
 * Transport contract:
 *   - `transport.on("report", (buf: Buffer) => void)`  inbound report
 *   - `transport.write(buf: Buffer): void`             outbound report
 */
export class Link {
  /**
   * @param {import("./emulator.js").CodexMicroEmulator} emulator
   * @param {object} transport
   */
  constructor(emulator, transport) {
    this.emulator = emulator;
    this.transport = transport;
    this.reassembler = new Reassembler();

    this._onReport = this._onReport.bind(this);
    this._onSend = this._onSend.bind(this);

    transport.on("report", this._onReport);
    emulator.on("send", this._onSend);
  }

  _onReport(buf) {
    for (const { channel, message } of this.reassembler.push(buf)) {
      if (channel === Channel.RPC) {
        this.emulator.handleLine(message);
      }
      // Debug-channel lines from the host are not part of the RPC flow.
    }
  }

  _onSend(line) {
    for (const report of encode(line, Channel.RPC)) {
      this.transport.write(report);
    }
  }

  dispose() {
    this.transport.off?.("report", this._onReport);
    this.emulator.off?.("send", this._onSend);
  }
}
