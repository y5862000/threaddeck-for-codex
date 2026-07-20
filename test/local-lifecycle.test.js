"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyToolActivity,
  composerSettingsFromEvent,
  activityFromEvent,
  consumeLifecycleLines
} = require("../src/local-lifecycle");

function lifecycleState() {
  return {
    status: null,
    startedAtMs: null,
    endedAtMs: null,
    activity: null,
    reasoningEffort: null,
    serviceTier: undefined,
    nextReasoningEffort: null,
    nextServiceTier: undefined,
    nextSettingsAtMs: null,
    turnId: null,
    foundStart: false
  };
}

function jsonLine(type, payload, timestamp) {
  return JSON.stringify({ type, payload, timestamp });
}

test("tool activity classification recognizes editing, web, verification, search, and install commands", () => {
  const cases = [
    ["await tools.apply_patch(patch)", { kind: "edit", code: "activity.editCode" }],
    ["await tools.web__run({search_query: []})", { kind: "search", code: "activity.webSearch" }],
    ["await tools.exec_command({cmd: 'pnpm test'})", { kind: "command", code: "activity.runTests" }],
    ["await tools.exec_command({cmd: 'node --check src/index.js'})", { kind: "inspect", code: "activity.checkCode" }],
    ["await tools.exec_command({cmd: 'rg needle src'})", { kind: "search", code: "activity.findFiles" }],
    [
      "await tools.exec_command({cmd: 'ditto build com.elgato.StreamDeck/Plugins/example'})",
      { kind: "command", code: "activity.installPlugin" }
    ]
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(classifyToolActivity(input), expected);
  }
  assert.equal(classifyToolActivity(""), null);
});

test("event activity maps lifecycle, patch, MCP, reasoning, and answer events", () => {
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "task_started" } }),
    { kind: "request", code: "activity.request" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "patch_apply_end", success: false } }),
    { kind: "error", code: "activity.patchFailed" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "browser" } } }),
    { kind: "search", code: "activity.checkWeb" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "agent_reasoning" } }),
    { kind: "think", code: "activity.think" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } }),
    { kind: "answer", code: "activity.replyReady" }
  );
  assert.deepEqual(
    activityFromEvent({
      type: "response_item",
      payload: { type: "custom_tool_call", input: "tools.exec_command({cmd: 'rg item src'})" }
    }),
    { kind: "search", code: "activity.findFiles" }
  );
  assert.equal(activityFromEvent({ type: "event_msg", payload: { type: "task_complete" } }), null);
});

test("reverse lifecycle reduction separates exact-turn settings from the live next-turn composer", () => {
  const startedAt = "2026-01-02T03:04:05.000Z";
  const endedAt = "2026-01-02T03:05:10.000Z";
  const lines = [
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "high", service_tier: "priority" }
    }, "2026-01-02T03:04:04.990Z"),
    jsonLine("event_msg", { type: "task_started", turn_id: "turn-a" }, startedAt),
    "{malformed-json",
    jsonLine("turn_context", { turn_id: "turn-a", effort: "high" }, "2026-01-02T03:04:05.020Z"),
    jsonLine("response_item", {
      type: "custom_tool_call",
      input: "tools.exec_command({cmd: 'pnpm test'})"
    }, "2026-01-02T03:04:30.000Z"),
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "medium", service_tier: "default" }
    }, "2026-01-02T03:04:40.000Z"),
    jsonLine("event_msg", { type: "task_complete" }, endedAt)
  ];
  const lifecycle = lifecycleState();

  assert.equal(consumeLifecycleLines(lines, lifecycle), true);
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.startedAtMs, Date.parse(startedAt));
  assert.equal(lifecycle.endedAtMs, Date.parse(endedAt));
  assert.equal(lifecycle.foundStart, true);
  assert.equal(lifecycle.turnId, "turn-a");
  assert.equal(lifecycle.reasoningEffort, "high");
  assert.equal(lifecycle.serviceTier, "priority");
  assert.equal(lifecycle.nextReasoningEffort, "medium");
  assert.equal(lifecycle.nextServiceTier, "default");
  assert.equal(lifecycle.nextSettingsAtMs, Date.parse("2026-01-02T03:04:40.000Z"));
  assert.deepEqual(lifecycle.activity, { kind: "command", code: "activity.runTests" });
});

