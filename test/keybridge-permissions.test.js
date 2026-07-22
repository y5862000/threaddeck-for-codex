"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prepareKeyBridgeExecutable } = require("../src/keybridge-permissions");

test("stages an executable helper without modifying the packaged source", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-keybridge-"));
  const bridgePath = path.join(directory, "bundle", "keybridge");
  const cacheDirectory = path.join(directory, "runtime");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, "native helper fixture");
  fs.chmodSync(bridgePath, 0o666);
  assert.throws(() => fs.accessSync(bridgePath, fs.constants.X_OK));

  const runtimePath = prepareKeyBridgeExecutable(bridgePath, { cacheDirectory });
  assert.notEqual(runtimePath, bridgePath);
  assert.match(path.basename(runtimePath), /^keybridge-[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(runtimePath, "utf8"), "native helper fixture");
  assert.equal(fs.statSync(runtimePath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(bridgePath).mode & 0o777, 0o666);
  assert.throws(() => fs.accessSync(bridgePath, fs.constants.X_OK));
  assert.equal(prepareKeyBridgeExecutable(bridgePath, { cacheDirectory }), runtimePath);

  fs.writeFileSync(runtimePath, "corrupt runtime copy");
  fs.chmodSync(runtimePath, 0o644);
  assert.equal(prepareKeyBridgeExecutable(bridgePath, { cacheDirectory }), runtimePath);
  assert.equal(fs.readFileSync(runtimePath, "utf8"), "native helper fixture");
  assert.equal(fs.statSync(runtimePath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(bridgePath).mode & 0o777, 0o666);
});
