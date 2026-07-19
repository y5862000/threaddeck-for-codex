"use strict";

// Pure parsers for the Codex Desktop global-state snapshot.

const {
  normalizedReasoningEffort,
  normalizedServiceTier
} = require("./remote-state");
const { isInternalThreadRecord } = require("./thread-privacy");
const { UUID_PATTERN, threadRecencyMs } = require("./time");

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function persistedAtomState(globalState) {
  const persistedValue = globalState?.["electron-persisted-atom-state"];
  let persisted = persistedValue;
  if (typeof persistedValue === "string") {
    try {
      persisted = JSON.parse(persistedValue);
    } catch {
      return null;
    }
  }
  return isObjectRecord(persisted) ? persisted : null;
}

function pinnedThreadIdsFromState(globalState) {
  const ids = Array.isArray(globalState?.["pinned-thread-ids"])
    ? globalState["pinned-thread-ids"]
    : [];
  return [...new Set(ids.filter((id) => typeof id === "string" && UUID_PATTERN.test(id)))];
}

function promptHistoryFromState(globalState) {
  const promptHistory = persistedAtomState(globalState)?.["prompt-history"];
  return isObjectRecord(promptHistory) ? promptHistory : null;
}

function remoteThreadRowsFromState(globalState) {
  const persisted = persistedAtomState(globalState);
  if (!persisted) return [];

  const byId = new Map();
  const internalIds = new Set();
  for (const [key, summaries] of Object.entries(persisted)) {
    if (!key.startsWith("remote-thread-summaries-v2:") || !Array.isArray(summaries)) continue;
    const cachedHostId = key.slice("remote-thread-summaries-v2:".length);
    for (const summary of summaries) {
      const id = summary?.conversationId;
      if (isInternalThreadRecord(summary)) {
        if (UUID_PATTERN.test(id ?? "")) {
          internalIds.add(id);
          byId.delete(id);
        }
        continue;
      }
      if (internalIds.has(id)) continue;
      const hostId = typeof summary?.hostId === "string" && summary.hostId
        ? summary.hostId
        : cachedHostId;
      const title = typeof summary?.title === "string" ? summary.title.trim() : "";
      if (!UUID_PATTERN.test(id ?? "") || !hostId || hostId === "local" || !title) continue;

      const recencyAt = Number(summary?.recencyAt ?? summary?.updatedAt ?? 0);
      const updatedAt = Number(summary?.updatedAt ?? recencyAt);
      const createdAt = Number(summary?.createdAt ?? recencyAt);
      const recencyAtMs = recencyAt > 100_000_000_000 ? recencyAt : recencyAt * 1000;
      const summaryUpdatedAtMs = updatedAt > 100_000_000_000 ? updatedAt : updatedAt * 1000;
      const existing = byId.get(id);
      if (existing && threadRecencyMs(existing) >= recencyAtMs) {
        continue;
      }
      byId.set(id, {
        id,
        hostId,
        remote: true,
        title,
        cwd: typeof summary?.cwd === "string" ? summary.cwd : "",
        rollout_path: null,
        recency_at: recencyAt,
        updated_at: updatedAt,
        summaryUpdatedAtMs,
        createdAtMs: createdAt > 100_000_000_000 ? createdAt : createdAt * 1000,
        hasUnreadTurn: Boolean(summary?.hasUnreadTurn),
        threadRuntimeStatus: summary?.threadRuntimeStatus ?? { type: "notLoaded" },
        reasoningEffort: normalizedReasoningEffort(summary?.reasoningEffort)
          ?? normalizedReasoningEffort(summary?.latestReasoningEffort),
        // The production v2 summary currently has a workspace `mode` field
        // (typically "default"), not a response-speed field. Never infer Fast
        // or Standard from that ambiguous value; only accept an explicit,
        // validated service tier when a newer Codex schema supplies one.
        serviceTier: normalizedServiceTier(summary?.serviceTier),
        workspaceKind: summary?.workspaceKind ?? "project"
      });
    }
  }
  return [...byId.values()].sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
}

module.exports = {
  persistedAtomState,
  pinnedThreadIdsFromState,
  promptHistoryFromState,
  remoteThreadRowsFromState
};
