const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PI = path.resolve(__dirname, "../com.yechan.threaddeck.sdPlugin/property-inspector");
const SCRIPT = fs.readFileSync(path.join(PI, "property-inspector.js"), "utf8");
const HTML = fs.readFileSync(path.join(PI, "index.html"), "utf8");
const TASK_ACTION = "com.yechan.threaddeck.thread1";
const COMMAND_ACTION = "com.yechan.threaddeck.newthread";
const NAVIGATION_ACTION = "com.yechan.threaddeck.page.previous";
const FIRST_ID = "01a07bb7-4397-7393-b9ca-75e7bb1cd1ad";
const SECOND_ID = "01a07bb7-4397-7393-b9ca-75e7bb1cd1ae";

class FakeElement {
  constructor(tagName = "div", dataset = {}) {
    Object.assign(this, { tagName, dataset, attributes: {}, hidden: false, disabled: false,
      listeners: new Map(), textContent: "", children: [], selectedValue: "" });
  }
  get value() { return this.selectedValue; }
  set value(value) {
    this.selectedValue = this.tagName !== "select" || this.children.some((option) => option.value === value) ? value : "";
  }
  set innerHTML(value) { throw new Error(`Unsafe HTML assignment: ${value}`); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  emit(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) {
    this.children.push(child);
    if (this.children.length === 1) this.value = child.value;
  }
  replaceChildren() { this.children = []; this.selectedValue = ""; }
}

function createInspector(locale = "en-US") {
  const elements = new Map();
  const labels = new Map();
  const copies = [];
  for (const [, tag, attributes, id] of HTML.matchAll(/<([a-z-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const dataset = Object.fromEntries([...attributes.matchAll(/data-([a-z]+)="([^"]+)"/g)].map((match) => [match[1], match[2]]));
    const element = new FakeElement(tag, dataset);
    element.hidden = /\bhidden\b/.test(attributes);
    element.disabled = /\bdisabled\b/.test(attributes);
    elements.set(id, element);
    if (dataset.copy) copies.push(element);
  }
  for (const [, id, content] of HTML.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const [, value, attributes, title] of content.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)) {
      const copy = /data-copy="([^"]+)"/.exec(attributes)?.[1];
      const option = new FakeElement("option", copy ? { copy } : {});
      option.value = value;
      option.textContent = title;
      elements.get(id).appendChild(option);
      if (copy) copies.push(option);
    }
  }
  // Include localized text outside controls, such as the document title and help.
  for (const [, key] of HTML.matchAll(/data-copy="([^"]+)"/g)) {
    if (!copies.some((element) => element.dataset.copy === key)) copies.push(new FakeElement("span", { copy: key }));
  }
  for (const [, id, attributes] of HTML.matchAll(/<label for="([^"]+)"([^>]*)>/g)) {
    const copy = /data-copy="([^"]+)"/.exec(attributes)?.[1];
    const label = new FakeElement("label", copy ? { copy } : {});
    labels.set(id, label);
    if (copy) copies.push(label);
  }
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  class FakeWebSocket extends FakeElement {
    static OPEN = 1;
    constructor(url) {
      super();
      Object.assign(this, { url, readyState: 0, sent: [] });
      sockets.push(this);
    }
    send(message) { assert.equal(this.readyState, FakeWebSocket.OPEN); this.sent.push(JSON.parse(message)); }
    open() { this.readyState = FakeWebSocket.OPEN; this.emit("open"); }
    close() { this.readyState = 3; this.emit("close"); }
    receive(message) { this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) }); }
  }
  const sandbox = {
    WebSocket: FakeWebSocket, navigator: { language: locale },
    document: {
      documentElement: { lang: "" },
      createElement(tag) { return new FakeElement(tag); },
      getElementById(id) { return elements.get(id) ?? null; },
      querySelector(selector) {
        const label = /^label\[for="([^"]+)"\]$/.exec(selector);
        if (label) return labels.get(label[1]);
        const option = /^option\[value="(top[1-8])"\]$/.exec(selector);
        return option ? elements.get("task-source").children.find((item) => item.value === option[1]) : null;
      },
      querySelectorAll(selector) {
        if (selector === "select[data-setting]") return [...elements.values()].filter((element) => element.dataset.setting);
        return selector === "[data-copy]" ? copies : [];
      }
    },
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SCRIPT, sandbox, { filename: "property-inspector.js" });
  function connect(settings = {}, action = TASK_ACTION, context = "task-context", info = {}) {
    sandbox.connectElgatoStreamDeckSocket("28196", context, "registerPropertyInspector", info, { action, payload: { settings } });
    return sockets.at(-1);
  }
  function change(id, value) { const select = elements.get(id); select.value = value; select.emit("change"); }
  function catalog(socket, tasks, available = true, context = "task-context") {
    socket.receive({ event: "sendToPropertyInspector", context, payload: { event: "task-catalog", tasks, available } });
  }
  return { connect, change, catalog, elements, sockets, sandbox, timers, labels, copies };
}
function saved(socket) { return socket.sent.filter((message) => message.event === "setSettings"); }
function requests(socket) { return socket.sent.filter((message) => message.event === "sendToPlugin"); }

