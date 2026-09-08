const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(
  path.join(ROOT, "com.yechan.threaddeck.sdPlugin/property-inspector/property-inspector.js"),
  "utf8"
);

class FakeElement {
  constructor(dataset = {}) {
    this.children = [];
    this.attributes = {};
    this.dataset = dataset;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

function createHost(navigatorLanguage = "en-US") {
  const elements = new Map([
    ["settings", new FakeElement()],
    ["settings-loading", new FakeElement()],
    ["task-settings", new FakeElement()],
    ["command-settings", new FakeElement()],
    ["navigation-settings", new FakeElement()],
    ["task-actions-settings", new FakeElement()],
    ["approval-target-settings", new FakeElement()],
    ["command-help", new FakeElement({ copy: "commandHelp" })],
    ["task-action-help", new FakeElement({ copy: "approvalHelp" })],
    ["approval-target-help", new FakeElement()],
    ["task-action", new FakeElement({ setting: "command" })],
    ["approval-target", new FakeElement({ setting: "approvalTarget" })],
    ["task-source", new FakeElement({ setting: "taskSource" })],
    ["command", new FakeElement({ setting: "command" })],
    ["page-direction", new FakeElement({ setting: "pageDirection" })],
    ["save-status", new FakeElement()]
  ]);
  const optionElements = new Map();
  const html = fs.readFileSync(path.join(ROOT, "com.yechan.threaddeck.sdPlugin/property-inspector/index.html"), "utf8");
  const localizedElements = new Map([...html.matchAll(/data-copy="([^"]+)"/g)]
    .map((match) => [match[1], new FakeElement({ copy: match[1] })]));
  for (const element of elements.values()) {
    if (element.dataset.copy) localizedElements.set(element.dataset.copy, element);
  }
  for (const [, id, body] of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const [, value, copy, text] of body.matchAll(/<option value="([^"]*)"(?: data-copy="([^"]+)")?[^>]*>([^<]*)<\/option>/g)) {
      const option = new FakeElement(copy ? { copy } : {});
      option.value = value;
      option.textContent = text;
      elements.get(id).children.push(option);
    }
  }
  const sockets = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    send(message) {
      this.sent.push(JSON.parse(message));
    }

    receive(message) {
      this.listeners.get("message")?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
    }

    close() { this.readyState = 3; }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners.get("open")?.();
    }
  }

  const sandbox = {
    WebSocket: FakeWebSocket,
    navigator: { language: navigatorLanguage },
    document: {
      documentElement: { lang: "" },
      getElementById(id) {
        return elements.get(id) ?? null;
      },
      querySelector(selector) {
        const match = selector.match(/^option\[value="(top[1-8])"\]$/);
        if (!match) return null;
        if (!optionElements.has(match[1])) optionElements.set(match[1], new FakeElement());
        return optionElements.get(match[1]);
      },
      querySelectorAll(selector) {
        if (selector === "[data-copy]") return [...localizedElements.values(), ...[...elements.values()].flatMap((element) => element.children).filter((option) => option.dataset.copy)];
        if (selector === "select[data-setting]") {
          return [
            elements.get("task-source"),
            elements.get("command"),
            elements.get("task-action"),
            elements.get("approval-target"),
            elements.get("page-direction")
          ];
        }
        return [];
      }
    },
    clearTimeout() {},
    setTimeout() {
      return 1;
    }
  };
  sandbox.window = sandbox;

  vm.runInNewContext(SCRIPT, sandbox, { filename: "property-inspector.js" });
  return { sandbox, elements, optionElements, localizedElements, sockets };
}

