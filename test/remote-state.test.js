"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REMOTE_ACTIVITY_STALE_MS,
  REMOTE_REASONING_SUMMARY_MAX_LENGTH,
  REMOTE_REASONING_TURN_TOLERANCE_MS,
  REMOTE_RUNTIME_OBSERVATION_MAX_GAP_MS,
  REMOTE_RUNTIME_TERMINAL_CONFIRM_MS,
  applyRemoteActivityLogLine,
  applyRemoteLifecycleLogLine,
  classifyRemoteReasoningSummary,
  composerStateForRemoteThread,
  deriveRemoteStatus,
  parseCodexComposerState,
  parseRemoteLogLine,
  parseCodexReasoningState,
  recordRemoteComposerStateObservation,
  reasoningEffortForRemoteThread,
  remoteReasoningActivityFromLogLine,
  serviceTierForRemoteThread,
  remoteTurnStatus,
  remoteWorkingActivity
} = require("../src/remote-state");
const { timingLabel, uuidV7TimestampMs } = require("../src/time");
const { parseCodexQueueWindows } = require("../src/queue-state");

const THREAD_ID = "019f0000-0000-7000-8000-000000000001";
const TURN_ID = "019f77d5-d319-7000-8000-000000000002";

function logAt(timestampMs, message) {
  return `${new Date(timestampMs).toISOString()} info [electron-message-handler] ${message}`;
}

function activityLine(threadId, timestampMs, turnId, summaries) {
  return logAt(
    timestampMs,
    `Reasoning summary item completed summary=${JSON.stringify(summaries)} summaryPartCount=${summaries.length} threadId=${threadId} turnId=${turnId}`
  );
}

function derive(thread, options) {
  return deriveRemoteStatus(thread, {
    nowMs: options.nowMs,
    lifecycle: options.lifecycle ?? null,
    reasoningEfforts: options.reasoningEfforts ?? new Map(),
    composerStates: options.composerStates,
    runtimeObservations: options.runtimeObservations ?? new Map(),
    activities: options.activities ?? new Map()
  });
}

test("typed remote log parsing separates lifecycle data from optional activity", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const completed = parseRemoteLogLine(activityLine(
    THREAD_ID,
    startedAtMs + 1_000,
    TURN_ID,
    ["**Implementing typed events**"]
  ));
  assert.deepEqual(completed, {
    kind: "reasoning",
    timestampMs: startedAtMs + 1_000,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    turnStartedAtMs: startedAtMs,
    status: "working",
    activity: { kind: "edit", code: "activity.implement" }
  });

  const empty = parseRemoteLogLine(activityLine(
    THREAD_ID,
    startedAtMs + 2_000,
    TURN_ID,
    []
  ));
  assert.equal(empty.kind, "reasoning");
  assert.equal(empty.activity, null);
  assert.equal(parseRemoteLogLine("malformed timestamp Reasoning summary"), null);
});

test("UUIDv7 turn start replaces the provisional log start", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const startConfigMs = startedAtMs - 192;
  const reasoningObservedMs = startedAtMs + 3_200;
  const lifecycles = new Map();

  assert.equal(remoteTurnStatus("in_progress"), "working");
  assert.equal(remoteTurnStatus("interrupted"), "stopped");
  assert.equal(remoteTurnStatus("unknown"), null);
  assert.ok(Number.isFinite(startedAtMs));
  assert.equal(applyRemoteLifecycleLogLine(
    logAt(
      startConfigMs,
      `Reasoning summary turn-start config resolved conversationId=${THREAD_ID}`
    ),
    lifecycles
  ), true);
  assert.equal(lifecycles.get(THREAD_ID).startedAtMs, startConfigMs);
  assert.equal(lifecycles.get(THREAD_ID).pendingTurnStart, true);

  assert.equal(applyRemoteLifecycleLogLine(
    logAt(
      reasoningObservedMs,
      `Reasoning summary item threadId=${THREAD_ID} turnId=${TURN_ID}`
    ),
    lifecycles
  ), true);
  assert.deepEqual(lifecycles.get(THREAD_ID), {
    status: "working",
    startedAtMs,
    endedAtMs: null,
    latestTurnId: TURN_ID,
    lastActivityAtMs: reasoningObservedMs,
    terminalObservedAtMs: null,
    pendingTurnStart: false,
    supersededTurnId: null,
    observedAtMs: reasoningObservedMs
  });
});

