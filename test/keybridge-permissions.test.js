"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureKeyBridgeExecutable } = require("../src/keybridge-permissions");

test("repairs a native helper whose executable bit was stripped during packaging", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-keybridge-"));
  const bridgePath = path.join(directory, "keybridge");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(bridgePath, "native helper fixture");
  fs.chmodSync(bridgePath, 0o666);
  assert.throws(() => fs.accessSync(bridgePath, fs.constants.X_OK));

  assert.equal(ensureKeyBridgeExecutable(bridgePath), true);
  assert.doesNotThrow(() => fs.accessSync(bridgePath, fs.constants.X_OK));
  assert.equal(fs.statSync(bridgePath).mode & 0o777, 0o755);
  assert.equal(ensureKeyBridgeExecutable(bridgePath), false);
});
