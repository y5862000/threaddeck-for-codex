"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodexControlPlane,
  definiteMicroFallback,
  verifyAfterMicroDelivery
} = require("../src/control-plane");
const { MicroBridgeError } = require("../src/micro-cdp");

function microError(code, delivery) {
  return new MicroBridgeError(code, { code, delivery });
}

test("uses Micro first and skips the legacy adapter after success", async () => {
  const calls = [];
  const plane = new CodexControlPlane({ micro: {} });
  const result = await plane.execute("fast", {
    micro: async () => {
      calls.push("micro");
      return true;
    },
    legacy: async () => calls.push("legacy")
  });
  assert.deepEqual(calls, ["micro"]);
  assert.equal(result.backend, "micro");
  assert.equal(result.ok, true);
});

test("falls back only when Micro definitely performed no action", async () => {
  const calls = [];
  const plane = new CodexControlPlane({ micro: {}, unavailableCooldownMs: 0 });
  const result = await plane.execute("submit", {
    micro: async () => {
      calls.push("micro");
      throw microError("MICRO_CAPABILITY_UNAVAILABLE", "none");
    },
    legacy: async () => {
      calls.push("legacy");
      return "sent";
    }
  });
  assert.deepEqual(calls, ["micro", "legacy"]);
  assert.equal(result.backend, "legacy");
  assert.equal(result.value, "sent");
});

test("never duplicates a command after an ambiguous renderer timeout", async () => {
  let legacyCalls = 0;
  const plane = new CodexControlPlane({ micro: {} });
  const result = await plane.execute("side-chat", {
    micro: async () => {
      throw microError("MICRO_TIMEOUT", "unknown");
    },
    legacy: async () => {
      legacyCalls += 1;
      return true;
    }
  });
  assert.equal(legacyCalls, 0);
  assert.equal(result.backend, "micro");
  assert.equal(result.ambiguous, true);
  assert.equal(result.ok, false);
});

test("read-only health snapshots are cached for later routing", async () => {
  const snapshot = { activeThreadKey: "task", slots: [] };
  const plane = new CodexControlPlane({
    micro: { refreshReadOnly: async () => snapshot }
  });
  assert.equal(await plane.refreshReadOnly(), snapshot);
  assert.equal(plane.health().snapshot, snapshot);
  assert.equal(plane.health().backend, "micro");
});

test("fallback classifier rejects any possibly delivered command", () => {
  assert.equal(definiteMicroFallback(microError("MICRO_UNAVAILABLE", "none")), true);
  assert.equal(definiteMicroFallback(microError("MICRO_UNAVAILABLE", "unknown")), false);
  assert.equal(definiteMicroFallback(microError("MICRO_TIMEOUT", "none")), false);
});

test("a failed post-delivery verification can never replay through legacy", async () => {
  let delivered = 0;
  let legacyCalls = 0;
  const plane = new CodexControlPlane({
    micro: {
      async toggleFast() {
        delivered += 1;
        return true;
      }
    }
  });
  const result = await plane.execute("fast-mode-toggle", {
    micro: async (bridge) => {
      await bridge.toggleFast();
      return verifyAfterMicroDelivery(async () => {
        throw microError("MICRO_UNAVAILABLE", "none");
      }, "Fast mode verification");
    },
    legacy: async () => {
      legacyCalls += 1;
      return true;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
  assert.equal(delivered, 1);
  assert.equal(legacyCalls, 0);
});
