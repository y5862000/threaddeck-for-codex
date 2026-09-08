"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FIXED_THREAD_SLOT, fixedTaskIdFromSettings, fixedTaskTitleFromSettings,
  taskSourceFromSettings, taskSlotFromSettings, codexCommandFromSettings } = require("../src/action-settings");
const { persistentThreadRows, selectFixedThreadRow, selectTopThreadRows } = require("../src/thread-selection");
const { remoteThreadRowsFromState } = require("../src/codex-state");

const id = (index) => `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
const row = (index, options = {}) => ({ id: id(index), title: "Same title", recency_at: 1000 - index, ...options });

test("fixed settings normalize UUIDs without changing existing task or command defaults", () => {
  assert.equal(taskSlotFromSettings({}), -1);
  for (let i = 1; i <= 8; i++) assert.equal(taskSlotFromSettings({ taskSource: `top${i}` }), i - 1);
  assert.equal(taskSourceFromSettings({ taskSource: " FIXED " }), "fixed");
  assert.equal(taskSlotFromSettings({ taskSource: "fixed" }), FIXED_THREAD_SLOT);
  assert.equal(FIXED_THREAD_SLOT, -2);
  assert.equal(fixedTaskIdFromSettings({ fixedTaskId: ` ${id(1).toUpperCase()} ` }), id(1));
  for (const fixedTaskId of [null, 42, "top1", "side-chat:123", "Same title"]) {
    assert.equal(fixedTaskIdFromSettings({ fixedTaskId }), null);
  }
  assert.equal(fixedTaskTitleFromSettings({ fixedTaskTitle: " Renamed " }), "Renamed");
  assert.equal(fixedTaskTitleFromSettings({}), null);
  assert.equal(codexCommandFromSettings({}), "new-task");
});

test("fixed identity survives duplicate titles, rename and reorder without falling back after removal", () => {
  const renamed = row(2, { title: "Renamed", recency_at: 1 });
  assert.equal(selectFixedThreadRow(id(2), [row(1), row(2)]).id, id(2));
  assert.equal(selectFixedThreadRow(id(2).toUpperCase(), [renamed, row(1)]), renamed);
  assert.equal(selectFixedThreadRow(id(2), [row(1), renamed]), renamed);
  assert.equal(selectFixedThreadRow(id(2), [row(1)]), null);
  assert.equal(selectFixedThreadRow("Same title", [row(1)]), null);
});

test("fixed catalog excludes hidden, archived, internal and temporary tasks including remote duplicates", () => {
  const rows = [row(1), row(2, { archived: 1 }), row(3, { hidden: true }),
    row(4, { thread_source: "subagent" }), row(5, { ephemeral: true }),
    row(6, { provisionalSideChat: true }), row(7, { provisionalNewThread: true }),
    row(8, { isArchived: "1" }), row(9, { isHidden: 1 })];
  const remote = rows.map((item) => ({ ...row(1), id: item.id.toUpperCase(), remote: true }));
  assert.deepEqual(persistentThreadRows(rows, remote).map((item) => item.id), [id(1)]);
  for (let i = 2; i <= 9; i++) assert.equal(selectFixedThreadRow(id(i), rows, remote), null);
  assert.deepEqual(persistentThreadRows([{ id: "new-thread:123" }]), []);
});

test("fixed selection can reach an unpinned remote task or local task outside Top 8", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
  const remote = row(13, { remote: true });
  const before = structuredClone(rows);
  const ranked = selectTopThreadRows(rows, [remote], [], [id(2)], 8);
  assert.deepEqual(ranked.selected.map((item) => item.id), [2, 1, 3, 4, 5, 6, 7, 8].map(id));
  assert.equal(selectFixedThreadRow(id(12), rows, [remote]).id, id(12));
  assert.equal(selectFixedThreadRow(id(13), rows, [remote]), remote);
  assert.equal(ranked.byId.has(id(13)), false);
  assert.deepEqual(rows, before);
});

test("explicit remote visibility flags survive parsing into the fixed picker", () => {
  for (const flag of ["archived", "isArchived", "hidden", "isHidden"]) {
    const remoteRows = remoteThreadRowsFromState({ "electron-persisted-atom-state": {
      "remote-thread-summaries-v2:host": [
        { conversationId: id(1), title: "Unavailable", [flag]: true },
        { conversationId: id(2), title: "Available", [flag]: false }
      ]
    } });
    assert.deepEqual(persistentThreadRows([], remoteRows).map((item) => item.id), [id(2)]);
    assert.equal(selectFixedThreadRow(id(1), [], remoteRows), null);
    assert.equal(selectTopThreadRows([], remoteRows, [], [id(1)], 8).selected[0].id, id(1),
      "existing ranked policy is independent of fixed-picker exclusion");
  }
});