test("Property Inspector exposes the Stream Deck callback and saves grouped task settings", () => {
  const { sandbox, elements, sockets } = createHost();
  assert.equal(typeof sandbox.connectElgatoStreamDeckSocket, "function");

  sandbox.connectElgatoStreamDeckSocket(
    "28196",
    "task-context",
    "registerPropertyInspector",
    {},
    {
      action: "com.yechan.threaddeck.thread1",
      payload: { settings: { taskSource: "top3" } }
    }
  );

  assert.equal(elements.get("settings").attributes["aria-busy"], "false");
  assert.equal(elements.get("settings-loading").hidden, true);
  assert.equal(elements.get("task-settings").hidden, false);
  assert.equal(elements.get("command-settings").hidden, true);
  assert.equal(elements.get("navigation-settings").hidden, true);
  assert.equal(elements.get("task-source").value, "top3");

  const socket = sockets[0];
  socket.open();
  assert.deepEqual(socket.sent[0], {
    event: "registerPropertyInspector",
    uuid: "task-context"
  });

  elements.get("task-source").value = "top4";
  elements.get("task-source").listeners.get("change")();
  assert.deepEqual(socket.sent[1], {
    event: "setSettings",
    context: "task-context",
    payload: { taskSource: "top4" }
  });

  sandbox.connectElgatoStreamDeckSocket(
    "28197",
    "navigation-context",
    "registerPropertyInspector",
    {},
    {
      action: "com.yechan.threaddeck.page.previous",
      payload: { settings: { currentPage: 0 } }
    }
  );

  assert.equal(elements.get("task-settings").hidden, true);
  assert.equal(elements.get("command-settings").hidden, true);
  assert.equal(elements.get("navigation-settings").hidden, false);
  assert.equal(elements.get("page-direction").value, "previous");

  const navigationSocket = sockets[1];
  navigationSocket.open();
  elements.get("page-direction").value = "next";
  elements.get("page-direction").listeners.get("change")();
  assert.deepEqual(navigationSocket.sent[1], {
    event: "setSettings",
    context: "navigation-context",
    payload: { currentPage: 0, pageDirection: "next" }
  });
});


test("Property Inspector uses Russian host language and preserves setting values", () => {
  const { sandbox, elements, optionElements, localizedElements, sockets } = createHost("en-US");
  sandbox.connectElgatoStreamDeckSocket("28196", "ru-context", "registerPropertyInspector",
    JSON.stringify({ application: { language: "ru_RU" } }),
    { action: "com.yechan.threaddeck.thread1", payload: { settings: { taskSource: "top3", custom: true } } });
  assert.equal(sandbox.document.documentElement.lang, "ru");
  assert.equal(localizedElements.get("taskLabel").textContent, "Задача");
  assert.equal(localizedElements.get("currentTask").textContent, "Текущая задача");
  assert.equal(localizedElements.get("commandLabel").textContent, "Команда");
  assert.equal(localizedElements.get("nextPage").textContent, "Следующая страница");
  assert.equal(localizedElements.get("title").textContent, "Настройки ThreadDeck");
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(optionElements.get(`top${index}`).textContent, `Задача ${index} в списке`);
  }
  assert.equal(elements.get("task-source").value, "top3");
  sockets[0].open();
  elements.get("task-source").value = "top8";
  elements.get("task-source").listeners.get("change")();
  assert.deepEqual(sockets[0].sent[1], {
    event: "setSettings", context: "ru-context",
    payload: { taskSource: "top8", custom: true }
  });
  assert.equal(elements.get("save-status").textContent, "Сохранено");
});

test("Property Inspector falls back to navigator only when host language is missing", () => {
  for (const info of [{}, "{broken", null, { application: { language: "  " } }]) {
    const { sandbox, localizedElements } = createHost("ru-RU");
    assert.equal(localizedElements.get("loading").textContent, "Загрузка настроек…");
    sandbox.connectElgatoStreamDeckSocket("28196", "context", "registerPropertyInspector", info, {});
    assert.equal(sandbox.document.documentElement.lang, "ru");
    assert.equal(localizedElements.get("help").textContent, "Справка");
  }
  const { sandbox, localizedElements } = createHost("ru-RU");
  sandbox.connectElgatoStreamDeckSocket("28196", "context", "registerPropertyInspector",
    { application: { language: "ja" } }, {});
  assert.equal(sandbox.document.documentElement.lang, "en");
  assert.equal(localizedElements.get("help").textContent, "Help");
});

test("Property Inspector can relocalize all task slots between supported languages", () => {
  const { sandbox, optionElements, localizedElements } = createHost("ru-RU");
  for (const [locale, language, slot, help] of [
    ["ko_KR", "ko", "상위 작업 1", "도움말"],
    ["ru-RU", "ru", "Задача 1 в списке", "Справка"],
    ["en-US", "en", "Top task 1", "Help"]
  ]) {
    sandbox.connectElgatoStreamDeckSocket("28196", "context", "registerPropertyInspector",
      { application: { language: locale } }, {});
    assert.equal(sandbox.document.documentElement.lang, language);
    assert.equal(optionElements.get("top1").textContent, slot);
    assert.equal(localizedElements.get("help").textContent, help);
  }
});


