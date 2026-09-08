const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { IpcApprovalControls, approvalRequest, projectSnapshot } = require("../src/ipc-approvals");

const threadId = "10000000-0000-4000-8000-000000000001";
const owner = "20000000-0000-4000-8000-000000000001";
const other = "30000000-0000-4000-8000-000000000001";
const context = { ok: true, pid: 123, token: "api1:123:123456789:501:0", frontmost: false };
const request = (overrides = {}) => ({ id: 7, method: "item/commandExecution/requestApproval",
  params: { threadId, turnId: "turn-1", itemId: "item-1", command: "fixture-only" }, ...overrides });
const clone = (v) => structuredClone(v);

class Client extends EventEmitter {
  constructor(requests = [request()]) { super(); this.epoch = 1; this.ready = false; this.requests = requests; this.revision = 1; this.calls = []; this.broadcasts = []; }
  async connect() { this.ready = true; }
  isReady() { return this.ready; }
  close() { this.ready = false; this.epoch++; this.emit("disconnect"); }
  async request(method, params, options) {
    this.calls.push({ method, params: clone(params), options });
    if (this.override) { const value = await this.override(method, params, options); if (value) return value; }
    if (method === "thread-owner-discovery") return { resultType: "success", method, handledByClientId: owner, result: {} };
    if (!this.keepRequest) { this.requests = []; this.revision++; }
    return { resultType: "success", method, handledByClientId: owner, result: { ok: true } };
  }
  broadcast(method, params, options) {
    this.broadcasts.push({ method, params, options });
    if (!params.following || this.noSnapshot) return;
    const change = { type: "snapshot", revision: this.revision,
      conversationState: { id: threadId, hostId: "local", requests: clone(this.requests), turns: ["not cached"] } };
    queueMicrotask(() => this.emit("broadcast", { method: "thread-stream-state-changed", version: this.version ?? 11,
      sourceClientId: this.snapshotOwner ?? owner, params: { conversationId: threadId, hostId: "local", change } }));
  }
  patch(patches, baseRevision = this.revision) {
    this.emit("broadcast", { method: "thread-stream-state-changed", version: 11, sourceClientId: owner,
      params: { conversationId: threadId, hostId: "local", change: { type: "patches", baseRevision, revision: ++this.revision, patches } } });
  }
}
function fixture(requests, readContext = async () => clone(context)) {
  const client = new Client(requests);
  return { client, controls: new IpcApprovalControls({ client, readContext, timeoutMs: 30 }) };
}
const decisions = (client) => client.calls.filter((c) => c.method !== "thread-owner-discovery");

test("selected task uses exact IPC request ID while Codex is backgrounded, with no broader grant", async () => {
  for (const decision of ["approve", "decline"]) {
    const { controls, client } = fixture();
    const capture = await controls.capture(threadId);
    assert.equal(capture.ok, true);
    assert.equal(await controls.capture(threadId).then((v) => v.reason), "busy");
    assert.deepEqual(await controls.execute(decision, capture.lease), { ok: true, delivery: "owner-accepted" });
    assert.deepEqual(decisions(client), [{ method: "thread-follower-command-approval-decision",
      params: { conversationId: threadId, requestId: 7, decision: decision === "approve" ? "accept" : "decline" },
      options: { version: 1, targetClientId: owner, timeoutMs: 30 } }]);
    assert.equal(client.broadcasts.at(-1).params.following, false);
    assert.equal(controls.active, null);
    assert.equal(controls.record, null);
  }
});

test("read-only capture never responds, including empty, unsupported and multiple pending requests", async () => {
  for (const [requests, reason] of [
    [[], "no-requests"], [[request(), request({ id: 8 })], "multiple-requests"],
    [[request({ method: "item/tool/requestUserInput" })], "unsupported-request"],
    [[request(), request({ id: 8, method: "item/tool/requestUserInput" })], "multiple-requests"]
  ]) {
    const { client, controls } = fixture(requests);
    const result = await controls.capture(threadId);
    assert.equal(result.reason, reason);
    assert.notEqual(result.canFallback, true);
    assert.equal(decisions(client).length, 0);
    assert.equal(controls.active, null);
  }
});

