"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  ApprovalControls,
  approvalRequestExpression,
  approvalResponseExpression,
  normalizeApprovalIdentity
} = require("../src/approval-controls");
const { CodexMicroBridge, MicroBridgeError } = require("../src/micro-cdp");

const THREAD = "019f8442-7025-7b42-8fc0-0b93f0be2073";
const OTHER = "019f8442-7025-7b42-8fc0-0b93f0be2074";
const request = (overrides = {}) => ({
  threadId: THREAD, hostId: "local", requestId: 17, kind: "exec", ...overrides
});
const state = () => ({ tail: Promise.resolve(), attempted: new Set() });
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

function controls(options = {}) {
  const sent = [];
  const controller = new ApprovalControls({
    readRequest: async () => request(),
    respond: async (...args) => { sent.push(args.slice(0, 2)); return { delivered: true }; },
    executionState: state(),
    ...options
  });
  return { controller, sent };
}

test("approval identities require exact UUID, request type, host, and typed request ID", () => {
  for (const value of [null, {}, request({ threadId: "task title" }), request({ hostId: null }),
    request({ requestId: "" }), request({ requestId: NaN }), request({ kind: "userInput" })]) {
    assert.equal(normalizeApprovalIdentity(value), null);
  }
  assert.deepEqual(normalizeApprovalIdentity(request({ requestId: 0 })), request({ requestId: 0 }));
});

test("absent request, wrong task, invalid commands and read failures never dispatch", async () => {
  for (const readRequest of [async () => null, async () => request({ threadId: OTHER }),
    async () => { throw new Error("offline"); }]) {
    const { controller, sent } = controls({ readRequest });
    assert.equal((await controller.execute("approve", THREAD)).delivery, "none");
    assert.deepEqual(sent, []);
  }
  const { controller, sent } = controls();
  assert.equal((await controller.execute("always-approve", THREAD)).ok, false);
  assert.equal((await controller.execute("approve", "title")).ok, false);
  assert.deepEqual(sent, []);
});

test("request/task/host/type changes between capture and dispatch are refused", async () => {
  for (const replacement of [null, request({ requestId: 18 }), request({ requestId: "17" }),
    request({ threadId: OTHER }), request({ hostId: "remote" }), request({ kind: "patch" })]) {
    let reads = 0;
    const { controller, sent } = controls({ readRequest: async () => ++reads === 1 ? request() : replacement });
    assert.equal((await controller.execute("approve", THREAD)).reason, "changed");
    assert.deepEqual(sent, []);
  }
});

test("a verified request is delivered once, with the selected decision only", async () => {
  for (const decision of ["approve", "decline"]) {
    const { controller, sent } = controls();
    const result = await controller.execute(decision, THREAD);
    assert.equal(result.ok, true);
    assert.equal(result.delivery, "invoked");
    assert.equal((await controller.execute(decision, THREAD)).reason, "already-handled");
    assert.deepEqual(sent, [[decision, request()]]);
  }
});

test("a key-down request is retained through key-up and never replaced after a hold", async () => {
  let reads = 0;
  const { controller, sent } = controls({ readRequest: async () => {
    reads++;
    return request({ requestId: 18 });
  } });
  assert.equal((await controller.execute("approve", THREAD, { request: request() })).reason, "changed");
  assert.equal(reads, 1);
  assert.deepEqual(sent, []);
  assert.equal((await controller.execute("approve", THREAD, { request: null })).reason, "unavailable");
  assert.equal(reads, 1);
});

test("context disappearance or settings change during a fresh read cancels before respond", async () => {
  const readStarted = deferred();
  const readFinished = deferred();
  let current = true;
  const { controller, sent } = controls({ readRequest: async () => {
    readStarted.resolve();
    return readFinished.promise;
  } });
  const result = controller.execute("approve", THREAD, { request: request(), isCurrent: () => current });
  await readStarted.promise;
  current = false;
  readFinished.resolve(request());
  assert.deepEqual(await result, { ok: false, reason: "cancelled", delivery: "none" });
  assert.deepEqual(sent, []);
});