const TASK_ACTION = "com.yechan.threaddeck.thread1";
const COMMAND_ACTION = "com.yechan.threaddeck.newthread";
const TASK_ACTIONS_ACTION = "com.yechan.threaddeck.taskactions";
const NAVIGATION_ACTION = "com.yechan.threaddeck.page.previous";

function createInspector(language = "en-US") {
  const host = createHost(language);
  return {
    ...host,
    connect(settings, action = TASK_ACTION, context = "task-context") {
      host.sandbox.connectElgatoStreamDeckSocket("28196", context, "registerPropertyInspector", {}, {
        action, context, payload: { settings }
      });
      return host.sockets.at(-1);
    },
    change(id, value) {
      const element = host.elements.get(id);
      element.value = value;
      element.listeners.get("change")?.();
    }
  };
}
function saved(socket) { return socket.sent.filter((message) => message.event === "setSettings"); }
function requests(socket) { return socket.sent.filter((message) => message.event === "sendToPlugin"); }

test("Approve and Decline autosave and explain pending approval behavior", () => {
  const ui = createInspector();
  const socket = ui.connect({ command: "approve", customSetting: "kept" }, COMMAND_ACTION, "command-context");
  socket.open();
  assert.equal(ui.elements.get("command").value, "approve");
  assert.equal(ui.elements.get("command-settings").hidden, false);
  assert.match(ui.elements.get("command-help").textContent, /pending request/);
  assert.match(ui.elements.get("command-help").textContent, /Blue Sent means the action was sent/);
  assert.equal(ui.elements.get("approval-target-settings").hidden, false);
  assert.equal(ui.elements.get("approval-target").value, "task-key");
  assert.doesNotMatch(ui.elements.get("command-help").textContent, /Command\+Return/);
  ui.change("command", "decline");
  assert.deepEqual(saved(socket)[0].payload, { command: "decline", customSetting: "kept" });
  assert.match(ui.elements.get("command-help").textContent, /Blue Sent means the action was sent/);
  ui.change("command", "send");
  assert.match(ui.elements.get("command-help").textContent, /Command\+Return/);
  assert.equal(ui.elements.get("approval-target-settings").hidden, true);
  assert.deepEqual(requests(socket), []);
});

test("Task actions exposes only approval decisions and preserves settings on save", () => {
  const ui = createInspector();
  const socket = ui.connect({ customSetting: "kept" }, TASK_ACTIONS_ACTION, "actions-context");
  socket.open();
  assert.equal(ui.elements.get("task-actions-settings").hidden, false);
  assert.equal(ui.elements.get("command-settings").hidden, true);
  assert.equal(ui.elements.get("task-settings").hidden, true);
  assert.equal(ui.elements.get("task-action").value, "approve");
  assert.deepEqual(ui.elements.get("task-action").children.map((option) => option.value), ["approve", "decline"]);
  assert.match(ui.elements.get("task-action-help").textContent, /Blue Sent means the action was sent/);
  assert.equal(ui.elements.get("approval-target-settings").hidden, false);
  assert.equal(saved(socket).length, 0, "opening settings must not change the profile");
  ui.change("task-action", "decline");
  assert.deepEqual(saved(socket)[0].payload, { customSetting: "kept", command: "decline" });
  assert.equal(saved(socket)[0].context, "actions-context");
  ui.change("task-action", "send");
  assert.equal(saved(socket).length, 1, "unrelated commands must not be saved");
  assert.deepEqual(requests(socket), []);
  socket.receive({ event: "didReceiveSettings", context: "actions-context", payload: { settings: { command: "send" } } });
  assert.equal(ui.elements.get("task-action").value, "", "invalid settings must not look like approval");
  assert.equal(ui.elements.get("approval-target-settings").hidden, true);
});

