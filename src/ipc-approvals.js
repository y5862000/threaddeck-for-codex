"use strict";

const { createHash } = require("node:crypto");

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const METHODS = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
  "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  "mcpServer/elicitation/request": "thread-follower-submit-mcp-server-elicitation-response"
};
const failure = (reason, delivery = "none") => ({ ok: false, reason, delivery });
const current = (fn) => { try { return fn() === true; } catch { return false; } };
const verifiedTarget = async (fn) => { try { return (await fn()) === true; } catch { return false; } };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const requestId = (v) => (Number.isSafeInteger(v) && v >= 0)
  || (typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v));
const fingerprint = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function approvalRequest(request, threadId) {
  if (!plain(request) || !requestId(request.id) || !Object.hasOwn(METHODS, request.method)
      || !plain(request.params) || request.params.threadId !== threadId
      || typeof request.params.turnId !== "string" || !request.params.turnId) return null;
  const elicitation = request.method === "mcpServer/elicitation/request";
  if (!elicitation && (typeof request.params.itemId !== "string" || !request.params.itemId)) return null;
  if (elicitation) {
    const schema = request.params.requestedSchema;
    // A simple tool approval needs no form values or acknowledgment checkbox.
    // Authentication, URL flows, general forms and extended forms stay manual.
    if (request.params.mode !== "form" || request.params._meta?.codex_approval_kind !== "mcp_tool_call"
        || !plain(schema) || schema.type !== "object" || !plain(schema.properties)
        || Object.keys(schema.properties).length !== 0
        || (schema.required != null && (!Array.isArray(schema.required) || schema.required.length !== 0))
        || Object.keys(schema).some((k) => !["type", "properties", "required", "additionalProperties", "$schema", "title", "description"].includes(k))) return null;
  }
  if (request.method === "item/permissions/requestApproval" && !plain(request.params.permissions)) return null;
  if (request.params.availableDecisions != null && (!Array.isArray(request.params.availableDecisions)
      || !request.params.availableDecisions.every((d) => typeof d === "string" || plain(d)))) return null;
  return { threadId, requestId: request.id, method: request.method,
    turnId: request.params.turnId, itemId: request.params.itemId ?? null,
    ...(request.method === "item/permissions/requestApproval" ? { permissions: request.params.permissions } : {}),
    availableDecisions: request.params.availableDecisions,
    fingerprint: fingerprint(request) };
}

function projectSnapshot(value, threadId) {
  if (!plain(value) || value.id !== threadId || value.hostId !== "local"
      || !Array.isArray(value.requests) || value.requests.length > 128
      || Buffer.byteLength(JSON.stringify(value.requests)) > 256 * 1024) return null;
  const seen = new Set();
  for (const r of value.requests) {
    if (!plain(r) || !requestId(r.id) || typeof r.method !== "string") return null;
    const key = JSON.stringify(r.id);
    if (seen.has(key)) return null;
    seen.add(key);
  }
  // Retain only the pending requests; conversation content is never cached or
  // logged by this adapter. Unsupported requests still count as ambiguity.
  return { requests: value.requests, signature: fingerprint(value.requests) };
}

function validContext(value) {
  return value?.ok === true && Number.isSafeInteger(value.pid) && value.pid > 1
    && typeof value.token === "string" && /^api1:\d+:\d+:\d+:\d+$/.test(value.token);
}

// An explicitly selected task is the target. The desktop IPC protocol has no
// complete inventory of ephemeral/hidden tasks, so this adapter deliberately
// does not infer a global singleton from saved threads or quiet broadcasts.
class IpcApprovalControls {
  constructor({ client, readContext, timeoutMs = 2000 }) {
    this.client = client;
    this.readContext = readContext;
    this.timeoutMs = timeoutMs;
    this.active = null;
    this.attempted = new Set();
    this.record = null;
    this.waiter = null;
    client.on("broadcast", (m) => this.observe(m));
    client.on("disconnect", () => {
      this.record = null;
      this.rejectWaiter("connection-changed");
    });
  }

  rejectWaiter(reason) {
    this.waiter?.reject(Object.assign(new Error(reason), { code: reason }));
  }