test("cancellation while queued skips fresh inspection and dispatch", async () => {
  const queueFinished = deferred();
  const executionState = { tail: queueFinished.promise, attempted: new Set() };
  let current = true;
  let reads = 0;
  const { controller, sent } = controls({
    executionState, readRequest: async () => { reads++; return request(); }
  });
  const result = controller.execute("decline", THREAD, { request: request(), isCurrent: () => current });
  await Promise.resolve();
  current = false;
  queueFinished.resolve();
  assert.equal((await result).reason, "cancelled");
  assert.equal(reads, 0);
  assert.deepEqual(sent, []);
});

test("cancellation after capture awaits or a throwing predicate never dispatches", async () => {
  const readStarted = deferred();
  const readFinished = deferred();
  let current = true;
  let reads = 0;
  const { controller, sent } = controls({ readRequest: async () => {
    reads++;
    readStarted.resolve();
    return readFinished.promise;
  } });
  const result = controller.execute("approve", THREAD, { isCurrent: () => current });
  await readStarted.promise;
  current = false;
  readFinished.resolve(request());
  assert.equal((await result).reason, "cancelled");
  assert.equal(reads, 1);
  assert.deepEqual(sent, []);
  assert.equal((await controller.execute("approve", THREAD, {
    request: request(), isCurrent: () => { throw new Error("context removed"); }
  })).reason, "cancelled");
});

test("the bridge receives and rechecks cancellation immediately before evaluation", async () => {
  const bridge = new CodexMicroBridge();
  let evaluations = 0;
  bridge.evaluate = async () => { evaluations++; return { delivered: true }; };
  let current = true;
  const isCurrent = () => current;
  const { controller } = controls({ respond: async (decision, identity, options) => {
    assert.equal(options.isCurrent, isCurrent);
    current = false;
    return bridge.respondToApproval(decision, identity, options);
  } });
  assert.equal((await controller.execute("approve", THREAD, { request: request(), isCurrent })).reason, "cancelled");
  assert.equal(evaluations, 0);
});

test("context changes after possible dispatch never become a no-delivery cancellation", async () => {
  for (const ambiguous of [false, true]) {
    let current = true;
    const { controller } = controls({ respond: async () => {
      current = false;
      if (ambiguous) throw new Error("response lost");
      return { delivered: true };
    } });
    const result = await controller.execute("approve", THREAD, {
      request: request(), isCurrent: () => current
    });
    assert.equal(result.delivery, ambiguous ? "unknown" : "invoked");
  }
});

test("concurrent contexts capture the original prompt and serialize all dispatches", async () => {
  const executionState = state();
  let current = request();
  let active = 0;
  let maximum = 0;
  const sent = [];
  const options = {
    executionState,
    readRequest: async () => ({ ...current }),
    respond: async (decision, identity) => {
      active += 1;
      maximum = Math.max(maximum, active);
      sent.push([decision, identity.requestId]);
      await Promise.resolve();
      current = request({ requestId: 18 });
      active -= 1;
      return { delivered: true };
    }
  };
  const first = new ApprovalControls(options);
  const second = new ApprovalControls(options);
  const results = await Promise.all([first.execute("approve", THREAD), second.execute("decline", THREAD)]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].reason, "already-handled");
  assert.equal(maximum, 1);
  assert.deepEqual(sent, [["approve", 17]]);
});

test("ambiguous delivery is consumed even if transport claims disconnected/unavailable", async () => {
  for (const respond of [async () => undefined, async () => ({ delivered: false }),
    async () => { throw new MicroBridgeError("disconnected", { delivery: "none" }); }]) {
    let attempts = 0;
    const { controller } = controls({ respond: async (...args) => { attempts++; return respond(...args); } });
    assert.equal((await controller.execute("approve", THREAD)).delivery, "unknown");
    assert.equal((await controller.execute("decline", THREAD)).reason, "already-handled");
    assert.equal(attempts, 1);
  }
});

