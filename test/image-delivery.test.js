"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageDeliveryQueue } = require("../src/image-delivery");

function fakeClock() {
  let nowMs = 0;
  let serial = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    schedule(callback, delayMs) {
      const id = ++serial;
      timers.set(id, { callback, dueAtMs: nowMs + delayMs });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(delayMs) {
      const targetMs = nowMs + delayMs;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAtMs <= targetMs)
          .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        nowMs = timer.dueAtMs;
        timer.callback();
      }
      nowMs = targetMs;
    }
  };
}

test("coalesces rapid key frames and bounds per-context delivery", () => {
  const clock = fakeClock();
  const delivered = [];
  const queue = createImageDeliveryQueue({
    deliver: (context, payload) => delivered.push([clock.now(), context, payload]),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    minContextIntervalMs: 80,
    minGlobalIntervalMs: 0
  });

  queue.enqueue("key", "frame-1");
  queue.enqueue("key", "frame-2");
  queue.enqueue("key", "frame-3");
  assert.deepEqual(delivered, [[0, "key", "frame-1"]]);
  assert.equal(queue.pendingCount(), 1);

  clock.advance(79);
  assert.equal(delivered.length, 1);
  clock.advance(1);
  assert.deepEqual(delivered[1], [80, "key", "frame-3"]);
  assert.equal(queue.pendingCount(), 0);
});

test("applies aggregate spacing when several keys animate", () => {
  const clock = fakeClock();
  const delivered = [];
  const queue = createImageDeliveryQueue({
    deliver: (context, payload) => delivered.push([clock.now(), context, payload]),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    minContextIntervalMs: 0,
    minGlobalIntervalMs: 28
  });

  queue.enqueue("a", "a1");
  queue.enqueue("b", "b1");
  queue.enqueue("c", "c1");
  assert.deepEqual(delivered, [[0, "a", "a1"]]);
  clock.advance(28);
  assert.equal(delivered.length, 2);
  clock.advance(28);
  assert.equal(delivered.length, 3);
  assert.deepEqual(delivered.map(([time]) => time), [0, 28, 56]);
});

test("defers during socket backpressure and sends only the newest frame", () => {
  const clock = fakeClock();
  const delivered = [];
  let bufferedBytes = 100_000;
  const queue = createImageDeliveryQueue({
    deliver: (context, payload) => delivered.push([clock.now(), context, payload]),
    bufferedAmount: () => bufferedBytes,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    minContextIntervalMs: 0,
    minGlobalIntervalMs: 0,
    maxBufferedBytes: 64 * 1024,
    backpressureRetryMs: 50
  });

  queue.enqueue("key", "old");
  queue.enqueue("key", "new");
  assert.equal(delivered.length, 0);
  assert.equal(queue.pendingCount(), 1);

  bufferedBytes = 0;
  clock.advance(75);
  assert.deepEqual(delivered, [[75, "key", "new"]]);
});

test("keeps aggregate pacing independent for separate Stream Deck devices", () => {
  const clock = fakeClock();
  const delivered = [];
  const queue = createImageDeliveryQueue({
    deliver: (context, payload) => delivered.push([clock.now(), context, payload]),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    resolvePolicy: (context) => ({
      lane: context.startsWith("a") ? "device-a" : "device-b",
      minContextIntervalMs: 0,
      minGlobalIntervalMs: 28
    })
  });

  queue.enqueue("a1", "a-first");
  queue.enqueue("b1", "b-first");
  queue.enqueue("a2", "a-second");
  queue.enqueue("b2", "b-second");
  assert.deepEqual(delivered.map(([time, context]) => [time, context]), [
    [0, "a1"],
    [0, "b1"]
  ]);

  clock.advance(28);
  assert.deepEqual(delivered.map(([time, context]) => [time, context]), [
    [0, "a1"],
    [0, "b1"],
    [28, "a2"],
    [28, "b2"]
  ]);
});

test("backs off a pressured device lane and recovers after a quiet window", () => {
  const clock = fakeClock();
  const delivered = [];
  const adaptiveChanges = [];
  let bufferedBytes = 100;
  const queue = createImageDeliveryQueue({
    deliver: (context, payload) => delivered.push([clock.now(), context, payload]),
    bufferedAmount: () => bufferedBytes,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onAdaptiveChange: (change) => adaptiveChanges.push(change),
    resolvePolicy: () => ({
      lane: "neo",
      minContextIntervalMs: 0,
      minGlobalIntervalMs: 0,
      maxBufferedBytes: 10,
      backpressureRetryMs: 50,
      maxSlowdownMultiplier: 4,
      recoveryMs: 100
    })
  });

  queue.enqueue("key", "old");
  queue.enqueue("key", "new");
  assert.equal(queue.laneSnapshot("neo").slowdownMultiplier, 1.5);
  bufferedBytes = 0;
  clock.advance(75);
  assert.deepEqual(delivered, [[75, "key", "new"]]);
  assert.equal(queue.laneSnapshot("neo").slowdownMultiplier, 1.5);

  clock.advance(100);
  queue.enqueue("key", "recovered");
  assert.equal(queue.laneSnapshot("neo").slowdownMultiplier, 1);
  assert.deepEqual(delivered.at(-1), [175, "key", "recovered"]);
  assert.deepEqual(
    adaptiveChanges.map(({ reason, slowdownMultiplier }) => [reason, slowdownMultiplier]),
    [["backpressure", 1.5], ["recovery", 1]]
  );
});