test("missing selection, invalid session and context cancellation cannot dispatch", async () => {
  for (const invalid of [null, { ok: false, error: "session-locked" }, { ...context, token: "unknown" }, { ...context, pid: 0 }]) {
    const { client, controls } = fixture(undefined, async () => invalid);
    assert.equal((await controls.capture(threadId)).ok, false);
    assert.equal(client.calls.length, 0);
  }
  const { client, controls } = fixture();
  assert.equal((await controls.capture(null)).reason, "no-selected-task");
  assert.equal((await controls.capture(threadId, () => false)).ok, false);
  const capture = await controls.capture(threadId);
  assert.equal((await controls.execute("approve", capture.lease, () => false)).delivery, "none");
  assert.equal(decisions(client).length, 0);
});

test("changed request, second request and owner failure before dispatch all fail closed", async () => {
  for (const change of [
    (c) => { c.requests = [request({ id: 8 })]; c.revision++; },
    (c) => { c.requests[0].params.command = "changed"; c.revision++; },
    (c) => { c.requests.push(request({ id: 8 })); c.revision++; },
    (c) => { c.override = async () => ({ resultType: "error", error: "no-client-found" }); }
  ]) {
    const { client, controls } = fixture();
    const capture = await controls.capture(threadId);
    change(client);
    assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
    assert.equal(decisions(client).length, 0);
  }
});

test("numeric and string request IDs are distinct; a changed type cannot reuse a capture", async () => {
  const { client, controls } = fixture();
  const capture = await controls.capture(threadId);
  client.requests[0].id = "7"; client.revision++;
  assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
  assert.equal(decisions(client).length, 0);
  assert.notEqual(approvalRequest(request(), threadId).fingerprint,
    approvalRequest(request({ id: "7" }), threadId).fingerprint);
});

test("unsupported protocol, wrong owner and malformed request snapshots cannot become ready", async () => {
  for (const change of [
    (c) => { c.version = 12; }, (c) => { c.snapshotOwner = other; },
    (c) => { c.requests = [request({ id: null })]; }, (c) => { c.requests = [request(), request()]; }
  ]) {
    const { client, controls } = fixture(); change(client);
    assert.equal((await controls.capture(threadId)).ok, false);
    assert.equal(decisions(client).length, 0);
  }
});

test("revision gaps, root/request patches and session changes during final check cannot dispatch", async () => {
  for (const mutation of [
    (c) => c.patch([{ op: "replace", path: ["requests"], value: [] }]),
    (c) => c.patch([{ op: "replace", path: [], value: {} }]),
    (c) => c.patch([{ op: "replace", path: ["turns", 0], value: {} }], -10),
    (c) => c.close()
  ]) {
    let reads = 0;
    const { client, controls } = fixture(undefined, async () => { if (++reads === 2) mutation(client); return context; });
    const capture = await controls.capture(threadId);
    assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
    assert.equal(decisions(client).length, 0);
  }
  let reads = 0;
  const { client, controls } = fixture(undefined, async () => ++reads === 1 ? context : { ...context, token: "api1:123:987654321:501:0" });
  const capture = await controls.capture(threadId);
  assert.equal((await controls.execute("approve", capture.lease)).delivery, "none");
  assert.equal(decisions(client).length, 0);
});

test("unrelated valid patches do not confuse pending identity", async () => {
  let reads = 0;
  const { client, controls } = fixture(undefined, async () => {
    if (++reads === 2) client.patch([{ op: "replace", path: ["turns", 0, "durationMs"], value: 5 }]);
    return context;
  });
  const capture = await controls.capture(threadId);
  assert.equal((await controls.execute("approve", capture.lease)).ok, true);
});

