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
const CODEX_THREAD_UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CODEX_EXACT_THREAD_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function microThreadIdFromKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return null;
  const uuid = key.match(CODEX_THREAD_UUID_PATTERN)?.[1];
  if (uuid) return uuid.toLowerCase();
  return key.startsWith("local:") ? key.slice("local:".length) || null : key;
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
    threadId: microThreadIdFromKey(threadKey),
    title: typeof slot.title === "string" ? slot.title : null,
    status: typeof slot.status === "string" ? slot.status : null,
    selected: slot.selected === true,
    activityAt: Number.isFinite(slot.activityAt) ? slot.activityAt : null
  };
}

function normalizeMicroModel(value) {
  const model = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9._-]*$/.test(model) ? model : null;
}

function normalizeMicroPowerSelection(value) {
  if (!value || typeof value !== "object") return null;
  const model = normalizeMicroModel(value.model);
  const reasoningEffort = typeof value.reasoningEffort === "string"
    ? value.reasoningEffort.trim().toLowerCase()
    : "";
  if (!model || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort)) {
    return null;
  }
  const id = typeof value.id === "string" && value.id.trim()
    ? value.id.trim().toLowerCase()
    : `${model}:${reasoningEffort}`;
  return {
    id,
    model,
    reasoningEffort,
    label: typeof value.label === "string" && value.label.trim()
      ? value.label.trim()
      : null,
    isMax: value.isMax === true
  };
}

function normalizeMicroPowerSelections(values) {
  const seen = new Set();
  const selections = [];
  for (const value of Array.isArray(values) ? values : []) {
    const selection = normalizeMicroPowerSelection(value);
    if (!selection || seen.has(selection.id)) continue;
    seen.add(selection.id);
    selections.push(selection);
  }
  return selections;
}

function normalizeMicroSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  const model = normalizeMicroModel(snapshot.model);
  const powerSelections = normalizeMicroPowerSelections(snapshot.powerSelections);
  const reasoningEffort = typeof snapshot.reasoningEffort === "string" && snapshot.reasoningEffort
    ? snapshot.reasoningEffort.toLowerCase()
    : null;
  const powerSelectionId = typeof snapshot.powerSelectionId === "string"
    ? snapshot.powerSelectionId.trim().toLowerCase()
    : powerSelections.find((selection) => (
      selection.model === model && selection.reasoningEffort === reasoningEffort
    ))?.id ?? null;
  return {
    connected: snapshot.connected === true,
    activeThreadKey: microThreadIdFromKey(snapshot.activeThreadKey),
    model,
    reasoningEffort,
    powerSelectionId,
    powerSelections,
    fastEnabled: typeof snapshot.fastEnabled === "boolean" ? snapshot.fastEnabled : null,
    theme: snapshot.theme === "light" ? "light" : snapshot.theme === "dark" ? "dark" : null,
    slots: (Array.isArray(snapshot.slots) ? snapshot.slots : [])
      .map(normalizeMicroSlot)
      .filter(Boolean),
    capabilities: {
      command: snapshot.capabilities?.command === true,
      hostMessage: snapshot.capabilities?.hostMessage === true,
      hid: snapshot.capabilities?.hid === true,
      slots: snapshot.capabilities?.slots === true,
      powerSelections: snapshot.capabilities?.powerSelections === true
        || powerSelections.length >= 2
    }
  };
}

function confirmedMicroThreadSnapshot(value, threadKey) {
  const threadId = microThreadIdFromKey(threadKey);
  if (!threadId) return null;
  const snapshot = normalizeMicroSnapshot(value);
  if (snapshot.activeThreadKey === threadId) return snapshot;
  const selectedSlot = snapshot.slots.find((slot) => (
    slot.threadId === threadId && slot.selected === true
  ));
  if (!selectedSlot) return null;
  // Codex can update the official Micro slot selection one renderer frame
  // before the focused composer exposes its new conversation id. Treat that
  // selected slot as the authoritative result of the AG0x command so callers
  // neither report a false failure nor re-promote the previous composer.
  return { ...snapshot, activeThreadKey: threadId };
}

function fastEnabledFromIntelligenceTrigger(trigger) {
  if (!trigger || trigger.getAttribute("data-state") !== "closed") return null;
  const indicator = trigger.querySelector("[data-reserved]");
  if (!indicator) return false;
  // Current Codex builds keep the compact Fast indicator mounted for layout
  // stability and expose its actual state as data-reserved="true|false".
  // Older builds mounted it only while Fast was enabled, with no value.
  return indicator.getAttribute("data-reserved") !== "false";
}

