"use strict";

// Pure parsing and localized count helpers for Codex queued-message state.

const { stringFingerprint, titleFingerprints } = require("./text");

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
        headerPositions: new Map(),
        buttons: new Map(),
        buttonPositions: new Map()
      };
      windows.push(current);
    } else if (kind === "header" && current && value) {
      current.headers.add(value);
      addGeometry(current.headerPositions, value, line.split("\t").slice(2));
    } else if (kind === "button" && current && value) {
      const count = Number.parseInt(rawCount, 10);
      if (Number.isFinite(count) && count > 0) {
        current.buttons.set(value, (current.buttons.get(value) ?? 0) + count);
        addGeometry(current.buttonPositions, value, line.split("\t").slice(3));
      }
    } else if (kind === "end") {
      current = null;
    }
  }
  return windows;
}

function addGeometry(store, fingerprint, fields) {
  const [rawX, rawY, rawWidth, rawHeight] = fields;
  const x = Number(rawX);
  const y = Number(rawY);
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (![x, y, width, height].every(Number.isFinite)) return;
  const positions = store.get(fingerprint) ?? [];
  positions.push({ x, y, width, height });
  store.set(fingerprint, positions);
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

function matchingHeaderPositions(window, thread) {
  const positions = [];
  for (const fingerprint of titleFingerprints(thread?.title)) {
    positions.push(...(window.headerPositions?.get(fingerprint) ?? []));
  }
  return positions;
}

function signalPositions(window, fingerprints) {
  const positions = [];
  for (const fingerprint of fingerprints) {
    positions.push(...(window.buttonPositions?.get(fingerprint) ?? []));
  }
  return positions;
}

function deduplicatedHorizontalAnchors(positions) {
  const anchors = positions
    .map(({ x }) => Number(x))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return anchors.filter((x, index) => index === 0 || x - anchors[index - 1] > 2);
}

function candidateForHorizontalPosition(candidates, x) {
  const preceding = candidates
    .flatMap((candidate) => candidate.anchors.map((anchor) => ({ candidate, anchor })))
    .filter(({ anchor }) => anchor <= x + 2)
    .sort((left, right) => right.anchor - left.anchor);
  if (preceding.length === 0) return null;
  const best = preceding[0];
  if (preceding.some(({ candidate, anchor }, index) => (
    index > 0
      && candidate.id !== best.candidate.id
      && Math.abs(anchor - best.anchor) <= 2
  ))) return null;
  return best.candidate;
}

function countsForSignal(window, candidates, fingerprints) {
  const counts = new Map(candidates.map(({ id }) => [id, 0]));
  for (const { x, width } of signalPositions(window, fingerprints)) {
    // Queue controls can inherit an incorrect leaf coordinate from an adjacent
    // Chromium pane. The bridge therefore reports their enclosing queue row;
    // its midpoint remains inside the owning conversation panel.
    const midpoint = Number(x) + Number(width) / 2;
    const candidate = candidateForHorizontalPosition(candidates, midpoint);
    if (!candidate) return null;
    counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  }
  return counts;
}

// A Codex window can contain a normal task and one or more Side Chat panes.
// The native bridge reports the screen geometry of header and queue controls;
// pair each queue row with the nearest pane header that begins to its left so
// rows in adjacent panes are never summed onto the currently selected task.
function queueCountsByThreadForWindow(window, threads) {
  if (!(window?.headerPositions instanceof Map)
      || !(window?.buttonPositions instanceof Map)) return null;
  const candidates = threads
    .map((thread) => ({
      id: thread?.id,
      thread,
      anchors: deduplicatedHorizontalAnchors(matchingHeaderPositions(window, thread))
    }))
    .filter(({ id, anchors }) => id && anchors.length > 0);
  if (candidates.length === 0) return null;

  const deleteCounts = countsForSignal(
    window,
    candidates,
    QUEUED_MESSAGE_DELETE_FINGERPRINTS
  );
  const actionCounts = countsForSignal(
    window,
    candidates,
    QUEUED_MESSAGE_ACTION_FINGERPRINTS
  );
  if (!deleteCounts || !actionCounts) return null;

  return new Map(candidates.map(({ id }) => [id, Math.max(
    deleteCounts.get(id) ?? 0,
    actionCounts.get(id) ?? 0
  )]));
}

module.exports = {
  parseCodexQueueWindows,
  queueCountForWindow,
  queueCountsByThreadForWindow
};