test("host routes inspector-session commands to the action and returns action-instance replies", () => {
  const ui = createInspector();
  ui.sandbox.connectElgatoStreamDeckSocket("28196", "inspector-session", "registerPropertyInspector", {}, {
    action: TASK_ACTION, context: "task-instance", payload: { settings: { taskSource: "fixed" } }
  });
  const socket = ui.sockets.at(-1);
  socket.open();
  assert.deepEqual(socket.sent[0], { event: "registerPropertyInspector", uuid: "inspector-session" });
  // Stream Deck 7.7 rejects UI commands using actionInfo.context with
  // 'Received messageType ... from the wrong context'. It validates the
  // inspector session first and then forwards the request to the action.
  assert.equal(requests(socket)[0].context, "inspector-session");
  ui.catalog(socket, [{ id: FIRST_ID, title: "Assigned task" }], true, "task-instance");
  assert.equal(ui.elements.get("fixed-task").disabled, false);
  ui.change("fixed-task", FIRST_ID);
  assert.equal(saved(socket).at(-1).context, "inspector-session");
  assert.equal(saved(socket).at(-1).payload.fixedTaskId, FIRST_ID);
  socket.receive({ event: "didReceiveSettings", action: TASK_ACTION, context: "task-instance",
    payload: { settings: { taskSource: "top2" } } });
  assert.equal(ui.elements.get("task-source").value, "top2");
  socket.receive({ event: "didReceiveSettings", action: TASK_ACTION, context: "other-instance",
    payload: { settings: { taskSource: "current" } } });
  assert.equal(ui.elements.get("task-source").value, "top2");
  socket.receive({ event: "didReceiveSettings", action: TASK_ACTION, context: "inspector-session",
    payload: { settings: { taskSource: "top3" } } });
  assert.equal(ui.elements.get("task-source").value, "top3");
});

test("legacy task settings initialize without writes and preserve existing selection behavior", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "top3", customSetting: true });
  assert.equal(typeof ui.sandbox.connectElgatoStreamDeckSocket, "function");
  assert.equal(ui.elements.get("settings").attributes["aria-busy"], "false");
  assert.equal(ui.elements.get("settings-loading").hidden, true);
  assert.equal(ui.elements.get("task-settings").hidden, false);
  assert.equal(ui.elements.get("command-settings").hidden, true);
  assert.equal(ui.elements.get("task-source").value, "top3");
  assert.equal(ui.elements.get("fixed-task").hidden, true);
  socket.open();
  assert.deepEqual(socket.sent[0], { event: "registerPropertyInspector", uuid: "task-context" });
  assert.deepEqual(requests(socket), [{ event: "sendToPlugin", action: TASK_ACTION,
    context: "task-context", payload: { event: "get-task-catalog" } }]);
  assert.deepEqual(saved(socket), []);
  ui.change("task-source", "top4");
  assert.deepEqual(saved(socket)[0].payload, { taskSource: "top4", customSetting: true });
  ui.change("task-source", "current");
  assert.equal(ui.elements.get("fixed-task").hidden, true);
});

test("async catalogue never assigns the first task, and explicit selection saves UUID and title", () => {
  const ui = createInspector();
  const socket = ui.connect();
  socket.open();
  ui.change("task-source", "fixed");
  assert.equal(requests(socket).length, 2);
  assert.equal(ui.elements.get("fixed-task").hidden, false);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  assert.match(ui.elements.get("fixed-task-status").textContent, /Loading/);
  ui.catalog(socket, [{ id: FIRST_ID, title: "First" }, { id: SECOND_ID, title: "Second", remote: true }]);
  assert.equal(ui.elements.get("fixed-task").disabled, false);
  assert.equal(ui.elements.get("fixed-task").value, "");
  assert.equal(saved(socket).length, 1);
  ui.change("fixed-task", SECOND_ID);
  assert.deepEqual(saved(socket).at(-1).payload, { taskSource: "fixed", fixedTaskId: SECOND_ID, fixedTaskTitle: "Second" });
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  assert.equal(ui.elements.get("fixed-task").children.at(-1).textContent, "Second (remote)");
});