const FAST_ENABLED_FROM_TRIGGER_SOURCE = `const fastEnabledFromIntelligenceTrigger = ${fastEnabledFromIntelligenceTrigger.toString()};`;

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
  ${FAST_ENABLED_FROM_TRIGGER_SOURCE}
  const visible = (element) => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
  const composerRoots = [...document.querySelectorAll('[data-codex-composer-root]')].filter(visible);
  const focusedRoot = document.activeElement?.closest?.('[data-codex-composer-root]');
  const activeComposerRoot = focusedRoot && visible(focusedRoot)
    ? focusedRoot
    : [...composerRoots].sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)[0] ?? null;
  const intelligenceTrigger = activeComposerRoot?.querySelector('[data-codex-intelligence-trigger]')
    ?? [...document.querySelectorAll('[data-codex-intelligence-trigger]')].find(visible)
    ?? null;
  let reasoningEffort = intelligenceTrigger?.getAttribute('data-selected-reasoning-effort') ?? null;
  let model = null;
  let powerSelectionId = null;
  let powerSelections = [];
  // The compact power slider is a model + effort axis. Its first position can
  // therefore be Terra Light even though the trigger's effort alone is still
  // low. Read the mounted component's public props without opening the menu
  // so ThreadDeck can preserve that otherwise invisible distinction.
  try {
    const reactKey = intelligenceTrigger && Object.getOwnPropertyNames(intelligenceTrigger)
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = reactKey ? intelligenceTrigger[reactKey] : null;
    for (let depth = 0; fiber && depth < 36; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (!model && typeof props.model === 'string') model = props.model;
      if (!reasoningEffort && typeof props.reasoningEffort === 'string') {
        reasoningEffort = props.reasoningEffort;
      }
      const selected = props.selectedPowerSelection ?? props.selectedLabelCandidate;
      if (!powerSelectionId && typeof selected?.id === 'string') {
        powerSelectionId = selected.id;
      }
      if (powerSelections.length === 0 && Array.isArray(props.powerSelections)) {
        powerSelections = props.powerSelections.map((selection) => ({
          id: typeof selection?.id === 'string' ? selection.id : null,
          model: typeof selection?.model === 'string' ? selection.model : null,
          reasoningEffort: typeof selection?.reasoningEffort === 'string'
            ? selection.reasoningEffort
            : null,
          label: typeof selection?.label === 'string' ? selection.label : null,
          isMax: selection?.isMax === true
        }));
      }
    }
  } catch {}
  if (!powerSelectionId && model && reasoningEffort) {
    powerSelectionId = powerSelections.find((selection) => (
      selection.model === model && selection.reasoningEffort === reasoningEffort
    ))?.id ?? null;
  }
  // While the picker is open the indicator is reserved for width measurement,
  // so that transient state remains unknown.
  const fastEnabled = fastEnabledFromIntelligenceTrigger(intelligenceTrigger);
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
    model,
    reasoningEffort,
    powerSelectionId,
    powerSelections,
    fastEnabled,
    theme,
    slots,
    capabilities: {
      command: urls.some((url) => url.includes('/assets/codex-micro-layout-')),
      hostMessage: typeof bus?.dispatchHostMessage === 'function',
      hid: hidHandlers > 0,
      slots: slots.length === 6,
      powerSelections: powerSelections.length >= 2
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

function runReasoningEncoderExpression(direction, count = 1, options = {}) {
  const powerSelectionDirection = direction === "decrease"
    ? "decrease"
    : direction === "increase" ? "increase" : null;
  if (!powerSelectionDirection) {
    throw new TypeError(`Unknown reasoning direction: ${direction}`);
  }
  const repeat = Math.max(1, Math.min(64, Math.trunc(count)));
  const confirmUltra = options.confirmUltra === true;
  return `(async () => {
    ${ASSET_URLS_SOURCE}
    const moduleUrl = (prefix) => urls.find((value) => value.includes('/assets/' + prefix));
    const commandsUrl = moduleUrl('run-command-');
    const bridgeUrl = moduleUrl('codex-micro-bridge-');
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
    if (typeof commandRunner !== 'function') {
      return { deliveredCount: 0, requestedCount: ${repeat}, error: 'Codex command runner is unavailable.' };
    }
    let deliveredCount = 0;
    let error = null;
    for (let index = 0; index < ${repeat}; index += 1) {
      try {
        const handled = commandRunner(
          'composer.openModelPicker',
          'codex_micro_encoder',
          {
            modelPicker: {
              menuView: 'simple',
              powerSelectionDirection: ${JSON.stringify(powerSelectionDirection)}
            }
          }
        );
        if (handled === false) {
          error = 'Codex reasoning command is not active in the current view.';
          break;
        }
        deliveredCount += 1;
        if (index + 1 < ${repeat}) await new Promise((resolve) => setTimeout(resolve, 90));
      } catch (caught) {
        error = String(caught?.message ?? caught ?? 'Codex reasoning command failed.');
        break;
      }
    }
    let ultraConfirmed = false;
    if (${confirmUltra} && deliveredCount > 0) {
      try {
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
            const buttons = [...dialog.querySelectorAll('button')]
              .filter((button) => button.getClientRects().length > 0 && !button.disabled);
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
              throw new Error('Ultra confirmation controls are ambiguous.');
            }
            fullAccessButtons[0].click();
            ultraConfirmed = true;
            break;
          }
          if (!ultraConfirmed) await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (ultraConfirmed) await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (caught) {
        error = String(caught?.message ?? caught ?? 'Ultra confirmation failed.');
      }
    }
    return { deliveredCount, requestedCount: ${repeat}, ultraConfirmed, error };
  })()`;
}

function runPowerSelectionExpression(modelValue, effortValue) {
  const model = normalizeMicroModel(modelValue);
  const reasoningEffort = typeof effortValue === "string"
    ? effortValue.trim().toLowerCase()
    : "";
  if (!model || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort)) {
    throw new TypeError(`Unknown Codex power selection: ${modelValue}:${effortValue}`);
  }
  return `(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const composerRoots = [...document.querySelectorAll('[data-codex-composer-root]')].filter(visible);
    const focusedRoot = document.activeElement?.closest?.('[data-codex-composer-root]');
    const activeComposerRoot = focusedRoot && visible(focusedRoot)
      ? focusedRoot
      : [...composerRoots].sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)[0] ?? null;
    const trigger = activeComposerRoot?.querySelector('[data-codex-intelligence-trigger]')
      ?? [...document.querySelectorAll('[data-codex-intelligence-trigger]')].find(visible)
      ?? null;
    const reactKey = trigger && Object.getOwnPropertyNames(trigger)
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = reactKey ? trigger[reactKey] : null;
    let controller = null;
    for (let depth = 0; fiber && depth < 36; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (typeof props.onSelectPower === 'function' && Array.isArray(props.powerSelections)) {
        controller = props;
        break;
      }
    }
    if (!controller) {
      return { delivered: false, error: 'Codex power-selection controller is unavailable.' };
    }
    const matches = controller.powerSelections.filter((selection) => (
      selection?.model === ${JSON.stringify(model)}
      && selection?.reasoningEffort === ${JSON.stringify(reasoningEffort)}
    ));
    if (matches.length !== 1) {
      return { delivered: false, error: matches.length === 0
        ? 'Requested Codex power selection is unavailable.'
        : 'Requested Codex power selection is ambiguous.' };
    }
    controller.onSelectPower(matches[0]);
    return {
      delivered: true,
      id: matches[0].id ?? ${JSON.stringify(`${model}:${reasoningEffort}`)},
      model: matches[0].model,
      reasoningEffort: matches[0].reasoningEffort
    };
  })()`;
}

