"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PENDING = 4096;
const MAX_QUEUED_BROADCASTS = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DISPATCHED = new Set([
  "no-client-found", "request-version-mismatch", "no-handler-for-request"
]);

class CodexIpcError extends Error {
  constructor(code, delivery = "none") {
    super(`Codex IPC: ${code}`);
    this.name = "CodexIpcError";
    this.code = code;
    this.delivery = delivery;
  }
}

function timeoutValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 60000) {
    throw new CodexIpcError("invalid-timeout");
  }
  return value;
}

// Read-only validation: never create, replace, repair, or change socket permissions.
async function validateCodexSocket(socketPath) {
  if (!path.isAbsolute(socketPath) || typeof process.getuid !== "function") {
    throw new CodexIpcError("untrusted-socket");
  }
  try {
    const [parent, socket] = await Promise.all([
      fs.lstat(path.dirname(socketPath)), fs.lstat(socketPath)
    ]);
    const uid = process.getuid();
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0 ||
        !socket.isSocket() || socket.uid !== uid) {
      throw new CodexIpcError("untrusted-socket");
    }
    return { dev: socket.dev, ino: socket.ino, parentDev: parent.dev, parentIno: parent.ino };
  } catch (error) {
    if (error instanceof CodexIpcError) throw error;
    throw new CodexIpcError("socket-unavailable");
  }
}

function validateMethod(method, version) {
  if (typeof method !== "string" || !method.length || method.length > 256 ||
      !Number.isSafeInteger(version) || version < 0) {
    throw new CodexIpcError("invalid-request");
  }
}

function sameSocketIdentity(before, after) {
  return ["dev", "ino", "parentDev", "parentIno"].every(key => before?.[key] === after?.[key]);
}

/**
 * Bounded client for the desktop's versioned IPC protocol. A connection must be
 * explicitly established; request/broadcast never reconnect or retry a decision.
 * request resolves the correlated full response, including server errors with a
 * delivery classification. Timeouts/disconnects after writing throw with unknown
 * delivery. None of these transport acknowledgments prove application success.
 */