test("saved UUID survives reordered and renamed catalogues and source changes without incidental writes", () => {
  const ui = createInspector();
  const settings = { taskSource: "fixed", fixedTaskId: SECOND_ID, fixedTaskTitle: "Old title" };
  const socket = ui.connect(settings);
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  socket.open();
  ui.catalog(socket, [{ id: FIRST_ID, title: "Other" }, { id: SECOND_ID, title: "New title" }]);
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  assert.equal(ui.elements.get("fixed-task").children.at(-1).textContent, "New title");
  ui.catalog(socket, [{ id: SECOND_ID, title: "Renamed again" }, { id: FIRST_ID, title: "Other" }]);
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  assert.deepEqual(saved(socket), []);
  ui.change("task-source", "top1");
  assert.deepEqual(saved(socket).at(-1).payload, { ...settings, taskSource: "top1" });
  ui.change("task-source", "fixed");
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
});

test("missing saved task stays selected with an unavailable label until explicitly replaced", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed", fixedTaskId: FIRST_ID, fixedTaskTitle: "Saved task" });
  socket.open();
  ui.catalog(socket, [{ id: SECOND_ID, title: "Other task" }]);
  const picker = ui.elements.get("fixed-task");
  assert.equal(picker.value, FIRST_ID);
  assert.equal(picker.children[1].textContent, "Saved task (unavailable)");
  assert.equal(picker.children[1].disabled, true);
  assert.match(ui.elements.get("fixed-task-status").textContent, /saved task is unavailable/);
  assert.deepEqual(saved(socket), []);
  ui.change("fixed-task", FIRST_ID);
  assert.deepEqual(saved(socket), []);
  ui.change("fixed-task", SECOND_ID);
  assert.deepEqual(saved(socket).at(-1).payload, { taskSource: "fixed", fixedTaskId: SECOND_ID, fixedTaskTitle: "Other task" });
});

test("absent, failed and empty catalogues preserve the saved assignment", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed", fixedTaskId: FIRST_ID, fixedTaskTitle: "Saved" });
  socket.open();
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  ui.catalog(socket, [{ id: SECOND_ID, title: "Ignored on failure" }], false);
  assert.equal(ui.elements.get("fixed-task").value, FIRST_ID);
  assert.match(ui.elements.get("fixed-task-status").textContent, /list is unavailable/);
  assert.equal(ui.elements.get("fixed-task").children.length, 2);
  ui.catalog(socket, []);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  assert.equal(ui.elements.get("fixed-task").value, FIRST_ID);
  assert.equal(ui.elements.get("fixed-task").children[1].textContent, "Saved (unavailable)");
  assert.deepEqual(saved(socket), []);
  const empty = createInspector();
  const emptySocket = empty.connect({ taskSource: "fixed" });
  emptySocket.open();
  empty.catalog(emptySocket, []);
  assert.equal(empty.elements.get("fixed-task").value, "");
  assert.equal(empty.elements.get("fixed-task-status").textContent, "No tasks available.");
});

test("catalogue titles are text and invalid or duplicate UUIDs are discarded", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed", fixedTaskId: "not-a-uuid" });
  socket.open();
  const title = '<img src=x onerror="globalThis.compromised = true"> & <script>bad()</script>';
  ui.catalog(socket, [
    { id: FIRST_ID.toUpperCase(), title }, { id: FIRST_ID, title: "Duplicate" },
    { id: "provisional:123", title: "Provisional" }, { id: `${SECOND_ID}extra`, title: "Invalid" },
    { id: SECOND_ID, title: {}, remote: true }, null, "invalid"
  ]);
  const options = ui.elements.get("fixed-task").children;
  assert.equal(options.length, 3);
  assert.equal(options[1].value, FIRST_ID);
  assert.equal(options[1].textContent, title);
  assert.equal(options[2].textContent, `${SECOND_ID} (remote)`);
  assert.equal(ui.elements.get("fixed-task").value, "");
  assert.equal(ui.sandbox.compromised, undefined);
  ui.change("fixed-task", "provisional:123");
  assert.deepEqual(saved(socket), []);
  ui.change("fixed-task", FIRST_ID);
  assert.equal(saved(socket)[0].payload.fixedTaskTitle, title);
});

