"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const {
  activityLabel,
  feedbackLabel,
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

test("normalizes Stream Deck languages to the supported languages", () => {
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage("ko_KR"), "ko");
  assert.equal(normalizeLanguage("ru"), "ru");
  assert.equal(normalizeLanguage("ru-RU"), "ru");
  assert.equal(normalizeLanguage("ru_RU"), "ru");
  assert.equal(normalizeLanguage(" RU-ru "), "ru");
  assert.equal(normalizeLanguage("ja"), "en");
});

test("localizes Russian activity codes and legacy Korean labels without changing activity data", () => {
  setLanguage("ru-RU");
  const activity = Object.freeze({ kind: "inspect", code: "activity.readLogs", label: "활동 기록 확인" });
  assert.equal(getLanguage(), "ru");
  assert.equal(activityLabel({ kind: "think", code: "activity.think" }), "Думаю");
  assert.equal(activityLabel(activity), "Читаю логи");
  assert.equal(activityLabel({ kind: "inspect", label: "활동 기록 확인" }), "Читаю логи");
  assert.equal(activityLabel("답변 완료"), "Есть ответ");
  assert.equal(localizeText("작업중"), "В работе");
  assert.deepEqual(activity, { kind: "inspect", code: "activity.readLogs", label: "활동 기록 확인" });
});

test("localizes Russian feedback separately from legacy activity labels", () => {
  setLanguage("ru");
  assert.equal(localizeText("상태 확인"), "Готов");
  assert.equal(feedbackLabel("상태 확인"), "Статус?");
  assert.equal(feedbackLabel("확인 중"), "Проверяю");
  assert.equal(feedbackLabel("FAST 확인"), "Fast?");
  assert.equal(t("voice.recording"), "Слушаю");
  assert.equal(t("permission.accessibility"), "Доступ");
});

test("preserves unknown keys and user text in Russian and falls back for unsupported languages", () => {
  setLanguage("ru");
  assert.equal(t("not.a.message"), "not.a.message");
  assert.equal(t("not.a.message", "Custom fallback"), "Custom fallback");
  assert.equal(localizeText("Исправить вход — Codex / HIGH"), "Исправить вход — Codex / HIGH");
  assert.equal(feedbackLabel("My custom feedback"), "My custom feedback");
  assert.equal(activityLabel({ kind: "inspect", label: "User task title" }), "User task title");
  assert.equal(activityLabel({ kind: "think", code: "activity.unknown" }), "Думаю");
  assert.equal(setLanguage("ja-JP"), "en");
  assert.equal(t("voice.recording"), "Listening");
  assert.equal(normalizeLanguage(null), "en");
});

test("Russian catalog covers every English message without relying on fallback", () => {
  const source = readFileSync(require.resolve("../src/i18n"), "utf8");
  const catalogs = vm.runInNewContext(`${source}\nMESSAGES;`, { module: { exports: {} } });
  assert.ok(catalogs.ru, "Russian catalog is present");
  assert.deepEqual(Object.keys(catalogs.ru).sort(), Object.keys(catalogs.en).sort());
  setLanguage("ru");
  for (const [key, value] of Object.entries(catalogs.ru)) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is nonempty`);
    assert.equal(t(key), value, `${key} resolves from Russian catalog`);
  }
});

test("Russian review-required errors stay localized after failed-turn integration", () => {
  setLanguage("ru");
  assert.equal(t("status.needInput"), "Нужен ввод");
  assert.equal(activityLabel({ kind: "error", code: "activity.reviewRequired" }), "Проверить");
});

test("selects Russian from Stream Deck registration and explicit language override", () => {
  const info = parseRegistrationInfo(JSON.stringify({ application: { language: "ru_RU", platform: "mac" } }));
  assert.equal(runtimeLanguage(info), "ru");
  assert.equal(runtimeLanguage(info, "ko-KR"), "ko");
  assert.equal(runtimeLanguage(info, "en-US"), "en");
  assert.equal(runtimeLanguage({ application: { language: "en" } }, "ru-RU"), "ru");
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
