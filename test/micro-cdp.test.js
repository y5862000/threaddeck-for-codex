"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACTIVATE_RUNTIME_EXPRESSION,
  READ_ONLY_SNAPSHOT_EXPRESSION,
  CodexMicroBridge,
  MicroBridgeError,
  isLoopbackWebSocketUrl,
  normalizeMicroSnapshot,
  parseDebugPortFromCommand,
  retainEvaluationPromise,
  runKeycapExpression,
  selectCodexMainTarget
} = require("../src/micro-cdp");

function assertRendererExpressionParses(expression) {
  assert.doesNotThrow(() => new Function(`return (${expression});`));
}

test("selects only the loopback main Codex renderer", () => {
  const selected = selectCodexMainTarget([
    {
      type: "page",
      url: "app://codex/index.html?initialRoute=avatar-overlay",
      webSocketDebuggerUrl: "ws://127.0.0.1:9300/devtools/page/avatar"
    },
    {
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9300/devtools/page/main"
    },
    {
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: "ws://192.168.1.5:9300/devtools/page/remote"
    }
  ]);
  assert.equal(selected.webSocketDebuggerUrl, "ws://127.0.0.1:9300/devtools/page/main");
  assert.equal(isLoopbackWebSocketUrl("ws://localhost:9300/devtools/page/main"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://192.168.1.5:9300/devtools/page/main"), false);
});

test("accepts a debug port only with an explicit loopback binding", () => {
  assert.equal(parseDebugPortFromCommand(
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=9345"
  ), 9345);
  assert.equal(parseDebugPortFromCommand(
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9345"
  ), null);
  assert.equal(parseDebugPortFromCommand(
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=0.0.0.0 --remote-debugging-port=9345"
  ), null);
});

test("normalizes the read-only Micro snapshot without conversation text", () => {
  assert.deepEqual(normalizeMicroSnapshot({
    connected: true,
    activeThreadKey: "thread-1",
    reasoningEffort: "High",
    fastEnabled: true,
    theme: "dark",
    slots: [
      { id: 0, threadKey: "thread-1", title: "Build", status: "working", selected: true },
      { id: 9, threadKey: "invalid" }
    ],
    capabilities: { command: true, hostMessage: true, hid: false, slots: true }
  }), {
    connected: true,
    activeThreadKey: "thread-1",
    reasoningEffort: "high",
    fastEnabled: true,
    theme: "dark",
    slots: [{
      id: 0,
      threadKey: "thread-1",
      title: "Build",
      status: "working",
      selected: true,
      activityAt: null
    }],
    capabilities: { command: true, hostMessage: true, hid: false, slots: true }
  });
});

test("keeps each awaited renderer evaluation reachable", () => {
  const expression = retainEvaluationPromise("Promise.resolve(42)", "test");
  assert.match(expression, /__threadDeckPendingEvaluations/);
  assert.match(expression, /threaddeck-test/);
  assert.match(expression, /Promise\.resolve\(42\)/);
});

test("all generated renderer entrypoints remain syntactically valid", () => {
  assertRendererExpressionParses(READ_ONLY_SNAPSHOT_EXPRESSION);
  assertRendererExpressionParses(ACTIVATE_RUNTIME_EXPRESSION);
  assertRendererExpressionParses(runKeycapExpression("FAST"));
  assert.match(ACTIVATE_RUNTIME_EXPRESSION, /3207467860/);
  assert.match(ACTIVATE_RUNTIME_EXPRESSION, /codex-micro-device-state-changed/);
});

test("Micro errors carry fallback and delivery semantics", () => {
  const error = new MicroBridgeError("missing", {
    code: "MICRO_CAPABILITY_UNAVAILABLE",
    delivery: "none"
  });
  assert.equal(error.code, "MICRO_CAPABILITY_UNAVAILABLE");
  assert.equal(error.delivery, "none");
});

test("keycap discovery activates Micro and retries only after a definite miss", async () => {
  const bridge = new CodexMicroBridge();
  let evaluations = 0;
  let activations = 0;
  bridge.ensureConnected = async () => {};
  bridge.activateRuntime = async () => {
    activations += 1;
    bridge.runtimeActivated = true;
    return true;
  };
  bridge.evaluate = async () => {
    evaluations += 1;
    if (evaluations === 1) {
      throw new MicroBridgeError("registry missing", {
        code: "MICRO_CAPABILITY_UNAVAILABLE",
        delivery: "none"
      });
    }
    return true;
  };
  assert.equal(await bridge.runKeycap("FAST"), true);
  assert.equal(activations, 1);
  assert.equal(evaluations, 2);
});

test("an ambiguous keycap failure is never replayed during activation", async () => {
  const bridge = new CodexMicroBridge();
  let activations = 0;
  bridge.ensureConnected = async () => {};
  bridge.activateRuntime = async () => {
    activations += 1;
    return true;
  };
  bridge.evaluate = async () => {
    throw new MicroBridgeError("timeout", {
      code: "MICRO_TIMEOUT",
      delivery: "unknown"
    });
  };
  await assert.rejects(() => bridge.runKeycap("PARTY"), /timeout/);
  assert.equal(activations, 0);
});
