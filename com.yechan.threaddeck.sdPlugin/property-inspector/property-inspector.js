"use strict";

const TASK_ACTION = "com.yechan.threaddeck.thread1";
const COMMAND_ACTION = "com.yechan.threaddeck.newthread";
const TASK_ACTIONS_ACTION = "com.yechan.threaddeck.taskactions";
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
    taskActionLabel: "Task action",
    approve: "Approve",
    decline: "Decline",
    approvalHelp: "Approve a pending request once or decline it. Blue Sent means the action was sent.",
    approvalTargetLabel: "Approval target",
    chooseApprovalTarget: "Choose an approval target…",
    approvalTaskKey: "Task selected on Stream Deck",
    approvalCurrentDialog: "Current dialog (foreground)",
    approvalTaskKeyHelp: "Press a Codex task key to choose its task. Its name appears on Approve and Decline. The same task stays selected when you switch tasks manually in Codex. Works while another app has focus.",
    approvalCurrentDialogHelp: "Keep the intended task and request in the foreground. Approve or Decline acts on the visible permission request. For Review findings, review the findings and check the acknowledgment in Codex first; Approve can then press Continue chat. No keyboard shortcut setup is needed.",
    approvalUnknownTargetHelp: "The saved approval target is not supported. Choose a target to enable this key.",
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
    taskActionLabel: "작업 액션",
    approve: "승인",
    decline: "거절",
    approvalHelp: "대기 중인 요청을 한 번 승인하거나 거절합니다. 파란색 전송됨은 동작 전송을 의미합니다.",
    approvalTargetLabel: "승인 대상",
    chooseApprovalTarget: "승인 대상 선택…",
    approvalTaskKey: "Stream Deck에서 선택한 작업",
    approvalCurrentDialog: "현재 대화상자 (맨 앞)",
    approvalTaskKeyHelp: "Codex 작업 버튼을 눌러 작업을 선택하세요. 승인과 거절 버튼에 작업 이름이 표시됩니다. Codex에서 다른 작업으로 직접 전환해도 선택한 작업은 유지됩니다. 다른 앱이 맨 앞에 있어도 사용할 수 있습니다.",
    approvalCurrentDialogHelp: "대상 작업과 요청을 맨 앞에 두세요. 승인 또는 거절은 표시된 권한 요청에 적용됩니다. Review findings는 먼저 Codex에서 내용을 검토하고 확인란을 선택하세요. 이후 승인 버튼으로 Continue chat을 누를 수 있습니다. 단축키 설정은 필요하지 않습니다.",
    approvalUnknownTargetHelp: "저장된 승인 대상은 지원되지 않습니다. 이 버튼을 사용하려면 대상을 선택하세요.",
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
    taskActionLabel: "Действие с запросом",
    approve: "Одобрить",
    decline: "Отклонить",
    approvalHelp: "Одобрить ожидающий запрос один раз или отклонить его. Синяя надпись «Отправлено» означает, что действие отправлено.",
    approvalTargetLabel: "Цель подтверждения",
    chooseApprovalTarget: "Выберите цель подтверждения…",
    approvalTaskKey: "Задача, выбранная на Stream Deck",
    approvalCurrentDialog: "Текущий диалог (на переднем плане)",
    approvalTaskKeyHelp: "Нажмите кнопку задачи Codex, чтобы выбрать её. Название появится на кнопках одобрения и отклонения. При ручном переходе к другой задаче в Codex выбор сохраняется. Работает, даже когда на переднем плане другое приложение.",
    approvalCurrentDialogHelp: "Откройте нужную задачу и запрос на переднем плане. Одобрение или отклонение применяется к видимому запросу разрешения. Для Review findings сначала просмотрите замечания и установите флажок подтверждения в Codex; после этого кнопка одобрения может нажать Continue chat. Настраивать сочетания клавиш не требуется.",
    approvalUnknownTargetHelp: "Сохранённая цель подтверждения не поддерживается. Выберите цель, чтобы включить эту кнопку.",
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
let actionContext = "";
let controlsBound = false;
let settings = {};
let statusTimer = null;
let settingsPending = false;
let hostLanguage = "";

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
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

