"use strict";

const { UUID_PATTERN, uuidV7TimestampMs } = require("./time");
const REMOTE_REASONING_TURN_TOLERANCE_MS = 5_000;
const REMOTE_RUNTIME_TERMINAL_CONFIRM_MS = 1_200;
const REMOTE_RUNTIME_OBSERVATION_MAX_GAP_MS = 10_000;
const REMOTE_ACTIVITY_STALE_MS = 120_000;
const REMOTE_REASONING_SUMMARY_MAX_LENGTH = 8_192;
const REASONING_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const SERVICE_TIER_ALIASES = new Map([
  ["default", "default"],
  ["standard", "default"],
  ["priority", "priority"],
  ["fast", "priority"]
]);

const REMOTE_ACTIVITY_VERB_GROUPS = [
  [/^(?:planning|designing|defining|formulating|outlining|proposing|prioritizing|scheduling|specifying|clarifying)$/, { kind: "think", label: "계획 중" }],
  [/^(?:analyzing|assessing|evaluating|identifying|diagnosing|investigating|comparing|examining|tracing)$/, { kind: "think", label: "분석 중" }],
  [/^(?:implementing|adding|updating|fixing|refactoring|inserting|appending|applying|replacing|patching|modifying|reordering)$/, { kind: "edit", label: "구현 중" }],
  [/^(?:optimizing|improving|enhancing)$/, { kind: "edit", label: "개선 중" }],
  [/^(?:adjusting|refining)$/, { kind: "edit", label: "조정 중" }],
  [/^(?:testing|verifying|validating|checking|confirming|auditing|benchmarking)$/, { kind: "inspect", label: "검증 중" }],
  [/^(?:searching|researching|browsing|locating)$/, { kind: "search", label: "검색 중" }],
  [/^(?:inspecting|reviewing|exploring|reading|extracting)$/, { kind: "inspect", label: "확인 중" }],
  [/^(?:running|executing|building|compiling|installing|deploying|packaging|training|simulating|staging)$/, { kind: "command", label: "실행 중" }],
  [/^(?:summarizing|documenting|reporting|finalizing|preparing|drafting|explaining|completing)$/, { kind: "answer", label: "정리 중" }]
];

function normalizedReasoningEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return REASONING_EFFORT_VALUES.has(normalized) ? normalized : null;
}

function normalizedServiceTier(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SERVICE_TIER_ALIASES.get(normalized) ?? null;
}

function remoteTurnStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["inprogress", "in_progress", "running", "active"].includes(status)) return "working";
  if (["completed", "complete", "succeeded", "success"].includes(status)) return "completed";
  if (["interrupted", "cancelled", "canceled", "aborted", "stopped"].includes(status)) return "stopped";
  if (["failed", "error"].includes(status)) return "error";
  return null;
}

