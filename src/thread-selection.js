"use strict";

// Pure policy for selecting the task rows displayed on ThreadDeck keys.

const { isInternalThreadRecord } = require("./thread-privacy");
const { threadRecencyMs } = require("./time");

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

module.exports = { selectTopThreadRows };
