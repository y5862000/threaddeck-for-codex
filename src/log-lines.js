"use strict";

// Keep append-only log parsing byte based until a complete line is available.
// Decoding each filesystem chunk independently can corrupt a UTF-8 code point
// split across two reads.

const DEFAULT_MAX_CARRY_BYTES = 1024 * 1024;
const DEFAULT_BOUNDARY_BYTES = 64;
const EMPTY_BUFFER = Buffer.alloc(0);

function positiveByteLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function byteBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value === null || value === undefined) return EMPTY_BUFFER;
  return Buffer.from(String(value), "utf8");
}

function consumeLogBytes(previousState, chunk, options = {}) {
  const maxCarryBytes = positiveByteLimit(
    options.maxCarryBytes,
    DEFAULT_MAX_CARRY_BYTES
  );
  const previousCarry = byteBuffer(previousState?.carryBytes);
  const inputChunk = byteBuffer(chunk);
  const input = previousCarry.length > 0
    ? Buffer.concat([previousCarry, inputChunk])
    : inputChunk;
  const lines = [];
  let lineStart = 0;
  let discardingLine = Boolean(previousState?.discardingLine)
    || options.discardLeadingPartial === true;
  let droppedLineCount = 0;

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== 0x0a) continue;
    let line = input.subarray(lineStart, index);
    lineStart = index + 1;
    if (discardingLine) {
      discardingLine = false;
      droppedLineCount += 1;
      continue;
    }
    if (line.length > maxCarryBytes) {
      droppedLineCount += 1;
      continue;
    }
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    lines.push(line.toString("utf8"));
  }

  let carryBytes = input.subarray(lineStart);
  if (discardingLine) {
    // Once the beginning of a line has been discarded, retaining its suffix
    // cannot make it parseable. Wait for the next newline without growing RAM.
    carryBytes = EMPTY_BUFFER;
  } else if (carryBytes.length > maxCarryBytes) {
    carryBytes = EMPTY_BUFFER;
    discardingLine = true;
    droppedLineCount += 1;
  } else if (carryBytes.length > 0) {
    // Copy so a small tail does not retain a much larger filesystem buffer.
    carryBytes = Buffer.from(carryBytes);
  }

  return {
    lines,
    state: { carryBytes, discardingLine },
    carryBytes,
    discardingLine,
    droppedLineCount
  };
}

// Compatibility wrapper for callers/tests that already hold decoded text.
function consumeLogText(previousCarry, chunk, options = {}) {
  const result = consumeLogBytes(
    { carryBytes: byteBuffer(previousCarry) },
    byteBuffer(chunk),
    options
  );
  return {
    lines: result.lines,
    carry: result.carryBytes.toString("utf8"),
    discardingLine: result.discardingLine,
    droppedLineCount: result.droppedLineCount
  };
}

function statPart(value) {
  if (typeof value === "bigint") return value.toString();
  return Number.isFinite(value) ? String(value) : "";
}

function logFileIdentity(stat) {
  if (!stat || typeof stat !== "object") return null;
  const device = statPart(stat.dev);
  const inode = statPart(stat.ino);
  const birthtime = statPart(stat.birthtimeMs);
  if (!device && !inode && !birthtime) return null;
  return `${device}:${inode}:${birthtime}`;
}

function canContinueLogCursor(cursor, stat, observedBoundary) {
  if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return false;
  if (!Number.isSafeInteger(stat?.size) || stat.size < cursor.offset) return false;
  const identity = logFileIdentity(stat);
  if (!identity || identity !== cursor.fileIdentity) return false;
  const expected = byteBuffer(cursor.boundaryBytes);
  if (expected.length === 0) return true;
  const observed = byteBuffer(observedBoundary);
  return observed.length === expected.length && observed.equals(expected);
}

function nextLogBoundary(previousBoundary, chunk, maxBytes = DEFAULT_BOUNDARY_BYTES) {
  const limit = positiveByteLimit(maxBytes, DEFAULT_BOUNDARY_BYTES);
  const previous = byteBuffer(previousBoundary);
  const appended = byteBuffer(chunk);
  if (appended.length >= limit) return Buffer.from(appended.subarray(appended.length - limit));
  const combined = previous.length > 0
    ? Buffer.concat([previous, appended])
    : appended;
  return Buffer.from(combined.subarray(Math.max(0, combined.length - limit)));
}

module.exports = {
  DEFAULT_BOUNDARY_BYTES,
  DEFAULT_MAX_CARRY_BYTES,
  canContinueLogCursor,
  consumeLogBytes,
  consumeLogText,
  logFileIdentity,
  nextLogBoundary
};
