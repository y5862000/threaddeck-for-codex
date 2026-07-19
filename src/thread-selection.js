"use strict";

// Pure policy for selecting the task rows displayed on ThreadDeck keys.

const { isInternalAmbientTitle } = require("./text");
const { threadRecencyMs } = require("./time");

function selectTopThreadRows(localRows, remoteRows, openSideChats, pinnedIds, limit) {
  const selectionLimit = Number.isInteger(limit) && limit > 0 ? limit : 8;
  const localIds = new Set(localRows.map((row) => row.id));
  const pinnedIdSet = new Set(pinnedIds);
  const pinnedRemoteRows = remoteRows.filter((row) => !localIds.has(row.id)
    && pinnedIdSet.has(row.id)
    && !isInternalAmbientTitle(row.title));
  const selectablePersistentRows = [...localRows, ...pinnedRemoteRows];
  const recentRows = [...localRows, ...openSideChats]
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
