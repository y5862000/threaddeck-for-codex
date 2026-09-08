"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CodexControlPlane } = require("../src/control-plane");

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
    checkInspectorFuse: async () => true,
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
  let fetchCalls = 0;
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
    fetch: async () => {
      fetchCalls += 1;
      return { ok: false, json: async () => [] };
    }
  });
  await assert.rejects(
    evaluator.evaluate("document.title"),
    /already owned by another process/
  );
  assert.equal(signalCalls, 0);
  assert.equal(fetchCalls, 0);
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

async function guardedInspectorFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threaddeck-inspector-fuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Moved Apps", "ChatGPT.app");
  const framework = path.join(app, "Contents/Frameworks/Codex Framework.framework/Codex Framework");
  await fs.mkdir(path.dirname(framework), { recursive: true });
  const wire = options.wire ?? "010111001";
  await fs.writeFile(framework, Buffer.concat([
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([1, wire.length]), Buffer.from(wire)
  ]));
  const stats = await fs.stat(framework, { bigint: true });
  const processRow = codexProcessRow().replace("/Applications/ChatGPT.app", app);
  const calls = { signals: 0, fetches: 0, processes: 0, mappings: 0 };
  const evaluator = new CodexMainInspectorEvaluator({
    platform: "darwin",
    WebSocket: FakeWebSocket,
    sendSignal(pid, signal) {
      assert.equal(pid, 740);
      assert.equal(signal, "SIGUSR1");
      calls.signals += 1;
    },
    execFile: async (command, args) => {
      if (command === "/bin/ps") {
        calls.processes += 1;
        return { stdout: calls.processes > 1 && options.nextProcess !== undefined
          ? options.nextProcess.replace("/Applications/ChatGPT.app", app)
          : processRow };
      }
      if (args.includes("-FfniD")) {
        calls.mappings += 1;
        return { stdout: `p740\nftxt\nD0x${stats.dev.toString(16)}\ni${stats.ino}\nn${framework}\n` };
      }
      if (args.includes("-Fp")) return { stdout: "" };
      return { stdout: options.existing || calls.signals > 0 ? "p740\nn127.0.0.1:9229\n" : "p740\n" };
    },
    fetch: async () => {
      calls.fetches += 1;
      return { ok: true, json: async () => inspectorTargets() };
    },
    sleep: async () => {}
  });
  return { evaluator, calls };
}

test("an enabled loaded framework and unchanged process generation permit exactly one signal", async (t) => {
  const { evaluator, calls } = await guardedInspectorFixture(t);
  assert.deepEqual(await evaluator.evaluate("document.title"), { title: "Codex" });
  assert.equal(calls.signals, 1);
  assert.equal(calls.processes, 2);
  assert.equal(calls.mappings, 1);
});

test("disabled or unknown loaded-framework fuses reject before any signal or contact", async (t) => {
  for (const wire of ["010011001", "010r11001", "010x11001", "", "010"]) {
    const { evaluator, calls } = await guardedInspectorFixture(t, { wire });
    await assert.rejects(evaluator.evaluate("document.title"), { code: "MICRO_UNAVAILABLE", delivery: "none" });
    assert.equal(calls.signals, 0, wire);
    assert.equal(calls.fetches, 0, wire);
  }
});

test("a vanished or changed process after the fuse check receives no signal", async (t) => {
  for (const nextProcess of [
    "", codexProcessRow().replace("22:46:04", "22:46:05"),
    codexProcessRow().replace("740", "741"),
    codexProcessRow().replace("MacOS/ChatGPT", "MacOS/Codex")
  ]) {
    const { evaluator, calls } = await guardedInspectorFixture(t, { nextProcess });
    await assert.rejects(evaluator.evaluate("document.title"), { code: "MICRO_UNAVAILABLE", delivery: "none" });
    assert.equal(calls.signals, 0);
    assert.equal(calls.fetches, 0);
  }
});

test("an existing process-owned external inspector works even with the fuse disabled and is not closed", async (t) => {
  const { evaluator, calls } = await guardedInspectorFixture(t, { wire: "010011001", existing: true });
  let closes = 0;
  evaluator.bestEffortCloseOwnedInspector = async () => { closes += 1; };
  assert.deepEqual(await evaluator.evaluate("document.title"), { title: "Codex" });
  assert.equal(calls.signals, 0);
  assert.equal(calls.mappings, 0);
  assert.match(FakeWebSocket.instances.at(-1).payload.params.expression, /const shouldClose = false/);
  assert.equal(closes, 0);
});

test("a compatibility rejection reaches the existing safe legacy fallback without native delivery", async (t) => {
  const { evaluator, calls } = await guardedInspectorFixture(t, { wire: "010011001" });
  const plane = new CodexControlPlane({ micro: {} });
  let legacyCalls = 0;
  const result = await plane.execute("fast", {
    micro: () => evaluator.evaluate("nativeCommand()"),
    legacy: async () => { legacyCalls += 1; return true; }
  });
  assert.equal(result.backend, "legacy");
  assert.equal(result.ok, true);
  assert.equal(legacyCalls, 1);
  assert.equal(calls.signals, 0);
  assert.equal(calls.fetches, 0);
});