test("host messages must match the active context, action and catalogue event", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed" });
  socket.open();
  const payload = { event: "task-catalog", available: true, tasks: [{ id: FIRST_ID, title: "Wrong" }] };
  socket.receive({ event: "sendToPropertyInspector", context: "other-context", payload });
  socket.receive({ event: "sendToPropertyInspector", payload });
  socket.receive({ event: "sendToPropertyInspector", context: "task-context", action: COMMAND_ACTION, payload });
  socket.receive({ event: "other", context: "task-context", payload });
  socket.receive({ event: "sendToPropertyInspector", context: "task-context", payload: { ...payload, event: "other" } });
  for (const data of ["not json", "null", "[]"]) socket.receive(data);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  assert.equal(ui.elements.get("fixed-task").children.length, 1);
  ui.catalog(socket, payload.tasks);
  assert.equal(ui.elements.get("fixed-task").disabled, false);
  assert.deepEqual(saved(socket), []);
});

test("failed refresh disables cached choices and a fresh deletion never retargets the saved task", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed", fixedTaskId: FIRST_ID, fixedTaskTitle: "Saved" });
  socket.open();
  ui.catalog(socket, [{ id: FIRST_ID, title: "Saved" }, { id: SECOND_ID, title: "Other" }]);
  ui.catalog(socket, [], false);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  ui.change("fixed-task", SECOND_ID);
  assert.deepEqual(saved(socket), []);
  ui.catalog(socket, [{ id: SECOND_ID, title: "Other" }]);
  assert.equal(ui.elements.get("fixed-task").disabled, false);
  assert.equal(ui.elements.get("fixed-task").value, FIRST_ID);
  assert.equal(ui.elements.get("fixed-task").children[1].textContent, "Saved (unavailable)");
  assert.deepEqual(saved(socket), []);
});

test("fresh settings update controls and saved identity before a delayed catalogue", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "top1" });
  socket.open();
  const payload = { settings: { taskSource: "fixed", fixedTaskId: SECOND_ID, fixedTaskTitle: "Selected elsewhere" } };
  socket.receive({ event: "didReceiveSettings", context: "other-context", payload });
  assert.equal(ui.elements.get("task-source").value, "top1");
  socket.receive({ event: "didReceiveSettings", context: "task-context", payload });
  assert.equal(ui.elements.get("task-source").value, "fixed");
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  assert.equal(requests(socket).length, 2);
  ui.catalog(socket, [{ id: FIRST_ID, title: "Earlier" }, { id: SECOND_ID, title: "Fresh" }]);
  assert.equal(ui.elements.get("fixed-task").value, SECOND_ID);
  assert.deepEqual(saved(socket), []);
  socket.receive({ event: "didReceiveSettings", context: "task-context", payload: { settings: { taskSource: "top2" } } });
  assert.equal(ui.elements.get("task-source").value, "top2");
  assert.equal(ui.elements.get("fixed-task").hidden, true);
});

test("reconnect registers again, flushes queued edits, and refreshes the catalogue", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "top1" });
  socket.open();
  ui.catalog(socket, [{ id: FIRST_ID, title: "Task" }]);
  socket.close();
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  ui.change("task-source", "fixed");
  const reconnect = [...ui.timers.values()].find((timer) => timer.delay === 500);
  assert.ok(reconnect);
  reconnect.callback();
  const nextSocket = ui.sockets.at(-1);
  assert.notEqual(nextSocket, socket);
  nextSocket.receive({ event: "didReceiveSettings", context: "task-context", payload: { settings: { taskSource: "current" } } });
  assert.equal(ui.elements.get("task-source").value, "fixed");
  nextSocket.open();
  assert.deepEqual(nextSocket.sent, [
    { event: "registerPropertyInspector", uuid: "task-context" },
    { event: "setSettings", context: "task-context", payload: { taskSource: "fixed" } },
    { event: "sendToPlugin", action: TASK_ACTION, context: "task-context", payload: { event: "get-task-catalog" } }
  ]);
  ui.catalog(socket, [{ id: SECOND_ID, title: "Stale old socket" }]);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
  ui.catalog(nextSocket, [{ id: FIRST_ID, title: "Fresh task" }]);
  assert.equal(ui.elements.get("fixed-task").disabled, false);
});