  observe(message) {
    const record = this.record;
    if (!record) return;
    if (message.method === "client-status-changed" && message.params?.clientId === record.owner
        && message.params.status === "disconnected") {
      record.dirty = true;
      this.rejectWaiter("owner-changed");
      return;
    }
    if (message.method !== "thread-stream-state-changed"
        || message.sourceClientId !== record.owner
        || message.params?.conversationId !== record.threadId || message.params.hostId !== "local") return;
    const change = message.params.change;
    if (message.version !== 11 || !plain(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) {
      record.dirty = true;
      this.rejectWaiter("unsupported-version");
      return;
    }
    if (change.type === "snapshot") {
      const projected = projectSnapshot(change.conversationState, record.threadId);
      if (!projected || change.revision < record.revision
          || (change.revision === record.revision && !record.dirty && record.value
            && record.value.signature !== projected.signature)) {
        record.dirty = true;
        this.rejectWaiter("state-changed");
        return;
      }
      record.revision = change.revision;
      record.value = projected;
      record.dirty = false;
      this.waiter?.resolve(projected);
      return;
    }
    if (change.type !== "patches" || change.baseRevision !== record.revision
        || change.revision <= change.baseRevision || !Array.isArray(change.patches)) {
      record.dirty = true;
      return;
    }
    record.revision = change.revision;
    for (const patch of change.patches) {
      if (!plain(patch) || !["add", "remove", "replace"].includes(patch.op)
          || !Array.isArray(patch.path) || patch.path.length === 0 || patch.path[0] === "requests") {
        // Refresh instead of applying an unfamiliar/root/request patch to a
        // partial conversation projection. A gap cannot make old data ready.
        record.dirty = true;
      }
    }
  }

  isCurrent(lease, isCurrent) {
    return this.active === lease && this.client.isReady() && this.client.epoch === lease.epoch
      && current(isCurrent);
  }

  async owner(threadId, targetClientId) {
    const reply = await this.client.request("thread-owner-discovery", { conversationId: threadId, hostId: "local" },
      { version: 1, targetClientId, timeoutMs: this.timeoutMs });
    if (reply.resultType !== "success" || !UUID.test(reply.handledByClientId ?? "")) throw Error("owner-unavailable");
    return reply.handledByClientId;
  }

  snapshot(lease) {
    if (this.waiter || this.record?.owner !== lease.owner || this.record?.threadId !== lease.threadId) {
      return Promise.reject(Error("state-changed"));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); }
      };
      const cleanup = () => { clearTimeout(timer); if (this.waiter === waiter) this.waiter = null; };
      this.waiter = waiter;
      timer = setTimeout(() => waiter.reject(Error("snapshot-timeout")), this.timeoutMs);
      try {
        this.client.broadcast("thread-stream-following-changed",
          { conversationId: lease.threadId, hostId: "local", following: true },
          { version: 1, targetClientIds: [lease.owner] });
      } catch (error) { waiter.reject(error); }
    });
  }

  async capture(threadId, isCurrent = () => true, verifyTarget = async () => true) {
    if (this.active) return failure("busy");
    if (!UUID.test(threadId ?? "") || !current(isCurrent)) return failure("no-selected-task");
    const lease = { threadId, attempted: false, verifyTarget };
    this.active = lease;
    try {
      const context = await this.readContext();
      if (!validContext(context)) return failure(context?.error ?? "context-unavailable");
      if (!await verifiedTarget(lease.verifyTarget)) return failure("target-changed");
      if (!current(isCurrent)) return failure("context-changed");
      lease.context = context;
      try { await this.client.connect(); } catch {
        return { ...failure("ipc-unavailable"), canFallback: true };
      }
      lease.epoch = this.client.epoch;
      if (!this.isCurrent(lease, isCurrent)) return failure("context-changed");
      lease.owner = await this.owner(threadId);
      if (!this.isCurrent(lease, isCurrent)) return failure("context-changed");
      this.record = { owner: lease.owner, threadId, revision: -1, dirty: true, value: null };
      const value = await this.snapshot(lease);
      if (!this.isCurrent(lease, isCurrent)) return failure("context-changed");
      if (value.requests.length === 0) return failure("no-requests");
      if (value.requests.length !== 1) return failure("multiple-requests");
      const request = approvalRequest(value.requests[0], threadId);
      if (!request) return failure("unsupported-request");
      lease.request = request;
      lease.key = JSON.stringify([context.token, threadId, request.method, request.requestId, request.turnId, request.itemId]);
      if (this.attempted.has(lease.key)) return failure("already-handled");
      if (this.attempted.size >= 4096) return failure("attempt-limit");
      lease.captured = true;
      return { ok: true, lease };
    } catch { return failure("ipc-state-unavailable"); }
    finally { if (!lease.captured) this.cancel(lease); }
  }

  cancel(lease) {
    if (this.active !== lease || lease?.attempted) return;
    this.release(lease);
  }

  release(lease) {
    if (this.active !== lease) return;
    this.rejectWaiter("cancelled");
    if (lease.owner && this.client.isReady() && this.client.epoch === lease.epoch) {
      try {
        this.client.broadcast("thread-stream-following-changed",
          { conversationId: lease.threadId, hostId: "local", following: false },
          { version: 1, targetClientIds: [lease.owner] });
      } catch { /* Disconnect removes the follower subscription at the router. */ }
    }
    this.record = null;
    this.active = null;
  }

  async execute(decision, lease, isCurrent = () => true) {
    if (lease?.executing) return failure("busy");
    if (!["approve", "decline"].includes(decision) || !lease?.captured || lease.attempted
        || !this.isCurrent(lease, isCurrent)) {
      this.cancel(lease);
      return failure("context-changed");
    }
    lease.executing = true;
    const wireDecision = decision === "approve" ? "accept" : "decline";
    try {
      if (lease.request.availableDecisions && !lease.request.availableDecisions.includes(wireDecision)) return failure("unsupported-decision");
      if (await this.owner(lease.threadId, lease.owner) !== lease.owner) return failure("owner-changed");
      const fresh = await this.snapshot(lease);
      if (!this.isCurrent(lease, isCurrent) || fresh.requests.length !== 1
          || fingerprint(fresh.requests[0]) !== lease.request.fingerprint) return failure("request-changed");
      const context = await this.readContext();
      if (!validContext(context) || context.pid !== lease.context.pid || context.token !== lease.context.token
          || !this.isCurrent(lease, isCurrent) || this.record?.dirty) return failure("context-changed");
      if (!await verifiedTarget(lease.verifyTarget)) return failure("target-changed");
      if (!this.isCurrent(lease, isCurrent) || this.record?.dirty) return failure("context-changed");
      // Session and selected-task reads yield to IPC messages. A full snapshot can
      // replace `fresh` without setting dirty, so validate the latest state
      // again immediately before committing to this exact request.
      const latest = this.record;
      if (latest?.owner !== lease.owner || latest.threadId !== lease.threadId
          || latest.value?.requests.length !== 1
          || fingerprint(latest.value.requests[0]) !== lease.request.fingerprint) return failure("request-changed");
      lease.attempted = true;
      this.attempted.add(lease.key);
      const method = METHODS[lease.request.method];
      let response;
      try {
        const params = { conversationId: lease.threadId, requestId: lease.request.requestId };
        if (lease.request.method === "item/permissions/requestApproval") {
          params.response = { permissions: decision === "approve" ? lease.request.permissions : {}, scope: "turn" };
        } else if (lease.request.method === "mcpServer/elicitation/request") {
          params.response = { action: wireDecision, content: decision === "approve" ? {} : null };
        } else params.decision = wireDecision;
        response = await this.client.request(method, params,
        { version: 1, targetClientId: lease.owner, timeoutMs: this.timeoutMs });
      } catch { return failure("delivery-unknown", "unknown"); }
      if (response.resultType === "error" && response.delivery === "none") {
        this.attempted.delete(lease.key);
        return failure("request-changed");
      }
      if (response.resultType !== "success" || response.method !== method
          || response.handledByClientId !== lease.owner || response.result?.ok !== true
          || !this.isCurrent(lease, isCurrent)) return failure("delivery-unknown", "unknown");
      try {
        const after = await this.snapshot(lease);
        if (after.requests.some((r) => r.id === lease.request.requestId)) return failure("delivery-unknown", "unknown");
      } catch { return failure("delivery-unknown", "unknown"); }
      // The owner removes requests optimistically. This acknowledges owner-side
      // handling, not backend completion; retain the same blue Sent feedback.
      return { ok: true, delivery: "owner-accepted" };
    } catch { return failure(lease.attempted ? "delivery-unknown" : "ipc-state-unavailable", lease.attempted ? "unknown" : "none"); }
    finally { this.release(lease); }
  }

  close() {
    this.rejectWaiter("closed");
    this.client.close();
    this.record = null;
    this.active = null;
  }
}

module.exports = { IpcApprovalControls, approvalRequest, projectSnapshot };