class CodexIpcClient extends EventEmitter {
  constructor({
    socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock"),
    connectSocket = file => net.createConnection(file),
    validateSocket = validateCodexSocket,
    timeoutMs = 2500,
    maxFrameBytes = MAX_FRAME_BYTES
  } = {}) {
    super();
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) ||
        typeof connectSocket !== "function" || typeof validateSocket !== "function") {
      throw new CodexIpcError("invalid-options");
    }
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_FRAME_BYTES) {
      throw new CodexIpcError("invalid-frame-limit");
    }
    this.socketPath = socketPath;
    this.timeoutMs = timeoutValue(timeoutMs);
    this.maxFrameBytes = maxFrameBytes;
    this.epoch = 0;
    this.clientId = null;
    this._connectSocket = connectSocket;
    this._validateSocket = validateSocket;
    this._state = null;
    this._connecting = null;
  }

  isReady() {
    return Boolean(this._state?.ready && !this._state.socket?.destroyed && this.clientId);
  }

  connect() {
    if (this.isReady()) return Promise.resolve(this);
    if (this._connecting) return this._connecting;
    const state = {
      epoch: ++this.epoch, socket: null, ready: false, ended: false,
      pending: new Map(), header: Buffer.alloc(4), headerBytes: 0,
      body: null, bodyBytes: 0, broadcasts: [], broadcastBytes: 0,
      rejectConnect: null, connectTimer: null
    };
    this._state = state;
    let resolveConnect;
    const promise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      state.rejectConnect = reject;
    });
    this._connecting = promise;
    state.connectTimer = setTimeout(() => this._end(state, "connect-timeout"), this.timeoutMs);
    this._open(state).then(() => {
      if (state.ended || this._state !== state) return;
      clearTimeout(state.connectTimer);
      state.rejectConnect = null;
      state.ready = true;
      this._connecting = null;
      resolveConnect(this);
      const broadcasts = state.broadcasts;
      state.broadcasts = [];
      state.broadcastBytes = 0;
      // Let connect callers install their listeners before replaying early frames.
      queueMicrotask(() => {
        for (const message of broadcasts) {
          if (this._state !== state || state.ended) break;
          this._broadcastReceived(state, message, 0);
        }
      });
    }).catch(error => {
      this._end(state, error instanceof CodexIpcError ? error.code : "connect-failed");
    });
    return promise;
  }

  async _open(state) {
    const identity = await this._validateSocket(this.socketPath);
    if (identity === false) throw new CodexIpcError("untrusted-socket");
    if (this._state !== state || state.ended) return;
    const socket = this._connectSocket(this.socketPath);
    if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function" ||
        typeof socket.destroy !== "function") throw new CodexIpcError("invalid-socket");
    state.socket = socket;
    await new Promise((resolve, reject) => {
      state.rejectOpening = reject;
      socket.once("connect", () => {
        if (this._state !== state || state.ended) return;
        state.rejectOpening = null;
        resolve();
      });
      socket.on("data", chunk => {
        if (this._state === state && !state.ended) this._read(state, chunk);
      });
      socket.on("error", () => this._end(state, "socket-error"));
      socket.on("end", () => this._end(state, "disconnected"));
      socket.on("close", () => this._end(state, "disconnected"));
    });
    if (this._state !== state || state.ended) return;
    const after = await this._validateSocket(this.socketPath);
    if (after === false || !sameSocketIdentity(identity, after)) {
      throw new CodexIpcError("socket-changed");
    }
    if (this._state !== state || state.ended) return;
    const response = await this._request(state, "initialize", { clientType: "threaddeck" }, {}, true);
    if (response.resultType !== "success") throw new CodexIpcError(response.error, response.delivery);
    if (!UUID.test(response.result?.clientId || "")) throw new CodexIpcError("invalid-initialize");
    this.clientId = response.result.clientId;
  }

  request(method, params, options = {}) {
    try {
      if (!this.isReady()) throw new CodexIpcError("not-connected");
      return this._request(this._state, method, params, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _request(state, method, params, { version = 0, targetClientId, hostId, timeoutMs = this.timeoutMs } = {}, initializing = false) {
    validateMethod(method, version);
    timeoutValue(timeoutMs);
    if (targetClientId !== undefined && (typeof targetClientId !== "string" || !UUID.test(targetClientId))) {
      throw new CodexIpcError("invalid-target");
    }
    if (hostId !== undefined && (typeof hostId !== "string" || !hostId.length || hostId.length > 256)) {
      throw new CodexIpcError("invalid-host");
    }
    if (state.ended || !state.socket || (!initializing && !state.ready)) throw new CodexIpcError("not-connected");
    if (state.pending.size >= MAX_PENDING) throw new CodexIpcError("pending-limit");
    const requestId = randomUUID();
    const message = {
      type: "request", requestId, sourceClientId: initializing ? "initializing-client" : this.clientId,
      version, method, params, timeoutMs,
      ...(targetClientId === undefined ? {} : { targetClientId }),
      ...(hostId === undefined ? {} : { hostId })
    };
    const frame = this._encode(message);
    this._checkWriteCapacity(state, frame);
    return new Promise((resolve, reject) => {
      const pending = { method, targetClientId, resolve, reject, sent: false, timer: null };
      pending.timer = setTimeout(() => {
        if (state.pending.get(requestId) !== pending) return;
        state.pending.delete(requestId);
        reject(new CodexIpcError("request-timeout", pending.sent ? "unknown" : "none"));
      }, timeoutMs);
      state.pending.set(requestId, pending);
      // Set before write: a throwing or callback-failing write may have emitted bytes.
      pending.sent = true;
      this._write(state, frame);
    });
  }

  broadcast(method, params, { version = 0, targetClientIds } = {}) {
    if (!this.isReady()) throw new CodexIpcError("not-connected");
    validateMethod(method, version);
    if (targetClientIds !== undefined && (!Array.isArray(targetClientIds) || targetClientIds.length > MAX_PENDING ||
        targetClientIds.some(id => typeof id !== "string" || !UUID.test(id)))) {
      throw new CodexIpcError("invalid-target");
    }
    const frame = this._encode({
      type: "broadcast", method, version, sourceClientId: this.clientId, params,
      ...(targetClientIds === undefined ? {} : { targetClientIds })
    });
    const state = this._state;
    this._checkWriteCapacity(state, frame);
    this._write(state, frame);
    if (state.ended) throw new CodexIpcError("socket-write-failed", "unknown");
    return true;
  }

  _encode(message) {
    let body;
    try { body = Buffer.from(JSON.stringify(message), "utf8"); }
    catch { throw new CodexIpcError("invalid-json"); }
    if (!body.length || body.length > this.maxFrameBytes) throw new CodexIpcError("frame-limit");
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    return frame;
  }

  _write(state, frame) {
    if (state.ended || this._state !== state) return;
    try {
      this._checkWriteCapacity(state, frame);
      state.socket.write(frame, error => {
        if (error) this._end(state, "socket-write-failed");
      });
    } catch { this._end(state, "socket-write-failed"); }
  }

  _checkWriteCapacity(state, frame) {
    // Bound socket backpressure as well as individual frames and request count.
    // A refusal here is known to precede any write of this particular message.
    const queued = state.socket?.writableLength || 0;
    if (queued + frame.length > this.maxFrameBytes + 4) throw new CodexIpcError("write-queue-limit");
  }

  _read(state, chunk) {
    if (!Buffer.isBuffer(chunk)) { this._end(state, "invalid-frame"); return; }
    let offset = 0;
    while (offset < chunk.length && !state.ended) {
      if (!state.body) {
        const count = Math.min(4 - state.headerBytes, chunk.length - offset);
        chunk.copy(state.header, state.headerBytes, offset, offset + count);
        state.headerBytes += count;
        offset += count;
        if (state.headerBytes !== 4) continue;
        const length = state.header.readUInt32LE(0);
        if (length < 1 || length > this.maxFrameBytes) { this._end(state, "frame-limit"); return; }
        state.body = Buffer.allocUnsafe(length);
        state.bodyBytes = 0;
      }
      const count = Math.min(state.body.length - state.bodyBytes, chunk.length - offset);
      chunk.copy(state.body, state.bodyBytes, offset, offset + count);
      state.bodyBytes += count;
      offset += count;
      if (state.bodyBytes !== state.body.length) continue;
      const body = state.body;
      state.body = null;
      state.bodyBytes = 0;
      state.headerBytes = 0;
      let message;
      try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { this._end(state, "invalid-json"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this._end(state, "invalid-message"); return;
      }
      this._message(state, message, body.length);
    }
  }

  _message(state, message, bytes) {
    if (message.type === "response") {
      const pending = state.pending.get(message.requestId);
      if (!pending) return; // Expired/previous-generation responses never resolve a new request.
      if ((message.resultType !== "success" && message.resultType !== "error") ||
          (message.resultType === "success" && (message.method !== pending.method || !UUID.test(message.handledByClientId || ""))) ||
          (message.method !== undefined && message.method !== pending.method) ||
          (message.handledByClientId !== undefined && pending.targetClientId !== undefined && message.handledByClientId !== pending.targetClientId) ||
          (message.resultType === "error" && (typeof message.error !== "string" || !message.error.length || message.error.length > 256))) {
        this._end(state, "invalid-response"); return;
      }
      state.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message.resultType === "error"
        ? { ...message, delivery: NOT_DISPATCHED.has(message.error) ? "none" : "unknown" }
        : message);
    } else if (message.type === "broadcast") {
      this._broadcastReceived(state, message, bytes);
    } else if (message.type === "client-discovery-request") {
      if (!UUID.test(message.requestId || "")) { this._end(state, "invalid-discovery"); return; }
      this._write(state, this._encode({
        type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false }
      }));
    }
    // This client executes no incoming request or advertised handler.
  }

  _broadcastReceived(state, message, bytes) {
    if (typeof message.method !== "string" || !message.method.length || message.method.length > 256 ||
        !Number.isSafeInteger(message.version) || message.version < 0 || !UUID.test(message.sourceClientId || "") ||
        (message.targetClientIds !== undefined && (!Array.isArray(message.targetClientIds) ||
          message.targetClientIds.length > MAX_PENDING || message.targetClientIds.some(id => typeof id !== "string" || !UUID.test(id))))) {
      this._end(state, "invalid-broadcast"); return;
    }
    if (!state.ready) {
      if (state.broadcasts.length >= MAX_QUEUED_BROADCASTS || state.broadcastBytes + bytes > this.maxFrameBytes) {
        this._end(state, "broadcast-queue-limit"); return;
      }
      state.broadcasts.push(message);
      state.broadcastBytes += bytes;
      return;
    }
    if (message.targetClientIds !== undefined && !message.targetClientIds.includes(this.clientId)) return;
    this.emit("broadcast", message);
  }

  _end(state, code) {
    if (state.ended) return;
    state.ended = true;
    state.ready = false;
    clearTimeout(state.connectTimer);
    state.rejectOpening?.(new CodexIpcError(code));
    state.rejectOpening = null;
    state.rejectConnect?.(new CodexIpcError(code));
    state.rejectConnect = null;
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexIpcError(code, pending.sent ? "unknown" : "none"));
    }
    state.pending.clear();
    state.body = null;
    state.broadcasts = [];
    state.broadcastBytes = 0;
    if (this._state === state) {
      this._state = null;
      this._connecting = null;
      this.clientId = null;
      this.epoch++;
    }
    state.socket?.destroy();
    this.emit("disconnect", new CodexIpcError(code));
  }

  close() {
    if (this._state) this._end(this._state, "closed");
  }
}

module.exports = { CodexIpcClient, CodexIpcError, validateCodexSocket };