test("reinitialization avoids duplicate autosaves and stale socket updates", () => {
  const ui = createInspector();
  const oldSocket = ui.connect({ taskSource: "fixed" });
  oldSocket.open();
  const socket = ui.connect({ currentPage: 0 }, NAVIGATION_ACTION, "navigation-context");
  socket.open();
  ui.catalog(oldSocket, [{ id: FIRST_ID, title: "Stale" }]);
  assert.equal(ui.elements.get("task-settings").hidden, true);
  assert.equal(ui.elements.get("navigation-settings").hidden, false);
  assert.equal(ui.elements.get("page-direction").value, "previous");
  ui.change("page-direction", "next");
  assert.deepEqual(saved(socket), [{ event: "setSettings", context: "navigation-context", payload: { currentPage: 0, pageDirection: "next" } }]);
  assert.deepEqual(requests(socket), []);
  assert.equal(oldSocket.readyState, 3);
});

test("socket error schedules one reconnect and edits before opening are saved", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "top1" });
  ui.change("task-source", "top2");
  assert.deepEqual(saved(socket), []);
  socket.open();
  assert.deepEqual(saved(socket)[0].payload, { taskSource: "top2" });
  socket.emit("error");
  socket.emit("error");
  assert.equal([...ui.timers.values()].filter((timer) => timer.delay === 500).length, 1);
  assert.equal(ui.elements.get("fixed-task").disabled, true);
});


test("same-title tasks have distinct choices and persist only the explicitly selected UUID", () => {
  const ui = createInspector();
  const socket = ui.connect({ taskSource: "fixed" });
  socket.open();
  ui.catalog(socket, [{ id: FIRST_ID, title: "Same title" }, { id: SECOND_ID, title: "Same title" }]);
  const picker = ui.elements.get("fixed-task");
  assert.deepEqual(picker.children.slice(1).map((option) => option.value), [FIRST_ID, SECOND_ID]);
  assert.notEqual(picker.children[1].textContent, picker.children[2].textContent);
  assert.equal(picker.value, "");
  ui.change("fixed-task", SECOND_ID);
  assert.deepEqual(saved(socket).at(-1).payload, {
    taskSource: "fixed", fixedTaskId: SECOND_ID, fixedTaskTitle: "Same title"
  });
  ui.catalog(socket, [{ id: SECOND_ID, title: "Same title" }, { id: FIRST_ID, title: "Same title" }]);
  assert.equal(picker.value, SECOND_ID);
  assert.equal(saved(socket).length, 1);
});

test("malformed settings cannot erase the saved task assignment", () => {
  const ui = createInspector();
  const settings = { taskSource: "fixed", fixedTaskId: FIRST_ID, fixedTaskTitle: "Saved" };
  const socket = ui.connect(settings);
  socket.open();
  for (const payload of [{}, null, { settings: null }, { settings: "{broken" }, { settings: [] }]) {
    socket.receive({ event: "didReceiveSettings", context: "task-context", payload });
    assert.equal(ui.elements.get("fixed-task").value, FIRST_ID);
    assert.equal(ui.elements.get("task-source").value, "fixed");
  }
  ui.change("task-source", "top2");
  assert.deepEqual(saved(socket).at(-1).payload, { ...settings, taskSource: "top2" });
});

test("replacing the inspector session cancels queued edits, reconnect callbacks and old opens", () => {
  const ui = createInspector();
  const oldSocket = ui.connect({ taskSource: "top1" });
  oldSocket.open();
  oldSocket.close();
  ui.change("task-source", "fixed");
  const reconnect = [...ui.timers.values()].find((timer) => timer.delay === 500);
  assert.ok(reconnect);
  const nextSocket = ui.connect({ taskSource: "top4" }, TASK_ACTION, "new-session");
  assert.equal(ui.timers.size, 0);
  reconnect.callback();
  oldSocket.open();
  oldSocket.receive({ event: "didReceiveSettings", context: "new-session", payload: {
    settings: { taskSource: "fixed", fixedTaskId: FIRST_ID }
  } });
  assert.equal(ui.sockets.length, 2);
  nextSocket.open();
  assert.equal(ui.elements.get("task-source").value, "top4");
  assert.deepEqual(saved(nextSocket), []);
  assert.equal(requests(nextSocket)[0].context, "new-session");
});

