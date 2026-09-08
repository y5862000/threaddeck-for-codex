"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { CodexIpcClient, validateCodexSocket } = require("../src/codex-ipc");

const CLIENT = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000002";
const OTHER = "30000000-0000-4000-8000-000000000003";

function frame(message) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function success(request, result = {}, handledByClientId = OWNER) {
  return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, handledByClientId, result };
}

function broadcast(params = {}, targetClientIds) {
  return { type: "broadcast", method: "snapshot", version: 11, sourceClientId: OWNER, params,
    ...(targetClientIds === undefined ? {} : { targetClientIds }) };
}

class FakeSocket extends EventEmitter {
  constructor({ initialize = true } = {}) {
    super();
    this.destroyed = false;
    this.writes = [];
    this.initialize = initialize;
  }
  write(bytes, callback) {
    const message = JSON.parse(bytes.subarray(4).toString("utf8"));
    this.writes.push(message);
    if (message.method === "initialize" && this.initialize) {
      queueMicrotask(() => this.emit("data", frame(success(message, { clientId: CLIENT }))));
    }
    callback?.();
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
  receive(message) { this.emit("data", frame(message)); }
}

function fixture(options = {}, socketOptions = {}) {
  const sockets = [];
  const client = new CodexIpcClient({
    socketPath: "/tmp/threaddeck-ipc-fixture.sock", timeoutMs: 300,
    validateSocket: async () => true,
    connectSocket: () => {
      const socket = new FakeSocket(socketOptions);
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    ...options
  });
  return { client, sockets, socket: () => sockets.at(-1) };
}

test("explicit connection shares initialization and assigns the server's client identity", async t => {
  const { client, sockets, socket } = fixture();
  t.after(() => client.close());
  assert.equal(client.isReady(), false);
  await assert.rejects(client.request("approval", {}), { code: "not-connected", delivery: "none" });
  const first = client.connect();
  assert.equal(client.connect(), first);
  await first;
  assert.equal(sockets.length, 1);
  assert.equal(client.isReady(), true);
  assert.equal(client.clientId, CLIENT);
  assert.equal(socket().writes[0].sourceClientId, "initializing-client");
  assert.deepEqual(socket().writes[0].params, { clientType: "threaddeck" });
  assert.equal(socket().writes[0].version, 0);
  await client.connect();
  assert.equal(socket().writes.length, 1);
  const epoch = client.epoch;
  client.close();
  assert.equal(client.isReady(), false);
  assert.ok(client.epoch > epoch);
  await client.connect();
  assert.equal(sockets.length, 2);
  assert.ok(client.epoch > epoch + 1);
});

test("request preserves routing, version, timeout, and correlates out-of-order responses", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  const first = client.request("owner", { first: true }, { version: 1, targetClientId: OWNER, hostId: "local", timeoutMs: 500 });
  const second = client.request("owner", { second: true });
  const [one, two] = socket().writes.slice(1);
  assert.equal(one.sourceClientId, CLIENT);
  assert.equal(one.targetClientId, OWNER);
  assert.equal(one.hostId, "local");
  assert.equal(one.version, 1);
  assert.equal(one.timeoutMs, 500);
  assert.notEqual(one.requestId, two.requestId);
  socket().receive(success(two, { ordinal: 2 }));
  socket().receive(success(one, { ordinal: 1 }));
  assert.equal((await second).result.ordinal, 2);
  assert.equal((await first).result.ordinal, 1);
});

test("split headers, split UTF-8 bodies, and multiple frames retain exact broadcast values", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  const values = [];
  client.on("broadcast", message => values.push(message.params.text));
  const one = frame(broadcast({ text: "Привет 🟡" }));
  for (const byte of one) socket().emit("data", Buffer.from([byte]));
  socket().emit("data", Buffer.concat([frame(broadcast({ text: "two" })), frame(broadcast({ text: "three" }))]));
  assert.deepEqual(values, ["Привет 🟡", "two", "three"]);
});

test("early broadcasts wait for initialize and honor explicit target lists", async t => {
  const { client, socket } = fixture({}, { initialize: false });
  t.after(() => client.close());
  const connecting = client.connect();
  await new Promise(resolve => setImmediate(resolve));
  const init = socket().writes[0];
  socket().receive(broadcast({ text: "ours" }, [CLIENT]));
  socket().receive(broadcast({ text: "other" }, [OTHER]));
  socket().receive(broadcast({ text: "empty" }, []));
  socket().receive(broadcast({ text: "all" }));
  socket().receive(success(init, { clientId: CLIENT }));
  await connecting;
  const values = [];
  client.on("broadcast", message => values.push(message.params.text));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(values, ["ours", "all"]);
});

test("client advertises no request handlers and never executes incoming requests", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  const requestId = randomUUID();
  socket().receive({ type: "client-discovery-request", requestId, request: { method: "arbitrary" } });
  socket().receive({ type: "request", requestId: randomUUID(), method: "arbitrary" });
  assert.equal(socket().writes.length, 2);
  assert.deepEqual(socket().writes[1], { type: "client-discovery-response", requestId, response: { canHandle: false } });
});

