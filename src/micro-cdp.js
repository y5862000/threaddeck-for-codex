"use strict";

/*
 * The loopback CDP target selection and Codex Micro renderer-bridge approach
 * are adapted in part from dazer1234/codex-stream-deck,
 * Copyright (c) 2026 Dazer, under the MIT License. The complete upstream
 * notice ships in licenses/codex-deck-MIT.txt and reference/codex-deck/.
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "ThreadDeck",
  "codex-micro-bridge.json"
);
const DEVICE_STATE = Object.freeze({
  type: "codex-micro-device-state-changed",
  state: {
    status: "connected",
    error: null,
    battery: { percentage: 100, isCharging: true }
  }
});
const MICRO_FEATURE_GATE = "3207467860";
const REASONING_ENCODER_KEYS = Object.freeze({
  decrease: "ENC_CW",
  increase: "ENC_CC"
});
const OFFICIAL_KEYCAP_IDS = new Set([
  "FAST",
  "PARTY",
  "CODEX",
  "NEW",
  "MIND+",
  "MIND-"
]);

class MicroBridgeError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "MicroBridgeError";
    this.code = options.code ?? "MICRO_ERROR";
    this.delivery = options.delivery ?? "none";
  }
}

function microUnavailable(message, cause = null) {
  return new MicroBridgeError(message, {
    code: "MICRO_UNAVAILABLE",
    delivery: "none",
    cause
  });
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function isLoopbackWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return ["ws:", "wss:"].includes(url.protocol) && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function selectCodexMainTarget(targets) {
  const candidates = (Array.isArray(targets) ? targets : []).filter((target) => (
    target?.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && isLoopbackWebSocketUrl(target.webSocketDebuggerUrl)
      && typeof target.url === "string"
      && target.url.startsWith("app://")
  ));
  const isIndexDocument = (target) => {
    try {
      return new URL(target.url).pathname === "/index.html";
    } catch {
      return false;
    }
  };
  const isAuxiliarySurface = (target) => /avatar-overlay|composition-surface/i.test(target.url);
  return candidates.find((target) => isIndexDocument(target) && !new URL(target.url).search)
    ?? candidates.find(isIndexDocument)
    ?? candidates.find((target) => !isAuxiliarySurface(target) && !target.url.includes("initialRoute="))
    ?? candidates.find((target) => !isAuxiliarySurface(target));
}

function parseDebugPortFromCommand(command) {
  const text = String(command ?? "");
  if (!/(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(text)) {
    return null;
  }
  const value = Number.parseInt(
    text.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/)?.[1] ?? "",
    10
  );
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

function normalizeMicroSlot(slot, index) {
  if (!slot || typeof slot !== "object") return null;
  const id = Number.isInteger(slot.id) ? slot.id : index;
  if (!Number.isInteger(id) || id < 0 || id > 5) return null;
  const threadKey = typeof slot.threadKey === "string" && slot.threadKey.trim()
    ? slot.threadKey.trim()
    : null;
  return {
    id,
    threadKey,
    title: typeof slot.title === "string" ? slot.title : null,
    status: typeof slot.status === "string" ? slot.status : null,
    selected: slot.selected === true,
    activityAt: Number.isFinite(slot.activityAt) ? slot.activityAt : null
  };
}

function normalizeMicroSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  return {
    connected: snapshot.connected === true,
    activeThreadKey: typeof snapshot.activeThreadKey === "string" && snapshot.activeThreadKey
      ? snapshot.activeThreadKey
      : null,
    reasoningEffort: typeof snapshot.reasoningEffort === "string" && snapshot.reasoningEffort
      ? snapshot.reasoningEffort.toLowerCase()
      : null,
    fastEnabled: typeof snapshot.fastEnabled === "boolean" ? snapshot.fastEnabled : null,
    theme: snapshot.theme === "light" ? "light" : snapshot.theme === "dark" ? "dark" : null,
    slots: (Array.isArray(snapshot.slots) ? snapshot.slots : [])
      .map(normalizeMicroSlot)
      .filter(Boolean),
    capabilities: {
      command: snapshot.capabilities?.command === true,
      hostMessage: snapshot.capabilities?.hostMessage === true,
      hid: snapshot.capabilities?.hid === true,
      slots: snapshot.capabilities?.slots === true
    }
  };
}

function retainEvaluationPromise(expression, id) {
  const key = `threaddeck-${id}`;
  return `(() => {
    const store = globalThis.__threadDeckPendingEvaluations ??= new Map();
    const pending = Promise.resolve((${expression}));
    store.set(${JSON.stringify(key)}, pending);
    setTimeout(() => store.delete(${JSON.stringify(key)}), 10000);
    return pending;
  })()`;
}

const ASSET_URLS_SOURCE = `
  const urls = [...new Set([
    ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
    ...performance.getEntriesByType('resource').map((entry) => entry.name)
  ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
`;

const FIND_BUS_SOURCE = `
  let bus = null;
  const preferredBusUrls = [
    ...urls.filter((url) => url.includes('/assets/vscode-api-')),
    ...urls.filter((url) => url.includes('/assets/codex-micro-bridge-')),
    ...urls.filter((url) => url.includes('/assets/codex-micro-'))
  ];
  for (const url of [...new Set(preferredBusUrls)]) {
    try {
      const namespace = await import(url);
      bus = Object.values(namespace).find((candidate) => candidate && typeof candidate === 'object' && candidate.handlers instanceof Map && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
      if (bus) break;
    } catch {}
  }
  if (!bus) {
    const bridgeUrl = urls.find((url) => url.includes('/assets/codex-micro-bridge-'));
    if (bridgeUrl) {
      try {
        const bridgeSource = await (await fetch(bridgeUrl)).text();
        const busLocal = bridgeSource.match(/([A-Za-z_$][\\w$]*)\\.dispatchHostMessage/)?.[1] ?? null;
        const importPattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
        let importMatch;
        while (busLocal && (importMatch = importPattern.exec(bridgeSource))) {
          for (const specifier of importMatch[1].split(',')) {
            const parts = specifier.trim().split(/\\s+as\\s+/);
            const exportName = parts[0];
            const localName = parts[1] ?? parts[0];
            if (localName !== busLocal) continue;
            const namespace = await import(new URL(importMatch[2], bridgeUrl).href);
            const candidate = namespace[exportName];
            if (candidate && typeof candidate === 'object' && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')) bus = candidate;
            break;
          }
          if (bus) break;
        }
      } catch {}
    }
  }
`;
const REFIND_BUS_SOURCE = FIND_BUS_SOURCE.replace("  let bus = null;\n", "");

const READ_ONLY_SNAPSHOT_EXPRESSION = `(async () => {
  ${ASSET_URLS_SOURCE}
  ${FIND_BUS_SOURCE}
  const visible = (element) => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
  const composerRoots = [...document.querySelectorAll('[data-codex-composer-root]')].filter(visible);
  const focusedRoot = document.activeElement?.closest?.('[data-codex-composer-root]');
  const activeComposerRoot = focusedRoot && visible(focusedRoot)
    ? focusedRoot
    : [...composerRoots].sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)[0] ?? null;
  const intelligenceTrigger = activeComposerRoot?.querySelector('[data-codex-intelligence-trigger]')
    ?? [...document.querySelectorAll('[data-codex-intelligence-trigger]')].find(visible)
    ?? null;
  const reasoningEffort = intelligenceTrigger?.getAttribute('data-selected-reasoning-effort') ?? null;
  // The closed composer trigger reserves its compact leading indicator only
  // for a selected fast service tier. While the picker is open the same span
  // is reserved for width measurement, so that transient state is unknown.
  const fastEnabled = intelligenceTrigger?.getAttribute('data-state') === 'closed'
    ? intelligenceTrigger.querySelector('[data-reserved]') != null
    : null;
  const activeThreadKey = activeComposerRoot?.closest('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id')
    ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id')
    ?? document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id')
    ?? null;

  let slots = [];
  const slotSignalsUrl = urls.find((url) => url.includes('/assets/codex-micro-slot-signals-'));
  if (slotSignalsUrl) {
    try {
      const root = document.getElementById('root');
      const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
      const slotSignals = await import(slotSignalsUrl);
      const resolvers = Object.values(slotSignals).filter((candidate) => candidate && typeof candidate === 'object' && typeof candidate.resolve === 'function' && typeof candidate.createSubscriberAtom === 'function');
      if (root && reactKey && resolvers.length > 0) {
        const queue = [root[reactKey]];
        const seen = new Set();
        let found = null;
        while (queue.length && seen.size < 30000 && !found) {
          const fiber = queue.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          const maps = [];
          if (fiber.memoizedProps?.value instanceof Map) maps.push(fiber.memoizedProps.value);
          let dependency = fiber.dependencies?.firstContext;
          while (dependency) {
            if (dependency.memoizedValue instanceof Map) maps.push(dependency.memoizedValue);
            dependency = dependency.next;
          }
          for (const chain of maps) {
            for (const node of chain.values()) {
              if (!node?.store || typeof node.store.get !== 'function') continue;
              for (const resolver of resolvers) {
                try {
                  const atom = resolver.resolve(node, chain);
                  const candidateSlots = node.store.get(atom);
                  if (Array.isArray(candidateSlots) && candidateSlots.length === 6 && candidateSlots.every((slot, index) => slot?.id === index)) {
                    found = candidateSlots;
                    break;
                  }
                } catch {}
              }
              if (found) break;
            }
            if (found) break;
          }
          queue.push(fiber.child, fiber.sibling);
        }
        if (found) {
          const toEpoch = (input) => {
            if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input < 100000000000 ? input * 1000 : input;
            if (typeof input === 'string') {
              const parsed = Date.parse(input);
              if (Number.isFinite(parsed)) return parsed;
            }
            return null;
          };
          slots = found.map((slot) => ({
            id: slot.id,
            threadKey: slot.threadKey ?? null,
            title: slot.title ?? null,
            status: slot.status ?? null,
            selected: slot.selected === true,
            activityAt: toEpoch(slot.activityAt) ?? toEpoch(slot.updatedAt) ?? toEpoch(slot.lastActivityAt) ?? null
          }));
        }
      }
    } catch {}
  }

  const html = document.documentElement;
  const body = document.body;
  const themeWords = [html.dataset.theme, html.dataset.colorScheme, html.className, body?.dataset?.theme, body?.className, getComputedStyle(html).colorScheme].filter(Boolean).join(' ').toLowerCase();
  const theme = /(^|[\\s_-])dark($|[\\s_-])/.test(themeWords)
    ? 'dark'
    : /(^|[\\s_-])light($|[\\s_-])/.test(themeWords)
      ? 'light'
      : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const hidHandlers = bus?.handlers?.get?.('codex-micro-hid-event')?.size ?? 0;
  return {
    connected: true,
    activeThreadKey,
    reasoningEffort,
    fastEnabled,
    theme,
    slots,
    capabilities: {
      command: urls.some((url) => url.includes('/assets/codex-micro-layout-')),
      hostMessage: typeof bus?.dispatchHostMessage === 'function',
      hid: hidHandlers > 0,
      slots: slots.length === 6
    }
  };
})()`;

// Codex keeps the Micro bridge behind a renderer feature gate. Discovery is
// deliberately read-only; this activation runs only immediately before an
// action that needs the native HID/PTT handlers. The override lives only in
// the current renderer process and is revalidated after every reconnect.
const ACTIVATE_RUNTIME_EXPRESSION = `(async () => {
  const gateName = ${JSON.stringify(MICRO_FEATURE_GATE)};
  const statsig = globalThis.__STATSIG__;
  if (!statsig) throw new Error('ThreadDeck: Codex Micro feature service is unavailable.');
  const clients = [...new Set([
    statsig.firstInstance,
    ...Object.values(statsig.instances ?? {})
  ].filter(Boolean))];
  if (clients.length === 0) throw new Error('ThreadDeck: Codex Micro feature client is unavailable.');
  for (const client of clients) {
    if (client.overrideAdapter?.__threadDeckMicroGate !== gateName) {
      const original = client.overrideAdapter ?? {};
      client.overrideAdapter = new Proxy(original, {
        get(target, property) {
          if (property === '__threadDeckMicroGate') return gateName;
          if (property === 'getGateOverride') {
            return (gate, user, options) => {
              if (gate?.name === gateName) return { ...gate, value: true };
              const fallback = Reflect.get(target, property, target);
              return typeof fallback === 'function'
                ? fallback.call(target, gate, user, options)
                : gate;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
    client._memoCache = {};
    client.$emt?.({ name: 'values_updated' });
  }

  ${ASSET_URLS_SOURCE}
  ${FIND_BUS_SOURCE}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!bus) {
      ${REFIND_BUS_SOURCE}
    }
    const deviceHandlers = bus?.handlers?.get?.('codex-micro-device-state-changed')?.size ?? 0;
    if (deviceHandlers > 0) {
      const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
      dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
      const handlerDeadline = Date.now() + 1800;
      while (Date.now() < handlerDeadline) {
        const hidHandlers = bus?.handlers?.get?.('codex-micro-hid-event')?.size ?? 0;
        if (hidHandlers > 0) {
          return {
            ready: true,
            clients: clients.length,
            deviceHandlers,
            hidHandlers
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('ThreadDeck: Codex Micro HID runtime is unavailable.');
})()`;

function runKeycapExpression(keycapId) {
  return `(async () => {
    ${ASSET_URLS_SOURCE}
    const moduleUrl = (prefix) => urls.find((value) => value.includes('/assets/' + prefix));
    const layoutUrl = moduleUrl('codex-micro-layout-');
    const commandsUrl = moduleUrl('run-command-');
    const bridgeUrl = moduleUrl('codex-micro-bridge-');
    if (!layoutUrl) throw new Error('ThreadDeck: Codex Micro keycap registry is unavailable.');
    const layout = await import(layoutUrl);
    const keycapGetter = Object.values(layout).find((candidate) => {
      if (typeof candidate !== 'function') return false;
      try { return candidate('FAST')?.id === 'FAST'; } catch { return false; }
    });
    if (typeof keycapGetter !== 'function') throw new Error('ThreadDeck: Codex Micro keycap registry changed.');
    const action = keycapGetter(${JSON.stringify(keycapId)})?.action;
    if (action?.type !== 'command') throw new Error('ThreadDeck: selected Micro keycap has no command.');
    let commandRunner = null;
    if (commandsUrl) {
      const commands = await import(commandsUrl);
      commandRunner = Object.values(commands).find((candidate) => typeof candidate === 'function' && Function.prototype.toString.call(candidate).includes('codex_micro')) ?? commands.i ?? null;
    }
    if (!commandRunner && bridgeUrl) {
      const bridgeSource = await (await fetch(bridgeUrl)).text();
      const runnerMatch = bridgeSource.match(/([A-Za-z_$][\\w$]*)\\(\\s*[A-Za-z_$][\\w$]*\\??\\.command\\s*,["'\\x60]codex_micro_hid["'\\x60]\\)/);
      const runnerLocal = runnerMatch?.[1];
      const importPattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
      let importMatch;
      while (runnerLocal && (importMatch = importPattern.exec(bridgeSource))) {
        for (const specifier of importMatch[1].split(',')) {
          const parts = specifier.trim().split(/\\s+as\\s+/);
          const exportName = parts[0];
          const localName = parts[1] ?? parts[0];
          if (localName !== runnerLocal) continue;
          const namespace = await import(new URL(importMatch[2], bridgeUrl).href);
          if (typeof namespace[exportName] === 'function') commandRunner = namespace[exportName];
          break;
        }
        if (commandRunner) break;
      }
    }
    if (typeof commandRunner !== 'function') throw new Error('ThreadDeck: Codex command runner is unavailable.');
    const handled = commandRunner(action.command, 'codex_micro_hid');
    if (!handled) throw new Error('ThreadDeck: Codex command is not active in the current view.');
    return true;
  })()`;
}

function dispatchHostMessageExpression(type) {
  return `(async () => {
    ${ASSET_URLS_SOURCE}
    ${FIND_BUS_SOURCE}
    if (!bus || typeof bus.dispatchHostMessage !== 'function') throw new Error('ThreadDeck: Codex host-message bus is unavailable.');
    bus.dispatchHostMessage({ type: ${JSON.stringify(type)} });
    return true;
  })()`;
}

const ACTIVATE_HID_EXPRESSION = `(async () => {
  ${ASSET_URLS_SOURCE}
  ${FIND_BUS_SOURCE}
  if (!bus) throw new Error('ThreadDeck: Codex Micro event bus is unavailable.');
  const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
  if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) {
    dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
    const deadline = Date.now() + 1200;
    while ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) throw new Error('ThreadDeck: Codex Micro HID handler is unavailable.');
  return true;
})()`;

function dispatchHidExpression(event, options = {}) {
  const repeat = Math.max(1, Math.min(64, Math.trunc(options.repeat ?? 1)));
  const intervalMs = Math.max(0, Math.min(250, Math.trunc(options.intervalMs ?? 70)));
  const confirmUltra = options.confirmUltra === true;
  return `(async () => {
    ${ASSET_URLS_SOURCE}
    ${FIND_BUS_SOURCE}
    if (!bus) throw new Error('ThreadDeck: Codex Micro event bus is unavailable.');
    const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
    if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) {
      dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
      const deadline = Date.now() + 1200;
      while ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) throw new Error('ThreadDeck: Codex Micro HID handler is unavailable.');
    for (let index = 0; index < ${repeat}; index += 1) {
      dispatch.call(bus, { type: 'codex-micro-hid-event', event: ${JSON.stringify(event)} });
      if (index + 1 < ${repeat} && ${intervalMs} > 0) await new Promise((resolve) => setTimeout(resolve, ${intervalMs}));
    }
    let ultraConfirmed = false;
    if (${confirmUltra}) {
      const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const deadline = Date.now() + 900;
      while (Date.now() < deadline && !ultraConfirmed) {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')]
          .filter((dialog) => dialog.getClientRects().length > 0);
        for (const dialog of dialogs) {
          const text = normalize(dialog.innerText || dialog.textContent);
          const exactWarning = (
            (text.includes('use ultra with full access?')
              && text.includes('extended reasoning')
              && text.includes('without asking'))
            || (text.includes('ultra')
              && text.includes('전체 액세스')
              && text.includes('확장')
              && text.includes('묻지 않'))
          );
          if (!exactWarning) continue;
          const buttons = [...dialog.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0 && !button.disabled);
          const fullAccessButtons = buttons.filter((button) => [
            'use full access',
            '전체 액세스 사용',
            '전체 접근 권한 사용'
          ].includes(normalize(button.innerText || button.textContent || button.getAttribute('aria-label'))));
          const continueButtons = buttons.filter((button) => [
            'continue',
            '계속',
            '계속하기'
          ].includes(normalize(button.innerText || button.textContent || button.getAttribute('aria-label'))));
          if (fullAccessButtons.length !== 1 || continueButtons.length !== 1) {
            throw new Error('ThreadDeck: Ultra confirmation controls are ambiguous.');
          }
          fullAccessButtons[0].click();
          ultraConfirmed = true;
          break;
        }
        if (!ultraConfirmed) await new Promise((resolve) => setTimeout(resolve, 30));
      }
      if (ultraConfirmed) await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { delivered: true, ultraConfirmed };
  })()`;
}

class CodexMicroBridge {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.fetch = options.fetch ?? globalThis.fetch;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.execFile = options.execFile ?? execFileAsync;
    this.readFile = options.readFile ?? fs.readFile;
    this.statePath = options.statePath ?? DEFAULT_STATE_PATH;
    this.platform = options.platform ?? process.platform;
    this.socket = null;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
    this.lastSnapshot = null;
    this.runtimeActivated = false;
    this.evaluationNamespace = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  }

  async refreshReadOnly() {
    try {
      await this.ensureConnected();
      const snapshot = normalizeMicroSnapshot(await this.evaluate(READ_ONLY_SNAPSHOT_EXPRESSION));
      this.lastSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.disconnect();
      throw this.normalizeError(error, "read-only Micro snapshot");
    }
  }

  async runKeycap(keycapId) {
    if (!OFFICIAL_KEYCAP_IDS.has(keycapId)) {
      throw new MicroBridgeError(`Unknown Codex Micro keycap: ${keycapId}`, {
        code: "MICRO_CAPABILITY_UNAVAILABLE",
        delivery: "none"
      });
    }
    try {
      await this.ensureConnected();
      try {
        return await this.evaluate(runKeycapExpression(keycapId));
      } catch (error) {
        const normalized = this.normalizeError(error, `${keycapId} command`);
        // Some Codex builds do not load the keycap registry until the Micro
        // feature has been activated. A definite pre-dispatch miss is safe to
        // activate and retry once; ambiguous failures are never replayed.
        if (normalized.delivery !== "none"
            || normalized.code !== "MICRO_CAPABILITY_UNAVAILABLE"
            || this.runtimeActivated) throw normalized;
        await this.activateRuntime();
        return await this.evaluate(runKeycapExpression(keycapId));
      }
    } catch (error) {
      throw this.normalizeError(error, `${keycapId} command`);
    }
  }

  async activateRuntime() {
    if (this.runtimeActivated) return true;
    try {
      await this.ensureConnected();
      const result = await this.evaluate(ACTIVATE_RUNTIME_EXPRESSION, { timeoutMs: 8500 });
      if (result?.ready !== true) {
        throw new MicroBridgeError("Codex Micro runtime did not become ready.", {
          code: "MICRO_CAPABILITY_UNAVAILABLE",
          delivery: "none"
        });
      }
      this.runtimeActivated = true;
      return true;
    } catch (error) {
      const normalized = this.normalizeError(error, "Micro runtime activation");
      if (/ThreadDeck: .* unavailable/i.test(normalized.message)) {
        normalized.code = "MICRO_CAPABILITY_UNAVAILABLE";
        normalized.delivery = "none";
      }
      throw normalized;
    }
  }

  async toggleFast() {
    return this.runKeycap("FAST");
  }

  async openSideChat() {
    return this.runKeycap("PARTY");
  }

  async submit() {
    return this.runKeycap("CODEX");
  }

  async newTask() {
    return this.runKeycap("NEW");
  }

  async setPushToTalk(active) {
    try {
      await this.ensureConnected();
      await this.activateRuntime();
      return await this.evaluate(dispatchHostMessageExpression(
        active ? "codex-micro-push-to-talk-start" : "codex-micro-push-to-talk-stop"
      ));
    } catch (error) {
      throw this.normalizeError(error, active ? "push-to-talk start" : "push-to-talk stop");
    }
  }

  async adjustReasoning(direction, count = 1, options = {}) {
    const key = REASONING_ENCODER_KEYS[direction];
    if (!key) {
      throw new MicroBridgeError(`Unknown reasoning direction: ${direction}`, {
        code: "MICRO_CAPABILITY_UNAVAILABLE",
        delivery: "none"
      });
    }
    try {
      await this.ensureConnected();
      await this.activateRuntime();
      return await this.evaluate(dispatchHidExpression({
        key,
        act: 2,
        slot: null,
        threadKey: null
      }, {
        repeat: count,
        intervalMs: 70,
        confirmUltra: options.confirmUltra === true
      }), { timeoutMs: 3600 + Math.max(1, count) * 120 });
    } catch (error) {
      throw this.normalizeError(error, "reasoning adjustment");
    }
  }

  async openThread(threadKey, options = {}) {
    await this.activateRuntime();
    let snapshot = options.snapshot ?? this.lastSnapshot ?? await this.refreshReadOnly();
    let slot = snapshot.slots.find((candidate) => candidate.threadKey === threadKey);
    if (!slot) {
      try {
        await this.ensureConnected();
        await this.evaluate(ACTIVATE_HID_EXPRESSION);
        snapshot = await this.refreshReadOnly();
        slot = snapshot.slots.find((candidate) => candidate.threadKey === threadKey);
      } catch (error) {
        throw this.normalizeError(error, "Micro slot activation");
      }
    }
    if (!slot) {
      throw new MicroBridgeError("The task is not assigned to a Codex Micro slot.", {
        code: "MICRO_CAPABILITY_UNAVAILABLE",
        delivery: "none"
      });
    }
    try {
      await this.ensureConnected();
      await this.evaluate(dispatchHidExpression({
        key: `AG0${slot.id}`,
        act: 1,
        slot: slot.id,
        threadKey
      }, { repeat: 1, intervalMs: 0 }));
      return { slot: slot.id, threadKey };
    } catch (error) {
      throw this.normalizeError(error, "task switch");
    }
  }

  async ensureConnected() {
    if (this.socket?.readyState === this.WebSocket?.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connect() {
    if (typeof this.fetch !== "function" || typeof this.WebSocket !== "function") {
      throw microUnavailable("This Stream Deck runtime does not provide fetch/WebSocket.");
    }
    const port = await this.discoverDebugPort();
    const targets = await this.fetchJson(`http://127.0.0.1:${port}/json/list`, 1500);
    const target = selectCodexMainTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      throw microUnavailable("No loopback Codex main renderer target is available.");
    }
    const socket = new this.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(microUnavailable("Timed out connecting to the Codex renderer."));
      }, 3000);
      const opened = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const failed = (event) => {
        clearTimeout(timer);
        cleanup();
        reject(microUnavailable("Could not connect to the Codex renderer.", event?.error));
      };
      const cleanup = () => {
        socket.removeEventListener?.("open", opened);
        socket.removeEventListener?.("error", failed);
      };
      socket.addEventListener?.("open", opened, { once: true });
      socket.addEventListener?.("error", failed, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data ?? event)));
    socket.addEventListener("close", () => this.disconnect(socket));
    socket.addEventListener("error", () => this.disconnect(socket));
    this.socket = socket;
    this.log(`Codex Micro renderer bridge connected on loopback port ${port}.`);
  }

  async evaluate(expression, options = {}) {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocket.OPEN) {
      throw microUnavailable("Codex Micro renderer bridge is not connected.");
    }
    const id = ++this.nextId;
    const retained = retainEvaluationPromise(expression, `${this.evaluationNamespace}-${id}`);
    const timeoutMs = options.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MicroBridgeError("Codex renderer response timed out.", {
          code: "MICRO_TIMEOUT",
          delivery: "unknown"
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: retained,
            awaitPromise: true,
            returnByValue: true
          }
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(microUnavailable("Could not send a command to the Codex renderer.", error));
      }
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new MicroBridgeError(message.error.message ?? "Unknown CDP error.", {
        code: "MICRO_CDP_ERROR",
        delivery: "unknown"
      }));
      return;
    }
    const result = message.result;
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "Codex renderer evaluation failed.";
      const capabilityFailure = /ThreadDeck: .* (?:unavailable|changed|not active|no command)/i
        .test(description);
      pending.reject(new MicroBridgeError(description, {
        code: capabilityFailure ? "MICRO_CAPABILITY_UNAVAILABLE" : "MICRO_RENDERER_ERROR",
        delivery: capabilityFailure ? "none" : "unknown"
      }));
      return;
    }
    pending.resolve(result?.result?.value);
  }

  disconnect(expected = null) {
    if (expected && this.socket !== expected) return;
    const socket = this.socket;
    this.socket = null;
    this.runtimeActivated = false;
    if (socket && [this.WebSocket?.OPEN, this.WebSocket?.CONNECTING].includes(socket.readyState)) {
      try {
        socket.close();
      } catch {
        // The pending requests below still receive a deterministic error.
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(microUnavailable("Codex Micro renderer bridge disconnected."));
    }
    this.pending.clear();
  }

  close() {
    this.disconnect();
  }

  normalizeError(error, operation) {
    if (error instanceof MicroBridgeError) return error;
    return new MicroBridgeError(`Could not complete ${operation}: ${error?.message ?? "unknown error"}`, {
      code: "MICRO_ERROR",
      delivery: "unknown",
      cause: error
    });
  }

  async readPortFile() {
    try {
      const value = JSON.parse(await this.readFile(this.statePath, "utf8"));
      const port = Number(value?.port);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    } catch {
      return null;
    }
  }

  async isDebugPort(port) {
    try {
      const value = await this.fetchJson(`http://127.0.0.1:${port}/json/version`, 750);
      const debuggerUrl = value?.webSocketDebuggerUrl;
      return typeof debuggerUrl === "string" && isLoopbackWebSocketUrl(debuggerUrl);
    } catch {
      return false;
    }
  }

  async discoverDebugPort() {
    const fromFile = await this.readPortFile();
    if (fromFile && await this.isDebugPort(fromFile)) return fromFile;
    if (this.platform !== "darwin") {
      throw microUnavailable("Codex Micro renderer control is currently available on macOS only.");
    }
    let stdout;
    try {
      ({ stdout } = await this.execFile("/bin/ps", ["-axo", "command="], {
        timeout: 4000,
        maxBuffer: 2 * 1024 * 1024
      }));
    } catch (error) {
      throw microUnavailable("Could not inspect the local Codex process.", error);
    }
    for (const line of String(stdout ?? "").split("\n")) {
      if (!line.includes(".app/Contents/MacOS/")) continue;
      const port = parseDebugPortFromCommand(line);
      if (port && await this.isDebugPort(port)) return port;
    }
    throw microUnavailable("Codex is not running with the loopback Micro bridge enabled.");
  }

  async fetchJson(url, timeoutMs) {
    const signal = typeof AbortSignal?.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    let response;
    try {
      response = await this.fetch(url, { signal });
    } catch (error) {
      throw microUnavailable("Codex loopback debug endpoint is unavailable.", error);
    }
    if (!response?.ok) {
      throw microUnavailable(`Codex loopback debug endpoint returned ${response?.status ?? "an error"}.`);
    }
    return response.json();
  }
}

module.exports = {
  ACTIVATE_RUNTIME_EXPRESSION,
  READ_ONLY_SNAPSHOT_EXPRESSION,
  CodexMicroBridge,
  MICRO_FEATURE_GATE,
  DEFAULT_STATE_PATH,
  MicroBridgeError,
  REASONING_ENCODER_KEYS,
  isLoopbackWebSocketUrl,
  normalizeMicroSnapshot,
  parseDebugPortFromCommand,
  retainEvaluationPromise,
  runKeycapExpression,
  selectCodexMainTarget
};
