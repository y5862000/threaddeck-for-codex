"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CODEX_COMMANDS, codexCommandFromSettings, taskActionFromSettings, taskSourceFromSettings, taskSlotFromSettings } = require("../src/action-settings");
const { setLanguage, t } = require("../src/i18n");

test("both approval action entry points interpret supported decisions consistently", () => {
  for (const command of ["approve", "decline", "APPROVE", " Decline "]) {
    const settings = Object.freeze({ command, customSetting: "kept" });
    const expected = command.trim().toLowerCase();
    assert.equal(taskActionFromSettings(settings), expected);
    assert.equal(codexCommandFromSettings(settings), expected);
    assert.equal(settings.customSetting, "kept");
  }
  assert.equal(CODEX_COMMANDS.has("approve"), true);
  assert.equal(CODEX_COMMANDS.has("decline"), true);
});

test("Task actions defaults to approve and rejects unsupported commands", () => {
  assert.equal(taskActionFromSettings(), "approve");
  assert.equal(taskActionFromSettings({}), "approve");
  for (const command of ["send", "new-task", "side-chat", "", "future", false, 0, {}, []]) {
    assert.equal(taskActionFromSettings({ command }), null);
  }
});

test("existing command and task defaults remain compatible", () => {
  assert.equal(codexCommandFromSettings(), "new-task");
  assert.equal(codexCommandFromSettings({ command: "future" }), "new-task");
  for (const command of ["new-task", "side-chat", "send"]) {
    assert.equal(codexCommandFromSettings({ command }), command);
  }
  assert.equal(taskSourceFromSettings({}), "current");
  assert.equal(taskSlotFromSettings({}), -1);
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(taskSlotFromSettings({ taskSource: `top${index}` }), index - 1);
  }
});

test("approval key feedback uses the selected locale", () => {
  try {
    for (const [language, approve, decline, sent] of [
      ["en", "Approve", "Decline", "Sent"],
      ["ko", "승인", "거절", "전송됨"],
      ["ru", "Одобрить", "Отклонить", "Отправлено"]
    ]) {
      setLanguage(language);
      assert.equal(t("approval.approve"), approve);
      assert.equal(t("approval.decline"), decline);
      assert.equal(t("approval.sent"), sent);
    }
  } finally { setLanguage("en"); }
});