test("activity parsing is cumulative, bounded, private, monotonic, and TTL scoped", () => {
  const activityThreadId = "019f0000-0000-7000-8000-00000000000a";
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const startConfigMs = startedAtMs - 192;
  const reasoningObservedMs = startedAtMs + 3_200;
  const activities = new Map();

  assert.equal(applyRemoteActivityLogLine(
    logAt(
      startConfigMs,
      `Reasoning summary turn-start config resolved conversationId=${activityThreadId}`
    ),
    activities
  ), true);

  const planningLine = activityLine(
    activityThreadId,
    reasoningObservedMs,
    TURN_ID,
    ["**Planning final validation tests**"]
  );
  assert.deepEqual(remoteReasoningActivityFromLogLine(planningLine), {
    kind: "think",
    code: "activity.plan"
  });
  assert.equal(applyRemoteActivityLogLine(planningLine, activities), true);
  assert.equal(activities.get(activityThreadId).activity.code, "activity.plan");

  const cumulativeLine = activityLine(
    activityThreadId,
    reasoningObservedMs + 1_000,
    TURN_ID,
    [
      "**Planning final validation tests**",
      "**Implementing compact activity cache**"
    ]
  );
  assert.equal(applyRemoteActivityLogLine(cumulativeLine, activities), true);
  assert.deepEqual(activities.get(activityThreadId).activity, {
    kind: "edit",
    code: "activity.implement"
  });

  const stateBeforeIgnoredLines = structuredClone(activities.get(activityThreadId));
  assert.equal(applyRemoteActivityLogLine(
    activityLine(activityThreadId, reasoningObservedMs + 2_000, TURN_ID, []),
    activities
  ), false);
  assert.deepEqual(activities.get(activityThreadId), stateBeforeIgnoredLines);

  assert.equal(applyRemoteActivityLogLine(
    logAt(
      reasoningObservedMs + 3_000,
      `Reasoning summary item completed summary=[broken summaryPartCount=1 threadId=${activityThreadId} turnId=${TURN_ID}`
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(activityThreadId), stateBeforeIgnoredLines);

  assert.equal(applyRemoteActivityLogLine(
    activityLine(
      activityThreadId,
      reasoningObservedMs + 500,
      TURN_ID,
      ["**Searching older evidence**"]
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(activityThreadId), stateBeforeIgnoredLines);

  const verificationLine = activityLine(
    activityThreadId,
    reasoningObservedMs + 4_000,
    TURN_ID,
    ["**Verifying release artifacts**"]
  );
  assert.equal(applyRemoteActivityLogLine(verificationLine, activities), true);
  assert.equal(activities.get(activityThreadId).activity.code, "activity.verify");
  const verifiedState = structuredClone(activities.get(activityThreadId));

  assert.equal(applyRemoteActivityLogLine(verificationLine, activities), false);
  assert.deepEqual(activities.get(activityThreadId), verifiedState);
  assert.equal(applyRemoteActivityLogLine(
    activityLine(
      activityThreadId,
      reasoningObservedMs + 5_000,
      TURN_ID,
      ["x".repeat(REMOTE_REASONING_SUMMARY_MAX_LENGTH + 1)]
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(activityThreadId), verifiedState);
  assert.equal(applyRemoteActivityLogLine(
    logAt(
      reasoningObservedMs + 6_000,
      `Reasoning summary part added payload={} threadId=${activityThreadId} turnId=${TURN_ID}`
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(activityThreadId), verifiedState);

  const lifecycle = { status: "working", startedAtMs, latestTurnId: TURN_ID };
  assert.equal(remoteWorkingActivity(
    { id: activityThreadId },
    lifecycle,
    reasoningObservedMs + 4_500,
    activities
  ).code, "activity.verify");
  assert.equal(remoteWorkingActivity(
    { id: activityThreadId },
    lifecycle,
    reasoningObservedMs + 4_000 + REMOTE_ACTIVITY_STALE_MS + 1,
    activities
  ), null);

  assert.equal(classifyRemoteReasoningSummary("Planning final validation tests").code, "activity.plan");
  assert.equal(classifyRemoteReasoningSummary("Searching current documentation").code, "activity.searching");
  assert.equal(classifyRemoteReasoningSummary("Summarizing final results").code, "activity.wrapUp");

  const serialized = JSON.stringify(activities.get(activityThreadId));
  assert.doesNotMatch(serialized, /Planning final validation tests/);
  assert.doesNotMatch(serialized, /Implementing compact activity cache/);
  assert.doesNotMatch(serialized, /Verifying release artifacts/);
  assert.deepEqual(Object.keys(activities.get(activityThreadId).activity).sort(), ["code", "kind"]);
});

test("new activity turns reject prior-turn and post-terminal activity", () => {
  const threadId = "019f0000-0000-7000-8000-00000000000a";
  const oldTurnId = TURN_ID;
  const oldStartMs = uuidV7TimestampMs(oldTurnId);
  const newTurnId = "019f780e-4bbf-7000-8000-00000000000b";
  const newStartMs = uuidV7TimestampMs(newTurnId);
  const activities = new Map();

  applyRemoteActivityLogLine(
    activityLine(threadId, oldStartMs + 1_000, oldTurnId, ["**Verifying old turn**"]),
    activities
  );
  assert.equal(applyRemoteActivityLogLine(
    logAt(
      newStartMs - 192,
      `Reasoning summary turn-start config resolved conversationId=${threadId}`
    ),
    activities
  ), true);
  assert.equal(activities.get(threadId).turnId, null);
  assert.equal(activities.get(threadId).activity.code, "activity.request");
  assert.equal(activities.get(threadId).supersededTurnId, oldTurnId);

  assert.equal(applyRemoteActivityLogLine(
    activityLine(threadId, newStartMs + 1_000, oldTurnId, ["**Implementing stale prior turn**"]),
    activities
  ), false);
  assert.equal(activities.get(threadId).activity.code, "activity.request");

  assert.equal(applyRemoteActivityLogLine(
    activityLine(threadId, newStartMs + 2_000, newTurnId, ["**Analyzing current turn**"]),
    activities
  ), true);
  assert.equal(applyRemoteActivityLogLine(
    logAt(
      newStartMs + 3_000,
      `maybe_resume_success conversationId=${threadId} latestTurnId=${newTurnId} latestTurnStatus=completed`
    ),
    activities
  ), true);
  const terminalState = structuredClone(activities.get(threadId));
  assert.equal(terminalState.terminal, true);
  assert.equal(terminalState.activity, null);

  assert.equal(applyRemoteActivityLogLine(
    activityLine(threadId, newStartMs + 4_000, newTurnId, ["**Implementing after completion**"]),
    activities
  ), false);
  assert.deepEqual(activities.get(threadId), terminalState);
});

test("quick retry ignores delayed prior completion before and after the new turn id", () => {
  const threadId = "019f0000-0000-7000-8000-00000000000e";
  const turnA = "019f77d5-d319-7000-8000-00000000000c";
  const turnB = "019f77d5-dae9-7000-8000-00000000000d";
  const startA = uuidV7TimestampMs(turnA);
  const startB = uuidV7TimestampMs(turnB);
  const activities = new Map();

  applyRemoteActivityLogLine(
    logAt(startA - 192, `Reasoning summary turn-start config resolved conversationId=${threadId}`),
    activities
  );
  applyRemoteActivityLogLine(
    activityLine(threadId, startA + 100, turnA, ["**Analyzing first turn**"]),
    activities
  );
  applyRemoteActivityLogLine(
    logAt(
      startA + 1_000,
      `maybe_resume_success conversationId=${threadId} latestTurnId=${turnA} latestTurnStatus=completed`
    ),
    activities
  );
  applyRemoteActivityLogLine(
    logAt(startB - 192, `Reasoning summary turn-start config resolved conversationId=${threadId}`),
    activities
  );

  const pendingState = structuredClone(activities.get(threadId));
  assert.equal(applyRemoteActivityLogLine(
    logAt(
      startB - 100,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnA}`
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(threadId), pendingState);

  assert.equal(applyRemoteActivityLogLine(
    activityLine(threadId, startB + 100, turnB, ["**Implementing quick retry**"]),
    activities
  ), true);
  assert.equal(activities.get(threadId).turnId, turnB);
  assert.equal(activities.get(threadId).activity.code, "activity.implement");
  assert.equal(activities.get(threadId).terminal, false);

  const identifiedState = structuredClone(activities.get(threadId));
  assert.equal(applyRemoteActivityLogLine(
    logAt(
      startB + 500,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnA}`
    ),
    activities
  ), false);
  assert.deepEqual(activities.get(threadId), identifiedState);
});

test("quick retry lifecycle ignores delayed prior completion on both sides of identification", () => {
  const threadId = "019f0000-0000-7000-8000-00000000000e";
  const turnA = "019f77d5-d319-7000-8000-00000000000c";
  const turnB = "019f77d5-dae9-7000-8000-00000000000d";
  const startA = uuidV7TimestampMs(turnA);
  const startB = uuidV7TimestampMs(turnB);
  const lifecycles = new Map();

  applyRemoteLifecycleLogLine(
    logAt(
      startA + 1_000,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnA}`
    ),
    lifecycles
  );
  applyRemoteLifecycleLogLine(
    logAt(startB - 192, `Reasoning summary turn-start config resolved conversationId=${threadId}`),
    lifecycles
  );
  const pendingLifecycle = structuredClone(lifecycles.get(threadId));

  assert.equal(applyRemoteLifecycleLogLine(
    logAt(
      startB - 100,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnA}`
    ),
    lifecycles
  ), false);
  assert.deepEqual(lifecycles.get(threadId), pendingLifecycle);

  assert.equal(applyRemoteLifecycleLogLine(
    logAt(startB + 100, `Reasoning summary item threadId=${threadId} turnId=${turnB}`),
    lifecycles
  ), true);
  assert.equal(lifecycles.get(threadId).status, "working");
  assert.equal(lifecycles.get(threadId).latestTurnId, turnB);
  assert.equal(lifecycles.get(threadId).endedAtMs, null);

  const identifiedLifecycle = structuredClone(lifecycles.get(threadId));
  assert.equal(applyRemoteLifecycleLogLine(
    logAt(
      startB + 500,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnA}`
    ),
    lifecycles
  ), false);
  assert.deepEqual(lifecycles.get(threadId), identifiedLifecycle);
});

test("a cold terminal tombstone blocks activity that arrives afterward", () => {
  const threadId = "019f0000-0000-7000-8000-00000000000f";
  const turnId = "019f77d5-d319-7000-8000-00000000000c";
  const startedAtMs = uuidV7TimestampMs(turnId);
  const activities = new Map();

  assert.equal(applyRemoteActivityLogLine(
    logAt(
      startedAtMs + 1_000,
      `[desktop-notifications] show turn-complete conversationId=${threadId} turnId=${turnId}`
    ),
    activities
  ), true);
  const terminalState = structuredClone(activities.get(threadId));
  assert.equal(terminalState.terminal, true);
  assert.equal(applyRemoteActivityLogLine(
    activityLine(threadId, startedAtMs + 1_500, turnId, ["**Implementing late activity**"]),
    activities
  ), false);
  assert.deepEqual(activities.get(threadId), terminalState);
});

test("activity storage is independent and runtime flags override its phase", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const startConfigMs = startedAtMs - 192;
  const reasoningObservedMs = startedAtMs + 3_200;
  const lifecycles = new Map();
  const activities = new Map();
  const reasoningEfforts = new Map([[
    THREAD_ID,
    { effort: "high", observedAtMs: reasoningObservedMs, turnStartedAtMs: startedAtMs }
  ]]);

  applyRemoteLifecycleLogLine(
    logAt(startConfigMs, `Reasoning summary turn-start config resolved conversationId=${THREAD_ID}`),
    lifecycles
  );
  applyRemoteLifecycleLogLine(
    logAt(reasoningObservedMs, `Reasoning summary item threadId=${THREAD_ID} turnId=${TURN_ID}`),
    lifecycles
  );
  const lifecycle = lifecycles.get(THREAD_ID);
  const lifecycleSnapshot = structuredClone(lifecycle);
  applyRemoteActivityLogLine(
    logAt(startConfigMs, `Reasoning summary turn-start config resolved conversationId=${THREAD_ID}`),
    activities
  );
  applyRemoteActivityLogLine(
    activityLine(THREAD_ID, reasoningObservedMs, TURN_ID, ["**Planning test implementation**"]),
    activities
  );
  assert.deepEqual(lifecycles.get(THREAD_ID), lifecycleSnapshot);

  const active = derive({
    id: THREAD_ID,
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    reasoningEffort: null,
    serviceTier: "default"
  }, {
    nowMs: startedAtMs + 10_000,
    lifecycle,
    reasoningEfforts,
    runtimeObservations: new Map(),
    activities
  });
  assert.equal(active.status, "working");
  assert.equal(active.startedAtMs, startedAtMs);
  assert.equal(active.reasoningEffort, "high");
  assert.equal(active.activity.code, "activity.plan");

  const approval = derive({
    id: THREAD_ID,
    threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] }
  }, {
    nowMs: startedAtMs + 10_000,
    lifecycle,
    reasoningEfforts,
    runtimeObservations: new Map(),
    activities
  });
  assert.equal(approval.activity.code, "activity.remoteApproval");

  const input = derive({
    id: THREAD_ID,
    threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnUserInput"] }
  }, {
    nowMs: startedAtMs + 10_000,
    lifecycle,
    reasoningEfforts,
    runtimeObservations: new Map(),
    activities
  });
  assert.equal(input.activity.code, "activity.remoteInput");

  const error = derive({
    id: THREAD_ID,
    threadRuntimeStatus: { type: "systemError" }
  }, {
    nowMs: startedAtMs + 10_000,
    lifecycle,
    reasoningEfforts,
    runtimeObservations: new Map(),
    activities
  });
  assert.equal(error.status, "error");
  assert.equal(error.activity.code, "activity.remoteError");
});

test("explicit completion freezes the accurate duration and resume cannot rewrite it", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const reasoningObservedMs = startedAtMs + 3_200;
  const endedAtMs = startedAtMs + 9 * 60_000 + 22_000;
  const misleadingSummaryUpdatedAtMs = startedAtMs + 1_000;
  const lifecycles = new Map([[
    THREAD_ID,
    {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      latestTurnId: TURN_ID,
      lastActivityAtMs: reasoningObservedMs,
      terminalObservedAtMs: null,
      pendingTurnStart: false,
      supersededTurnId: null,
      observedAtMs: reasoningObservedMs
    }
  ]]);
  const observations = new Map();

  assert.equal(applyRemoteLifecycleLogLine(
    logAt(
      endedAtMs,
      `[desktop-notifications] show turn-complete threadId=${THREAD_ID} turnId=${TURN_ID}`
    ),
    lifecycles
  ), true);
  const completed = derive({
    id: THREAD_ID,
    summaryUpdatedAtMs: misleadingSummaryUpdatedAtMs,
    threadRuntimeStatus: { type: "notLoaded" },
    hasUnreadTurn: true,
    reasoningEffort: null,
    serviceTier: "default"
  }, {
    nowMs: endedAtMs + 100,
    lifecycle: lifecycles.get(THREAD_ID),
    runtimeObservations: observations
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.endedAtMs, endedAtMs);
  assert.equal(timingLabel(completed, endedAtMs), "09:22");
  assert.notEqual(completed.endedAtMs, misleadingSummaryUpdatedAtMs);

  applyRemoteLifecycleLogLine(
    logAt(
      endedAtMs + 2_000,
      `maybe_resume_success conversationId=${THREAD_ID} latestTurnId=${TURN_ID} latestTurnStatus=interrupted`
    ),
    lifecycles
  );
  const stopped = derive({
    id: THREAD_ID,
    threadRuntimeStatus: { type: "notLoaded" }
  }, {
    nowMs: endedAtMs + 2_000,
    lifecycle: lifecycles.get(THREAD_ID),
    runtimeObservations: observations
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.startedAtMs, startedAtMs);
  assert.equal(stopped.endedAtMs, endedAtMs);

  applyRemoteLifecycleLogLine(
    logAt(
      endedAtMs + 5 * 60_000,
      `maybe_resume_success conversationId=${THREAD_ID} latestTurnId=${TURN_ID} latestTurnStatus=completed`
    ),
    lifecycles
  );
  applyRemoteLifecycleLogLine(
    logAt(
      endedAtMs + 10 * 60_000,
      `maybe_resume_success conversationId=${THREAD_ID} latestTurnId=${TURN_ID} latestTurnStatus=completed`
    ),
    lifecycles
  );
  assert.equal(lifecycles.get(THREAD_ID).endedAtMs, endedAtMs);
  assert.equal(lifecycles.get(THREAD_ID).terminalObservedAtMs, endedAtMs);
});

test("runtime inactivity requires confirmation, can recover, and freezes the first inactive time", () => {
  const threadId = "019f0000-0000-7000-8000-000000000003";
  const turnId = "019f77d5-d319-7000-8000-000000000004";
  const startedAtMs = uuidV7TimestampMs(turnId);
  const endedAtMs = startedAtMs + 70_000;
  const lifecycle = {
    status: "working",
    startedAtMs,
    endedAtMs: null,
    latestTurnId: turnId,
    lastActivityAtMs: startedAtMs + 30_000,
    terminalObservedAtMs: null,
    observedAtMs: startedAtMs + 30_000
  };
  const observations = new Map();
  const activeThread = {
    id: threadId,
    threadRuntimeStatus: { type: "active", activeFlags: [] }
  };
  const inactiveThread = {
    id: threadId,
    threadRuntimeStatus: { type: "notLoaded" }
  };

  derive(activeThread, {
    nowMs: startedAtMs + 40_000,
    lifecycle,
    runtimeObservations: observations
  });
  const transientInactive = derive(inactiveThread, {
    nowMs: startedAtMs + 50_000,
    lifecycle,
    runtimeObservations: observations
  });
  assert.equal(transientInactive.status, "working");

  const recoveredActive = derive(activeThread, {
    nowMs: startedAtMs + 50_500,
    lifecycle,
    runtimeObservations: observations
  });
  assert.equal(recoveredActive.status, "working");

  derive(activeThread, {
    nowMs: endedAtMs - 5_000,
    lifecycle,
    runtimeObservations: observations
  });
  const pendingTerminal = derive(inactiveThread, {
    nowMs: endedAtMs,
    lifecycle,
    runtimeObservations: observations
  });
  assert.equal(pendingTerminal.status, "working");

  const observedTerminal = derive(inactiveThread, {
    nowMs: endedAtMs + REMOTE_RUNTIME_TERMINAL_CONFIRM_MS,
    lifecycle,
    runtimeObservations: observations
  });
  assert.equal(observedTerminal.status, "completed");
  assert.equal(observedTerminal.endedAtMs, endedAtMs);
  assert.equal(timingLabel(observedTerminal, endedAtMs), "01:10");
});

test("cold starts and stale runtime observation gaps never fabricate an end time", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const endedAtMs = startedAtMs + 9 * 60_000 + 22_000;
  const lifecycle = {
    status: "working",
    startedAtMs,
    endedAtMs: null,
    latestTurnId: TURN_ID,
    lastActivityAtMs: startedAtMs + 5 * 60_000,
    terminalObservedAtMs: null,
    observedAtMs: startedAtMs + 5 * 60_000
  };

  const coldCompleted = derive({
    id: "019f0000-0000-7000-8000-000000000005",
    threadRuntimeStatus: { type: "notLoaded" },
    hasUnreadTurn: true
  }, {
    nowMs: endedAtMs,
    lifecycle,
    runtimeObservations: new Map()
  });
  assert.equal(coldCompleted.status, "completed");
  assert.equal(coldCompleted.endedAtMs, null);
  assert.equal(timingLabel(coldCompleted, endedAtMs), "--:--");

  const staleThreadId = "019f0000-0000-7000-8000-000000000007";
  const observations = new Map();
  derive({
    id: staleThreadId,
    threadRuntimeStatus: { type: "active", activeFlags: [] }
  }, {
    nowMs: startedAtMs + 10_000,
    lifecycle,
    runtimeObservations: observations
  });
  const reappearedAtMs = startedAtMs + 10_000
    + REMOTE_RUNTIME_OBSERVATION_MAX_GAP_MS
    + 60_000;
  const staleObservationReappeared = derive({
    id: staleThreadId,
    threadRuntimeStatus: { type: "notLoaded" },
    hasUnreadTurn: true
  }, {
    nowMs: reappearedAtMs,
    lifecycle,
    runtimeObservations: observations
  });
  const staleObservationConfirmed = derive({
    id: staleThreadId,
    threadRuntimeStatus: { type: "notLoaded" },
    hasUnreadTurn: true
  }, {
    nowMs: reappearedAtMs + REMOTE_RUNTIME_TERMINAL_CONFIRM_MS,
    lifecycle,
    runtimeObservations: observations
  });
  assert.equal(staleObservationReappeared.status, "completed");
  assert.equal(staleObservationReappeared.endedAtMs, null);
  assert.equal(staleObservationConfirmed.status, "completed");
  assert.equal(staleObservationConfirmed.endedAtMs, null);
  assert.equal(timingLabel(staleObservationConfirmed, endedAtMs), "--:--");
});

test("a terminal resume for a different turn does not invent an end timestamp", () => {
  const threadId = "019f0000-0000-7000-8000-000000000006";
  const previousTurnId = "019f77c3-ca44-7000-8000-000000000007";
  const currentTurnId = "019f77d5-d319-7000-8000-000000000004";
  const previousStartMs = uuidV7TimestampMs(previousTurnId);
  const previousEndMs = previousStartMs + 60_000;
  const currentStartMs = uuidV7TimestampMs(currentTurnId);
  const observedResumeMs = currentStartMs + 90_000;
  const lifecycles = new Map([[
    threadId,
    {
      status: "completed",
      startedAtMs: previousStartMs,
      endedAtMs: previousEndMs,
      latestTurnId: previousTurnId,
      lastActivityAtMs: previousStartMs + 30_000,
      terminalObservedAtMs: previousEndMs,
      observedAtMs: previousEndMs
    }
  ]]);

  applyRemoteLifecycleLogLine(
    logAt(
      observedResumeMs,
      `maybe_resume_success conversationId=${threadId} latestTurnId=${currentTurnId} latestTurnStatus=completed`
    ),
    lifecycles
  );
  const firstResume = structuredClone(lifecycles.get(threadId));
  applyRemoteLifecycleLogLine(
    logAt(
      observedResumeMs + 5 * 60_000,
      `maybe_resume_success conversationId=${threadId} latestTurnId=${currentTurnId} latestTurnStatus=completed`
    ),
    lifecycles
  );
  const repeatedResume = lifecycles.get(threadId);
  assert.equal(firstResume.endedAtMs, null);
  assert.equal(firstResume.terminalObservedAtMs, null);
  assert.equal(repeatedResume.endedAtMs, null);
  assert.equal(repeatedResume.lastActivityAtMs, null);
  assert.equal(repeatedResume.terminalObservedAtMs, null);

  const completed = derive({
    id: threadId,
    threadRuntimeStatus: { type: "notLoaded" }
  }, {
    nowMs: observedResumeMs + 100,
    lifecycle: repeatedResume,
    runtimeObservations: new Map()
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.endedAtMs, null);
  assert.equal(timingLabel(completed, observedResumeMs), "--:--");
});

test("reasoning effort rejects stale observations and prefers summary metadata", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const lifecycle = { status: "working", startedAtMs, latestTurnId: TURN_ID };
  const efforts = new Map([[
    THREAD_ID,
    {
      effort: "medium",
      observedAtMs: startedAtMs - REMOTE_REASONING_TURN_TOLERANCE_MS - 1,
      turnStartedAtMs: startedAtMs - 60_000
    }
  ]]);

  assert.equal(reasoningEffortForRemoteThread(
    { id: THREAD_ID, reasoningEffort: null },
    lifecycle,
    efforts
  ), null);
  assert.equal(reasoningEffortForRemoteThread(
    { id: THREAD_ID, reasoningEffort: "max" },
    lifecycle,
    efforts
  ), "max");
  assert.equal(parseCodexReasoningState("effort=ultra confidence=120 visited=800"), "ultra");
  assert.equal(parseCodexReasoningState("effort=unknown confidence=0 visited=800"), null);
});

test("unified composer state parses reasoning and canonical response speed", () => {
  assert.deepEqual(parseCodexComposerState(
    "reasoning=medium service_tier=priority available=1 reasoning_available=1 service_tier_available=1 confidence=520 visited=812"
  ), {
    reasoningEffort: "medium",
    serviceTier: "priority",
    available: true,
    reasoningAvailable: true,
    serviceTierAvailable: true
  });
  assert.deepEqual(parseCodexComposerState(
    "reasoning=unknown service_tier=unknown available=0 reasoning_available=0 service_tier_available=0"
  ), {
    reasoningEffort: null,
    serviceTier: null,
    available: false,
    reasoningAvailable: false,
    serviceTierAvailable: false
  });
  assert.equal(
    parseCodexComposerState("effort=high service_tier=fast available=1").serviceTier,
    "priority"
  );
});

test("remote composer observations are bound to the exact turn and never bleed", () => {
  const startedAtMs = uuidV7TimestampMs(TURN_ID);
  const lifecycle = { status: "working", startedAtMs, latestTurnId: TURN_ID };
  const observations = new Map();
  assert.equal(recordRemoteComposerStateObservation(
    { id: THREAD_ID },
    lifecycle,
    { reasoningEffort: "medium", serviceTier: "priority" },
    startedAtMs + 500,
    observations
  ), true);
  assert.deepEqual(composerStateForRemoteThread(
    { id: THREAD_ID },
    lifecycle,
    observations
  ), { reasoningEffort: "medium", serviceTier: "priority" });
  assert.equal(serviceTierForRemoteThread(
    { id: THREAD_ID },
    lifecycle,
    observations
  ), "priority");
  assert.equal(recordRemoteComposerStateObservation(
    { id: THREAD_ID },
    lifecycle,
    {
      reasoningEffort: "high",
      serviceTier: "default",
      reasoningAvailable: false,
      serviceTierAvailable: false
    },
    startedAtMs + 600,
    observations
  ), false);

  const nextLifecycle = {
    status: "working",
    startedAtMs: startedAtMs + 60_000,
    latestTurnId: "019f77d6-bd79-7000-8000-000000000003"
  };
  assert.deepEqual(composerStateForRemoteThread(
    { id: THREAD_ID },
    nextLifecycle,
    observations
  ), { reasoningEffort: null, serviceTier: null });
  assert.deepEqual(composerStateForRemoteThread(
    { id: THREAD_ID, reasoningEffort: "high", serviceTier: "standard" },
    nextLifecycle,
    observations
  ), { reasoningEffort: "high", serviceTier: "default" });
  assert.equal(recordRemoteComposerStateObservation(
    { id: THREAD_ID },
    nextLifecycle,
    { reasoningEffort: "low", serviceTier: "default" },
    startedAtMs,
    observations
  ), false);
});

test("queue parser preserves the focused Codex window", () => {
  const windows = parseCodexQueueWindows("window\t2\t1\nend\nwindow\t3\t0\nend\n");
  assert.equal(windows.length, 2);
  assert.equal(windows[0].index, 2);
  assert.equal(windows[0].focused, true);
  assert.equal(windows[1].focused, false);
});
