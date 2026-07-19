"use strict";

// Goal records come from two Codex surfaces: the local SQLite database uses
// snake_case values and app-server/Accessibility observations use camelCase.
// Keep normalization and elapsed-time math in one place so local and remote
// task buttons follow the same lifecycle rules as Codex Desktop.

const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

function normalizeGoalStatus(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const camelCase = normalized
    .replace(/[-_]([a-z])/g, (_match, letter) => letter.toUpperCase());
  return GOAL_STATUSES.has(camelCase) ? camelCase : null;
}

function nonnegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestampMs(value) {
  const number = nonnegativeNumber(value);
  if (number === null || number === 0) return null;
  return number < 100_000_000_000 ? number * 1000 : number;
}

function normalizeGoalRecord(row, options = {}) {
  if (!row || typeof row !== "object") return null;
  const status = normalizeGoalStatus(row.status);
  const timeUsedSeconds = nonnegativeNumber(row.time_used_seconds ?? row.timeUsedSeconds);
  if (!status || timeUsedSeconds === null) return null;
  const threadId = String(row.thread_id ?? row.threadId ?? "").trim() || null;
  const goalId = String(row.goal_id ?? row.goalId ?? "").trim() || null;
  return {
    threadId,
    goalId,
    status,
    timeUsedSeconds,
    createdAtMs: row.created_at_ms !== undefined
      ? nonnegativeNumber(row.created_at_ms)
      : timestampMs(row.createdAt),
    updatedAtMs: row.updated_at_ms !== undefined
      ? nonnegativeNumber(row.updated_at_ms)
      : timestampMs(row.updatedAt),
    source: options.source ?? row.source ?? null
  };
}

function goalElapsedMs(goal, nowMs = Date.now()) {
  const frozenElapsedMs = nonnegativeNumber(goal?.frozenElapsedMs);
  if (frozenElapsedMs !== null) return frozenElapsedMs;
  const timeUsedSeconds = nonnegativeNumber(goal?.timeUsedSeconds);
  if (timeUsedSeconds === null) return null;
  const baseMs = timeUsedSeconds * 1000;
  if (normalizeGoalStatus(goal?.status) !== "active") return baseMs;
  if (!Number.isFinite(goal?.updatedAtMs)) return baseMs;
  const endMs = Number.isFinite(goal?.freezeAtMs) ? goal.freezeAtMs : nowMs;
  if (!Number.isFinite(endMs)) return baseMs;
  return baseMs + Math.max(0, endMs - goal.updatedAtMs);
}

function goalIsUnfinished(goal) {
  const status = normalizeGoalStatus(goal?.status);
  return Boolean(status && status !== "complete");
}

function goalIdentity(goal) {
  if (!goal) return null;
  return goal.goalId
    ?? (Number.isFinite(goal.createdAtMs) ? `${goal.threadId ?? "goal"}:${goal.createdAtMs}` : null);
}

function freezeGoal(goal, cutoffMs, status = goal?.status, elapsedMs = null) {
  if (!goal || !Number.isFinite(cutoffMs)) return goal ?? null;
  const normalizedStatus = normalizeGoalStatus(status) ?? goal.status;
  const fixedElapsedMs = nonnegativeNumber(elapsedMs) ?? goalElapsedMs(goal, cutoffMs);
  if (goal.status === "active" && normalizedStatus === "active") {
    return {
      ...goal,
      freezeAtMs: cutoffMs,
      frozenElapsedMs: fixedElapsedMs
    };
  }
  return {
    ...goal,
    status: normalizedStatus,
    timeUsedSeconds: Number.isFinite(fixedElapsedMs)
      ? Math.floor(fixedElapsedMs / 1000)
      : goal.timeUsedSeconds,
    updatedAtMs: cutoffMs,
    freezeAtMs: undefined,
    frozenElapsedMs: fixedElapsedMs
  };
}

