"use strict";

// Codex creates a temporary Side Chat by forking the parent task and then
// injecting the forked context into a new ephemeral conversation. Prompt
// history is not guaranteed to retain every open Side Chat, so preserve the
// fork/inject identity pair from the desktop log as a second discovery source.

const { UUID_PATTERN, uuidV7TimestampMs } = require("./time");

const DEFAULT_FORK_PAIR_TTL_MS = 15_000;

function createSideChatDiscoveryState() {
  return {
    pendingForkByOrigin: new Map(),
    recordsById: new Map(),
    closedAtById: new Map()
  };
}

function logTimestampMs(line) {
  const timestampMs = Date.parse(String(line ?? "").slice(0, 24));
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function conversationIdFromLine(line) {
  return String(line ?? "").match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
}

function originIdFromLine(line) {
  return String(line ?? "").match(/originWebcontentsId=([^\s]+)/i)?.[1] ?? "unknown";
}

function responseSucceeded(line) {
  const errorCode = String(line ?? "").match(/errorCode=([^\s]+)/)?.[1] ?? null;
  return errorCode === null || errorCode === "null";
}

function conversationBelongsToSession(id, observedAtMs, sessionStartedAtMs, toleranceMs) {
  if (!UUID_PATTERN.test(id) || !Number.isFinite(observedAtMs)) return false;
  if (!Number.isFinite(sessionStartedAtMs)) return true;
  const createdAtMs = uuidV7TimestampMs(id);
  if (!Number.isFinite(createdAtMs)) return false;
  return createdAtMs + toleranceMs >= sessionStartedAtMs
    && observedAtMs + toleranceMs >= sessionStartedAtMs;
}

function recentForkForOrigin(state, originId, observedAtMs, pairTtlMs) {
  const direct = state.pendingForkByOrigin.get(originId) ?? null;
  if (direct && observedAtMs >= direct.observedAtMs
      && observedAtMs - direct.observedAtMs <= pairTtlMs) return direct;

  let latest = null;
  for (const fork of state.pendingForkByOrigin.values()) {
    if (observedAtMs < fork.observedAtMs || observedAtMs - fork.observedAtMs > pairTtlMs) continue;
    if (!latest || fork.observedAtMs > latest.observedAtMs) latest = fork;
  }
  return latest;
}

function prunePendingForks(state, nowMs, pairTtlMs) {
  for (const [originId, fork] of state.pendingForkByOrigin) {
    if (nowMs - fork.observedAtMs > pairTtlMs) state.pendingForkByOrigin.delete(originId);
  }
}

function applySideChatLogLine(state, line, options = {}) {
  if (!state?.pendingForkByOrigin || !state?.recordsById || !state?.closedAtById) return null;
  const text = String(line ?? "");
  if (!text.includes("method=thread/")) return null;
  const observedAtMs = logTimestampMs(text);
  if (!Number.isFinite(observedAtMs)) return null;

  const pairTtlMs = Number.isFinite(options.pairTtlMs)
    ? Math.max(0, options.pairTtlMs)
    : DEFAULT_FORK_PAIR_TTL_MS;
  const toleranceMs = Number.isFinite(options.sessionToleranceMs)
    ? Math.max(0, options.sessionToleranceMs)
    : 0;
  prunePendingForks(state, observedAtMs, pairTtlMs);

  if (text.includes("method=thread/fork")) {
    const parentId = conversationIdFromLine(text);
    if (!parentId || !UUID_PATTERN.test(parentId) || !responseSucceeded(text)) return null;
    const originId = originIdFromLine(text);
    state.pendingForkByOrigin.set(originId, { parentId, observedAtMs, originId });
    return { kind: "fork", parentId, observedAtMs };
  }

  if (text.includes("method=thread/inject_items")) {
    const id = conversationIdFromLine(text);
    if (!id || !responseSucceeded(text)
        || !conversationBelongsToSession(
          id,
          observedAtMs,
          options.sessionStartedAtMs,
          toleranceMs
        )) return null;
    const originId = originIdFromLine(text);
    const fork = recentForkForOrigin(state, originId, observedAtMs, pairTtlMs);
    const createdAtMs = uuidV7TimestampMs(id) ?? observedAtMs;
    const previous = state.recordsById.get(id) ?? null;
    const record = {
      id,
      parentId: fork?.parentId ?? previous?.parentId ?? null,
      createdAtMs: previous?.createdAtMs ?? createdAtMs,
      observedAtMs: Math.max(previous?.observedAtMs ?? 0, observedAtMs)
    };
    state.recordsById.set(id, record);
    if (fork) state.pendingForkByOrigin.delete(fork.originId);
    return { kind: "side-chat", ...record };
  }

  if (text.includes("method=thread/unsubscribe")) {
    const id = conversationIdFromLine(text);
    if (!id || !UUID_PATTERN.test(id) || !responseSucceeded(text)) return null;
    const previous = state.closedAtById.get(id);
    state.closedAtById.set(id, Math.max(previous ?? 0, observedAtMs));
    return { kind: "closed", id, observedAtMs };
  }

  return null;
}

function openDiscoveredSideChats(state, persistentIds = new Set()) {
  const persistent = persistentIds instanceof Set ? persistentIds : new Set(persistentIds);
  return [...state.recordsById.values()]
    .filter((record) => !persistent.has(record.id) && !state.closedAtById.has(record.id))
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
}

module.exports = {
  DEFAULT_FORK_PAIR_TTL_MS,
  applySideChatLogLine,
  createSideChatDiscoveryState,
  openDiscoveredSideChats
};