function runUltraWarningConfirmationExpression(timeoutMs = 4500) {
  const boundedTimeoutMs = Math.max(250, Math.min(8000, Math.trunc(timeoutMs)));
  return `(async () => {
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const deadline = Date.now() + ${boundedTimeoutMs};
    let warningSeen = false;
    while (Date.now() < deadline) {
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
        warningSeen = true;
        const buttons = [...dialog.querySelectorAll('button')]
          .filter((button) => button.getClientRects().length > 0 && !button.disabled);
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
        await new Promise((resolve) => setTimeout(resolve, 140));
        return { confirmed: true, warningSeen: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { confirmed: false, warningSeen };
  })()`;
}

function runSideChatFocusExpression(threadId) {
  const normalizedThreadId = String(threadId ?? "").trim().toLowerCase();
  if (!CODEX_EXACT_THREAD_UUID_PATTERN.test(normalizedThreadId)) {
    throw new MicroBridgeError("Invalid Side Chat thread id.", {
      code: "MICRO_CAPABILITY_UNAVAILABLE",
      delivery: "none"
    });
  }
  const tabId = `sidechat:${normalizedThreadId}`;
  return `(async () => {
    const tabId = ${JSON.stringify(tabId)};
    const threadId = ${JSON.stringify(normalizedThreadId)};
    const visible = (element) => Boolean(
      element
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden'
    );
    const roots = [...document.querySelectorAll('[data-tab-id]')]
      .filter((element) => element.getAttribute('data-tab-id') === tabId && visible(element));
    const tabs = [...new Set(roots.flatMap((root) => (
      root.matches('[role="tab"]')
        ? [root]
        : [...root.querySelectorAll('[role="tab"]')]
    )))].filter(visible);
    if (tabs.length !== 1) {
      return {
        delivered: false,
        error: tabs.length === 0
          ? 'The exact Side Chat tab is not mounted.'
          : 'The exact Side Chat tab is ambiguous.',
        matches: tabs.length,
        threadId
      };
    }
    const tab = tabs[0];
    const alreadySelected = tab.getAttribute('aria-selected') === 'true';
    tab.click();
    tab.focus({ preventScroll: true });
    const deadline = Date.now() + 700;
    while (tab.getAttribute('aria-selected') !== 'true' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      delivered: true,
      selected: tab.getAttribute('aria-selected') === 'true',
      alreadySelected,
      threadId
    };
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
    if (!REASONING_ENCODER_KEYS[direction]) {
      throw new MicroBridgeError(`Unknown reasoning direction: ${direction}`, {
        code: "MICRO_CAPABILITY_UNAVAILABLE",
        delivery: "none"
      });
    }
    try {
      await this.ensureConnected();
      await this.activateRuntime();
      const requestedCount = Math.max(1, Math.min(64, Math.trunc(count)));
      const result = await this.evaluate(
        runReasoningEncoderExpression(direction, requestedCount, options),
        { timeoutMs: 3600 + requestedCount * 140 }
      );
      const deliveredCount = Math.max(0, Math.trunc(result?.deliveredCount ?? 0));
      if (result?.error || deliveredCount !== requestedCount) {
        throw new MicroBridgeError(
          result?.error
            ? `Codex Micro reasoning adjustment stopped: ${result.error}`
            : `Codex Micro reasoning adjustment delivered ${deliveredCount}/${requestedCount} steps.`,
          {
            code: deliveredCount > 0
              ? "MICRO_PARTIAL_DELIVERY"
              : "MICRO_CAPABILITY_UNAVAILABLE",
            delivery: deliveredCount > 0 ? "unknown" : "none"
          }
        );
      }
      return result;
    } catch (error) {
      throw this.normalizeError(error, "reasoning adjustment");
    }
  }

  async setPowerSelection(model, reasoningEffort) {
    try {
      await this.ensureConnected();
      const result = await this.evaluate(
        runPowerSelectionExpression(model, reasoningEffort),
        { timeoutMs: 2500 }
      );
      if (result?.delivered !== true) {
        throw new MicroBridgeError(
          `Codex power selection was not delivered: ${result?.error ?? "unknown error"}`,
          {
            code: "MICRO_CAPABILITY_UNAVAILABLE",
            delivery: "none"
          }
        );
      }
      return result;
    } catch (error) {
      throw this.normalizeError(error, "power selection");
    }
  }

  async confirmUltraFullAccess(options = {}) {
    const timeoutMs = Math.max(250, Math.min(8000, Math.trunc(options.timeoutMs ?? 4500)));
    try {
      await this.ensureConnected();
      return await this.evaluate(
        runUltraWarningConfirmationExpression(timeoutMs),
        { timeoutMs: timeoutMs + 1000 }
      );
    } catch (error) {
      throw this.normalizeError(error, "Ultra confirmation");
    }
  }

  async focusSideChat(threadId) {
    try {
      await this.ensureConnected();
      const result = await this.evaluate(
        runSideChatFocusExpression(threadId),
        { timeoutMs: 1800 }
      );
      if (result?.delivered !== true) {
        throw new MicroBridgeError(
          `The Side Chat tab could not be selected: ${result?.error ?? "unknown error"}`,
          {
            code: "MICRO_CAPABILITY_UNAVAILABLE",
            delivery: "none"
          }
        );
      }
      if (result.selected !== true) {
        throw new MicroBridgeError("The Side Chat tab did not confirm selection.", {
          code: "MICRO_POST_DELIVERY_ERROR",
          delivery: "unknown"
        });
      }
      return result;
    } catch (error) {
      throw this.normalizeError(error, "Side Chat focus");
    }
  }

  async openThread(threadKey, options = {}) {
    await this.activateRuntime();
    const threadId = microThreadIdFromKey(threadKey);
    let snapshot = options.snapshot ?? this.lastSnapshot ?? await this.refreshReadOnly();
    let slot = snapshot.slots.find((candidate) => candidate.threadId === threadId);
    if (!slot) {
      try {
        await this.ensureConnected();
        await this.evaluate(ACTIVATE_HID_EXPRESSION);
        snapshot = await this.refreshReadOnly();
        slot = snapshot.slots.find((candidate) => candidate.threadId === threadId);
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
        threadKey: slot.threadKey
      }, { repeat: 1, intervalMs: 0 }));
      return { slot: slot.id, threadKey: slot.threadKey, threadId: slot.threadId };
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
  confirmedMicroThreadSnapshot,
  fastEnabledFromIntelligenceTrigger,
  isLoopbackWebSocketUrl,
  microThreadIdFromKey,
  normalizeMicroSnapshot,
  normalizeMicroPowerSelections,
  parseDebugPortFromCommand,
  retainEvaluationPromise,
  runReasoningEncoderExpression,
  runPowerSelectionExpression,
  runSideChatFocusExpression,
  runUltraWarningConfirmationExpression,
  runKeycapExpression,
  selectCodexMainTarget
};
