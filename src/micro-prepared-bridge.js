"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SOCKET_PREFIX = "/tmp/threaddeck-";

function preparedBridgeError(message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.code = options.code ?? "MICRO_UNAVAILABLE";
  error.delivery = options.delivery ?? "none";
  return error;
}

function safeSocketPath(value) {
  return typeof value === "string"
    && /^\/tmp\/threaddeck-\d+-\d+-[a-f0-9]+\.sock$/.test(value)
    && Buffer.byteLength(value) < 100;
}

function preparedBridgeBootstrapExpression(options = {}) {
  const socketPath = String(options.socketPath ?? "");
  const token = String(options.token ?? "");
  if (!safeSocketPath(socketPath)) throw new TypeError("Invalid ThreadDeck socket path.");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TypeError("Invalid ThreadDeck bridge token.");
  const config = JSON.stringify({
    socketPath,
    token,
    maxRequestBytes: MAX_REQUEST_BYTES
  });
  return `(async () => {
    const config = ${config};
    const bridgeKey = '__threadDeckPreparedRendererBridge';
    const fs = process.getBuiltinModule('fs');
    const net = process.getBuiltinModule('net');
    const moduleApi = process.getBuiltinModule('module');
    const urlApi = process.getBuiltinModule('url');
    const requireFromApp = moduleApi.createRequire(
      urlApi.pathToFileURL(process.resourcesPath + '/app.asar/main.js')
    );
    const electron = requireFromApp('electron');
    const safePath = (value) => typeof value === 'string'
      && /^\\/tmp\\/threaddeck-\\d+-\\d+-[a-f0-9]+\\.sock$/.test(value)
      && Buffer.byteLength(value) < 100;
    const unlink = (value) => {
      if (!safePath(value)) return;
      try { fs.unlinkSync(value); } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
    };
    const previous = globalThis[bridgeKey];
    if (previous && previous.server) {
      for (const client of previous.clients || []) {
        try { client.destroy(); } catch {}
      }
      try { previous.server.close(); } catch {}
      try { unlink(previous.socketPath); } catch {}
    }
    unlink(config.socketPath);
    const clients = new Set();
    const send = (client, payload) => {
      if (!client.destroyed) client.write(JSON.stringify(payload) + '\\n');
    };
    const renderer = () => electron.webContents.getAllWebContents().find((candidate) => {
      if (!candidate || candidate.isDestroyed()) return false;
      try {
        const candidateUrl = new urlApi.URL(candidate.getURL());
        return candidateUrl.protocol === 'app:'
          && candidateUrl.pathname === '/index.html'
          && !candidateUrl.search;
      } catch {
        return false;
      }
    });
    const server = net.createServer((client) => {
      clients.add(client);
      client.unref();
      let buffer = '';
      let sequence = Promise.resolve();
      const respondTo = async (request) => {
        const id = Number.isInteger(request && request.id) ? request.id : null;
        if (!id || request.token !== config.token) {
          send(client, {
            id,
            ok: false,
            error: { message: 'ThreadDeck bridge authentication failed.', code: 'MICRO_UNAVAILABLE', delivery: 'none' }
          });
          return;
        }
        if (request.op === 'close') {
          send(client, { id, ok: true, value: true });
          setTimeout(() => {
            for (const peer of clients) {
              try { peer.destroy(); } catch {}
            }
            try { server.close(); } catch {}
            try { unlink(config.socketPath); } catch {}
            if (globalThis[bridgeKey] && globalThis[bridgeKey].server === server) {
              delete globalThis[bridgeKey];
            }
          }, 10);
          return;
        }
        if (request.op !== 'evaluate'
            || typeof request.expression !== 'string'
            || Buffer.byteLength(request.expression) > config.maxRequestBytes) {
          send(client, {
            id,
            ok: false,
            error: { message: 'ThreadDeck bridge request is invalid.', code: 'MICRO_UNAVAILABLE', delivery: 'none' }
          });
          return;
        }
        try {
          const page = renderer();
          if (!page) throw new Error('ThreadDeck: Codex main renderer is unavailable.');
          const value = await page.executeJavaScript(request.expression, false);
          send(client, { id, ok: true, value });
        } catch (error) {
          const message = String(error && (error.stack || error.message) || error || 'Codex renderer evaluation failed.');
          const capabilityFailure = /ThreadDeck: .* (?:unavailable|changed|not active|no command)/i.test(message);
          send(client, {
            id,
            ok: false,
            error: {
              message,
              code: capabilityFailure ? 'MICRO_CAPABILITY_UNAVAILABLE' : 'MICRO_RENDERER_ERROR',
              delivery: capabilityFailure ? 'none' : 'unknown'
            }
          });
        }
      };
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > config.maxRequestBytes + 4096) {
          client.destroy();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let request;
          try { request = JSON.parse(line); } catch {
            send(client, {
              id: null,
              ok: false,
              error: { message: 'ThreadDeck bridge request is not JSON.', code: 'MICRO_UNAVAILABLE', delivery: 'none' }
            });
            continue;
          }
          sequence = sequence.then(() => respondTo(request), () => respondTo(request));
        }
      });
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
    });
    server.on('error', () => {});
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(config.socketPath);
    });
    fs.chmodSync(config.socketPath, 0o600);
    server.unref();
    globalThis[bridgeKey] = {
      server,
      clients,
      socketPath: config.socketPath
    };
    return { ready: true, socketPath: config.socketPath };
  })()`;
}

