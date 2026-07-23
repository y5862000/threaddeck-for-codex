"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  crossfadeSvgFrames,
  easedProgress,
  interpolate,
  smootherStep01
} = require("../src/motion");

test("smootherStep01 reaches rest with zero-slope endpoints", () => {
  assert.equal(smootherStep01(-1), 0);
  assert.equal(smootherStep01(0), 0);
  assert.equal(smootherStep01(1), 1);
  assert.equal(smootherStep01(2), 1);
  assert.ok(smootherStep01(0.01) < 0.00002);
  assert.ok(1 - smootherStep01(0.99) < 0.00002);
});

test("eased progress and interpolation remain monotonic", () => {
  const samples = [0, 50, 100, 150, 200].map((nowMs) => easedProgress(0, 200, nowMs));
  assert.deepEqual(samples, [...samples].sort((left, right) => left - right));
  assert.equal(interpolate(20, 80, samples[0]), 20);
  assert.equal(interpolate(20, 80, samples.at(-1)), 80);
});

test("SVG crossfade keeps both frames only during the transition", () => {
  const from = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>';
  const to = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>';
  assert.equal(crossfadeSvgFrames(from, to, 0), from);
  assert.equal(crossfadeSvgFrames(from, to, 1), to);
  const middle = crossfadeSvgFrames(from, to, 0.5);
  assert.match(middle, /opacity="0\.5000"/);
  assert.equal((middle.match(/<image /g) ?? []).length, 2);
});
