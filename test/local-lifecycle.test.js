"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyToolActivity,
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
    foundStart: false
  };
}

function jsonLine(type, payload, timestamp) {
  return JSON.stringify({ type, payload, timestamp });
}

test("tool activity classification recognizes editing, web, verification, search, and install commands", () => {
  const cases = [
    ["await tools.apply_patch(patch)", { kind: "edit", label: "코드 수정" }],
    ["await tools.web__run({search_query: []})", { kind: "search", label: "웹 검색" }],
    ["await tools.exec_command({cmd: 'pnpm test'})", { kind: "command", label: "테스트 실행" }],
    ["await tools.exec_command({cmd: 'node --check src/index.js'})", { kind: "inspect", label: "코드 검증" }],
    ["await tools.exec_command({cmd: 'rg needle src'})", { kind: "search", label: "파일 검색" }],
    [
      "await tools.exec_command({cmd: 'ditto build com.elgato.StreamDeck/Plugins/example'})",
      { kind: "command", label: "플러그인 설치" }
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
    { kind: "request", label: "요청 분석" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "patch_apply_end", success: false } }),
    { kind: "error", label: "수정 실패" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "browser" } } }),
    { kind: "search", label: "웹 결과 확인" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "agent_reasoning" } }),
    { kind: "think", label: "생각 중" }
  );
  assert.deepEqual(
    activityFromEvent({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } }),
    { kind: "answer", label: "답변 완료" }
  );
  assert.deepEqual(
    activityFromEvent({
      type: "response_item",
      payload: { type: "custom_tool_call", input: "tools.exec_command({cmd: 'rg item src'})" }
    }),
    { kind: "search", label: "파일 검색" }
  );
  assert.equal(activityFromEvent({ type: "event_msg", payload: { type: "task_complete" } }), null);
});

test("reverse lifecycle reduction recovers completion, start, activity, effort, and service tier", () => {
  const startedAt = "2026-01-02T03:04:05.000Z";
  const endedAt = "2026-01-02T03:05:10.000Z";
  const lines = [
    jsonLine("event_msg", { type: "task_started" }, startedAt),
    "{malformed-json",
    jsonLine("event_msg", {
      type: "thread_settings_applied",
      thread_settings: { reasoning_effort: "medium", service_tier: "priority" }
    }, "2026-01-02T03:04:05.100Z"),
    jsonLine("turn_context", { effort: "high" }, "2026-01-02T03:04:05.200Z"),
    jsonLine("response_item", {
      type: "custom_tool_call",
      input: "tools.exec_command({cmd: 'pnpm test'})"
    }, "2026-01-02T03:04:30.000Z"),
    jsonLine("event_msg", { type: "task_complete" }, endedAt)
  ];
  const lifecycle = lifecycleState();

  assert.equal(consumeLifecycleLines(lines, lifecycle), true);
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.startedAtMs, Date.parse(startedAt));
  assert.equal(lifecycle.endedAtMs, Date.parse(endedAt));
  assert.equal(lifecycle.foundStart, true);
  assert.equal(lifecycle.reasoningEffort, "high");
  assert.equal(lifecycle.serviceTier, "priority");
  assert.deepEqual(lifecycle.activity, { kind: "command", label: "테스트 실행" });
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