test("a definite atomic guard rejection permits a later deliberate press, with no automatic retry", async () => {
  let attempts = 0;
  const { controller } = controls({ respond: async () => {
    attempts++;
    return { delivered: false, delivery: "none", reason: "changed" };
  } });
  assert.equal((await controller.execute("approve", THREAD)).reason, "changed");
  assert.equal(attempts, 1);
  await controller.execute("approve", THREAD);
  assert.equal(attempts, 2);
});

// A synthetic renderer model, never an installed Codex document or its code.
function rendererFixture(options = {}) {
  const hits = [];
  const identity = request(options.identity);
  const actions = {
    onApprove: () => hits.push("once"), onDeny: () => hits.push("deny"),
    scopedApproveAction: { onClick: () => hits.push("session") },
    leadingAction: { onClick: () => hits.push("always") },
    ...options.actions
  };
  const node = (extra = {}) => ({
    isConnected: true, getClientRects: () => [{}], closest: () => null,
    getAttribute: () => null, ...extra
  });
  const owner = options.unknownOwner ? { conversationId: THREAD } : identity.kind === "permissionRequest"
    ? { conversationId: identity.threadId, hostId: identity.hostId,
      pendingRequest: { requestId: identity.requestId, permissions: { network: { enabled: true } } } }
    : { conversationId: identity.threadId, hostId: identity.hostId,
      item: { type: identity.kind, approvalRequestId: identity.requestId } };
  const root = { return: null, stateNode: {} };
  root.stateNode.current = root;
  const surface = node({
    __reactFiber$test: {
      memoizedProps: {}, return: {
        memoizedProps: { actions }, return: { memoizedProps: owner, return: root }
      }
    },
    querySelectorAll: () => [node({ disabled: options.actions?.approveDisabled }), node(),
      ...options.disabledSecondary ? [node({ disabled: true })] : []]
  });
  const composer = node();
  const portals = (options.portals ?? [options.currentThread ?? THREAD]).map((threadId) => node({
    getAttribute: () => threadId,
    closest: (selector) => selector === '[data-codex-composer-root]' ? composer : null
  }));
  composer.querySelectorAll = (selector) => selector === '[data-above-composer-conversation-id]' ? portals : [];
  const context = {
    getComputedStyle: () => ({ visibility: "visible" }),
    document: {
      activeElement: node(),
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === '[data-codex-composer-root]') return [composer];
        if (selector === '[data-codex-approval-surface]') return options.noSurface ? []
          : options.ambiguous ? [surface, node()] : [surface];
        if (selector.startsWith('[data-app-action-sidebar-thread-id]')) return options.sidebarThread
          ? [node({ getAttribute: () => options.sidebarThread })] : [];
        if (selector.includes('[role="dialog"]')) return options.dialog ? [node()] : [];
        return [];
      }
    }
  };
  return { context, hits, surface, actions, composer, portals };
}

test("renderer reads only exact actionable exec, patch, and turn-permission identities", () => {
  for (const kind of ["exec", "patch", "permissionRequest"]) {
    const fixture = rendererFixture({ identity: { kind } });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(
      approvalRequestExpression(THREAD), fixture.context
    ))), request({ kind }));
    assert.deepEqual(fixture.hits, []);
  }
});

test("renderer fails closed for hidden, disabled, ambiguous, unknown or different-task cards", () => {
  for (const options of [{ noSurface: true }, { ambiguous: true }, { unknownOwner: true },
    { currentThread: OTHER }, { identity: { threadId: OTHER } }, { actions: { isLoading: true } },
    { actions: { disableHotkeys: true } },
    { actions: { approveLabel: "Always allow" } }, { dialog: true }]) {
    const fixture = rendererFixture(options);
    assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context), null);
    assert.equal(vm.runInNewContext(approvalResponseExpression("approve", request()), fixture.context).delivered, false);
    assert.deepEqual(fixture.hits, []);
  }
  const fixture = rendererFixture();
  fixture.surface.isConnected = false;
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context), null);
});