function classifyRemoteReasoningSummary(value) {
  const cleaned = String(value ?? "")
    .replace(/[*_`#]/g, "")
    .replace(/^[-–—:;,.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return { kind: "think", label: "생각 중" };
  const verb = cleaned.toLowerCase().match(/^[a-z]+/)?.[0] ?? null;
  const verbGroup = verb
    ? REMOTE_ACTIVITY_VERB_GROUPS.find(([pattern]) => pattern.test(verb))
    : null;
  if (verbGroup) return { ...verbGroup[1] };
  if (/(계획|설계|정의|구상|우선순위)/.test(cleaned)) return { kind: "think", label: "계획 중" };
  if (/(분석|평가|진단|비교|원인 파악|조사)/.test(cleaned)) return { kind: "think", label: "분석 중" };
  if (/(구현|수정|개선|추가|리팩터|적용)/.test(cleaned)) return { kind: "edit", label: "구현 중" };
  if (/(검증|테스트|확인|감사|벤치마크)/.test(cleaned)) return { kind: "inspect", label: "검증 중" };
  if (/(검색|자료 찾|리서치|탐색)/.test(cleaned)) return { kind: "search", label: "검색 중" };
  if (/(검토|읽기|살펴|점검)/.test(cleaned)) return { kind: "inspect", label: "확인 중" };
  if (/(실행|빌드|배포|설치|훈련|시뮬레이션)/.test(cleaned)) return { kind: "command", label: "실행 중" };
  if (/(요약|정리|문서|보고|마무리)/.test(cleaned)) return { kind: "answer", label: "정리 중" };
  return { kind: "think", label: "생각 중" };
}

function remoteReasoningActivityFromLogLine(line) {
  if (!line.includes("Reasoning summary item completed")) return null;
  const raw = line.match(/\ssummary=(.*?)(?=\ssummaryPartCount=\d+\b)/)?.[1] ?? null;
  if (raw === null || raw.length > REMOTE_REASONING_SUMMARY_MAX_LENGTH) return null;
  let summaries;
  try {
    summaries = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(summaries)) return null;
  const latest = [...summaries].reverse().find((item) => typeof item === "string" && item.trim());
  return latest ? classifyRemoteReasoningSummary(latest) : null;
}

function parseRemoteLogLine(line) {
  if (typeof line !== "string" || !line) return null;
  const timestampMs = Date.parse(line.slice(0, 24));
  if (!Number.isFinite(timestampMs)) return null;

  if (line.includes("maybe_resume_success")) {
    const threadId = line.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const turnId = line.match(/latestTurnId=([0-9a-f-]{36})/i)?.[1] ?? null;
    return {
      kind: "resume",
      timestampMs,
      threadId,
      turnId,
      turnStartedAtMs: uuidV7TimestampMs(turnId),
      status: remoteTurnStatus(line.match(/latestTurnStatus=([^ ]+)/i)?.[1]),
      activity: null
    };
  }

  if (line.includes("Reasoning summary turn-start config resolved")) {
    return {
      kind: "config-start",
      timestampMs,
      threadId: line.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null,
      turnId: null,
      turnStartedAtMs: timestampMs,
      status: "working",
      activity: { kind: "request", label: "요청 분석" }
    };
  }

  if (line.includes("Reasoning summary") && line.includes("turnId=")) {
    const threadId = line.match(/threadId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const turnId = line.match(/turnId=([0-9a-f-]{36})/i)?.[1] ?? null;
    return {
      kind: "reasoning",
      timestampMs,
      threadId,
      turnId,
      turnStartedAtMs: uuidV7TimestampMs(turnId),
      status: "working",
      activity: remoteReasoningActivityFromLogLine(line)
    };
  }

  if (line.includes("[desktop-notifications] show turn-complete")) {
    const threadId = line.match(/(?:conversationId|threadId)=([0-9a-f-]{36})/i)?.[1] ?? null;
    const turnId = line.match(/turnId=([0-9a-f-]{36})/i)?.[1] ?? null;
    return {
      kind: "turn-complete",
      timestampMs,
      threadId,
      turnId,
      turnStartedAtMs: uuidV7TimestampMs(turnId),
      status: "completed",
      activity: null
    };
  }

  return null;
}

function remoteActivityTurnsMatch(left, right) {
  if (!left || !right) return false;
  if (left.turnId && right.turnId) return left.turnId === right.turnId;
  return Number.isFinite(left.turnStartedAtMs)
    && Number.isFinite(right.turnStartedAtMs)
    && Math.abs(left.turnStartedAtMs - right.turnStartedAtMs) <= REMOTE_REASONING_TURN_TOLERANCE_MS;
}

function applyRemoteActivityLogLine(line, activities) {
  const event = parseRemoteLogLine(line);
  if (!event) return false;
  const { timestampMs } = event;

  const store = (threadId, next) => {
    if (!UUID_PATTERN.test(threadId ?? "")) return false;
    const previous = activities.get(threadId) ?? null;
    if (previous && timestampMs <= previous.observedAtMs) return false;
    const turnStartedAtMs = Number.isFinite(next.turnStartedAtMs)
      ? next.turnStartedAtMs
      : previous?.turnStartedAtMs ?? null;
    if (previous
        && Number.isFinite(previous.turnStartedAtMs)
        && Number.isFinite(turnStartedAtMs)
        && turnStartedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < previous.turnStartedAtMs) {
      return false;
    }
    const candidate = {
      turnId: Object.hasOwn(next, "turnId") ? next.turnId : previous?.turnId ?? null,
      turnStartedAtMs,
      activity: Object.hasOwn(next, "activity") ? next.activity : previous?.activity ?? null,
      observedAtMs: timestampMs,
      terminal: Boolean(next.terminal),
      authoritativeTurnStart: Boolean(next.authoritativeTurnStart),
      supersededTurnId: next.authoritativeTurnStart
        ? previous?.turnId ?? previous?.supersededTurnId ?? null
        : null
    };
    if (previous?.authoritativeTurnStart
        && previous.supersededTurnId
        && candidate.turnId === previous.supersededTurnId) return false;
    const sameTurn = remoteActivityTurnsMatch(previous, candidate);
    const newerTurn = previous
      && Number.isFinite(previous.turnStartedAtMs)
      && Number.isFinite(candidate.turnStartedAtMs)
      && candidate.turnStartedAtMs > previous.turnStartedAtMs;
    if (previous?.turnId && candidate.turnId
        && previous.turnId !== candidate.turnId && !newerTurn) return false;
    if (previous?.terminal && sameTurn && !candidate.terminal && !next.authoritativeTurnStart) return false;
    activities.set(threadId, candidate);
    return true;
  };

  if (event.kind === "config-start") {
    return store(event.threadId, {
      turnId: null,
      turnStartedAtMs: event.turnStartedAtMs,
      activity: event.activity,
      terminal: false,
      authoritativeTurnStart: true
    });
  }

  if (event.kind === "reasoning") {
    if (!event.threadId || !event.turnId
        || !Number.isFinite(event.turnStartedAtMs) || !event.activity) return false;
    return store(event.threadId, {
      turnId: event.turnId,
      turnStartedAtMs: event.turnStartedAtMs,
      activity: event.activity,
      terminal: false
    });
  }

  if (event.kind === "resume") {
    if (!event.threadId || !event.turnId || !Number.isFinite(event.turnStartedAtMs)
        || !["completed", "stopped", "error"].includes(event.status)) return false;
    return store(event.threadId, {
      turnId: event.turnId,
      turnStartedAtMs: event.turnStartedAtMs,
      activity: null,
      terminal: true
    });
  }

  if (event.kind === "turn-complete") {
    if (!event.threadId || !event.turnId || !Number.isFinite(event.turnStartedAtMs)) return false;
    return store(event.threadId, {
      turnId: event.turnId,
      turnStartedAtMs: event.turnStartedAtMs,
      activity: null,
      terminal: true
    });
  }
  return false;
}

function remoteWorkingActivity(thread, lifecycle, nowMs = Date.now(), activities) {
  if (!thread?.id || lifecycle?.status !== "working") return null;
  const observed = activities.get(thread.id) ?? null;
  if (!observed?.activity || observed.terminal) return null;
  const ageMs = nowMs - observed.observedAtMs;
  if (ageMs < 0 || ageMs > REMOTE_ACTIVITY_STALE_MS) return null;
  const currentTurn = {
    turnId: lifecycle.latestTurnId ?? null,
    turnStartedAtMs: Number.isFinite(lifecycle.startedAtMs) ? lifecycle.startedAtMs : null
  };
  return remoteActivityTurnsMatch(observed, currentTurn) ? observed.activity : null;
}

function applyRemoteLifecycleLogLine(line, lifecycles) {
  const event = parseRemoteLogLine(line);
  if (!event) return false;
  const { timestampMs } = event;

  const update = (threadId, next) => {
    if (!UUID_PATTERN.test(threadId ?? "")) return false;
    const previous = lifecycles.get(threadId);
    if (previous && timestampMs + REMOTE_REASONING_TURN_TOLERANCE_MS < previous.observedAtMs) return false;
    const nextStartedAtMs = Number.isFinite(next.startedAtMs)
      ? next.startedAtMs
      : previous?.startedAtMs ?? null;
    if (previous && Number.isFinite(previous.startedAtMs)
        && Number.isFinite(nextStartedAtMs)
        && nextStartedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < previous.startedAtMs) {
      return false;
    }
    const latestTurnId = Object.hasOwn(next, "latestTurnId")
      ? next.latestTurnId
      : previous?.latestTurnId ?? null;
    if (previous?.pendingTurnStart
        && previous.supersededTurnId
        && latestTurnId === previous.supersededTurnId) return false;
    if (previous?.latestTurnId && latestTurnId
        && previous.latestTurnId !== latestTurnId
        && Number.isFinite(previous.startedAtMs)
        && Number.isFinite(nextStartedAtMs)
        && nextStartedAtMs < previous.startedAtMs) {
      return false;
    }
    const turnChanged = Boolean(
      previous?.latestTurnId
      && latestTurnId
      && previous.latestTurnId !== latestTurnId
    );
    lifecycles.set(threadId, {
      status: next.status ?? previous?.status ?? "idle",
      startedAtMs: nextStartedAtMs,
      endedAtMs: Object.hasOwn(next, "endedAtMs")
        ? next.endedAtMs
        : turnChanged ? null : previous?.endedAtMs ?? null,
      latestTurnId,
      lastActivityAtMs: Object.hasOwn(next, "lastActivityAtMs")
        ? next.lastActivityAtMs
        : turnChanged ? null : previous?.lastActivityAtMs ?? null,
      terminalObservedAtMs: Object.hasOwn(next, "terminalObservedAtMs")
        ? next.terminalObservedAtMs
        : turnChanged ? null : previous?.terminalObservedAtMs ?? null,
      pendingTurnStart: Boolean(next.pendingTurnStart),
      supersededTurnId: next.pendingTurnStart
        ? previous?.latestTurnId ?? previous?.supersededTurnId ?? null
        : null,
      observedAtMs: Math.max(timestampMs, previous?.observedAtMs ?? 0)
    });
    return true;
  };

  if (event.kind === "resume") {
    if (!event.threadId || !event.turnId || !event.status
        || !Number.isFinite(event.turnStartedAtMs)) return false;
    const resumed = {
      status: event.status,
      startedAtMs: event.turnStartedAtMs,
      latestTurnId: event.turnId
    };
    if (event.status === "working") {
      resumed.endedAtMs = null;
      resumed.lastActivityAtMs = timestampMs;
    }
    return update(event.threadId, resumed);
  }

  if (event.kind === "config-start") {
    return update(event.threadId, {
      status: "working",
      startedAtMs: event.turnStartedAtMs,
      endedAtMs: null,
      latestTurnId: null,
      lastActivityAtMs: timestampMs,
      terminalObservedAtMs: null,
      pendingTurnStart: true
    });
  }

  if (event.kind === "reasoning") {
    if (!event.threadId || !event.turnId || !Number.isFinite(event.turnStartedAtMs)) return false;
    return update(event.threadId, {
      status: "working",
      startedAtMs: event.turnStartedAtMs,
      endedAtMs: null,
      latestTurnId: event.turnId,
      lastActivityAtMs: timestampMs,
      terminalObservedAtMs: null
    });
  }

  if (event.kind === "turn-complete") {
    if (!event.threadId || !event.turnId || !Number.isFinite(event.turnStartedAtMs)) return false;
    return update(event.threadId, {
      status: "completed",
      startedAtMs: event.turnStartedAtMs,
      endedAtMs: timestampMs,
      latestTurnId: event.turnId,
      terminalObservedAtMs: timestampMs
    });
  }
  return false;
}

function parseCodexReasoningState(output) {
  const effort = String(output ?? "").match(/(?:^|\s)effort=(none|minimal|low|medium|high|xhigh|max|ultra)(?:\s|$)/i)?.[1];
  return normalizedReasoningEffort(effort);
}

function parseCodexComposerState(output) {
  const text = String(output ?? "");
  const reasoning = text.match(
    /(?:^|\s)(?:reasoning|effort)=(none|minimal|low|medium|high|xhigh|max|ultra|unknown)(?:\s|$)/i
  )?.[1];
  const serviceTier = text.match(
    /(?:^|\s)service_tier=(priority|default|fast|standard|unknown)(?:\s|$)/i
  )?.[1];
  const available = text.match(/(?:^|\s)available=([01])(?:\s|$)/)?.[1] === "1";
  const reasoningAvailableMatch = text.match(
    /(?:^|\s)reasoning_available=([01])(?:\s|$)/
  )?.[1];
  const serviceTierAvailableMatch = text.match(
    /(?:^|\s)service_tier_available=([01])(?:\s|$)/
  )?.[1];
  const reasoningEffort = normalizedReasoningEffort(reasoning);
  const normalizedTier = normalizedServiceTier(serviceTier);
  return {
    reasoningEffort,
    serviceTier: normalizedTier,
    available,
    reasoningAvailable: reasoningAvailableMatch === undefined
      ? reasoningEffort !== null
      : reasoningAvailableMatch === "1",
    serviceTierAvailable: serviceTierAvailableMatch === undefined
      ? normalizedTier !== null
      : serviceTierAvailableMatch === "1"
  };
}

function remoteComposerObservationTurnsMatch(observed, lifecycle) {
  if (!observed || !lifecycle) return false;
  const currentTurnId = lifecycle.latestTurnId ?? null;
  if (observed.turnId && currentTurnId) return observed.turnId === currentTurnId;
  return Number.isFinite(observed.turnStartedAtMs)
    && Number.isFinite(lifecycle.startedAtMs)
    && Math.abs(observed.turnStartedAtMs - lifecycle.startedAtMs)
      <= REMOTE_REASONING_TURN_TOLERANCE_MS;
}

function recordRemoteComposerStateObservation(
  thread,
  lifecycle,
  state,
  observedAtMs,
  observations
) {
  if (!UUID_PATTERN.test(thread?.id ?? "")
      || !(observations instanceof Map)
      || !Number.isFinite(observedAtMs)
      || !lifecycle
      || (!lifecycle.latestTurnId && !Number.isFinite(lifecycle.startedAtMs))) {
    return false;
  }
  const reasoningEffort = state?.reasoningAvailable === false
    ? null
    : normalizedReasoningEffort(state?.reasoningEffort ?? state?.effort);
  const serviceTier = state?.serviceTierAvailable === false
    ? null
    : normalizedServiceTier(state?.serviceTier);
  if (!reasoningEffort && !serviceTier) return false;
  if (Number.isFinite(lifecycle.startedAtMs)
      && observedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < lifecycle.startedAtMs) {
    return false;
  }

  const candidateTurn = {
    turnId: lifecycle.latestTurnId ?? null,
    turnStartedAtMs: Number.isFinite(lifecycle.startedAtMs)
      ? lifecycle.startedAtMs
      : null
  };
  const previous = observations.get(thread.id) ?? null;
  const sameTurn = remoteComposerObservationTurnsMatch(previous, lifecycle);
  if (sameTurn && Number.isFinite(previous?.observedAtMs)
      && observedAtMs < previous.observedAtMs) return false;

  const next = {
    ...candidateTurn,
    reasoningEffort: reasoningEffort
      ?? (sameTurn ? normalizedReasoningEffort(previous?.reasoningEffort ?? previous?.effort) : null),
    serviceTier: serviceTier
      ?? (sameTurn ? normalizedServiceTier(previous?.serviceTier) : null),
    observedAtMs
  };
  observations.set(thread.id, next);
  return true;
}

function composerStateForRemoteThread(thread, lifecycle, observations) {
  const explicitReasoning = normalizedReasoningEffort(thread?.reasoningEffort);
  const explicitTier = normalizedServiceTier(thread?.serviceTier);
  if (!thread?.id || !(observations instanceof Map)) {
    return { reasoningEffort: explicitReasoning, serviceTier: explicitTier };
  }
  const observed = observations.get(thread.id) ?? null;
  if (!remoteComposerObservationTurnsMatch(observed, lifecycle)) {
    return { reasoningEffort: explicitReasoning, serviceTier: explicitTier };
  }
  if (Number.isFinite(lifecycle?.startedAtMs)
      && observed.observedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < lifecycle.startedAtMs) {
    return { reasoningEffort: explicitReasoning, serviceTier: explicitTier };
  }
  return {
    reasoningEffort: explicitReasoning
      ?? normalizedReasoningEffort(observed.reasoningEffort ?? observed.effort),
    serviceTier: explicitTier ?? normalizedServiceTier(observed.serviceTier)
  };
}

function reasoningEffortForRemoteThread(thread, lifecycle, efforts) {
  return composerStateForRemoteThread(thread, lifecycle, efforts).reasoningEffort;
}

function serviceTierForRemoteThread(thread, lifecycle, observations) {
  return composerStateForRemoteThread(thread, lifecycle, observations).serviceTier;
}

function observeRemoteRuntimeEnd(thread, lifecycle, nowMs = Date.now(), observations) {
  const startedAtMs = Number.isFinite(lifecycle?.startedAtMs) ? lifecycle.startedAtMs : null;
  if (!thread?.id || !Number.isFinite(startedAtMs)) {
    if (thread?.id) observations.delete(thread.id);
    return { endedAtMs: null, inactiveSinceMs: null, pending: false, wasActive: false };
  }

  const turnId = lifecycle?.latestTurnId ?? null;
  const existing = observations.get(thread.id) ?? null;
  const sameTurn = existing
    && (
      turnId && existing.turnId
        ? turnId === existing.turnId
        : Math.abs(existing.turnStartedAtMs - startedAtMs) <= REMOTE_REASONING_TURN_TOLERANCE_MS
    );
  const observationGapMs = Number.isFinite(existing?.lastObservedAtMs)
    ? nowMs - existing.lastObservedAtMs
    : Number.POSITIVE_INFINITY;
  const continuousObservation = observationGapMs >= 0
    && observationGapMs <= REMOTE_RUNTIME_OBSERVATION_MAX_GAP_MS;
  const previous = sameTurn
    && (continuousObservation || Number.isFinite(existing?.endedAtMs))
    ? existing
    : null;
  const runtimeType = String(thread.threadRuntimeStatus?.type ?? "notLoaded");

  if (runtimeType === "active") {
    const next = {
      turnId,
      turnStartedAtMs: startedAtMs,
      wasActive: true,
      inactiveSinceMs: null,
      endedAtMs: null,
      runtimeType,
      lastObservedAtMs: nowMs
    };
    observations.set(thread.id, next);
    return { ...next, pending: false };
  }

  if (!previous?.wasActive) {
    const next = {
      turnId,
      turnStartedAtMs: startedAtMs,
      wasActive: false,
      inactiveSinceMs: null,
      endedAtMs: null,
      runtimeType,
      lastObservedAtMs: nowMs
    };
    observations.set(thread.id, next);
    return { ...next, pending: false };
  }

  const inactiveSinceMs = Number.isFinite(previous.inactiveSinceMs)
    ? previous.inactiveSinceMs
    : nowMs;
  const endedAtMs = Number.isFinite(previous.endedAtMs)
    ? previous.endedAtMs
    : nowMs - inactiveSinceMs >= REMOTE_RUNTIME_TERMINAL_CONFIRM_MS
      ? inactiveSinceMs
      : null;
  const next = {
    turnId,
    turnStartedAtMs: startedAtMs,
    wasActive: true,
    inactiveSinceMs,
    endedAtMs,
    runtimeType,
    lastObservedAtMs: nowMs
  };
  observations.set(thread.id, next);
  return { ...next, pending: !Number.isFinite(endedAtMs) };
}

function deriveRemoteStatus(thread, options) {
  const {
    nowMs = Date.now(),
    lifecycle: suppliedLifecycle,
    reasoningEfforts,
    composerStates,
    runtimeObservations,
    activities
  } = options;
  const runtimeStatus = thread.threadRuntimeStatus ?? { type: "notLoaded" };
  const lifecycle = suppliedLifecycle ?? null;
  const startedAtMs = Number.isFinite(lifecycle?.startedAtMs) ? lifecycle.startedAtMs : null;
  const runtimeEnd = observeRemoteRuntimeEnd(thread, lifecycle, nowMs, runtimeObservations);
  const composerState = composerStateForRemoteThread(
    thread,
    lifecycle,
    composerStates instanceof Map ? composerStates : reasoningEfforts
  );
  const reasoningEffort = composerState.reasoningEffort;
  const serviceTier = composerState.serviceTier;
  const observedActivity = remoteWorkingActivity(thread, lifecycle, nowMs, activities)
    ?? { kind: "command", label: "원격 작업" };

  if (runtimeStatus.type === "active") {
    const flags = Array.isArray(runtimeStatus.activeFlags) ? runtimeStatus.activeFlags : [];
    const waitingOnApproval = flags.includes("waitingOnApproval");
    const waitingOnUserInput = flags.includes("waitingOnUserInput");
    return {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: waitingOnApproval
        ? { kind: "request", label: "원격 승인 대기" }
        : waitingOnUserInput
          ? { kind: "request", label: "원격 입력 대기" }
          : observedActivity
    };
  }
  if (runtimeStatus.type === "systemError") {
    return {
      status: "error",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: { kind: "error", label: "원격 오류" }
    };
  }

  const lifecycleTerminal = ["completed", "stopped", "error"].includes(lifecycle?.status);
  const completionEvidence = lifecycleTerminal
    || Number.isFinite(runtimeEnd.endedAtMs)
    || (Boolean(thread.hasUnreadTurn) && runtimeStatus.type !== "active");

  if (Number.isFinite(startedAtMs)
      && lifecycle?.status === "working"
      && (!completionEvidence || runtimeEnd.pending)) {
    return {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: observedActivity
    };
  }
  if (Number.isFinite(startedAtMs) && completionEvidence) {
    const status = lifecycle?.status === "stopped"
      ? "stopped"
      : lifecycle?.status === "error"
        ? "error"
        : "completed";
    const preferredEndMs = [
      lifecycle?.endedAtMs,
      runtimeEnd.endedAtMs,
      lifecycle?.terminalObservedAtMs
    ].find(Number.isFinite) ?? null;
    const endedAtMs = Number.isFinite(preferredEndMs)
      ? Math.max(preferredEndMs, lifecycle?.lastActivityAtMs ?? startedAtMs)
      : null;
    return {
      status,
      startedAtMs,
      endedAtMs,
      reasoningEffort,
      serviceTier,
      activity: status === "stopped"
        ? { kind: "stopped", label: "원격 작업 중단" }
        : status === "error"
          ? { kind: "error", label: "원격 오류" }
          : { kind: "complete", label: thread.hasUnreadTurn ? "원격 완료 확인" : "원격 작업 종료" }
    };
  }
  return {
    status: "idle",
    startedAtMs: null,
    endedAtMs: null,
    reasoningEffort,
    serviceTier,
    activity: {
      kind: thread.hasUnreadTurn ? "answer" : "idle",
      label: thread.hasUnreadTurn ? "원격 확인 필요" : "원격 열기"
    }
  };
}

module.exports = {
  UUID_PATTERN,
  REMOTE_REASONING_TURN_TOLERANCE_MS,
  REMOTE_RUNTIME_TERMINAL_CONFIRM_MS,
  REMOTE_RUNTIME_OBSERVATION_MAX_GAP_MS,
  REMOTE_ACTIVITY_STALE_MS,
  REMOTE_REASONING_SUMMARY_MAX_LENGTH,
  REASONING_EFFORT_VALUES,
  normalizedReasoningEffort,
  normalizedServiceTier,
  uuidV7TimestampMs,
  remoteTurnStatus,
  classifyRemoteReasoningSummary,
  remoteReasoningActivityFromLogLine,
  parseRemoteLogLine,
  remoteActivityTurnsMatch,
  applyRemoteActivityLogLine,
  remoteWorkingActivity,
  applyRemoteLifecycleLogLine,
  parseCodexReasoningState,
  parseCodexComposerState,
  recordRemoteComposerStateObservation,
  composerStateForRemoteThread,
  reasoningEffortForRemoteThread,
  serviceTierForRemoteThread,
  observeRemoteRuntimeEnd,
  deriveRemoteStatus
};