test("composer settings parser exposes only non-message thread setting events", () => {
  assert.deepEqual(composerSettingsFromEvent({
    type: "event_msg",
    timestamp: "2026-03-04T05:06:07.000Z",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "ultra", service_tier: "priority" }
    }
  }), {
    reasoningEffort: "ultra",
    serviceTier: "priority",
    timestampMs: Date.parse("2026-03-04T05:06:07.000Z")
  });
  assert.equal(composerSettingsFromEvent({ type: "event_msg", payload: { type: "user_message" } }), null);
});

test("a dequeued follow-up becomes a new exact turn with the then-current composer settings", () => {
  const lines = [
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "high", service_tier: "default" }
    }, "2026-04-05T06:07:07.990Z"),
    jsonLine("event_msg", { type: "task_started", turn_id: "turn-a" }, "2026-04-05T06:07:08.000Z"),
    jsonLine("turn_context", { turn_id: "turn-a", effort: "high" }, "2026-04-05T06:07:08.010Z"),
    // The user changes the composer while a follow-up is still queued.
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "ultra", service_tier: "priority" }
    }, "2026-04-05T06:07:20.000Z"),
    jsonLine("event_msg", { type: "task_complete", turn_id: "turn-a" }, "2026-04-05T06:07:30.000Z"),
    // Codex starts the queued text as a new run using the live composer state.
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "ultra", service_tier: "priority" }
    }, "2026-04-05T06:07:30.090Z"),
    jsonLine("event_msg", { type: "task_started", turn_id: "turn-b" }, "2026-04-05T06:07:30.100Z"),
    jsonLine("turn_context", { turn_id: "turn-b", effort: "ultra" }, "2026-04-05T06:07:30.110Z")
  ];
  const lifecycle = lifecycleState();

  assert.equal(consumeLifecycleLines(lines, lifecycle), true);
  assert.equal(lifecycle.status, "working");
  assert.equal(lifecycle.turnId, "turn-b");
  assert.equal(lifecycle.reasoningEffort, "ultra");
  assert.equal(lifecycle.serviceTier, "priority");
  assert.equal(lifecycle.nextReasoningEffort, "ultra");
  assert.equal(lifecycle.nextServiceTier, "priority");
});

test("lifecycle reduction distinguishes stopped and working turns", () => {
  const startedAt = "2026-02-03T04:05:06.000Z";
  const stoppedAt = "2026-02-03T04:05:16.000Z";
  const stopped = lifecycleState();
  consumeLifecycleLines([
    jsonLine("event_msg", { type: "task_started" }, startedAt),
    jsonLine("event_msg", { type: "turn_aborted" }, stoppedAt)
  ], stopped);

  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.startedAtMs, Date.parse(startedAt));
  assert.equal(stopped.endedAtMs, Date.parse(stoppedAt));
  assert.equal(stopped.foundStart, true);

  const working = lifecycleState();
  consumeLifecycleLines([
    jsonLine("event_msg", { type: "task_started" }, startedAt)
  ], working);
  assert.equal(working.status, "working");
  assert.equal(working.startedAtMs, Date.parse(startedAt));
  assert.equal(working.endedAtMs, null);
});

test("malformed JSONL lines are ignored without changing lifecycle state", () => {
  const lifecycle = lifecycleState();
  assert.equal(consumeLifecycleLines(["", "not-json", "{broken"], lifecycle), false);
  assert.deepEqual(lifecycle, lifecycleState());
});
