// Hardware-free end-to-end test of the emulator's protocol layer.
//
// It stands up the emulator behind a loopback transport, then plays the role of
// the ChatGPT app on the other end: framing RPC requests into 64-byte reports,
// reading framed responses back, and asserting the emulator answers correctly.
// Run with:  node --test   (or: npm test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexMicroEmulator } from "../src/emulator.js";
import { Link } from "../src/link.js";
import { LoopbackTransport } from "../src/transports/loopback.js";
import { encode, Reassembler, Channel } from "../src/framing.js";
import { Method, Notify } from "../src/protocol.js";

/** A minimal stand-in for the host app over a loopback transport. */
class FakeHost {
  constructor(transport) {
    this.transport = transport;
    this.reasm = new Reassembler();
    this.lines = [];
    this.waiters = [];
    transport.on("report", (buf) => {
      for (const { channel, message } of this.reasm.push(buf)) {
        if (channel !== Channel.RPC) continue;
        this.lines.push(message);
        const w = this.waiters.shift();
        if (w) w(JSON.parse(message));
      }
    });
  }

  // The real app sends bare JSON with NO trailing newline — match that so the
  // suite exercises the actual framing the firmware parses.
  send(obj) {
    for (const report of encode(JSON.stringify(obj), Channel.RPC)) {
      this.transport.write(report);
    }
  }

  /** Send a request and await the next line the device emits. */
  request(obj) {
    const p = new Promise((resolve) => this.waiters.push(resolve));
    this.send(obj);
    return p;
  }

  nextLine() {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function wire() {
  const emulator = new CodexMicroEmulator({ battery: 87, charging: true });
  const [deviceSide, hostSide] = LoopbackTransport.pair();
  new Link(emulator, deviceSide);
  return { emulator, host: new FakeHost(hostSide) };
}

test("device.status returns a well-formed status", async () => {
  const { host } = wire();
  const res = await host.request({ method: Method.DEVICE_STATUS, params: null, id: 42 });
  assert.equal(res.id, 42);
  assert.equal(res.result.battery, 87);
  assert.equal(res.result.is_charging, true);
  assert.equal(typeof res.result.version, "string");
  assert.equal(res.result.profile_index, 0);
});

test("sys.version returns the firmware version string", async () => {
  const { host } = wire();
  const res = await host.request({ method: Method.SYS_VERSION, params: null, id: 7 });
  assert.equal(res.result, "1.0.0");
});

test("lighting RPCs are acked and surface a lighting event", async () => {
  const { emulator, host } = wire();
  const lightings = [];
  emulator.on("lighting", (m) => lightings.push(m));

  const ack1 = await host.request({
    method: Method.OAI_THREADS_LIGHTING,
    params: [{ id: 0, c: 65356, b: 1, e: 1, s: 0 }], // slot 0 -> green/"complete"
    id: 100,
  });
  assert.equal(ack1.result, true);

  const ack2 = await host.request({
    method: Method.OAI_RGB_CONFIG,
    params: { keys: { e: 1, b: 1, s: 0, m: 0, c: 16777215 }, ambient: { e: 0, b: 0, s: 0, m: 0, c: 0 } },
    id: 101,
  });
  assert.equal(ack2.result, true);

  assert.equal(lightings.length, 2);
  assert.equal(lightings[0].slots[0].c, 65356);
  assert.equal(lightings[1].keys.c, 16777215);
});

test("unknown methods are still acked (so the host never hangs)", async () => {
  const { host } = wire();
  const res = await host.request({ method: "some.future.method", params: {}, id: 5 });
  assert.equal(res.id, 5);
  assert.equal(res.result, true);
});

test("key presses are emitted as v.oai.hid notifications", async () => {
  const { emulator, host } = wire();
  const linep = host.nextLine();
  emulator.tapAgent(2); // AG02 press+release; we read the first (press)
  const note = await linep;
  assert.equal(note.m, Notify.HID);
  assert.equal(note.p.k, "AG02");
  assert.equal(note.p.ag, 2);
  assert.equal(note.p.act, 1);
});

test("joystick movement is emitted as a v.oai.rad notification", async () => {
  const { emulator, host } = wire();
  const linep = host.nextLine();
  emulator.sendJoystick(0.25, 0.9);
  const note = await linep;
  assert.equal(note.m, Notify.JOYSTICK);
  assert.equal(note.p.a, 0.25);
  assert.equal(note.p.d, 0.9);
});

test("messages longer than one report survive reassembly", async () => {
  const { host } = wire();
  // Force a params payload that pushes the JSON well past 61 bytes.
  const big = "x".repeat(200);
  const res = await host.request({ method: Method.SYS_VERSION, params: { pad: big }, id: 999 });
  assert.equal(res.id, 999);
  assert.equal(res.result, "1.0.0");
});
