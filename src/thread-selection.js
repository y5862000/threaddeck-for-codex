"use strict";

// Pure policy for selecting the task rows displayed on ThreadDeck keys.

const { isInternalThreadRecord } = require("./thread-privacy");
const { threadRecencyMs, UUID_PATTERN } = require("./time");

function isExcludedFlag(value) {
  return value === true || value === 1 || value === "1";
}

function isSelectableThreadRow(row) {
  return Boolean(row?.id)
    && !isInternalThreadRecord(row)
    && ![row.archived, row.isArchived, row.hidden, row.isHidden].some(isExcludedFlag);
}

function isPersistentThreadRow(row) {
  return isSelectableThreadRow(row)
    && UUID_PATTERN.test(row.id)
    && !row.ephemeral
    && !row.provisionalSideChat
    && !row.provisionalNewThread;
}

// Explicit assignment has a broader remote catalogue than ranked keys. Local
// identity wins even when its row is excluded, so a remote duplicate cannot
// bring an archived or hidden local task back into the picker.
function persistentThreadRows(localRows = [], remoteRows = []) {
  const localIds = new Set(localRows.map((row) => String(row?.id ?? "").toLowerCase()));
  const seen = new Set();
  return [...localRows, ...remoteRows.filter((row) => !localIds.has(String(row?.id ?? "").toLowerCase()))]
    .filter((row) => {
      if (!isPersistentThreadRow(row)) return false;
      const id = row.id.toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function selectFixedThreadRow(id, localRows = [], remoteRows = []) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  return persistentThreadRows(localRows, remoteRows)
    .find((row) => row.id.toLowerCase() === id.toLowerCase()) ?? null;
}

function selectTopThreadRows(localRows, remoteRows, openSideChats, pinnedIds, limit) {
  const selectionLimit = Number.isInteger(limit) && limit > 0 ? limit : 8;
  const visibleLocalRows = localRows.filter((row) => !isInternalThreadRecord(row));
  const visibleSideChats = openSideChats.filter((row) => !isInternalThreadRecord(row));
  const localIds = new Set(visibleLocalRows.map((row) => row.id));
  const pinnedIdSet = new Set(pinnedIds);
  const pinnedRemoteRows = remoteRows.filter((row) => !localIds.has(row.id)
    && pinnedIdSet.has(row.id)
    && !isInternalThreadRecord(row));
  const selectablePersistentRows = [...visibleLocalRows, ...pinnedRemoteRows];
  const recentRows = [...visibleLocalRows, ...visibleSideChats]
    .sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
  const byId = new Map(selectablePersistentRows.map((row) => [row.id, row]));
  const selected = [];
  const selectedIds = new Set();

  for (const id of pinnedIds) {
    const row = byId.get(id);
    if (!row || selectedIds.has(id)) continue;
    selected.push({ ...row, pinned: true });
    selectedIds.add(id);
    if (selected.length === selectionLimit) break;
  }

  for (const row of recentRows) {
    if (selected.length === selectionLimit) break;
    if (selectedIds.has(row.id)) continue;
    selected.push({ ...row, pinned: false });
    selectedIds.add(row.id);
  }

  return {
    selected,
    byId,
    mostRecentId: recentRows[0]?.id ?? null
  };
}

module.exports = { persistentThreadRows, selectFixedThreadRow, selectTopThreadRows };
