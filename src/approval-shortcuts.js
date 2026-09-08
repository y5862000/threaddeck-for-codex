"use strict";

function nativeReply(value) {
  try { return JSON.parse(value?.stdout ?? ""); } catch { return null; }
}

function current(callback) {
  try { return callback() === true; } catch { return false; }
}

function captureDiagnostics(reply) {
  const known = (value, values) => values.includes(value) ? value : "unknown";
  const scan = reply.scanDiagnostics;
  return {
    scanComplete: typeof scan?.complete === "boolean" ? scan.complete : null,
    visited: Number.isSafeInteger(scan?.visited) && scan.visited >= 0 && scan.visited <= 4096 ? scan.visited : null,
    scanLimit: known(scan?.limitReason, [null, "depth-limit", "node-limit", "deadline", "text-limit",
      "accessibility-read", "missing-role", "invalid-children", "children-read", "window-unavailable", "application-unavailable"]),
    reviewState: reply.review == null ? "absent" : known(reply.review.state, ["ready", "unchecked", "unavailable"]),
    cardState: reply.approval == null ? "absent" : known(reply.approval.state, ["ready", "unavailable"]),
    cardReason: known(reply.approval?.reason ?? null, [null, "scan-incomplete", "blocking-surface", "actions-unavailable",
      "header-unavailable", "card-structure", "controls-unavailable", "untrusted-surface"])
  };
}

class ApprovalShortcutControls {
  constructor({ run }) {
    this.run = run;
    this.active = null;
  }

  async capture(isCurrent = () => true) {
    if (this.active) return { ok: false, reason: "busy" };
    const lease = { context: null, attempted: false };
    this.active = lease;
    try {
      if (!current(isCurrent)) return { ok: false, reason: "context-changed" };
      const reply = nativeReply(await this.run(["codex-approval-context"]));
      if (!reply || !Number.isSafeInteger(reply.pid) || reply.pid <= 1
          || typeof reply.token !== "string" || !/^[a-zA-Z0-9:._-]{1,64}$/.test(reply.token)) {
        return { ok: false, reason: reply?.error ?? "context-unavailable" };
      }
      if (!current(isCurrent)) return { ok: false, reason: "context-changed" };
      lease.context = reply;
      return { ok: true, lease, diagnostics: captureDiagnostics(reply) };
    } catch (error) {
      return { ok: false, reason: nativeReply(error)?.error ?? "context-unavailable" };
    } finally {
      if (!lease.context) this.cancel(lease);
    }
  }

  cancel(lease) {
    if (this.active === lease && !lease.attempted) this.active = null;
  }

  async execute(decision, lease, isCurrent = () => true) {
    if (!["approve", "decline"].includes(decision) || this.active !== lease
        || !lease?.context || lease.attempted || !current(isCurrent)) {
      this.cancel(lease);
      return { ok: false, reason: "context-changed", delivery: "none" };
    }
    const review = lease.context.review;
    if (review != null && (decision !== "approve" || review.state !== "ready"
        || typeof review.token !== "string"
        || !/^r1:[0-9a-f]{64}$/.test(review.token ?? ""))) {
      this.cancel(lease);
      return { ok: false, reason: review.state === "unchecked" ? "review-required" : "review-unavailable", delivery: "none" };
    }
    const approval = lease.context.approval;
    if (review == null && (approval?.state !== "ready"
        || typeof approval.token !== "string"
        || !/^a1:[0-9a-f]{64}$/.test(approval.token ?? ""))) {
      this.cancel(lease);
      return { ok: false, reason: "approval-unavailable", delivery: "none" };
    }
    // A native capture identifies the observed card, not a Codex request ID.
    // Never queue or retry: an uncertain activation may already have acted.
    lease.attempted = true;
    const args = review != null
      ? ["codex-review-continue", String(lease.context.pid), lease.context.token, review.token]
      : ["codex-approval-card", decision, String(lease.context.pid),
        lease.context.token, approval.token];
    try {
      const reply = nativeReply(await this.run(args));
      if (reply?.sent === true) return { ok: true, delivery: "sent" };
      if (reply?.sent === false) return { ok: false, reason: reply.error, delivery: "none" };
      return { ok: false, reason: "delivery-unknown", delivery: "unknown" };
    } catch (error) {
      const reply = nativeReply(error);
      return reply?.sent === false
        ? { ok: false, reason: reply.error, delivery: "none" }
        : { ok: false, reason: "delivery-unknown", delivery: "unknown" };
    } finally {
      if (this.active === lease) this.active = null;
    }
  }
}

module.exports = { ApprovalShortcutControls };
