"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CodexMainInspectorEvaluator,
  isLoopbackInspectorUrl,
  mainProcessEvaluationExpression,
  parseListenerPids,
  rendererEvaluationExpression,
  selectNodeInspectorTarget
} = require("../src/micro-main-inspector");

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(name, listener) {
    const rows = this.listeners.get(name) ?? [];
    rows.push(listener);
    this.listeners.set(name, rows);
  }

  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((row) => row !== listener));
  }

  emit(name, event) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  send(raw) {
    this.payload = JSON.parse(raw);
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        id: this.payload.id,
        result: { result: { value: { title: "Codex" } } }
      })
    }));
  }

  close() {
    this.readyState = 3;
  }
}

FakeWebSocket.instances = [];

function codexProcessRow() {
  return "  740     1 Sun Jul 26 22:46:04 2026     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
}

function inspectorTargets() {
  return [{
    type: "node",
    webSocketDebuggerUrl: "ws://127.0.0.1:9229/inspector-test"
  }];
}

test("inspector targets must stay on the expected loopback port", () => {
  assert.equal(isLoopbackInspectorUrl("ws://127.0.0.1:9229/test"), true);
  assert.equal(isLoopbackInspectorUrl("ws://localhost:9229/test"), true);
  assert.equal(isLoopbackInspectorUrl("ws://0.0.0.0:9229/test"), false);
  assert.equal(isLoopbackInspectorUrl("ws://127.0.0.1:9230/test"), false);
  assert.equal(selectNodeInspectorTarget(inspectorTargets())?.type, "node");
  assert.equal(selectNodeInspectorTarget([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9229/test" }]), null);
});

test("listener PID parsing is unique and ignores unrelated lsof fields", () => {
  assert.deepEqual(parseListenerPids("p740\nf12\np740\np900\nn127.0.0.1:9229\n"), [740, 900]);
});

test("renderer evaluation uses the main app webContents and closes only an owned inspector", () => {
  const owned = rendererEvaluationExpression("document.title", {
    closeOwnedInspector: true,
    idleCloseMs: 350
  });
  assert.match(owned, /getAllWebContents/);
  assert.match(owned, /executeJavaScript/);
  assert.match(owned, /const shouldClose = true/);
  assert.match(owned, /inspector\.close\(\)/);
  const external = rendererEvaluationExpression("document.title", {
    closeOwnedInspector: false
  });
  assert.match(external, /const shouldClose = false/);
});

test("main-process evaluation can prepare a bridge before closing an owned inspector", () => {
  const expression = mainProcessEvaluationExpression("Promise.resolve({ ready: true })", {
    closeOwnedInspector: true,
    idleCloseMs: 350
  });
  assert.match(expression, /Promise\.resolve\(\{ ready: true \}\)/);
  assert.match(expression, /const shouldClose = true/);
  assert.doesNotMatch(expression, /executeJavaScript/);
  assert.doesNotThrow(() => new Function(`return (${expression});`));
});

test("a running Codex receives one SIGUSR1 and its temporary inspector evaluates the renderer", async () => {
  let signaled = false;
  let signalCalls = 0;
  const evaluator = new CodexMainInspectorEvaluator({
    WebSocket: FakeWebSocket,
    sendSignal(pid, signal) {
      assert.equal(pid, 740);
      assert.equal(signal, "SIGUSR1");
      signalCalls += 1;
      signaled = true;
    },
    sleep: async () => {},
    execFile: async (command, args) => {
      if (command === "/bin/ps") return { stdout: codexProcessRow() };
      if (args.includes("-Fp")) return { stdout: "" };
      return { stdout: signaled ? "p740\nn127.0.0.1:9229\n" : "p740\n" };
    },
    fetch: async () => ({ ok: true, json: async () => inspectorTargets() })
  });
  const result = await evaluator.evaluate("({ title: document.title })");
  assert.deepEqual(result, { title: "Codex" });
  assert.equal(signalCalls, 1);
  assert.match(FakeWebSocket.instances.at(-1).payload.params.expression, /const shouldClose = true/);
});

test("an inspector already owned by another process is never contacted", async () => {
  let signalCalls = 0;
  const evaluator = new CodexMainInspectorEvaluator({
    WebSocket: FakeWebSocket,
    sendSignal() {
      signalCalls += 1;
    },
    execFile: async (command, args) => {
      if (command === "/bin/ps") return { stdout: codexProcessRow() };
      if (args.includes("-Fp")) return { stdout: "p999\n" };
      return { stdout: "p740\n" };
    },
    fetch: async () => ({ ok: false, json: async () => [] })
  });
  await assert.rejects(
    evaluator.evaluate("document.title"),
    /already owned by another process/
  );
  assert.equal(signalCalls, 0);
});

test("an expired ThreadDeck lease never closes a later external inspector", async () => {
  FakeWebSocket.instances = [];
  const evaluator = new CodexMainInspectorEvaluator({
    WebSocket: FakeWebSocket,
    now: () => 5000,
    execFile: async (command, args) => {
      if (command === "/bin/ps") return { stdout: codexProcessRow() };
      if (args.includes("-Fp")) return { stdout: "p740\n" };
      return { stdout: "p740\nn127.0.0.1:9229\n" };
    },
    fetch: async () => ({ ok: true, json: async () => inspectorTargets() })
  });
  evaluator.ownedGeneration = "740:Sun Jul 26 22:46:04 2026:/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  evaluator.ownedUntilMs = 4999;
  const result = await evaluator.evaluate("document.title");
  assert.deepEqual(result, { title: "Codex" });
  assert.match(FakeWebSocket.instances.at(-1).payload.params.expression, /const shouldClose = false/);
  assert.equal(evaluator.ownedGeneration, null);
});