test("new owner snapshots during the session read cannot change the captured request or its uniqueness", async () => {
  for (const mutate of [
    (c) => { c.requests[0].params.command = "changed after refresh"; },
    (c) => { c.requests.push(request({ id: 8 })); },
    (c) => { c.requests = []; },
    (c) => { c.requests[0].id = "7"; }
  ]) {
    let reads = 0;
    const { client, controls } = fixture(undefined, async () => {
      if (++reads === 2) {
        mutate(client);
        client.emit("broadcast", { method: "thread-stream-state-changed", version: 11,
          sourceClientId: owner, params: { conversationId: threadId, hostId: "local",
            change: { type: "snapshot", revision: ++client.revision,
              conversationState: { id: threadId, hostId: "local", requests: clone(client.requests) } } } });
      }
      return context;
    });
    const capture = await controls.capture(threadId);
    assert.deepEqual(await controls.execute("approve", capture.lease),
      { ok: false, reason: "request-changed", delivery: "none" });
    assert.equal(decisions(client).length, 0);
    assert.equal(controls.active, null);
  }
});

test("selected task must be verified strictly at capture and again before dispatch", async () => {
  for (const verifyTarget of [async () => false, async () => 1, async () => undefined,
    async () => { throw Error("selection unavailable"); }]) {
    const { client, controls } = fixture();
    assert.equal((await controls.capture(threadId, () => true, verifyTarget)).reason, "target-changed");
    assert.equal(client.calls.length, 0);
    assert.equal(controls.active, null);
  }
  const { client, controls } = fixture();
  let verifications = 0;
  const capture = await controls.capture(threadId, () => true, async () => ++verifications === 1);
  assert.equal(capture.ok, true);
  assert.deepEqual(await controls.execute("approve", capture.lease),
    { ok: false, reason: "target-changed", delivery: "none" });
  assert.equal(verifications, 2);
  assert.equal(decisions(client).length, 0);
});

test("a snapshot changing during selected-task verification cannot dispatch", async () => {
  const { client, controls } = fixture();
  let verifications = 0;
  const capture = await controls.capture(threadId, () => true, async () => {
    if (++verifications === 2) {
      client.requests[0].params.command = "changed during selection verification";
      client.emit("broadcast", { method: "thread-stream-state-changed", version: 11,
        sourceClientId: owner, params: { conversationId: threadId, hostId: "local",
          change: { type: "snapshot", revision: ++client.revision,
            conversationState: { id: threadId, hostId: "local", requests: clone(client.requests) } } } });
    }
    return true;
  });
  assert.deepEqual(await controls.execute("approve", capture.lease),
    { ok: false, reason: "request-changed", delivery: "none" });
  assert.equal(decisions(client).length, 0);
});

test("concurrent decisions share one lease and cancellation during the final read prevents dispatch", async () => {
  const { client, controls } = fixture();
  const capture = await controls.capture(threadId);
  let resumeOwner, enteredOwner;
  const ownerEntered = new Promise((resolve) => { enteredOwner = resolve; });
  client.override = async (method) => {
    if (method !== "thread-owner-discovery") return;
    enteredOwner();
    await new Promise((resolve) => { resumeOwner = resolve; });
  };
  const execution = controls.execute("approve", capture.lease);
  await ownerEntered;
  assert.equal((await controls.execute("decline", capture.lease)).reason, "busy");
  resumeOwner();
  assert.equal((await execution).ok, true);
  assert.equal(decisions(client).length, 1);

  let reads = 0, cancelledLease;
  const cancelled = fixture(undefined, async () => {
    if (++reads === 2) cancelled.controls.cancel(cancelledLease);
    return context;
  });
  cancelledLease = (await cancelled.controls.capture(threadId)).lease;
  assert.equal((await cancelled.controls.execute("approve", cancelledLease)).delivery, "none");
  assert.equal(decisions(cancelled.client).length, 0);
  assert.equal(cancelled.controls.active, null);
});

test("acknowledgment without disappearance and disappearance without matching ack are unknown, never retried", async () => {
  for (const mutate of [
    (c) => { c.keepRequest = true; },
    (c) => { c.override = async (method) => {
      if (method === "thread-owner-discovery") return;
      c.requests = []; c.revision++; return { resultType: "success", method, handledByClientId: other, result: { ok: true } };
    }; },
    (c) => { c.override = async (method) => { if (method !== "thread-owner-discovery") throw Error("disconnect"); }; }
  ]) {
    const { client, controls } = fixture();
    const capture = await controls.capture(threadId); mutate(client);
    assert.equal((await controls.execute("approve", capture.lease)).delivery, "unknown");
    client.requests = [request()]; client.revision++;
    assert.equal((await controls.capture(threadId)).reason, "already-handled");
    assert.equal((await controls.execute("approve", capture.lease)).ok, false);
    assert.equal(decisions(client).length, 1);
  }
});

