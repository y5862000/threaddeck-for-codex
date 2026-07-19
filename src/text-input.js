"use strict";

// Shared parsing and comparison helpers for Codex composer text state.

function parseTextInputState(command, output) {
  const focusedMatch = output.match(/^(\d+)\t([0-9a-f]{16})$/i);
  if (command === "focused-text-state" && focusedMatch) {
    return {
      source: "focused",
      candidates: 1,
      length: Number(focusedMatch[1]),
      hash: focusedMatch[2].toLowerCase()
    };
  }
  const aggregateMatch = output.match(/^(\d+)\t(\d+)\t([0-9a-f]{16})$/i);
  if (command === "editable-text-state" && aggregateMatch) {
    return {
      source: "aggregate",
      candidates: Number(aggregateMatch[1]),
      length: Number(aggregateMatch[2]),
      hash: aggregateMatch[3].toLowerCase()
    };
  }
  return null;
}

function sameTextInputState(left, right) {
  return Boolean(left && right)
    && left.source === right.source
    && left.candidates === right.candidates
    && left.length === right.length
    && left.hash === right.hash;
}

function comparableTextInputStates(left, right) {
  return Boolean(left && right) && left.source === right.source;
}

function voiceDraftReturnedToBaseline(current, tracker) {
  if (!current || !tracker?.lastObserved) return false;
  if (tracker.baseline && sameTextInputState(current, tracker.baseline)) return true;
  return comparableTextInputStates(current, tracker.lastObserved)
    && tracker.lastObserved.length > 0
    && current.length === 0;
}

module.exports = {
  parseTextInputState,
  sameTextInputState,
  comparableTextInputStates,
  voiceDraftReturnedToBaseline
};