test("approval target autosaves for both approval actions without altering unrelated settings", () => {
  for (const action of [TASK_ACTIONS_ACTION, COMMAND_ACTION]) {
    const ui = createInspector();
    const socket = ui.connect({ command: "approve", customSetting: "kept" }, action, "approval-context");
    socket.open();
    assert.equal(ui.elements.get("approval-target").value, "task-key");
    assert.deepEqual(saved(socket), [], "showing the default must not rewrite settings");
    assert.match(ui.elements.get("approval-target-help").textContent, /name appears on Approve and Decline/);
    assert.match(ui.elements.get("approval-target-help").textContent, /stays selected when you switch tasks manually in Codex/);
    assert.match(ui.elements.get("approval-target-help").textContent, /another app has focus/);
    ui.change("approval-target", "current-dialog");
    assert.deepEqual(saved(socket).at(-1).payload, { command: "approve", customSetting: "kept", approvalTarget: "current-dialog" });
    assert.match(ui.elements.get("approval-target-help").textContent, /intended task and request in the foreground/);
    assert.match(ui.elements.get("approval-target-help").textContent, /Review findings/);
    assert.match(ui.elements.get("approval-target-help").textContent, /check the acknowledgment in Codex first/);
    ui.change(action === TASK_ACTIONS_ACTION ? "task-action" : "command", "decline");
    assert.equal(saved(socket).at(-1).payload.approvalTarget, "current-dialog");
    ui.change("approval-target", "task-key");
    assert.deepEqual(saved(socket).at(-1).payload, { command: "decline", customSetting: "kept", approvalTarget: "task-key" });
    assert.deepEqual(requests(socket), [], "approval target changes only settings");
  }
});

test("unknown approval targets stay unselected and preserved until explicitly replaced", () => {
  for (const approvalTarget of [null, "", "future-mode", false, 0, "TASK-KEY", " current-dialog "]) {
    const ui = createInspector();
    const socket = ui.connect({ command: "approve", approvalTarget }, TASK_ACTIONS_ACTION, "approval-context");
    socket.open();
    assert.equal(ui.elements.get("approval-target").value, "");
    assert.match(ui.elements.get("approval-target-help").textContent, /not supported/);
    assert.equal(saved(socket).length, 0);
    ui.change("task-action", "decline");
    assert.deepEqual(saved(socket).at(-1).payload, { command: "decline", approvalTarget });
    ui.change("approval-target", "invalid");
    assert.equal(saved(socket).length, 1, "unknown or placeholder values cannot be saved as a mode");
    ui.change("approval-target", "current-dialog");
    assert.deepEqual(saved(socket).at(-1).payload, { command: "decline", approvalTarget: "current-dialog" });
  }
});

test("non-approval actions hide target settings and cannot save a target through the hidden control", () => {
  for (const [action, settings] of [
    [TASK_ACTION, { taskSource: "current" }], [NAVIGATION_ACTION, {}],
    [COMMAND_ACTION, { command: "send" }], [COMMAND_ACTION, { command: "new-task" }],
    [COMMAND_ACTION, { command: "side-chat" }], [TASK_ACTIONS_ACTION, { command: "send" }]
  ]) {
    const ui = createInspector();
    const socket = ui.connect(settings, action);
    socket.open();
    assert.equal(ui.elements.get("approval-target-settings").hidden, true);
    ui.change("approval-target", "current-dialog");
    assert.equal(saved(socket).length, 0);
  }
});

test("approval target reflects external settings and survives command switches", () => {
  const ui = createInspector();
  const socket = ui.connect({ command: "send", approvalTarget: "current-dialog" }, COMMAND_ACTION, "approval-context");
  socket.open();
  ui.change("command", "approve");
  assert.equal(ui.elements.get("approval-target-settings").hidden, false);
  assert.equal(ui.elements.get("approval-target").value, "current-dialog");
  socket.receive({ event: "didReceiveSettings", context: "approval-context", payload: {
    settings: { command: "decline", approvalTarget: "task-key" }
  } });
  assert.equal(ui.elements.get("approval-target").value, "task-key");
  ui.change("command", "new-task");
  assert.equal(ui.elements.get("approval-target-settings").hidden, true);
  assert.equal(saved(socket).at(-1).payload.approvalTarget, "task-key");
  ui.change("command", "decline");
  assert.equal(ui.elements.get("approval-target").value, "task-key");
});

