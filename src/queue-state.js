"use strict";

// Pure parsing and localized count helpers for Codex queued-message state.

const { stringFingerprint } = require("./text");

const QUEUED_MESSAGE_DELETE_LABELS = [
  "대기열에 있는 메시지 삭제",
  "Delete queued message"
];
const QUEUED_MESSAGE_ACTION_LABELS = [
  "대기열에 있는 메시지 액션",
  "Queued message actions"
];

const QUEUED_MESSAGE_DELETE_FINGERPRINTS = new Set(QUEUED_MESSAGE_DELETE_LABELS.map(stringFingerprint));
const QUEUED_MESSAGE_ACTION_FINGERPRINTS = new Set(QUEUED_MESSAGE_ACTION_LABELS.map(stringFingerprint));

function parseCodexQueueWindows(output) {
  const windows = [];
  let current = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const [kind, value, rawCount] = line.split("\t");
    if (kind === "window") {
      current = {
        index: Number(value),
        focused: rawCount === "1",
        headers: new Set(),
        buttons: new Map()
      };
      windows.push(current);
    } else if (kind === "header" && current && value) {
      current.headers.add(value);
    } else if (kind === "button" && current && value) {
      const count = Number.parseInt(rawCount, 10);
      if (Number.isFinite(count) && count > 0) current.buttons.set(value, count);
    } else if (kind === "end") {
      current = null;
    }
  }
  return windows;
}

function queueCountForWindow(window) {
  let deleteCount = 0;
  let actionCount = 0;
  for (const fingerprint of QUEUED_MESSAGE_DELETE_FINGERPRINTS) {
    deleteCount = Math.max(deleteCount, window.buttons.get(fingerprint) ?? 0);
  }
  for (const fingerprint of QUEUED_MESSAGE_ACTION_FINGERPRINTS) {
    actionCount = Math.max(actionCount, window.buttons.get(fingerprint) ?? 0);
  }
  return Math.max(deleteCount, actionCount);
}

module.exports = {
  parseCodexQueueWindows,
  queueCountForWindow
};
