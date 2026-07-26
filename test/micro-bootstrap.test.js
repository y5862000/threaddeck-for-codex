"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CodexMicroBootstrap,
  codexAppCandidates,
  createBootstrapPolicy,
  evaluateBootstrapPolicy,
  normalizeBootstrapPolicy,
  parseCodexMainProcess,
  parseLoopbackListenerPorts,
  parseLoopbackDebugPort
} = require("../src/micro-bootstrap");

test("Codex app discovery keeps Spotlight results and verified fallback locations", () => {
  assert.deepEqual(codexAppCandidates(
    "/Applications/ChatGPT.app\n/Volumes/Old/Codex.app\n",
    "/tmp/threaddeck-home"
  ), [
    "/Applications/ChatGPT.app",
    "/Volumes/Old/Codex.app",
    "/Applications/Codex.app",
    "/tmp/threaddeck-home/Applications/ChatGPT.app",
    "/tmp/threaddeck-home/Applications/Codex.app"
  ]);
});

test("the first unbridged Codex generation is preserved", () => {
  const result = evaluateBootstrapPolicy(createBootstrapPolicy(1000), {
    nowMs: 1000,
    generation: "41:start:/Applications/ChatGPT.app",
    bridgeHealthy: false
  });
  assert.equal(result.action.type, "preserve");
  assert.equal(result.policy.preservedInitialGeneration, "41:start:/Applications/ChatGPT.app");
});

test("a later unbridged Codex generation is never restarted automatically", () => {
  let result = evaluateBootstrapPolicy(createBootstrapPolicy(1000), {
    nowMs: 1000,
    generation: "41:start:/Applications/ChatGPT.app",
    bridgeHealthy: false
  }, { stableMs: 100 });
  result = evaluateBootstrapPolicy(result.policy, {
    nowMs: 2000,
    generation: null,
    bridgeHealthy: false
  }, { stableMs: 100 });
  result = evaluateBootstrapPolicy(result.policy, {
    nowMs: 2100,
    generation: "52:new:/Applications/ChatGPT.app",
    bridgeHealthy: false
  }, { stableMs: 100 });
  assert.equal(result.action.type, "wait");
  result = evaluateBootstrapPolicy(result.policy, {
    nowMs: 2201,
    generation: "52:new:/Applications/ChatGPT.app",
    bridgeHealthy: false
  }, { stableMs: 100 });
  assert.equal(result.action.type, "preserve");
  assert.equal(result.action.reason, "normal-launch-after-stop");
  const repeated = evaluateBootstrapPolicy(result.policy, {
    nowMs: 2400,
    generation: "52:new:/Applications/ChatGPT.app",
    bridgeHealthy: false
  }, { stableMs: 100 });
  assert.equal(repeated.action.type, "preserve");
});

test("Codex main-process parsing ignores helpers and preserves a stable generation", () => {
  const output = [
    "  740     1 Mon Jul 20 20:02:29 2026     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "  741   740 Mon Jul 20 20:02:30 2026     /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper"
  ].join("\n");
  const row = parseCodexMainProcess(output, "/Applications/ChatGPT.app");
  assert.equal(row.pid, 740);
  assert.match(row.generation, /^740:Mon Jul 20 20:02:29 2026:/);
});

test("only an explicit loopback debugging address is accepted", () => {
  assert.equal(parseLoopbackDebugPort("ChatGPT --remote-debugging-port=43123"), null);
  assert.equal(parseLoopbackDebugPort(
    "ChatGPT --remote-debugging-address=0.0.0.0 --remote-debugging-port=43123"
  ), null);
  assert.equal(parseLoopbackDebugPort(
    "ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123"
  ), 43123);
});

test("legacy recovery fields are removed when the bootstrap policy is normalized", () => {
  const policy = normalizeBootstrapPolicy({
    ...createBootstrapPolicy(1000),
    initialized: true,
    recoveryPendingUntilMs: 9000,
    recoveryAttempts: ["old-generation"]
  }, 2000);
  assert.equal(Object.hasOwn(policy, "recoveryPendingUntilMs"), false);
  assert.equal(Object.hasOwn(policy, "recoveryAttempts"), false);
  assert.equal(policy.initialized, true);
});

test("only process-owned loopback listener rows become recovery candidates", () => {
  assert.deepEqual(parseLoopbackListenerPorts([
    "p740",
    "n127.0.0.1:43123",
    "n[::1]:43124",
    "n0.0.0.0:43125",
    "n192.168.0.2:43126",
    "n127.0.0.1:43123"
  ].join("\n")), [43123, 43124]);
});

test("a hidden process-owned CDP listener reconnects without restarting Codex", async () => {
  const bootstrap = new CodexMicroBootstrap({
    execFile: async (command) => {
      assert.equal(command, "/usr/sbin/lsof");
      return { stdout: "p740\nn127.0.0.1:43123\n" };
    },
    fetch: async (url) => ({
      ok: true,
      async json() {
        return url.endsWith("/json/list")
          ? [{ type: "page", url: "app://codex/index.html" }]
          : { webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/browser/test" };
      }
    }),
    listenerRescanMs: 0
  });
  const main = {
    pid: 740,
    generation: "740:start:/Applications/ChatGPT.app",
    command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
  };
  const candidates = await bootstrap.debugPortCandidates(main);
  assert.deepEqual(candidates, [43123]);
  assert.equal(await bootstrap.healthyDebugPort(main, candidates), 43123);
});

test("an unbridged running Codex enters fallback without a restart prompt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "threaddeck-bootstrap-"));
  const statuses = [];
  const bootstrap = new CodexMicroBootstrap({
    policyPath: path.join(directory, "policy.json"),
    bridgeStatePath: path.join(directory, "bridge.json"),
    onStatus: (status) => statuses.push(status)
  });
  bootstrap.discoverAppPath = async () => "/Applications/ChatGPT.app";
  bootstrap.findMainProcess = async () => ({
    pid: 740,
    generation: "740:start:/Applications/ChatGPT.app",
    command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
  });
  bootstrap.debugPortCandidates = async () => [];
  bootstrap.healthyDebugPort = async () => null;
  bootstrap.policy = createBootstrapPolicy(1000);
  const status = await bootstrap.performTick();
  assert.equal(status.state, "fallback");
  assert.equal(status.detail, "no-loopback-bridge");
  assert.equal(statuses.at(-1).state, "fallback");
  await fs.rm(directory, { recursive: true, force: true });
});