class CodexPreparedRendererBridge {
  constructor(options = {}) {
    this.mainInspector = options.mainInspector;
    this.net = options.net ?? net;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    this.pid = options.pid ?? process.pid;
    this.bootstrap = options.bootstrap ?? ((configuration) => this.defaultBootstrap(configuration));
    this.socketPathFactory = options.socketPathFactory ?? ((random) => (
      `${SOCKET_PREFIX}${this.uid}-${this.pid}-${random}.sock`
    ));
    this.log = options.log ?? (() => {});
    this.socket = null;
    this.socketPath = null;
    this.token = null;
    this.generation = null;
    this.preparing = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  isReady() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
  }

  async canAttach() {
    if (this.isReady()) return true;
    return Boolean(await this.mainInspector?.canAttach?.().catch(() => false));
  }

  prepare() {
    if (this.isReady()) return Promise.resolve(true);
    if (this.preparing) return this.preparing;
    this.preparing = this.performPrepare();
    return this.preparing.finally(() => {
      this.preparing = null;
    });
  }

  async performPrepare() {
    this.invalidate(null, preparedBridgeError("Replacing the inactive Codex command bridge."));
    const random = this.randomBytes(12).toString("hex");
    const socketPath = this.socketPathFactory(random);
    const token = this.randomBytes(32).toString("hex");
    if (!safeSocketPath(socketPath)) {
      throw preparedBridgeError("Could not create a safe local Codex command socket.");
    }
    const result = await this.bootstrap({ socketPath, token });
    if (result?.ready !== true) {
      throw preparedBridgeError("Codex did not prepare its local command bridge.");
    }
    this.socketPath = socketPath;
    this.token = token;
    this.generation = result.generation ?? null;
    try {
      await this.connect(socketPath);
    } catch (error) {
      this.socketPath = null;
      this.token = null;
      this.generation = null;
      throw error;
    }
    this.log("Codex command bridge prepared before the first Stream Deck press.");
    return true;
  }

  async defaultBootstrap({ socketPath, token }) {
    if (!this.mainInspector?.findMainProcess || !this.mainInspector?.evaluateMain) {
      throw preparedBridgeError("The Codex command bridge bootstrap is unavailable.");
    }
    const main = await this.mainInspector.findMainProcess();
    if (!main) throw preparedBridgeError("Codex Desktop is not running.");
    const value = await this.mainInspector.evaluateMain(
      preparedBridgeBootstrapExpression({ socketPath, token }),
      { expectedGeneration: main.generation, timeoutMs: 5000, idleCloseMs: 50 }
    );
    // A ThreadDeck-owned inspector closes before prepare() resolves, so even
    // an immediate first key press uses only the private Unix socket.
    await this.mainInspector.sleep?.(75);
    return { ...value, generation: main.generation };
  }

  connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = this.net.createConnection(socketPath);
      let settled = false;
      const failed = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(preparedBridgeError("Could not connect to the prepared Codex command bridge.", {
          cause: error
        }));
      };
      const connected = () => {
        if (settled) return;
        settled = true;
        socket.off("error", failed);
        this.attachSocket(socket);
        resolve();
      };
      socket.once("error", failed);
      socket.once("connect", connected);
    });
  }

  attachSocket(socket) {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.invalidate(socket, preparedBridgeError(
      "The prepared Codex command bridge failed.",
      { cause: error, delivery: "unknown" }
    )));
    socket.on("close", () => this.invalidate(socket, preparedBridgeError(
      "The prepared Codex command bridge closed.",
      { delivery: "unknown" }
    )));
  }

  handleData(chunk) {
    this.buffer += String(chunk ?? "");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Number.isInteger(response.id)) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok === true) {
        pending.resolve(response.value);
      } else {
        pending.reject(preparedBridgeError(
          response.error?.message ?? "Codex command bridge evaluation failed.",
          {
            code: response.error?.code ?? "MICRO_RENDERER_ERROR",
            delivery: response.error?.delivery ?? "unknown"
          }
        ));
      }
    }
  }

  async evaluate(expression, options = {}) {
    if (!this.isReady()) await this.prepare();
    const socket = this.socket;
    if (!socket || !this.token) {
      throw preparedBridgeError("The Codex command bridge is not ready.");
    }
    const id = ++this.nextId;
    const timeoutMs = Math.max(250, Math.trunc(
      options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    ));
    const payload = JSON.stringify({
      id,
      token: this.token,
      op: "evaluate",
      expression
    });
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      throw preparedBridgeError("The Codex command is too large.");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(preparedBridgeError("Codex prepared command response timed out.", {
          code: "MICRO_TIMEOUT",
          delivery: "unknown"
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        pending.reject(preparedBridgeError("Could not send the prepared Codex command.", {
          cause: error,
          delivery: "none"
        }));
      });
    });
  }

  invalidate(expected = null, error = null) {
    if (expected && this.socket !== expected) return;
    const socket = this.socket;
    this.socket = null;
    this.buffer = "";
    if (socket && !socket.destroyed) socket.destroy();
    const failure = error ?? preparedBridgeError("The prepared Codex command bridge disconnected.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  async close() {
    const socket = this.socket;
    const token = this.token;
    this.socket = null;
    this.buffer = "";
    this.socketPath = null;
    this.token = null;
    this.generation = null;
    const closingError = preparedBridgeError("The prepared Codex command bridge is closing.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closingError);
    }
    this.pending.clear();
    if (!socket || !token || socket.destroyed) {
      this.invalidate();
      return;
    }
    const id = ++this.nextId;
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 40);
        socket.write(`${JSON.stringify({ id, token, op: "close" })}\n`, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    } catch {
      // The Codex process may already be gone.
    }
    if (!socket.destroyed) socket.destroy();
  }
}

module.exports = {
  CodexPreparedRendererBridge,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  preparedBridgeBootstrapExpression,
  preparedBridgeError,
  safeSocketPath
};
