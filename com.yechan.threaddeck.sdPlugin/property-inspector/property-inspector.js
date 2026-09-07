"use strict";

const TASK_ACTION = "com.yechan.threaddeck.thread1";
const COMMAND_ACTION = "com.yechan.threaddeck.newthread";
const NAVIGATION_ACTION = "com.yechan.threaddeck.page.previous";
const COPY = {
  en: {
    title: "ThreadDeck settings",
    loading: "Loading settings…",
    taskLabel: "Task slot",
    currentTask: "Current task",
    topTask: "Top task {index}",
    taskHelp: "Choose a Codex task for this key.",
    commandLabel: "Command",
    newTask: "New task",
    sideChat: "Side Chat",
    send: "Send",
    commandHelp: "Send uses Return on a tap and Command+Return after the key turns blue.",
    directionLabel: "Direction",
    previousPage: "Previous page",
    nextPage: "Next page",
    help: "Help",
    saved: "Saved"
  },
  ko: {
    title: "ThreadDeck 설정",
    loading: "설정을 불러오는 중…",
    taskLabel: "작업 위치",
    currentTask: "현재 작업",
    topTask: "상위 작업 {index}",
    taskHelp: "이 버튼으로 제어할 Codex 작업을 선택하세요.",
    commandLabel: "명령",
    newTask: "새 작업",
    sideChat: "사이드챗",
    send: "보내기",
    commandHelp: "보내기는 짧게 누르면 Return, 파란색이 될 때까지 누르면 Command+Return입니다.",
    directionLabel: "방향",
    previousPage: "이전 페이지",
    nextPage: "다음 페이지",
    help: "도움말",
    saved: "저장됨"
  },
  ru: {
    title: "Настройки ThreadDeck",
    loading: "Загрузка настроек…",
    taskLabel: "Задача",
    currentTask: "Текущая задача",
    topTask: "Задача {index} в списке",
    taskHelp: "Выберите задачу Codex для этой кнопки.",
    commandLabel: "Команда",
    newTask: "Новая задача",
    sideChat: "Дополнительный чат",
    send: "Отправить",
    commandHelp: "Короткое нажатие отправляет Return. Удержание до синего цвета — Command+Return.",
    directionLabel: "Направление",
    previousPage: "Предыдущая страница",
    nextPage: "Следующая страница",
    help: "Справка",
    saved: "Сохранено"
  }
};

let socket = null;
let context = "";
let action = "";
let settings = {};
let statusTimer = null;
let settingsPending = false;
let hostLanguage = "";

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function language() {
  const base = String(hostLanguage || navigator.language || "en")
    .trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return Object.hasOwn(COPY, base) ? base : "en";
}

function localize() {
  const copy = COPY[language()];
  document.documentElement.lang = language();
  for (const element of document.querySelectorAll("[data-copy]")) {
    const value = copy[element.dataset.copy];
    if (value) element.textContent = value;
  }
  for (let index = 1; index <= 8; index += 1) {
    const option = document.querySelector(`option[value="top${index}"]`);
    if (option) option.textContent = copy.topTask.replace("{index}", String(index));
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
  const loadingPanel = document.getElementById("settings-loading");
  const taskPanel = document.getElementById("task-settings");
  const commandPanel = document.getElementById("command-settings");
  const navigationPanel = document.getElementById("navigation-settings");
  taskPanel.hidden = action !== TASK_ACTION;
  commandPanel.hidden = action !== COMMAND_ACTION;
  navigationPanel.hidden = action !== NAVIGATION_ACTION;
  loadingPanel.hidden = true;

  const taskSource = document.getElementById("task-source");
  const command = document.getElementById("command");
  const pageDirection = document.getElementById("page-direction");
  taskSource.value = /^(?:current|top[1-8])$/.test(settings.taskSource)
    ? settings.taskSource
    : "current";
  command.value = /^(?:new-task|side-chat|send)$/.test(settings.command)
    ? settings.command
    : "new-task";
  pageDirection.value = /^(?:previous|next)$/.test(settings.pageDirection)
    ? settings.pageDirection
    : "previous";

  for (const select of document.querySelectorAll("select[data-setting]")) {
    select.addEventListener("change", () => {
      setSettings({ ...settings, [select.dataset.setting]: select.value });
    });
  }

  const main = document.getElementById("settings");
  main.setAttribute("aria-busy", "false");
}

function connectElgatoStreamDeckSocket(
  port,
  uuid,
  registerEvent,
  info,
  actionInfo
) {
  const registrationInfo = parseJson(info);
  hostLanguage = String(registrationInfo?.application?.language ?? "").trim();
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
}

localize();
