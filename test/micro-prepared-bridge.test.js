"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const test = require("node:test");

const {
  CodexPreparedRendererBridge,
  preparedBridgeBootstrapExpression,
  safeSocketPath
} = require("../src/micro-prepared-bridge");

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function unlink(socketPath) {
  await fs.unlink(socketPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

test("prepared bridge bootstrap is a valid main-process expression with a private socket", () => {
  const socketPath = "/tmp/threaddeck-501-100-aabbccddeeff.sock";
  const expression = preparedBridgeBootstrapExpression({
    socketPath,
    token: "a".repeat(64)
  });
  assert.equal(safeSocketPath(socketPath), true);
  assert.equal(safeSocketPath("/tmp/other.sock"), false);
  assert.match(expression, /chmodSync\(config\.socketPath, 0o600\)/);
  assert.match(expression, /executeJavaScript/);
  assert.match(expression, /ThreadDeck bridge authentication failed/);
  assert.doesNotThrow(() => new Function(`return (${expression});`));
});

test("commands reuse the bridge prepared before the first button press", async (t) => {
  let bootstrapCount = 0;
  let server = null;
  let socketPath = null;
  const clients = new Set();
  const bridge = new CodexPreparedRendererBridge({
    uid: 501,
    pid: process.pid,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    async bootstrap(configuration) {
      bootstrapCount += 1;
      socketPath = configuration.socketPath;
      await unlink(socketPath);
      server = net.createServer((client) => {
        clients.add(client);
        let buffer = "";
        client.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          assert.equal(request.token, configuration.token);
          client.write(`${JSON.stringify({
            id: request.id,
            ok: true,
            value: { expression: request.expression }
          })}\n`);
        });
        client.on("close", () => clients.delete(client));
      });
      await listen(server, socketPath);
      return { ready: true, generation: "test-generation" };
    }
  });
  t.after(async () => {
    bridge.invalidate();
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server?.close(resolve));
    await unlink(socketPath);
  });

  await bridge.prepare();
  assert.equal(bridge.isReady(), true);
  assert.equal(bootstrapCount, 1);
  assert.deepEqual(await bridge.evaluate("Promise.resolve(1)"), {
    expression: "Promise.resolve(1)"
  });
  assert.deepEqual(await bridge.evaluate("Promise.resolve(2)"), {
    expression: "Promise.resolve(2)"
  });
  await bridge.prepare();
  assert.equal(bootstrapCount, 1);
});