function updateCommandHelp() {
  const copy = COPY[language()];
  document.getElementById("command-help").textContent = /^(?:approve|decline)$/.test(settings.command)
    ? copy.approvalHelp : copy.commandHelp;
  const visible = action === TASK_ACTIONS_ACTION
    ? /^(?:approve|decline)$/.test(document.getElementById("task-action").value)
    : action === COMMAND_ACTION && /^(?:approve|decline)$/.test(settings.command);
  document.getElementById("approval-target-settings").hidden = !visible;
  const target = !Object.hasOwn(settings, "approvalTarget") ? "task-key"
    : settings.approvalTarget === "task-key" || settings.approvalTarget === "current-dialog" ? settings.approvalTarget : "";
  document.getElementById("approval-target").value = target;
  document.getElementById("approval-target-help").textContent = target === "task-key" ? copy.approvalTaskKeyHelp
    : target === "current-dialog" ? copy.approvalCurrentDialogHelp : copy.approvalUnknownTargetHelp;
}

function initializeControls() {
  const loadingPanel = document.getElementById("settings-loading");
  const taskPanel = document.getElementById("task-settings");
  const commandPanel = document.getElementById("command-settings");
  const taskActionsPanel = document.getElementById("task-actions-settings");
  const navigationPanel = document.getElementById("navigation-settings");
  taskPanel.hidden = action !== TASK_ACTION;
  commandPanel.hidden = action !== COMMAND_ACTION;
  taskActionsPanel.hidden = action !== TASK_ACTIONS_ACTION;
  navigationPanel.hidden = action !== NAVIGATION_ACTION;
  loadingPanel.hidden = true;

  const taskSource = document.getElementById("task-source");
  const command = document.getElementById("command");
  const pageDirection = document.getElementById("page-direction");
  taskSource.value = /^(?:current|top[1-8])$/.test(settings.taskSource)
    ? settings.taskSource
    : "current";
  command.value = /^(?:new-task|side-chat|send|approve|decline)$/.test(settings.command)
    ? settings.command
    : "new-task";
  const taskAction = String(settings.command ?? "approve").trim().toLowerCase();
  document.getElementById("task-action").value = /^(?:approve|decline)$/.test(taskAction) ? taskAction : "";
  pageDirection.value = /^(?:previous|next)$/.test(settings.pageDirection)
    ? settings.pageDirection
    : "previous";

  updateCommandHelp();
  if (!controlsBound) {
    controlsBound = true;
    for (const select of document.querySelectorAll("select[data-setting]")) {
      select.addEventListener("change", () => {
        if (select === document.getElementById("task-action")
          && (action !== TASK_ACTIONS_ACTION || !/^(?:approve|decline)$/.test(select.value))) return;
        if (select.dataset.setting === "approvalTarget"
          && (document.getElementById("approval-target-settings").hidden
            || !["task-key", "current-dialog"].includes(select.value))) return;
        setSettings({ ...settings, [select.dataset.setting]: select.value });
        updateCommandHelp();
      });
    }
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
  const previousSocket = socket;
  socket = null;
  if (previousSocket) previousSocket.close();
  settingsPending = false;
  const registrationInfo = parseJson(info);
  hostLanguage = String(registrationInfo?.application?.language ?? "").trim();
  context = uuid;
  const parsedActionInfo = parseJson(actionInfo);
  actionContext = typeof parsedActionInfo.context === "string" && parsedActionInfo.context
    ? parsedActionInfo.context : uuid;
  action = parsedActionInfo.action ?? "";
  settings = parseJson(parsedActionInfo.payload?.settings);
  localize();
  initializeControls();

  const nextSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    nextSocket.send(JSON.stringify({ event: registerEvent, uuid }));
    if (settingsPending) setSettings(settings);
  });
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket || settingsPending) return;
    const message = parseJson(event.data);
    if (message.event !== "didReceiveSettings"
      || (message.context !== context && message.context !== actionContext)
      || (message.action && message.action !== action)) return;
    settings = parseJson(parseJson(message.payload).settings);
    initializeControls();
  });
}

localize();
