"use strict";

const TASK_ACTION = "com.yechan.threaddeck.thread1";
const COMMAND_ACTION = "com.yechan.threaddeck.newthread";
const COPY = {
  en: {
    taskLabel: "Task slot",
    currentTask: "Current task",
    taskHelp: "Use one action repeatedly and choose which Codex task each key follows.",
    commandLabel: "Command",
    newTask: "New task",
    sideChat: "Side Chat",
    send: "Send",
    commandHelp: "Send uses Return on a tap and Command+Return after the key turns blue.",
    help: "Help",
    saved: "Saved"
  },
  ko: {
    taskLabel: "작업 위치",
    currentTask: "현재 작업",
    taskHelp: "같은 액션을 여러 번 배치한 뒤 각 버튼이 표시할 Codex 작업을 고르세요.",
    commandLabel: "명령",
    newTask: "새 작업",
    sideChat: "사이드챗",
    send: "보내기",
    commandHelp: "보내기는 짧게 누르면 Return, 파란색이 될 때까지 누르면 Command+Return입니다.",
    help: "도움말",
    saved: "저장됨"
  }
};

let socket = null;
let context = "";
let action = "";
let settings = {};
let statusTimer = null;
let settingsPending = false;

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function language() {
  return /^ko(?:-|$)/i.test(navigator.language) ? "ko" : "en";
}

function localize() {
  const copy = COPY[language()];
  document.documentElement.lang = language();
  for (const element of document.querySelectorAll("[data-copy]")) {
    const value = copy[element.dataset.copy];
    if (value) element.textContent = value;
  }
  if (language() === "ko") {
    for (let index = 1; index <= 8; index += 1) {
      const option = document.querySelector(`option[value="top${index}"]`);
      if (option) option.textContent = `상위 작업 ${index}`;
    }
  }
}

function showStatus() {
  const status = document.getElementById("save-status");
  status.textContent = COPY[language()].saved;
  if (statusTimer) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    status.textContent = "";
  }, 1200);
}

function setSettings(nextSettings) {
  settings = nextSettings;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    settingsPending = true;
    return;
  }
  socket.send(JSON.stringify({
    event: "setSettings",
    context,
    payload: settings
  }));
  settingsPending = false;
  showStatus();
}

function initializeControls() {
  const taskPanel = document.getElementById("task-settings");
  const commandPanel = document.getElementById("command-settings");
  taskPanel.hidden = action !== TASK_ACTION;
  commandPanel.hidden = action !== COMMAND_ACTION;

  const taskSource = document.getElementById("task-source");
  const command = document.getElementById("command");
  taskSource.value = /^(?:current|top[1-8])$/.test(settings.taskSource)
    ? settings.taskSource
    : "current";
  command.value = /^(?:new-task|side-chat|send)$/.test(settings.command)
    ? settings.command
    : "new-task";

  for (const select of document.querySelectorAll("select[data-setting]")) {
    select.addEventListener("change", () => {
      setSettings({ ...settings, [select.dataset.setting]: select.value });
    });
  }

  const main = document.getElementById("settings");
  main.setAttribute("aria-busy", "false");
}

window.connectElgatoStreamDeckSocket = function connectElgatoStreamDeckSocket(
  port,
  uuid,
  registerEvent,
  info,
  actionInfo
) {
  void info;
  context = uuid;
  const parsedActionInfo = parseJson(actionInfo);
  action = parsedActionInfo.action ?? "";
  settings = parsedActionInfo.payload?.settings ?? {};
  localize();
  initializeControls();

  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    if (settingsPending) setSettings(settings);
  });
};
