"use strict";

// Shared privacy boundary for every task source. Structural provenance wins;
// title signatures are only a fallback for older snapshots without metadata.

const { isInternalAmbientTitle } = require("./text");

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceDeclaresSubagent(value) {
  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed.toLowerCase() === "subagent") return true;
    if (!trimmed.startsWith("{")) return false;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  return isObjectRecord(source)
    && Object.prototype.hasOwnProperty.call(source, "subagent");
}

function isInternalThreadMetadata(row) {
  if (!isObjectRecord(row)) return false;
  const threadSources = [row.thread_source, row.threadSource];
  if (threadSources.some((value) => (
    String(value ?? "").trim().toLowerCase() === "subagent"
  ))) return true;
  const agentPaths = [row.agent_path, row.agentPath];
  if (agentPaths.some((value) => typeof value === "string" && value.trim())) return true;
  return sourceDeclaresSubagent(row.source);
}

function isInternalThreadRecord(row) {
  return isInternalThreadMetadata(row) || isInternalAmbientTitle(row?.title);
}

module.exports = {
  isInternalThreadMetadata,
  isInternalThreadRecord,
  sourceDeclaresSubagent
};
