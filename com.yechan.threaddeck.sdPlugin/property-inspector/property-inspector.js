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
    fixedTask: "Fixed task",
    fixedTaskLabel: "Task",
    chooseTask: "Choose a task…",
    loadingTasks: "Loading tasks…",
    tasksUnavailable: "The task list is unavailable. Your saved assignment is kept.",
    noTasks: "No tasks available.",
    fixedTaskHelp: "This key keeps the selected task when its title or position changes.",
    missingTaskHelp: "The saved task is unavailable. Choose another task to replace it.",
    unavailableTask: "unavailable",
    remoteTask: "remote",
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
    fixedTask: "고정 작업",
    fixedTaskLabel: "작업",
    chooseTask: "작업 선택…",
    loadingTasks: "작업을 불러오는 중…",
    tasksUnavailable: "작업 목록을 불러올 수 없습니다. 저장된 연결은 유지됩니다.",
    noTasks: "선택할 수 있는 작업이 없습니다.",
    fixedTaskHelp: "제목이나 순서가 바뀌어도 이 버튼은 선택한 작업을 유지합니다.",
    missingTaskHelp: "저장된 작업을 사용할 수 없습니다. 변경하려면 다른 작업을 선택하세요.",
    unavailableTask: "사용 불가",
    remoteTask: "원격",
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
    fixedTask: "Закреплённая задача",
    fixedTaskLabel: "Задача",
    chooseTask: "Выберите задачу…",
    loadingTasks: "Загрузка задач…",
    tasksUnavailable: "Список задач недоступен. Сохранённая привязка остаётся.",
    noTasks: "Нет доступных задач.",
    fixedTaskHelp: "Кнопка сохраняет выбранную задачу при изменении её названия или позиции в списке.",
    missingTaskHelp: "Сохранённая задача недоступна. Выберите другую, чтобы заменить её.",
    unavailableTask: "недоступна",
    remoteTask: "удалённая",
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
let actionContext = "";
let action = "";
let settings = {};
let statusTimer = null;
let settingsPending = false;
let hostLanguage = "";
let controlsBound = false;
let tasks = [];
let catalogAvailable = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let connectionGeneration = 0;

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function taskId(value) {
  return typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : "";
}

function taskSource() {
  return /^(?:current|top[1-8]|fixed)$/.test(settings.taskSource) ? settings.taskSource : "current";
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

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function setSettings(nextSettings) {
  settings = nextSettings;
  settingsPending = !sendMessage({
    event: "setSettings",
    context,
    payload: settings
  });
  if (!settingsPending) showStatus();
}

function requestTaskCatalog() {
  if (action !== TASK_ACTION) return;
  sendMessage({
    event: "sendToPlugin",
    action: TASK_ACTION,
    context,
    payload: { event: "get-task-catalog" }
  });
}

function renderTaskPicker() {
  const copy = COPY[language()];
  const select = document.getElementById("fixed-task");
  const status = document.getElementById("fixed-task-status");
  const savedId = taskId(settings.fixedTaskId);
  const selectedTask = tasks.find((task) => task.id === savedId);
  const missing = Boolean(savedId && !selectedTask && catalogAvailable === true);
  select.replaceChildren();
  function addOption(value, title, disabled = false) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = title;
    option.disabled = disabled;
    select.appendChild(option);
  }
  addOption("", copy.chooseTask, true);
  if (savedId && !selectedTask) {
    const title = typeof settings.fixedTaskTitle === "string" && settings.fixedTaskTitle.trim()
      ? settings.fixedTaskTitle : savedId;
    addOption(savedId, missing ? `${title} (${copy.unavailableTask})` : title, true);
  }
  const titleCounts = new Map();
  for (const task of tasks) titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  for (const task of tasks) {
    const title = titleCounts.get(task.title) > 1 ? `${task.title} — ${task.id}` : task.title;
    addOption(task.id, task.remote ? `${title} (${copy.remoteTask})` : title);
  }
  select.value = savedId || "";
  select.disabled = catalogAvailable !== true || tasks.length === 0;
  status.textContent = catalogAvailable === null ? copy.loadingTasks
    : catalogAvailable === false ? copy.tasksUnavailable
    : missing ? copy.missingTaskHelp
    : tasks.length === 0 ? copy.noTasks : copy.fixedTaskHelp;
}

