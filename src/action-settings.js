"use strict";

const { UUID_PATTERN } = require("./time");

const FIXED_THREAD_SLOT = -2;
const TASK_SOURCE_TO_SLOT = new Map([
  ["current", -1],
  ["fixed", FIXED_THREAD_SLOT],
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

function fixedTaskIdFromSettings(settings = {}) {
  const value = typeof settings?.fixedTaskId === "string" ? settings.fixedTaskId.trim() : "";
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function fixedTaskTitleFromSettings(settings = {}) {
  const value = typeof settings?.fixedTaskTitle === "string" ? settings.fixedTaskTitle.trim() : "";
  return value || null;
}

function codexCommandFromSettings(settings = {}) {
  const value = String(settings?.command ?? "").trim().toLowerCase();
  return CODEX_COMMANDS.has(value) ? value : "new-task";
}

module.exports = {
  CODEX_COMMANDS,
  FIXED_THREAD_SLOT,
  fixedTaskIdFromSettings,
  fixedTaskTitleFromSettings,
  TASK_SOURCE_TO_SLOT,
  codexCommandFromSettings,
  taskSlotFromSettings,
  taskSourceFromSettings
};
