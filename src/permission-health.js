"use strict";

function booleanField(fields, name) {
  if (fields[name] === "1") return true;
  if (fields[name] === "0") return false;
  return null;
}

function integerField(fields, name) {
  if (!/^-?\d+$/.test(fields[name] ?? "")) return null;
  return Number.parseInt(fields[name], 10);
}

function parsePermissionHealth(output) {
  const fields = {};
  for (const match of String(output ?? "").matchAll(/(?:^|\s)([a-z_]+)=([^\s]+)/gi)) {
    fields[match[1]] = match[2];
  }
  const accessibility = booleanField(fields, "accessibility");
  const postEvent = booleanField(fields, "post_event");
  const codexRunning = booleanField(fields, "codex_running");
  const codexAccess = booleanField(fields, "codex_access");
  if ([accessibility, postEvent, codexRunning, codexAccess].every((value) => value === null)) {
    return null;
  }
  return {
    accessibility,
    postEvent,
    codexRunning,
    codexAccess,
    axError: integerField(fields, "ax_error")
  };
}

function permissionIssueForHealth(health, options = {}) {
  if (!health) return null;
  if (health.accessibility === false) return "accessibility";
  if (health.postEvent === false) return "post-event";
  if (options.includeCodexAccess
      && health.codexRunning === true
      && health.codexAccess === false) return "codex-access";
  return null;
}

function permissionIssueLabel(issue) {
  if (issue === "accessibility") return "권한 필요";
  if (issue === "post-event") return "입력 권한";
  if (issue === "codex-access") return "Codex 권한";
  if (issue === "codex-operation") return "Codex 점검";
  if (issue === "input-operation") return "입력 점검";
  if (issue === "media-operation") return "미디어 점검";
  return "기능 점검";
}

module.exports = {
  parsePermissionHealth,
  permissionIssueForHealth,
  permissionIssueLabel
};