test("broadcast uses one targeted frame and performs no implicit connection", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  assert.throws(() => client.broadcast("follow", {}), { code: "not-connected", delivery: "none" });
  await client.connect();
  assert.equal(client.broadcast("follow", { following: true }, { version: 1, targetClientIds: [OWNER] }), true);
  assert.deepEqual(socket().writes[1], {
    type: "broadcast", method: "follow", sourceClientId: CLIENT, version: 1,
    targetClientIds: [OWNER], params: { following: true }
  });
});

for (const [error, delivery] of [
  ["no-client-found", "none"], ["request-version-mismatch", "none"], ["no-handler-for-request", "none"],
  ["request-timeout", "unknown"], ["client-disconnected", "unknown"], ["server-closed", "unknown"], ["future-error", "unknown"]
]) {
  test(`server ${error} response preserves the full error with ${delivery} delivery`, async t => {
    const { client, socket } = fixture();
    t.after(() => client.close());
    await client.connect();
    const request = client.request("approval", {}, { targetClientId: OWNER });
    const requestId = socket().writes.at(-1).requestId;
    socket().receive({ type: "response", requestId, resultType: "error", error });
    assert.deepEqual(await request, { type: "response", requestId, resultType: "error", error, delivery });
    assert.equal(client.isReady(), true);
  });
}

test("timeout has unknown delivery, releases pending state, and ignores late responses", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  const timed = client.request("approval", {}, { timeoutMs: 10 });
  const expired = socket().writes.at(-1);
  await assert.rejects(timed, { code: "request-timeout", delivery: "unknown" });
  assert.equal(client._state.pending.size, 0);
  const current = client.request("approval", {});
  socket().receive(success(expired, { expired: true }));
  assert.equal(client._state.pending.size, 1);
  socket().receive(success(socket().writes.at(-1), { current: true }));
  assert.deepEqual((await current).result, { current: true });
  assert.equal(socket().writes.length, 3);
});

test("disconnect invalidates all in-flight requests and ignores data from an older socket", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  const old = socket();
  const pending = client.request("approval", {});
  const rejected = assert.rejects(pending, { code: "disconnected", delivery: "unknown" });
  old.emit("end");
  await rejected;
  assert.equal(client.isReady(), false);
  await client.connect();
  const messages = [];
  client.on("broadcast", message => messages.push(message));
  old.receive(broadcast());
  old.emit("error", Error("stale error"));
  assert.equal(client.isReady(), true);
  assert.equal(messages.length, 0);
});

for (const [name, mutate] of [
  ["method mismatch", response => { response.method = "different"; }],
  ["target mismatch", response => { response.handledByClientId = OTHER; }],
  ["missing handler", response => { delete response.handledByClientId; }],
  ["invalid result type", response => { response.resultType = "unknown"; }]
]) {
  test(`correlated ${name} closes the connection without retry`, async t => {
    const { client, socket } = fixture();
    t.after(() => client.close());
    await client.connect();
    const pending = client.request("approval", {}, { targetClientId: OWNER });
    const rejected = assert.rejects(pending, { code: "invalid-response", delivery: "unknown" });
    const response = success(socket().writes.at(-1));
    mutate(response);
    socket().receive(response);
    await rejected;
    assert.equal(client.isReady(), false);
    assert.equal(socket().writes.length, 2);
  });
}

for (const [name, payload] of [
  ["zero-length", Buffer.alloc(4)],
  ["oversized", Buffer.from([1, 0, 0, 4])],
  ["malformed JSON", frame(Buffer.from("{"))],
  ["invalid UTF-8", frame(Buffer.from([0x22, 0xff, 0x22]))],
  ["array envelope", frame([])]
]) {
  test(`${name} frame closes without retaining request state`, async t => {
    const { client, socket } = fixture();
    t.after(() => client.close());
    await client.connect();
    const state = client._state;
    const pending = client.request("approval", {});
    const rejected = assert.rejects(pending, error => error.delivery === "unknown");
    socket().emit("data", payload);
    await rejected;
    assert.equal(client.isReady(), false);
    assert.equal(state.pending.size, 0);
    assert.equal(state.body, null);
  });
}

test("bad initialization cannot establish client identity", async t => {
  const { client, socket } = fixture({}, { initialize: false });
  t.after(() => client.close());
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, { code: "invalid-initialize" });
  await new Promise(resolve => setImmediate(resolve));
  socket().receive(success(socket().writes[0], { clientId: "not-a-uuid" }));
  await rejected;
  assert.equal(client.isReady(), false);
  assert.equal(client.clientId, null);
});

test("connect timeout also bounds a silent initialize", async t => {
  const { client, socket } = fixture({ timeoutMs: 15 }, { initialize: false });
  t.after(() => client.close());
  await assert.rejects(client.connect(), { code: "connect-timeout", delivery: "none" });
  assert.equal(socket().destroyed, true);
  assert.equal(client._state, null);
});

