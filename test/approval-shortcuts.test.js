const test = require("node:test");
const assert = require("node:assert/strict");
const { ApprovalShortcutControls } = require("../src/approval-shortcuts");

const cardToken = `a1:${"d".repeat(64)}`;
const context = { pid: 123, token: "v2:123:45:501:1", approval: { state: "ready", token: cardToken } };
const output = (value) => ({ stdout: JSON.stringify(value) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("a native press is captured once and sends one decision; repeated release does not send again", async () => {
  const calls = [];
  const controls = new ApprovalShortcutControls({ run: async (args) => { calls.push(args); return output(args.length === 1 ? context : { sent: true }); } });
  const capture = await controls.capture();
  assert.equal(capture.ok, true);
  assert.equal((await controls.capture()).reason, "busy");
  assert.deepEqual(await controls.execute("approve", capture.lease), { ok: true, delivery: "sent" });
  assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
  assert.deepEqual(calls, [["codex-approval-context"], ["codex-approval-card", "approve",
    "123", context.token, cardToken]]);
});

test("cancellation before/during capture and before dispatch emits no input and releases reservation", async () => {
  let isCurrent = true;
  const pending = deferred();
  const calls = [];
  const controls = new ApprovalShortcutControls({ run: async (args) => { calls.push(args); return pending.promise; } });
  assert.equal((await controls.capture(() => false)).ok, false);
  assert.equal(calls.length, 0);
  const capture = controls.capture(() => isCurrent);
  isCurrent = false;
  pending.resolve(output(context));
  assert.equal((await capture).reason, "context-changed");
  assert.equal(controls.active, null);
  isCurrent = true;
  const ready = await controls.capture();
  assert.equal((await controls.execute("decline", ready.lease, () => false)).delivery, "none");
  assert.equal(controls.active, null);
  const cancelled = await controls.capture();
  controls.cancel(cancelled.lease);
  assert.equal((await controls.execute("decline", cancelled.lease)).delivery, "none");
  assert.equal(calls.every((args) => args.length === 1), true);
});

test("concurrent native presses are rejected, including while delivery is unresolved", async () => {
  const pending = deferred();
  let sent = 0;
  const controls = new ApprovalShortcutControls({ run: async (args) => args.length === 1 ? output(context) : (sent++, pending.promise) });
  const capture = await controls.capture();
  const dispatch = controls.execute("decline", capture.lease);
  controls.cancel(capture.lease);
  assert.equal((await controls.capture()).reason, "busy");
  pending.resolve(output({ sent: true }));
  assert.equal((await dispatch).delivery, "sent");
  assert.equal(sent, 1);
});

test("native rejection remains a no-delivery error; transport loss is unknown and never retried", async () => {
  for (const response of [output({ sent: false, error: "approval-changed" }), { stdout: "bad" }, new Error("timeout")]) {
    let sends = 0;
    const controls = new ApprovalShortcutControls({ run: async (args) => {
        if (args.length === 1) return output(context);
        sends++;
        if (response instanceof Error) throw response;
        return response;
      } });
    const capture = await controls.capture();
    const result = await controls.execute("approve", capture.lease);
    assert.equal(result.delivery, response.stdout?.includes("approval-changed") ? "none" : "unknown");
    await controls.execute("approve", capture.lease);
    assert.equal(sends, 1);
  }
  const denied = Object.assign(new Error("denied"), output({ sent: false, error: "permission-denied" }));
  const controls = new ApprovalShortcutControls({ run: async () => { throw denied; } });
  assert.equal((await controls.capture()).reason, "permission-denied");
  assert.equal(controls.active, null);
});

test("review continuation invokes only the captured checked dialog and does not require shortcut bindings", async () => {
  const token = `r1:${"a".repeat(64)}`;
  const calls = [];
  const controls = new ApprovalShortcutControls({ run: async (args) => { calls.push(args); return output(args.length === 1
      ? { ...context, review: { state: "ready", token } } : { sent: true }); } });
  const capture = await controls.capture();
  assert.deepEqual(await controls.execute("approve", capture.lease), { ok: true, delivery: "sent" });
  assert.deepEqual(calls[1], ["codex-review-continue", "123", context.token, token]);
  assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
  assert.equal(calls.length, 2);
});

test("unchecked, ambiguous, malformed reviews and Decline never fall back to a shortcut", async () => {
  for (const [decision, review] of [
    ["approve", { state: "unchecked", token: `r1:${"b".repeat(64)}` }],
    ["approve", { state: "unavailable" }],
    ["approve", { state: "ready", token: "invalid" }],
    ["decline", { state: "ready", token: `r1:${"b".repeat(64)}` }]
  ]) {
    let calls = 0;
    const controls = new ApprovalShortcutControls({ run: async () => { calls++; return output({ ...context, review }); } });
    const capture = await controls.capture();
    assert.equal((await controls.execute(decision, capture.lease)).delivery, "none");
    assert.equal(calls, 1);
    assert.equal(controls.active, null);
  }
});

test("an uncertain review AXPress is never retried or replaced with a shortcut", async () => {
  let calls = 0;
  const controls = new ApprovalShortcutControls({ run: async () => ++calls === 1
      ? output({ ...context, review: { state: "ready", token: `r1:${"c".repeat(64)}` } })
      : Promise.reject(Object.assign(new Error("AXPress failed"), output({ sent: null, error: "delivery-unknown" }))) });
  const capture = await controls.capture();
  assert.equal((await controls.execute("approve", capture.lease)).delivery, "unknown");
  await controls.execute("approve", capture.lease);
  assert.equal(calls, 2);
});


test("Decline targets the same captured permission card without a keymap", async () => {
  const calls = [];
  const controls = new ApprovalShortcutControls({ run: async (args) => {
    calls.push(args); return output(args.length === 1 ? context : { sent: true });
  } });
  const captured = await controls.capture();
  assert.deepEqual(await controls.execute("decline", captured.lease), { ok: true, delivery: "sent" });
  assert.deepEqual(calls[1], ["codex-approval-card", "decline", "123", context.token, cardToken]);
});

test("absent, ambiguous and malformed permission cards never dispatch keys or actions", async () => {
  for (const approval of [undefined, null, {}, { state: "unavailable" },
    { state: "ready" }, { state: "ready", token: "r1:" + "d".repeat(64) },
    { state: "ready", token: "a1:" + "d".repeat(63) }]) {
    for (const decision of ["approve", "decline"]) {
      const calls = [];
      const controls = new ApprovalShortcutControls({ run: async (args) => {
        calls.push(args); return output({ ...context, approval });
      } });
      const captured = await controls.capture();
      assert.deepEqual(await controls.execute(decision, captured.lease),
        { ok: false, reason: "approval-unavailable", delivery: "none" });
      assert.deepEqual(calls, [["codex-approval-context"]]);
      assert.equal(controls.active, null);
    }
  }
});

test("capture diagnostics expose only fixed states and counts, never request text or tokens", async () => {
  const controls = new ApprovalShortcutControls({ run: async () => output({ ...context,
    scanDiagnostics: { visited: 579, complete: true, limitReason: "private text" },
    approval: { state: "ready", token: cardToken, reason: "private justification" },
    title: "private task title" }) });
  const capture = await controls.capture();
  assert.deepEqual(capture.diagnostics, { scanComplete: true, visited: 579,
    scanLimit: "unknown", reviewState: "absent", cardState: "ready", cardReason: "unknown" });
  controls.cancel(capture.lease);
});