test("a definitely unrouted decision allows a later deliberate attempt", async () => {
  const { client, controls } = fixture();
  const first = await controls.capture(threadId);
  client.override = async (method) => method === "thread-owner-discovery" ? undefined
    : { resultType: "error", error: "no-client-found", delivery: "none" };
  assert.equal((await controls.execute("approve", first.lease)).delivery, "none");
  client.override = null;
  const next = await controls.capture(threadId);
  assert.equal((await controls.execute("approve", next.lease)).ok, true);
  assert.equal(decisions(client).length, 2);
});

test("permission grant is limited to the requested subset and current turn", async () => {
  for (const decision of ["approve", "decline"]) {
    const permissions = { network: { enabled: true } };
    const r = request({ method: "item/permissions/requestApproval", params: { threadId, turnId: "turn", itemId: "item", permissions } });
    const { client, controls } = fixture([r]);
    const capture = await controls.capture(threadId);
    assert.equal((await controls.execute(decision, capture.lease)).ok, true);
    assert.deepEqual(decisions(client)[0].params.response, { permissions: decision === "approve" ? permissions : {}, scope: "turn" });
  }
});

test("only empty tool-approval elicitation forms accept a one-press response", async () => {
  const r = request({ method: "mcpServer/elicitation/request", params: { threadId, turnId: "turn", mode: "form",
    _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object", properties: {} } } });
  for (const decision of ["approve", "decline"]) {
    const { client, controls } = fixture([clone(r)]);
    const capture = await controls.capture(threadId);
    assert.equal((await controls.execute(decision, capture.lease)).ok, true);
    assert.deepEqual(decisions(client)[0].params.response,
      { action: decision === "approve" ? "accept" : "decline", content: decision === "approve" ? {} : null });
    assert.equal(Object.hasOwn(decisions(client)[0].params.response, "_meta"), false);
  }
  for (const mutate of [
    (p) => { p.mode = "url"; }, (p) => { p.mode = "openai/form"; },
    (p) => { p._meta.codex_approval_kind = "connector_auth"; },
    (p) => { p.requestedSchema.properties.agree = { type: "boolean" }; },
    (p) => { p.requestedSchema.required = ["agree"]; },
    (p) => { p.requestedSchema.allOf = []; }
  ]) {
    const value = clone(r); mutate(value.params);
    assert.equal(approvalRequest(value, threadId), null);
  }
});

test("file decisions preserve routing and unsupported session-only choices do not broaden approval", async () => {
  const file = fixture([request({ method: "item/fileChange/requestApproval" })]);
  const capture = await file.controls.capture(threadId);
  assert.equal((await file.controls.execute("decline", capture.lease)).ok, true);
  assert.equal(decisions(file.client)[0].method, "thread-follower-file-approval-decision");
  const r = request(); r.params.availableDecisions = ["acceptForSession", "decline"];
  const { controls, client } = fixture([r]);
  const onlySession = await controls.capture(threadId);
  assert.equal((await controls.execute("approve", onlySession.lease)).reason, "unsupported-decision");
  assert.equal(decisions(client).length, 0);
});

test("only pending state is retained, malformed identity and oversized state are rejected", () => {
  const projected = projectSnapshot({ id: threadId, hostId: "local", requests: [request()], turns: ["private content"] }, threadId);
  assert.deepEqual(Object.keys(projected), ["requests", "signature"]);
  assert.equal(projectSnapshot({ id: other, hostId: "local", requests: [] }, threadId), null);
  assert.equal(projectSnapshot({ id: threadId, hostId: "remote", requests: [] }, threadId), null);
  assert.equal(projectSnapshot({ id: threadId, hostId: "local", requests: [request({ oversized: "x".repeat(300000) })] }, threadId), null);
});
