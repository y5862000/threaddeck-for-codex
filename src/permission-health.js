"use strict";

const { t } = require("./i18n");

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
  return t(`permission.${issue}`, t("permission.unknown", "Check setup"));
}

module.exports = {
  parsePermissionHealth,
  permissionIssueForHealth,
  permissionIssueLabel
};
