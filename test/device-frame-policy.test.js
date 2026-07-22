"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEVICE_TYPE_NAMES,
  framePolicyForDevice,
  normalizeDeviceInfo,
  registrationDevices
} = require("../src/device-frame-policy");

test("normalizes registration devices without trusting missing geometry", () => {
  const devices = registrationDevices({
    devices: [
      { id: "neo", name: "Desk", type: 9, size: { columns: 4, rows: 2 } },
      { id: "xl", type: 2, size: { columns: 8, rows: 4 } },
      { type: 1, size: { columns: 3, rows: 2 } }
    ]
  });

  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map(({ id, typeName, keyCount }) => ({ id, typeName, keyCount })), [
    { id: "neo", typeName: "stream-deck-neo", keyCount: 8 },
    { id: "xl", typeName: "stream-deck-xl", keyCount: 32 }
  ]);
  assert.equal(normalizeDeviceInfo("unknown", {}).keyCount, 0);
  assert.equal(DEVICE_TYPE_NAMES[13], "stream-deck-plus-xl");
});

test("selects measured Neo and conservative model-specific frame budgets", () => {
  const neo = framePolicyForDevice(
    { type: 9, size: { columns: 4, rows: 2 } },
    { deviceId: "neo" }
  );
  const mini = framePolicyForDevice(
    { type: 1, size: { columns: 3, rows: 2 } },
    { deviceId: "mini" }
  );
  const xl = framePolicyForDevice(
    { type: 2, size: { columns: 8, rows: 4 } },
    { deviceId: "xl" }
  );
  const mobile = framePolicyForDevice(
    { type: 3, size: { columns: 4, rows: 2 } },
    { deviceId: "mobile" }
  );

  assert.deepEqual(
    [neo.profile, neo.perKeyFps, neo.aggregateFps, neo.minContextIntervalMs, neo.minGlobalIntervalMs],
    ["neo-tested", 30, 90, 33, 11]
  );
  assert.deepEqual(
    [mini.profile, mini.perKeyFps, mini.aggregateFps],
    ["small-physical", 10, 60]
  );
  assert.deepEqual(
    [xl.profile, xl.perKeyFps, xl.aggregateFps],
    ["large-physical", 10, 45]
  );
  assert.deepEqual(
    [mobile.profile, mobile.perKeyFps, mobile.aggregateFps],
    ["mobile", 10, 30]
  );
});

test("uses geometry fallback for future device types and permits diagnostics overrides", () => {
  const futureSmall = framePolicyForDevice(
    { type: 99, size: { columns: 4, rows: 2 } },
    { deviceId: "future" }
  );
  const unknown = framePolicyForDevice(null, { deviceId: "missing" });
  const overridden = framePolicyForDevice(
    { type: 9, size: { columns: 4, rows: 2 } },
    { deviceId: "neo", perKeyFps: 12, aggregateFps: 48 }
  );

  assert.deepEqual(
    [futureSmall.profile, futureSmall.aggregateFps],
    ["unknown-small", 45]
  );
  assert.deepEqual([unknown.profile, unknown.aggregateFps], ["unknown-large", 30]);
  assert.deepEqual(
    [overridden.perKeyFps, overridden.aggregateFps, overridden.minContextIntervalMs, overridden.minGlobalIntervalMs],
    [12, 48, 83, 21]
  );
});
