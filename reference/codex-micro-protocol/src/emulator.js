import { EventEmitter } from "node:events";
import {
  Method,
  Notify,
  Act,
  Keys,
  response,
  notification,
  parse,
} from "./protocol.js";

// Number of agent/thread slots on a Codex Micro.
export const SLOT_COUNT = 6;

/**
 * Stateful emulation of Codex Micro firmware at the JSON-RPC layer.
 *
 * Transport-agnostic: feed it complete inbound RPC lines via {@link handleLine}
 * and listen for `send` events carrying outbound lines (responses and
 * notifications). It also emits `lighting` whenever the host pushes a new
 * lighting configuration, so a physical backend (e.g. a Stream Deck) can react.
 *
 * Events:
 *   - `send`     (line: string)            an outbound RPC/notification line
 *   - `lighting` (model: LightingModel)    host asked us to change lighting
 *   - `request`  ({method, params, id})    every inbound request (for logging)
 *   - `log`      (level, ...args)
 */
export class CodexMicroEmulator extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.firmwareVersion]
   * @param {number} [opts.battery]      0..100
   * @param {boolean} [opts.charging]
   */
  constructor(opts = {}) {
    super();
    this.firmwareVersion = opts.firmwareVersion ?? "1.0.0";
    this.battery = opts.battery ?? 100;
    this.charging = opts.charging ?? false;
    this.profileIndex = 0;
    this.layerIndex = 0;

    // Latest lighting the host requested, surfaced to physical backends.
    this.lighting = {
      keys: null, // {e,b,s,m,c} from v.oai.rgbcfg
      ambient: null, // {e,b,s,m,c} from v.oai.rgbcfg
      slots: new Array(SLOT_COUNT).fill(null), // per-thread from v.oai.thstatus
    };
  }

  /**
   * Process one complete inbound JSON-RPC line and emit any response.
   * Every request that carries an id gets a reply — the host's transport
   * blocks its send queue on a per-id response (10 s timeout), so a missing
   * reply is what stalls the real bridge (see openai/codex#33409).
   * @param {string} line
   */
  handleLine(line) {
    let msg;
    try {
      msg = parse(line);
    } catch (err) {
      this.emit("log", "warn", "unparseable RPC line", line, err.message);
      return;
    }

    const { id, method, params } = msg;

    // Notifications from the host (no id) — none are expected; ignore politely.
    if (id === undefined) {
      this.emit("log", "debug", "ignoring host notification", method);
      return;
    }

    this.emit("request", { id, method, params });

    switch (method) {
      case Method.DEVICE_STATUS:
        this._send(response(id, this._status()));
        break;

      case Method.SYS_VERSION:
        this._send(response(id, this.firmwareVersion));
        break;

      case Method.OAI_RGB_CONFIG:
        this._applyRgbConfig(params);
        this._send(response(id, true));
        break;

      case Method.OAI_THREADS_LIGHTING:
        this._applyThreadsLighting(params);
        this._send(response(id, true));
        break;

      case Method.LIGHTS_PREVIEW:
        // Live preview from the configurator; acknowledge without persisting.
        this._send(response(id, true));
        break;

      default:
        // Unknown method: acknowledge so the host never blocks waiting on us.
        this.emit("log", "debug", "acking unknown method", method);
        this._send(response(id, true));
        break;
    }
  }

  /** Current device.status result payload. */
  _status() {
    return {
      version: this.firmwareVersion,
      profile_index: this.profileIndex,
      layer_index: this.layerIndex,
      battery: this.battery,
      is_charging: this.charging,
    };
  }

  _applyRgbConfig(params) {
    if (!params || typeof params !== "object") return;
    this.lighting.keys = params.keys ?? this.lighting.keys;
    this.lighting.ambient = params.ambient ?? this.lighting.ambient;
    this._emitLighting();
  }

  _applyThreadsLighting(params) {
    if (!Array.isArray(params)) return;
    for (const thread of params) {
      if (thread && typeof thread.id === "number" && thread.id >= 0 && thread.id < SLOT_COUNT) {
        this.lighting.slots[thread.id] = thread;
      }
    }
    this._emitLighting();
  }

  _emitLighting() {
    // Deep-ish clone so listeners can't mutate our state.
    this.emit("lighting", {
      keys: this.lighting.keys ? { ...this.lighting.keys } : null,
      ambient: this.lighting.ambient ? { ...this.lighting.ambient } : null,
      slots: this.lighting.slots.map((s) => (s ? { ...s } : null)),
    });
  }

  // ---- Physical input -> host notifications -------------------------------

  /**
   * Emit a HID key notification to the host.
   * @param {string} key   e.g. "AG00", "ACT06", "ENC_CW"
   * @param {number} [act] Act.PRESS / Act.RELEASE / Act.HOLD
   * @param {number|null} [agent]
   */
  sendKey(key, act = Act.PRESS, agent = null) {
    const p = { k: key, act };
    if (agent !== null) p.ag = agent;
    this._send(notification(Notify.HID, p));
  }

  /** Convenience: press then release an agent key for slot i (0..5). */
  tapAgent(i) {
    this.sendKey(Keys.AGENT[i], Act.PRESS, i);
    this.sendKey(Keys.AGENT[i], Act.RELEASE, i);
  }

  /** Convenience: press then release an action key by its full id, e.g. "ACT06". */
  tapAction(key) {
    this.sendKey(key, Act.PRESS);
    this.sendKey(key, Act.RELEASE);
  }

  /**
   * Emit a joystick/radial movement notification.
   * @param {number} angle    0..1
   * @param {number} distance 0..1  (host treats distance <= 0.1 as noise)
   */
  sendJoystick(angle, distance) {
    this._send(notification(Notify.JOYSTICK, { a: angle, d: distance }));
  }

  _send(line) {
    this.emit("send", line);
  }
}
