"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  parseCodexMainProcess,
  parseLoopbackListenerPorts
} = require("./micro-bootstrap");

const execFileAsync = promisify(execFile);
const DEFAULT_INSPECTOR_PORT = 9229;
const DEFAULT_OPEN_TIMEOUT_MS = 1800;
const DEFAULT_IDLE_CLOSE_MS = 350;

function inspectorUnavailable(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "MICRO_UNAVAILABLE";
  error.delivery = "none";
  return error;
}

function isLoopbackInspectorUrl(value, expectedPort = DEFAULT_INSPECTOR_PORT) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1"
      || url.hostname === "localhost"
      || url.hostname === "[::1]";
    return url.protocol === "ws:"
      && loopback
      && Number(url.port) === expectedPort;
  } catch {
    return false;
  }
}

function selectNodeInspectorTarget(targets, expectedPort = DEFAULT_INSPECTOR_PORT) {
  return (Array.isArray(targets) ? targets : []).find((target) => (
    target?.type === "node"
      && typeof target.webSocketDebuggerUrl === "string"
      && isLoopbackInspectorUrl(target.webSocketDebuggerUrl, expectedPort)
  )) ?? null;
}

function parseListenerPids(output) {
  const pids = [];
  for (const line of String(output ?? "").split("\n")) {
    const pid = Number(line.trim().match(/^p(\d+)$/)?.[1]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function rendererEvaluationExpression(expression, options = {}) {
  const closeOwnedInspector = options.closeOwnedInspector === true;
  const idleCloseMs = Math.max(50, Math.min(
    2000,
    Math.trunc(options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS)
  ));
  return `(async () => {
    const shouldClose = ${JSON.stringify(closeOwnedInspector)};
    const scheduleClose = () => {
      if (!shouldClose) return;
      const inspector = process.getBuiltinModule('inspector');
      if (globalThis.__threadDeckInspectorCloseTimer) {
        clearTimeout(globalThis.__threadDeckInspectorCloseTimer);
      }
      globalThis.__threadDeckInspectorCloseTimer = setTimeout(() => {
        globalThis.__threadDeckInspectorCloseTimer = null;
        inspector.close();
      }, ${idleCloseMs});
    };
    try {
      const moduleApi = process.getBuiltinModule('module');
      const urlApi = process.getBuiltinModule('url');
      const requireFromApp = moduleApi.createRequire(
        urlApi.pathToFileURL(process.resourcesPath + '/app.asar/main.js')
      );
      const electron = requireFromApp('electron');
      const page = electron.webContents.getAllWebContents().find((candidate) => {
        if (!candidate || candidate.isDestroyed()) return false;
        try {
          const url = new URL(candidate.getURL());
          return url.protocol === 'app:'
            && url.pathname === '/index.html'
            && !url.search;
        } catch {
          return false;
        }
      });
      if (!page) throw new Error('ThreadDeck: Codex main renderer is unavailable.');
      return await page.executeJavaScript(${JSON.stringify(expression)}, false);
    } finally {
      scheduleClose();
    }
  })()`;
}

function mainProcessEvaluationExpression(expression, options = {}) {
  const closeOwnedInspector = options.closeOwnedInspector === true;
  const idleCloseMs = Math.max(50, Math.min(
    2000,
    Math.trunc(options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS)
  ));
  return `(async () => {
    const shouldClose = ${JSON.stringify(closeOwnedInspector)};
    const scheduleClose = () => {
      if (!shouldClose) return;
      const inspector = process.getBuiltinModule('inspector');
      if (globalThis.__threadDeckInspectorCloseTimer) {
        clearTimeout(globalThis.__threadDeckInspectorCloseTimer);
      }
      globalThis.__threadDeckInspectorCloseTimer = setTimeout(() => {
        globalThis.__threadDeckInspectorCloseTimer = null;
        inspector.close();
      }, ${idleCloseMs});
    };
    try {
      return await (${expression});
    } finally {
      scheduleClose();
    }
  })()`;
}

class CodexMainInspectorEvaluator {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.execFile = options.execFile ?? execFileAsync;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.sendSignal = options.sendSignal ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? Date.now;
    this.port = options.port ?? DEFAULT_INSPECTOR_PORT;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this.nextId = 0;
    this.queue = Promise.resolve();
    this.ownedGeneration = null;
    this.ownedUntilMs = 0;
  }

  async canAttach() {
    if (this.platform !== "darwin"
        || typeof this.fetch !== "function"
        || typeof this.WebSocket !== "function") return false;
    return Boolean(await this.findMainProcess().catch(() => null));
  }

  evaluate(expression, options = {}) {
    const run = () => this.performEvaluation(expression, options, "renderer");
    const result = this.queue.then(run, run);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  evaluateMain(expression, options = {}) {
    const run = () => this.performEvaluation(expression, options, "main");
    const result = this.queue.then(run, run);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async performEvaluation(expression, options = {}, target = "renderer") {
    if (this.platform !== "darwin") {
      throw inspectorUnavailable("The on-demand Codex renderer bridge is available on macOS only.");
    }
    if (typeof this.fetch !== "function" || typeof this.WebSocket !== "function") {
      throw inspectorUnavailable("This Stream Deck runtime does not provide fetch/WebSocket.");
    }
    const main = await this.findMainProcess();
    if (!main) throw inspectorUnavailable("Codex Desktop is not running.");
    if (options.expectedGeneration
        && options.expectedGeneration !== main.generation) {
      throw inspectorUnavailable("Codex restarted before the command bridge was prepared.");
    }
    const session = await this.ensureInspectorTarget(main);
    let socket = null;
    try {
      socket = await this.openSocket(session.target.webSocketDebuggerUrl);
      const id = ++this.nextId;
      const timeoutMs = Math.max(250, Math.trunc(options.timeoutMs ?? 5000));
      const wrap = target === "main"
        ? mainProcessEvaluationExpression
        : rendererEvaluationExpression;
      const wrapped = wrap(expression, {
        closeOwnedInspector: session.ownedByThreadDeck,
        idleCloseMs: options.idleCloseMs ?? this.idleCloseMs
      });
      return await this.request(socket, {
        id,
        method: "Runtime.evaluate",
        params: {
          expression: wrapped,
          awaitPromise: true,
          returnByValue: true
        }
      }, timeoutMs);
    } catch (error) {
      if (session.ownedByThreadDeck) {
        await this.bestEffortCloseOwnedInspector(session.target);
      }
      throw error;
    } finally {
      try {
        socket?.close();
      } catch {
        // The renderer result is authoritative even if the inspector socket
        // has already closed itself after the short idle window.
      }
      if (session.ownedByThreadDeck) {
        this.ownedUntilMs = this.now() + this.idleCloseMs;
      }
    }
  }

  async findMainProcess() {
    let result;
    try {
      result = await this.execFile("/bin/ps", [
        "-axo", "pid=,ppid=,lstart=,command="
      ], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      throw inspectorUnavailable("Could not inspect the local Codex process.", error);
    }
    return parseCodexMainProcess(result?.stdout ?? result ?? "");
  }

  async ownedLoopbackPorts(pid) {
    try {
      const result = await this.execFile("/usr/sbin/lsof", [
        "-nP",
        "-a",
        "-p", String(pid),
        "-iTCP",
        "-sTCP:LISTEN",
        "-Fn"
      ], { timeout: 2500, maxBuffer: 128 * 1024 });
      return parseLoopbackListenerPorts(result?.stdout ?? result ?? "");
    } catch {
      return [];
    }
  }

  async listeningPids() {
    try {
      const result = await this.execFile("/usr/sbin/lsof", [
        "-nP",
        `-iTCP:${this.port}`,
        "-sTCP:LISTEN",
        "-Fp"
      ], { timeout: 2500, maxBuffer: 32 * 1024 });
      return parseListenerPids(result?.stdout ?? result ?? "");
    } catch {
      return [];
    }
  }

  async inspectorTarget(main) {
    const ports = await this.ownedLoopbackPorts(main.pid);
    if (!ports.includes(this.port)) return null;
    let response;
    try {
      response = await this.fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(500)
          : undefined
      });
    } catch {
      return null;
    }
    if (!response?.ok) return null;
    const target = selectNodeInspectorTarget(await response.json(), this.port);
    return target ? { target } : null;
  }

  async ensureInspectorTarget(main) {
    let existing = await this.inspectorTarget(main);
    if (existing) {
      const ownedByThreadDeck = this.ownedGeneration === main.generation
        && this.now() <= this.ownedUntilMs;
      if (!ownedByThreadDeck && this.ownedGeneration === main.generation) {
        this.ownedGeneration = null;
        this.ownedUntilMs = 0;
      }
      return {
        ...existing,
        ownedByThreadDeck
      };
    }
    const listeners = await this.listeningPids();
    if (listeners.some((pid) => pid !== main.pid)) {
      throw inspectorUnavailable(
        `Loopback inspector port ${this.port} is already owned by another process.`
      );
    }
    try {
      this.sendSignal(main.pid, "SIGUSR1");
    } catch (error) {
      throw inspectorUnavailable("Could not open the on-demand Codex inspector.", error);
    }
    this.ownedGeneration = main.generation;
    this.ownedUntilMs = Number.POSITIVE_INFINITY;
    const deadline = Date.now() + this.openTimeoutMs;
    while (Date.now() < deadline) {
      existing = await this.inspectorTarget(main);
      if (existing) return { ...existing, ownedByThreadDeck: true };
      await this.sleep(50);
    }
    this.ownedGeneration = null;
    this.ownedUntilMs = 0;
    throw inspectorUnavailable("Timed out opening the on-demand Codex inspector.");
  }

  async bestEffortCloseOwnedInspector(target) {
    let socket = null;
    try {
      await this.sleep(25);
      socket = await this.openSocket(target.webSocketDebuggerUrl);
      const id = ++this.nextId;
      await this.request(socket, {
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `(() => {
            setTimeout(() => process.getBuiltinModule('inspector').close(), 25);
            return true;
          })()`,
          awaitPromise: true,
          returnByValue: true
        }
      }, 500);
    } catch {
      // If the inspector already closed there is nothing left to clean up.
      // A later command will re-check exact PID ownership before attaching.
    } finally {
      try {
        socket?.close();
      } catch {
        // Ignore a socket that the inspector close timer already ended.
      }
    }
  }

  openSocket(url) {
    if (!isLoopbackInspectorUrl(url, this.port)) {
      return Promise.reject(inspectorUnavailable("Codex inspector target is not loopback-only."));
    }
    const socket = new this.WebSocket(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(inspectorUnavailable("Timed out connecting to the on-demand Codex inspector."));
      }, 1500);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener?.("open", opened);
        socket.removeEventListener?.("error", failed);
      };
      const opened = () => {
        cleanup();
        resolve(socket);
      };
      const failed = (event) => {
        cleanup();
        reject(inspectorUnavailable("Could not connect to the on-demand Codex inspector.", event?.error));
      };
      socket.addEventListener?.("open", opened, { once: true });
      socket.addEventListener?.("error", failed, { once: true });
    });
  }

  request(socket, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error("Codex on-demand renderer response timed out.");
        error.code = "MICRO_TIMEOUT";
        error.delivery = "unknown";
        reject(error);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener?.("message", received);
        socket.removeEventListener?.("error", failed);
        socket.removeEventListener?.("close", closed);
      };
      const failed = (event) => {
        cleanup();
        reject(inspectorUnavailable("The on-demand Codex inspector failed.", event?.error));
      };
      const closed = () => {
        cleanup();
        reject(inspectorUnavailable("The on-demand Codex inspector closed before responding."));
      };
      const received = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data ?? event));
        } catch {
          return;
        }
        if (message.id !== payload.id) return;
        cleanup();
        if (message.error) {
          const error = new Error(message.error.message ?? "Unknown inspector error.");
          error.code = "MICRO_CDP_ERROR";
          error.delivery = "unknown";
          reject(error);
          return;
        }
        const result = message.result;
        if (result?.exceptionDetails) {
          const description = result.exceptionDetails.exception?.description
            ?? result.exceptionDetails.text
            ?? "Codex on-demand renderer evaluation failed.";
          const capabilityFailure = /ThreadDeck: .* (?:unavailable|changed|not active|no command)/i
            .test(description);
          const error = new Error(description);
          error.code = capabilityFailure
            ? "MICRO_CAPABILITY_UNAVAILABLE"
            : "MICRO_RENDERER_ERROR";
          error.delivery = capabilityFailure ? "none" : "unknown";
          reject(error);
          return;
        }
        resolve(result?.result?.value);
      };
      socket.addEventListener?.("message", received);
      socket.addEventListener?.("error", failed, { once: true });
      socket.addEventListener?.("close", closed, { once: true });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        cleanup();
        reject(inspectorUnavailable("Could not send an on-demand Codex renderer command.", error));
      }
    });
  }
}

module.exports = {
  CodexMainInspectorEvaluator,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_INSPECTOR_PORT,
  inspectorUnavailable,
  isLoopbackInspectorUrl,
  mainProcessEvaluationExpression,
  parseListenerPids,
  rendererEvaluationExpression,
  selectNodeInspectorTarget
};