test("renderer derives current task from the composer's child portal with the sidebar unmounted", () => {
  const fixture = rendererFixture();
  assert.equal(fixture.composer.closest('[data-above-composer-conversation-id]'), null);
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context).threadId, THREAD);
  assert.equal(vm.runInNewContext(approvalResponseExpression("approve", request()), fixture.context).delivered, true);
  assert.deepEqual(fixture.hits, ["once"]);
});

test("renderer refuses conflicting visible portals or active sidebar identities", () => {
  for (const options of [{ portals: [THREAD, OTHER] }, { portals: [THREAD, ""] },
    { sidebarThread: OTHER }, { portals: [] }]) {
    const fixture = rendererFixture(options);
    assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context), null);
    assert.deepEqual(fixture.hits, []);
  }
  const fixture = rendererFixture({ portals: [], sidebarThread: THREAD });
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context), null);
});

test("disabled scope buttons do not block once/deny, and approve-only state does not block denial", () => {
  for (const decision of ["approve", "decline"]) {
    const fixture = rendererFixture({ disabledSecondary: true });
    assert.equal(vm.runInNewContext(approvalResponseExpression(decision, request()), fixture.context).delivered, true);
    assert.deepEqual(fixture.hits, [decision === "approve" ? "once" : "deny"]);
  }
  const fixture = rendererFixture({ actions: { approveDisabled: true } });
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context).requestId, 17);
  assert.equal(vm.runInNewContext(approvalResponseExpression("approve", request()), fixture.context).delivered, false);
  assert.deepEqual(fixture.hits, []);
  assert.equal(vm.runInNewContext(approvalResponseExpression("decline", request()), fixture.context).delivered, true);
  assert.deepEqual(fixture.hits, ["deny"]);
});

test("renderer rechecks request identity synchronously and selects only once/deny callbacks", () => {
  for (const decision of ["approve", "decline"]) {
    const fixture = rendererFixture();
    assert.equal(vm.runInNewContext(approvalResponseExpression(decision, request({ requestId: 18 })), fixture.context).delivered, false);
    assert.deepEqual(fixture.hits, []);
    assert.equal(vm.runInNewContext(approvalResponseExpression(decision, request()), fixture.context).delivered, true);
    assert.deepEqual(fixture.hits, [decision === "approve" ? "once" : "deny"]);
  }
});

test("renderer resolves React's committed fiber and refuses callbacks from a previous request", () => {
  const fixture = rendererFixture();
  const replacement = rendererFixture({ identity: { requestId: 18 } });
  const oldFiber = fixture.surface.__reactFiber$test;
  const newFiber = replacement.surface.__reactFiber$test;
  oldFiber.alternate = newFiber;
  oldFiber.return.return.return.stateNode.current = newFiber.return.return.return;
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context).requestId, 18);
  assert.equal(vm.runInNewContext(approvalResponseExpression("approve", request()), fixture.context).delivered, false);
  assert.deepEqual(fixture.hits, []);
  assert.deepEqual(replacement.hits, []);
  oldFiber.alternate = null;
  assert.equal(vm.runInNewContext(approvalRequestExpression(THREAD), fixture.context), null);
});

test("bridge approval dispatch never reconnects, activates Micro, or retries", async () => {
  const bridge = new CodexMicroBridge();
  const calls = [];
  bridge.ensureConnected = async () => { calls.push("connect"); };
  bridge.activateRuntime = async () => { throw new Error("must not activate"); };
  bridge.evaluate = async (expression) => {
    calls.push(expression);
    return request();
  };
  assert.deepEqual(await bridge.readApprovalRequest(THREAD), request());
  assert.equal(calls.length, 2);
  calls.length = 0;
  bridge.evaluate = async () => { calls.push("evaluate"); throw new Error("socket closed after dispatch"); };
  await assert.rejects(() => bridge.respondToApproval("approve", request()),
    (error) => error.delivery === "unknown");
  assert.deepEqual(calls, ["evaluate"]);
  await assert.rejects(() => bridge.respondToApproval("acceptForSession", request()), TypeError);
  assert.deepEqual(calls, ["evaluate"]);
});
