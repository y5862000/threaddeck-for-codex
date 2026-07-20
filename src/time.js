"use strict";

// Thread identity, recency, and elapsed-time helpers with no runtime state.

const { goalElapsedMs } = require("./goal-state");
const { t } = require("./i18n");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidV7TimestampMs(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const compact = id.replaceAll("-", "").toLowerCase();
  if (compact[12] !== "7") return null;
  const timestampMs = Number.parseInt(compact.slice(0, 12), 16);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function threadRecencyMs(thread) {
  const raw = Number(thread?.recency_at ?? thread?.updated_at ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 100_000_000_000 ? raw : raw * 1000;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (hours > 0) return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  return `${String(totalMinutes).padStart(2, "0")}:${paddedSeconds}`;
}

function timingLabel(thread, nowMs) {
  if (thread?.goal) {
    const goalDurationMs = goalElapsedMs(thread.goal, nowMs);
    return Number.isFinite(goalDurationMs) ? formatDuration(goalDurationMs) : "--:--";
  }
  if (!Number.isFinite(thread?.startedAtMs)) {
    if (["working", "completed", "stopped"].includes(thread?.status)) return "--:--";
    return t("action.open", "Open");
  }
  const endMs = thread.status === "working" ? nowMs : thread.endedAtMs;
  if (!Number.isFinite(endMs) || endMs < thread.startedAtMs) return "--:--";
  const duration = formatDuration(endMs - thread.startedAtMs);
  if (["working", "completed", "stopped"].includes(thread.status)) return duration;
  return t("action.open", "Open");
}

module.exports = {
  UUID_PATTERN,
  formatDuration,
  threadRecencyMs,
  timingLabel,
  uuidV7TimestampMs
};