function updateTaskControls() {
  const source = taskSource();
  const fixed = source === "fixed";
  document.querySelector('label[for="fixed-task"]').hidden = !fixed;
  document.getElementById("fixed-task").hidden = !fixed;
  document.getElementById("fixed-task-status").hidden = !fixed;
  renderTaskPicker();
}

function bindControls() {
  if (controlsBound) return;
  controlsBound = true;
  for (const select of document.querySelectorAll("select[data-setting]")) {
    select.addEventListener("change", () => {
      if (select.dataset.setting === "fixedTaskId") {
        if (action !== TASK_ACTION || taskSource() !== "fixed" || catalogAvailable !== true) return;
        const task = tasks.find((candidate) => candidate.id === taskId(select.value));
        if (!task) return;
        setSettings({ ...settings, fixedTaskId: task.id, fixedTaskTitle: task.title });
      } else {
        setSettings({ ...settings, [select.dataset.setting]: select.value });
      }
      updateTaskControls();
      if (select.dataset.setting === "taskSource" && taskSource() === "fixed") requestTaskCatalog();
    });
  }
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
  taskSource.value = /^(?:current|top[1-8]|fixed)$/.test(settings.taskSource)
    ? settings.taskSource
    : "current";
  command.value = /^(?:new-task|side-chat|send)$/.test(settings.command)
    ? settings.command
    : "new-task";
  pageDirection.value = /^(?:previous|next)$/.test(settings.pageDirection)
    ? settings.pageDirection
    : "previous";

  updateTaskControls();
  bindControls();

  const main = document.getElementById("settings");
  main.setAttribute("aria-busy", "false");
}

function receiveMessage(message) {
  if ((message.context !== actionContext && message.context !== context)
      || (message.action && message.action !== action)) return;
  const payload = parseJson(message.payload);
  if (message.event === "didReceiveSettings") {
    // A disconnected edit belongs to the user and is sent after reconnecting.
    if (settingsPending) return;
    const nextSettings = parseJson(payload.settings, null);
    if (!nextSettings) return;
    settings = nextSettings;
    initializeControls();
    if (taskSource() === "fixed") requestTaskCatalog();
  } else if (message.event === "sendToPropertyInspector" && action === TASK_ACTION
    && payload.event === "task-catalog") {
    catalogAvailable = payload.available === true && Array.isArray(payload.tasks);
    if (catalogAvailable) {
      const seen = new Set();
      tasks = [];
      for (const candidate of payload.tasks) {
        const id = taskId(candidate?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        tasks.push({
          id,
          title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : id,
          remote: candidate.remote === true
        });
      }
    }
    renderTaskPicker();
  }
}

function openSocket(port, uuid, registerEvent, generation) {
  const nextSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket = nextSocket;
  const isCurrent = () => socket === nextSocket && generation === connectionGeneration;
  nextSocket.addEventListener("open", () => {
    if (!isCurrent()) return;
    reconnectDelay = 500;
    sendMessage({ event: registerEvent, uuid });
    if (settingsPending) setSettings(settings);
    requestTaskCatalog();
  });
  nextSocket.addEventListener("message", (message) => {
    if (isCurrent()) receiveMessage(parseJson(message.data));
  });
  function disconnected() {
    if (!isCurrent()) return;
    socket = null;
    catalogAvailable = false;
    renderTaskPicker();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (generation === connectionGeneration) openSocket(port, uuid, registerEvent, generation);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }
  nextSocket.addEventListener("close", disconnected);
  nextSocket.addEventListener("error", () => {
    if (!isCurrent()) return;
    disconnected();
    nextSocket.close();
  });
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
  connectionGeneration += 1;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (statusTimer) window.clearTimeout(statusTimer);
  statusTimer = null;
  document.getElementById("save-status").textContent = "";
  const previousSocket = socket;
  socket = null;
  if (previousSocket) previousSocket.close();
  settingsPending = false;
  tasks = [];
  catalogAvailable = null;
  reconnectDelay = 500;
  const parsedActionInfo = parseJson(actionInfo);
  // Stream Deck validates outgoing UI commands against its inspector session
  // UUID, then routes them to the action. Replies can identify the action
  // instance instead; do not conflate these two sides of the connection.
  context = uuid;
  actionContext = typeof parsedActionInfo.context === "string" && parsedActionInfo.context
    ? parsedActionInfo.context
    : uuid;
  action = parsedActionInfo.action ?? "";
  settings = parseJson(parsedActionInfo.payload?.settings);
  localize();
  initializeControls();

  openSocket(port, uuid, registerEvent, connectionGeneration);
}

localize();
