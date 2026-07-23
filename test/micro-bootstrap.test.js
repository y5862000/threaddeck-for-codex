"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  codexAppCandidates,
  createBootstrapPolicy,
  evaluateBootstrapPolicy,
  parseCodexMainProcess,
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
