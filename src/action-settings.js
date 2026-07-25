"use strict";

const TASK_SOURCE_TO_SLOT = new Map([
  ["current", -1],
  ...Array.from({ length: 8 }, (_, index) => [`top${index + 1}`, index])
]);
const CODEX_COMMANDS = new Set(["new-task", "side-chat", "send"]);

function taskSourceFromSettings(settings = {}) {
  const value = String(settings?.taskSource ?? "").trim().toLowerCase();
  return TASK_SOURCE_TO_SLOT.has(value) ? value : "current";
}

function taskSlotFromSettings(settings = {}) {
  return TASK_SOURCE_TO_SLOT.get(taskSourceFromSettings(settings));
}

function codexCommandFromSettings(settings = {}) {
  const value = String(settings?.command ?? "").trim().toLowerCase();
  return CODEX_COMMANDS.has(value) ? value : "new-task";
}

module.exports = {
  CODEX_COMMANDS,
  TASK_SOURCE_TO_SLOT,
  codexCommandFromSettings,
  taskSlotFromSettings,
  taskSourceFromSettings
};