test("command settings preserve existing choices, help and unrelated saved values", () => {
  const ui = createInspector();
  const socket = ui.connect({ command: "send", customSetting: true }, COMMAND_ACTION, "command-context");
  socket.open();
  assert.equal(ui.elements.get("command-settings").hidden, false);
  assert.equal(ui.elements.get("task-settings").hidden, true);
  assert.equal(ui.elements.get("navigation-settings").hidden, true);
  assert.equal(ui.elements.get("command").value, "send");
  assert.deepEqual(ui.elements.get("command").children.map((option) => option.value), ["new-task", "side-chat", "send"]);
  assert.match(ui.copies.find((element) => element.dataset.copy === "commandHelp").textContent, /Command\+Return/);
  assert.deepEqual(requests(socket), []);
  ui.change("command", "side-chat");
  assert.deepEqual(saved(socket), [{ event: "setSettings", context: "command-context", payload: {
    command: "side-chat", customSetting: true
  } }]);
});

test("host language relocalizes existing controls and fixed-task states in English, Korean and Russian", () => {
  const ui = createInspector("ru-RU");
  const locales = [
    { locale: "ko_KR", language: "ko", title: "ThreadDeck 설정", slot: "상위 작업 1", fixed: "고정 작업", help: "도움말",
      loading: "작업을 불러오는 중…", unavailable: "사용 불가", remote: "원격", saved: "저장됨", empty: "선택할 수 있는 작업이 없습니다.", failed: "작업 목록을 불러올 수 없습니다." },
    { locale: "ru-RU", language: "ru", title: "Настройки ThreadDeck", slot: "Задача 1 в списке", fixed: "Закреплённая задача", help: "Справка",
      loading: "Загрузка задач…", unavailable: "недоступна", remote: "удалённая", saved: "Сохранено", empty: "Нет доступных задач.", failed: "Список задач недоступен." },
    { locale: "en-US", language: "en", title: "ThreadDeck settings", slot: "Top task 1", fixed: "Fixed task", help: "Help",
      loading: "Loading tasks…", unavailable: "unavailable", remote: "remote", saved: "Saved", empty: "No tasks available.", failed: "The task list is unavailable." }
  ];
  for (const copy of locales) {
    const settings = { taskSource: "fixed", fixedTaskId: FIRST_ID, fixedTaskTitle: "Saved", custom: true };
    const socket = ui.connect(settings, TASK_ACTION, "task-context", JSON.stringify({ application: { language: copy.locale } }));
    const label = (key) => ui.copies.find((element) => element.dataset.copy === key).textContent;
    assert.equal(ui.sandbox.document.documentElement.lang, copy.language);
    assert.equal(label("title"), copy.title);
    assert.equal(label("help"), copy.help);
    assert.equal(label("fixedTask"), copy.fixed);
    assert.equal(ui.elements.get("task-source").children.find((option) => option.value === "top1").textContent, copy.slot);
    assert.equal(ui.elements.get("fixed-task-status").textContent, copy.loading);
    socket.open();
    assert.deepEqual(saved(socket), []);
    ui.catalog(socket, [{ id: SECOND_ID, title: "Other", remote: true }]);
    assert.equal(ui.elements.get("fixed-task").children[1].textContent, `Saved (${copy.unavailable})`);
    assert.equal(ui.elements.get("fixed-task").children[2].textContent, `Other (${copy.remote})`);
    ui.catalog(socket, [], false);
    assert.ok(ui.elements.get("fixed-task-status").textContent.startsWith(copy.failed));
    ui.change("task-source", "top8");
    assert.deepEqual(saved(socket).at(-1).payload, { ...settings, taskSource: "top8" });
    assert.equal(ui.elements.get("save-status").textContent, copy.saved);
    socket.receive({ event: "didReceiveSettings", context: "task-context", payload: { settings: { taskSource: "fixed" } } });
    ui.catalog(socket, []);
    assert.equal(ui.elements.get("fixed-task-status").textContent, copy.empty);
  }
});

test("navigator language is the fallback only when the host language is missing", () => {
  for (const info of [{}, "{broken", null, { application: { language: "  " } }]) {
    const ui = createInspector("ru-RU");
    assert.equal(ui.copies.find((element) => element.dataset.copy === "loading").textContent, "Загрузка настроек…");
    ui.connect({}, TASK_ACTION, "task-context", info);
    assert.equal(ui.sandbox.document.documentElement.lang, "ru");
    assert.equal(ui.copies.find((element) => element.dataset.copy === "help").textContent, "Справка");
  }
  const ui = createInspector("ru-RU");
  ui.connect({}, TASK_ACTION, "task-context", { application: { language: "ja" } });
  assert.equal(ui.sandbox.document.documentElement.lang, "en");
  assert.equal(ui.copies.find((element) => element.dataset.copy === "help").textContent, "Help");
});
