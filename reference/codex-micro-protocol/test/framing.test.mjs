// Framing tests. The critical case: the app sends host→device RPC as bare JSON
// with NO trailing newline, so the reassembler must detect complete objects by
// balanced braces, not by newline. Getting this wrong times out every request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, Reassembler, Channel, extractJsonObjects } from "../src/framing.js";

function feed(reassembler, str) {
  const out = [];
  for (const report of encode(str, Channel.RPC)) {
    for (const m of reassembler.push(report)) out.push(m.message);
  }
  return out;
}

test("extractJsonObjects: complete, partial, back-to-back, braces in strings", () => {
  assert.deepEqual(extractJsonObjects('{"a":1}'), { objects: ['{"a":1}'], rest: "" });

  const partial = extractJsonObjects('{"a":1');
  assert.deepEqual(partial.objects, []);
  assert.equal(partial.rest, '{"a":1');

  const two = extractJsonObjects('{"a":1}{"b":2}');
  assert.deepEqual(two.objects, ['{"a":1}', '{"b":2}']);

  // Braces inside strings must not confuse depth tracking.
  const tricky = extractJsonObjects('{"t":"a}{b","n":{"x":1}}');
  assert.deepEqual(tricky.objects, ['{"t":"a}{b","n":{"x":1}}']);

  // Escaped quote inside a string.
  const esc = extractJsonObjects('{"q":"a\\"}b"}');
  assert.deepEqual(esc.objects, ['{"q":"a\\"}b"}']);
});

test("reassembler completes a single-report request with no newline", () => {
  const r = new Reassembler();
  const msgs = feed(r, JSON.stringify({ method: "device.status", id: 1 }));
  assert.deepEqual(msgs, [JSON.stringify({ method: "device.status", id: 1 })]);
});

test("reassembler completes a multi-report request with no newline", () => {
  const r = new Reassembler();
  const big = { method: "v.oai.thstatus", id: 2, params: Array.from({ length: 6 }, (_, i) => ({ id: i, c: 16777215, b: 1, e: 1, s: 0 })) };
  const raw = JSON.stringify(big);
  assert.ok(raw.length > 61, "payload must span multiple reports");
  const msgs = feed(r, raw);
  assert.deepEqual(msgs, [raw]);
});

test("reassembler handles two requests arriving back-to-back", () => {
  const r = new Reassembler();
  const a = JSON.stringify({ method: "sys.version", id: 3 });
  const b = JSON.stringify({ method: "device.status", id: 4 });
  const msgs = feed(r, a + b);
  assert.deepEqual(msgs, [a, b]);
});