function unfreezeGoal(goal) {
  if (!goal) return null;
  if (!Object.hasOwn(goal, "freezeAtMs")
      && !Object.hasOwn(goal, "frozenElapsedMs")
      && !Object.hasOwn(goal, "resumeRequiresObservation")) {
    return goal;
  }
  const {
    freezeAtMs: _freezeAtMs,
    frozenElapsedMs: _frozenElapsedMs,
    resumeRequiresObservation: _resumeRequiresObservation,
    ...unfrozen
  } = goal;
  return unfrozen;
}

function applyGoalTerminalCutoff(goal, thread, previousCutoff = null, nowMs = Date.now()) {
  if (!goal || normalizeGoalStatus(goal.status) !== "active") {
    return { goal: goal ?? null, cutoff: null };
  }
  const identity = goalIdentity(goal) ?? `${goal.source ?? "unknown"}:${thread?.id ?? "thread"}`;
  const sameCutoff = previousCutoff?.identity === identity ? previousCutoff : null;
  const terminal = thread?.status === "stopped" || thread?.status === "error";
  // Remote goal snapshots can remain stale-active after the remote runtime
  // becomes idle. A completed turn is therefore a provisional cap: it stops a
  // blocked goal from running forever, but is released immediately if the
  // automatic goal continuation starts another turn.
  const provisionalTerminal = Boolean(
    thread?.remote && ["completed", "idle"].includes(thread?.status)
  );
  let cutoff = sameCutoff;
  if ((terminal || provisionalTerminal) && !cutoff) {
    cutoff = {
      identity,
      cutoffMs: Number.isFinite(thread?.endedAtMs) ? thread.endedAtMs : nowMs,
      goalUpdatedAtMs: Number.isFinite(goal.updatedAtMs) ? goal.updatedAtMs : null,
      provisional: provisionalTerminal,
      frozenElapsedMs: null
    };
    cutoff.frozenElapsedMs = goalElapsedMs(goal, cutoff.cutoffMs);
  }
  if (!cutoff) {
    return {
      goal: goal.resumeRequiresObservation ? goal : unfreezeGoal(goal),
      cutoff: null
    };
  }

  if (!terminal && !provisionalTerminal && cutoff.provisional) {
    if (goal.resumeRequiresObservation) return { goal, cutoff };
    return { goal: unfreezeGoal(goal), cutoff: null };
  }

  const snapshotAdvanced = Number.isFinite(goal.updatedAtMs)
    && Number.isFinite(cutoff.cutoffMs)
    && goal.updatedAtMs > cutoff.cutoffMs;
  if (!terminal && !provisionalTerminal && snapshotAdvanced) {
    if (goal.resumeRequiresObservation) return { goal, cutoff };
    return { goal: unfreezeGoal(goal), cutoff: null };
  }
  return {
    goal: freezeGoal(goal, cutoff.cutoffMs, goal.status, cutoff.frozenElapsedMs),
    cutoff
  };
}

function parseCodexGoalState(output, observedAtMs = Date.now()) {
  const text = String(output ?? "");
  const status = normalizeGoalStatus(
    text.match(/(?:^|\s)state=([a-z_-]+)(?:\s|$)/i)?.[1]
  );
  const elapsedValue = text.match(/(?:^|\s)elapsed=(\d+|unknown)(?:\s|$)/i)?.[1];
  const timeUnknown = String(elapsedValue ?? "").toLowerCase() === "unknown";
  const elapsedSeconds = timeUnknown ? null : nonnegativeNumber(elapsedValue);
  if (!status || (!timeUnknown && elapsedSeconds === null) || !Number.isFinite(observedAtMs)) {
    return null;
  }
  return {
    threadId: null,
    goalId: null,
    status,
    timeUsedSeconds: elapsedSeconds,
    createdAtMs: null,
    updatedAtMs: observedAtMs,
    source: "accessibility",
    ...(timeUnknown ? { timeUnknown: true } : {})
  };
}

module.exports = {
  GOAL_STATUSES,
  applyGoalTerminalCutoff,
  freezeGoal,
  goalElapsedMs,
  goalIdentity,
  goalIsUnfinished,
  normalizeGoalRecord,
  normalizeGoalStatus,
  parseCodexGoalState,
  timestampMs,
  unfreezeGoal
};
