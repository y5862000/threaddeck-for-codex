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
    ["task-source", new FakeElement({ setting: "taskSource" })],
    ["command", new FakeElement({ setting: "command" })],
    ["page-direction", new FakeElement({ setting: "pageDirection" })],
    ["save-status", new FakeElement()]
  ]);
  const optionElements = new Map();
  const html = fs.readFileSync(path.join(ROOT, "com.yechan.threaddeck.sdPlugin/property-inspector/index.html"), "utf8");
  const localizedElements = new Map([...html.matchAll(/data-copy="([^"]+)"/g)]
    .map((match) => [match[1], new FakeElement({ copy: match[1] })]));
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
        if (selector === "[data-copy]") return [...localizedElements.values()];
        if (selector === "select[data-setting]") {
          return [
            elements.get("task-source"),
            elements.get("command"),
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