test("approval keys explain the visible-card action without changing Codex shortcuts", () => {
  const ui = createInspector();
  ui.sandbox.connectElgatoStreamDeckSocket("28196", "inspector-session", "registerPropertyInspector", {}, {
    action: TASK_ACTIONS_ACTION, context: "task-instance", payload: { settings: { command: "approve", approvalTarget: "current-dialog" } }
  });
  const socket = ui.sockets.at(-1);
  socket.open();
  assert.deepEqual(requests(socket), []);
  assert.equal(ui.elements.has("prepare-approval-shortcuts"), false);
  assert.match(ui.elements.get("approval-target-help").textContent, /visible permission request/);
  assert.match(ui.elements.get("approval-target-help").textContent, /No keyboard shortcut setup/);
  assert.deepEqual(saved(socket), []);
});

test("approval copy is localized in every supported host language", () => {
  for (const [language, approve, decline, target] of [
    ["en", "Approve", "Decline", "Task selected on Stream Deck"],
    ["ko", "승인", "거절", "Stream Deck에서 선택한 작업"],
    ["ru", "Одобрить", "Отклонить", "Задача, выбранная на Stream Deck"]
  ]) {
    const ui = createInspector();
    ui.sandbox.connectElgatoStreamDeckSocket("28196", "context", "registerPropertyInspector",
      { application: { language } }, { action: TASK_ACTIONS_ACTION, payload: { settings: {} } });
    const label = (id, value) => ui.elements.get(id).children.find((option) => option.value === value).textContent;
    assert.equal(label("command", "approve"), approve);
    assert.equal(label("command", "decline"), decline);
    assert.equal(label("task-action", "approve"), approve);
    assert.equal(label("task-action", "decline"), decline);
    assert.equal(label("approval-target", "task-key"), target);
  }
});

test("external settings target the active inspector without replacing pending user edits", () => {
  const ui = createInspector();
  const socket = ui.connect({ command: "approve" }, TASK_ACTIONS_ACTION, "active-context");
  const message = (context, settings, action = TASK_ACTIONS_ACTION) => ({
    event: "didReceiveSettings", context, action, payload: { settings }
  });
  socket.open();
  socket.receive(message("other-context", { command: "decline" }));
  socket.receive(message("active-context", { command: "decline" }, COMMAND_ACTION));
  socket.receive("{invalid");
  socket.receive("null");
  assert.equal(ui.elements.get("task-action").value, "approve");
  socket.receive(message("active-context", { command: "decline", approvalTarget: "current-dialog" }));
  assert.equal(ui.elements.get("task-action").value, "decline");
  const next = ui.connect({ command: "approve" }, TASK_ACTIONS_ACTION, "new-context");
  ui.change("approval-target", "current-dialog");
  next.receive(message("new-context", { command: "decline" }));
  socket.receive(message("new-context", { command: "decline" }));
  socket.open();
  assert.equal(ui.elements.get("task-action").value, "approve");
  next.open();
  assert.deepEqual(saved(next).map((entry) => entry.payload), [{ command: "approve", approvalTarget: "current-dialog" }]);
});

test("settings messages may identify the action instance while saves use the inspector session", () => {
  const ui = createInspector();
  ui.sandbox.connectElgatoStreamDeckSocket("28196", "inspector-session", "registerPropertyInspector", {}, {
    action: TASK_ACTIONS_ACTION, context: "action-instance", payload: { settings: {} }
  });
  const socket = ui.sockets.at(-1);
  socket.open();
  socket.receive({ event: "didReceiveSettings", context: "action-instance", action: TASK_ACTIONS_ACTION,
    payload: { settings: { command: "decline", approvalTarget: "current-dialog" } } });
  assert.equal(ui.elements.get("task-action").value, "decline");
  ui.change("approval-target", "task-key");
  assert.equal(saved(socket).at(-1).context, "inspector-session");
});

test("approval extraction leaves the existing task sources and profiles unchanged", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "top2", customSetting: "kept" });
  socket.open();
  assert.deepEqual(ui.elements.get("task-source").children.map((option) => option.value),
    ["current", "top1", "top2", "top3", "top4", "top5", "top6", "top7", "top8"]);
  assert.deepEqual(saved(socket), []);
  assert.deepEqual(requests(socket), []);
});
