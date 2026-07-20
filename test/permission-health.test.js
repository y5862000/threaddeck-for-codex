"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePermissionHealth,
  permissionIssueForHealth,
  permissionIssueLabel
} = require("../src/permission-health");

test("parses native permission health without depending on field order", () => {
  assert.deepEqual(
    parsePermissionHealth("post_event=0 accessibility=1 ax_error=-25211 codex_access=0 codex_running=1\n"),
    {
      accessibility: true,
      postEvent: false,
      codexRunning: true,
      codexAccess: false,
      axError: -25211
    }
  );
  assert.equal(parsePermissionHealth("unrelated output"), null);
});

test("separates Accessibility, event-posting, and stale Codex access", () => {
  assert.equal(permissionIssueForHealth({ accessibility: false, postEvent: false }), "accessibility");
  assert.equal(permissionIssueForHealth({ accessibility: true, postEvent: false }), "post-event");
  assert.equal(permissionIssueForHealth({
    accessibility: true,
    postEvent: true,
    codexRunning: true,
    codexAccess: false
  }), null);
  assert.equal(permissionIssueForHealth({
    accessibility: true,
    postEvent: true,
    codexRunning: true,
    codexAccess: false
  }, { includeCodexAccess: true }), "codex-access");
});

test("uses short Korean labels that fit a Neo key", () => {
  assert.equal(permissionIssueLabel("accessibility"), "권한 필요");
  assert.equal(permissionIssueLabel("post-event"), "입력 권한");
  assert.equal(permissionIssueLabel("codex-operation"), "Codex 점검");
  assert.equal(permissionIssueLabel("media-operation"), "미디어 점검");
});
