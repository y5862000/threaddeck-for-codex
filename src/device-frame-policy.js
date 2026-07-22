"use strict";

const DEVICE_TYPE_NAMES = Object.freeze({
  0: "stream-deck",
  1: "stream-deck-mini",
  2: "stream-deck-xl",
  3: "stream-deck-mobile",
  4: "corsair-gkeys",
  5: "stream-deck-pedal",
  6: "corsair-voyager",
  7: "stream-deck-plus",
  8: "scuf-controller",
  9: "stream-deck-neo",
  10: "stream-deck-studio",
  11: "virtual-stream-deck",
  12: "galleon-100-sd",
  13: "stream-deck-plus-xl"
});

const NON_DISPLAY_DEVICE_TYPES = new Set([4, 5, 6, 8]);

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeDeviceInfo(deviceId, value = {}) {
  if (!value || typeof value !== "object") value = {};
  const id = String(deviceId ?? value.id ?? "").trim();
  const type = Number.isInteger(Number(value.type)) ? Number(value.type) : null;
  const columns = positiveInteger(value.size?.columns);
  const rows = positiveInteger(value.size?.rows);
  return Object.freeze({
    id,
    name: String(value.name ?? "").trim(),
    type,
    typeName: DEVICE_TYPE_NAMES[type] ?? "unknown",
    size: Object.freeze({ columns, rows }),
    keyCount: columns * rows
  });
}

function fpsInterval(fps) {
  return Math.max(1, Math.round(1000 / finitePositive(fps, 10)));
}

function baseBudgetForDevice(device) {
  const type = device?.type;
  const keyCount = positiveInteger(device?.keyCount);

  // Neo is the only physical model measured end-to-end by this project. Its
  // 90 fps aggregate ceiling keeps normal one-to-three-key animation at the
  // renderer's native 30 fps and an eight-key completion pulse near 11 fps.
  if (type === 9) {
    return { profile: "neo-tested", perKeyFps: 30, aggregateFps: 90, maxBufferedBytes: 16 * 1024 };
  }

  // Virtual devices avoid a physical USB image queue. Mobile still crosses a
  // network boundary, so it starts at Elgato's conservative icon cadence.
  if (type === 11) {
    return { profile: "virtual", perKeyFps: 20, aggregateFps: 90, maxBufferedBytes: 64 * 1024 };
  }
  if (type === 3) {
    return { profile: "mobile", perKeyFps: 10, aggregateFps: 30, maxBufferedBytes: 16 * 1024 };
  }

  // Models without normal LCD action keys do not benefit from animation. The
  // low ceiling still allows transient feedback in Stream Deck's software UI.
  if (NON_DISPLAY_DEVICE_TYPES.has(type)) {
    return { profile: "non-display", perKeyFps: 10, aggregateFps: 20, maxBufferedBytes: 16 * 1024 };
  }

  // Untested physical displays follow the public 10 fps/key guidance and use
  // a lower aggregate ceiling as their page size grows. Backpressure can lower
  // these values further at runtime; it never raises them beyond this policy.
  if (type === 1) {
    return { profile: "small-physical", perKeyFps: 10, aggregateFps: 60, maxBufferedBytes: 16 * 1024 };
  }
  if (type === 0 || type === 7) {
    return { profile: "standard-physical", perKeyFps: 10, aggregateFps: 60, maxBufferedBytes: 16 * 1024 };
  }
  if (type === 2 || type === 10 || type === 13) {
    return { profile: "large-physical", perKeyFps: 10, aggregateFps: 45, maxBufferedBytes: 16 * 1024 };
  }
  if (type === 12) {
    return { profile: "hybrid-physical", perKeyFps: 10, aggregateFps: 45, maxBufferedBytes: 16 * 1024 };
  }

  if (keyCount > 0 && keyCount <= 8) {
    return { profile: "unknown-small", perKeyFps: 10, aggregateFps: 45, maxBufferedBytes: 16 * 1024 };
  }
  if (keyCount > 0 && keyCount <= 15) {
    return { profile: "unknown-standard", perKeyFps: 10, aggregateFps: 40, maxBufferedBytes: 16 * 1024 };
  }
  return { profile: "unknown-large", perKeyFps: 10, aggregateFps: 30, maxBufferedBytes: 16 * 1024 };
}

function framePolicyForDevice(deviceInfo, options = {}) {
  const device = normalizeDeviceInfo(options.deviceId, deviceInfo);
  const base = baseBudgetForDevice(device);
  const perKeyFps = finitePositive(options.perKeyFps, base.perKeyFps);
  const aggregateFps = finitePositive(options.aggregateFps, base.aggregateFps);
  return Object.freeze({
    lane: device.id || "unknown-device",
    deviceId: device.id,
    deviceType: device.type,
    deviceTypeName: device.typeName,
    keyCount: device.keyCount,
    profile: base.profile,
    perKeyFps,
    aggregateFps,
    minContextIntervalMs: fpsInterval(perKeyFps),
    minGlobalIntervalMs: fpsInterval(aggregateFps),
    maxBufferedBytes: finitePositive(options.maxBufferedBytes, base.maxBufferedBytes),
    backpressureRetryMs: fpsInterval(Math.min(aggregateFps, 30)),
    maxSlowdownMultiplier: 4,
    recoveryMs: 3_000
  });
}

function registrationDevices(registrationInfo) {
  const devices = Array.isArray(registrationInfo?.devices) ? registrationInfo.devices : [];
  return devices
    .map((device) => normalizeDeviceInfo(device?.id, device))
    .filter((device) => device.id);
}

module.exports = {
  DEVICE_TYPE_NAMES,
  framePolicyForDevice,
  normalizeDeviceInfo,
  registrationDevices
};
