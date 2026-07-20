"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  activityLabel,
  getLanguage,
  localizeText,
  normalizeLanguage,
  setLanguage,
  t
} = require("../src/i18n");
const {
  parseRegistrationInfo,
  runtimeCapabilities,
  runtimeLanguage,
  runtimePlatform
} = require("../src/runtime-info");

test.afterEach(() => setLanguage("en"));

test("normalizes Stream Deck languages to the supported English/Korean pair", () => {
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage("ko_KR"), "ko");
  assert.equal(normalizeLanguage("ja"), "en");
});

test("localizes stable activity codes and legacy lifecycle labels", () => {
  setLanguage("en");
  assert.equal(activityLabel({ kind: "think", code: "activity.think" }), "Thinking");
  assert.equal(activityLabel({ kind: "inspect", label: "활동 기록 확인" }), "Reading logs");
  assert.equal(localizeText("작업중"), "Working");

  setLanguage("ko");
  assert.equal(getLanguage(), "ko");
  assert.equal(t("voice.recording"), "말하는 중");
  assert.equal(activityLabel({ kind: "inspect", code: "activity.readLogs" }), "활동 기록 확인");
});

test("reads language and platform from Stream Deck registration info", () => {
  const raw = JSON.stringify({ application: { language: "ko", platform: "mac" } });
  const info = parseRegistrationInfo(raw);
  assert.equal(runtimeLanguage(info), "ko");
  assert.equal(runtimeLanguage(info, "en-US"), "en");
  assert.equal(runtimePlatform(info), "mac");
  assert.deepEqual(runtimeCapabilities(info), {
    platform: "mac",
    supported: true,
    nativeBridge: "keybridge",
    supportsCodexDesktopAutomation: true,
    supportsMediaControl: true
  });
  assert.equal(parseRegistrationInfo("{broken"), null);
});