test("close during asynchronous validation prevents any later socket connection", async () => {
  let release;
  const validation = new Promise(resolve => { release = resolve; });
  const { client, sockets } = fixture({ validateSocket: () => validation });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, { code: "closed", delivery: "none" });
  client.close();
  release(true);
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 0);
});

test("validator failure opens no socket and a changed identity sends no initialize", async () => {
  const denied = fixture({ validateSocket: async () => false });
  await assert.rejects(denied.client.connect(), { code: "untrusted-socket" });
  assert.equal(denied.sockets.length, 0);
  let validations = 0;
  const changed = fixture({ validateSocket: async () => ({ dev: 1, ino: ++validations, parentDev: 1, parentIno: 3 }) });
  await assert.rejects(changed.client.connect(), { code: "socket-changed" });
  assert.equal(changed.socket().writes.length, 0);
  assert.equal(changed.socket().destroyed, true);
});

test("failed writes are uncertain and never reissued", async t => {
  const { client, socket } = fixture();
  t.after(() => client.close());
  await client.connect();
  let writes = 0;
  socket().write = () => { writes++; throw Error("partial write possible"); };
  await assert.rejects(client.request("approval", {}), { code: "socket-write-failed", delivery: "unknown" });
  assert.equal(writes, 1);
  assert.equal(client.isReady(), false);
});

test("invalid outgoing routing and serialization fail before sending", async t => {
  const { client, socket } = fixture({ maxFrameBytes: 512 });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request("approval", {}, { targetClientId: "wrong" }), { code: "invalid-target", delivery: "none" });
  await assert.rejects(client.request("approval", {}, { timeoutMs: Infinity }), { code: "invalid-timeout", delivery: "none" });
  await assert.rejects(client.request("approval", {}, { version: -1 }), { code: "invalid-request", delivery: "none" });
  const circular = {}; circular.self = circular;
  await assert.rejects(client.request("approval", circular), { code: "invalid-json", delivery: "none" });
  await assert.rejects(client.request("approval", { huge: "x".repeat(512) }), { code: "frame-limit", delivery: "none" });
  assert.equal(socket().writes.length, 1);
  assert.equal(client._state.pending.size, 0);
});

test("pending request limit is enforced before another request is sent", async t => {
  const { client, socket } = fixture({ timeoutMs: 5000 });
  t.after(() => client.close());
  await client.connect();
  const pending = Array.from({ length: 4096 }, () => client.request("discovery", {}).catch(error => error));
  await assert.rejects(client.request("approval", {}), { code: "pending-limit", delivery: "none" });
  assert.equal(socket().writes.length, 4097);
  client.close();
  assert.equal((await Promise.all(pending)).every(error => error.delivery === "unknown"), true);
});

test("socket backpressure refuses another frame before dispatch", async t => {
  const { client, socket } = fixture({ maxFrameBytes: 1024 });
  t.after(() => client.close());
  await client.connect();
  socket().writableLength = 1024;
  await assert.rejects(client.request("approval", {}), { code: "write-queue-limit", delivery: "none" });
  assert.throws(() => client.broadcast("follow", {}), { code: "write-queue-limit", delivery: "none" });
  assert.equal(socket().writes.length, 1);
  assert.equal(client._state.pending.size, 0);
  assert.equal(client.isReady(), true);
});

test("early broadcast queue is bounded", async t => {
  const { client, socket } = fixture({}, { initialize: false });
  t.after(() => client.close());
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, { code: "broadcast-queue-limit" });
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 33; index++) socket().receive(broadcast({ index }));
  await rejected;
  assert.equal(client.isReady(), false);
});

test("real isolated Unix socket validates permissions and completes framed requests", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "threaddeck-ipc-test-"));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, "fixture.sock");
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (request.type === "request") {
          const response = frame(success(request, request.method === "initialize" ? { clientId: CLIENT } : { received: true }));
          socket.write(response.subarray(0, 2));
          socket.write(response.subarray(2));
        }
      }
    });
  });
  const client = new CodexIpcClient({ socketPath });
  t.after(async () => {
    client.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  assert.equal(typeof (await validateCodexSocket(socketPath)).ino, "number");
  await client.connect();
  assert.deepEqual((await client.request("fixture-read", {}, { targetClientId: OWNER })).result, { received: true });
  client.close();
  const link = path.join(directory, "link.sock");
  await fs.symlink(socketPath, link);
  await assert.rejects(validateCodexSocket(link), { code: "untrusted-socket" });
  const regular = path.join(directory, "regular");
  await fs.writeFile(regular, "fixture");
  await assert.rejects(validateCodexSocket(regular), { code: "untrusted-socket" });
  await fs.chmod(directory, 0o770);
  await assert.rejects(validateCodexSocket(socketPath), { code: "untrusted-socket" });
  await fs.chmod(directory, 0o700);
});
