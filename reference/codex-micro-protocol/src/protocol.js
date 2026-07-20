// JSON-RPC method names, notification channels, keycodes, and lighting enums
// used by the Codex Micro / OpenAI integration. Values are lifted verbatim from
// @worklouder/device-kit-oai and @worklouder/wl-device-kit so the ChatGPT app's
// CodexMicroService talks to us unmodified.

// USB descriptor identity the ChatGPT app's discovery matches on.
export const USB = Object.freeze({
  VENDOR_ID: 0x303a, // Espressif — every Work Louder device
  PRODUCT_ID: 0x8360, // Codex Micro (a.k.a. "Project2077")
  USAGE_PAGE: 0xff00, // vendor-defined; the interface must expose this
  MANUFACTURER: "Work Louder",
  PRODUCT: "Codex Micro",
});

// Requests the host (ChatGPT app) sends to us.
export const Method = Object.freeze({
  DEVICE_STATUS: "device.status",
  SYS_VERSION: "sys.version",
  LIGHTS_PREVIEW: "lights.preview",
  // Vendor / OAI-specific.
  OAI_RGB_CONFIG: "v.oai.rgbcfg", // keys + ambient-ring lighting
  OAI_THREADS_LIGHTING: "v.oai.thstatus", // per-thread (slot) lighting
});

// Notifications we send to the host (no id field).
export const Notify = Object.freeze({
  HID: "v.oai.hid", // key press/release
  JOYSTICK: "v.oai.rad", // radial / joystick movement
});

// LED animation effects (OAILightingEffect).
export const Effect = Object.freeze({
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
});

// Key identifiers carried in v.oai.hid notifications. These are the
// KV_OAI_* configurator keycodes with the "KV_OAI_" prefix stripped — the
// exact strings the firmware reports and the service's /^AG0([0-5])$/ expects.
export const Keys = Object.freeze({
  // Six agent / thread keys — map to lighting slots 0..5.
  AGENT: ["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"],
  // Action keys.
  ACTION: ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"],
  // Encoder events.
  ENCODER_CCW: "ENC_CC",
  ENCODER_CW: "ENC_CW",
  ENCODER_CLICK: "ENC_CLK",
});

// HID action types (act field). Value 2 doubles as the encoder rotation-tick
// action: the app only advances reasoning depth on ENC_CW/ENC_CC when act === 2
// (mapping them to ArrowUp/ArrowDown); it ignores those keys with act 0/1.
export const Act = Object.freeze({
  RELEASE: 0,
  PRESS: 1,
  HOLD: 2,
  ROTATE: 2,
});

/**
 * Build a JSON-RPC response line for a request id. The firmware protocol omits
 * the "jsonrpc" field and terminates every message with a newline.
 * @param {number|string} id
 * @param {*} result
 */
export function response(id, result) {
  return JSON.stringify({ id: typeof id === "string" ? Number(id) : id, result }) + "\n";
}

/**
 * Build a JSON-RPC error response line.
 * @param {number|string} id
 * @param {number} code
 * @param {string} message
 */
export function errorResponse(id, code, message) {
  return (
    JSON.stringify({ id: typeof id === "string" ? Number(id) : id, error: { code, message } }) + "\n"
  );
}

/**
 * Build a notification line (device -> host). Uses the compact {m, p} form the
 * firmware emits; the host accepts both compact and long-form.
 * @param {string} method
 * @param {*} params
 */
export function notification(method, params) {
  return JSON.stringify({ m: method, p: params }) + "\n";
}

// HID report descriptor for the virtual device: a single vendor-defined
// (usage page 0xFF00) application collection with report ID 6, a 63-byte input
// report and a 63-byte output report. The primary usage page of 0xFF00 is what
// the ChatGPT app's discovery requires (`device.usagePage !== 0xFF00` is
// rejected). The native helper hands these bytes to IOHIDUserDevice.
export const REPORT_DESCRIPTOR = Uint8Array.from([
  0x06, 0x00, 0xff, // Usage Page (Vendor-Defined 0xFF00)
  0x09, 0x01, //       Usage (0x01)
  0xa1, 0x01, //       Collection (Application)
  0x85, 0x06, //         Report ID (6)
  0x09, 0x01, //         Usage (0x01)
  0x15, 0x00, //         Logical Minimum (0)
  0x26, 0xff, 0x00, //   Logical Maximum (255)
  0x75, 0x08, //         Report Size (8 bits)
  0x95, 0x3f, //         Report Count (63)
  0x81, 0x02, //         Input (Data,Var,Abs)
  0x09, 0x01, //         Usage (0x01)
  0x91, 0x02, //         Output (Data,Var,Abs)
  0xc0, //             End Collection
]);

/**
 * Device identity properties the native helper sets on the virtual device so
 * the ChatGPT app recognises it. bcdDevice keeps its low two bits clear so the
 * app classifies the link as USB (`(release & 0x0003) === 0`).
 */
export const DEVICE_PROPERTIES = Object.freeze({
  vendorId: USB.VENDOR_ID,
  productId: USB.PRODUCT_ID,
  versionNumber: 0x0100,
  manufacturer: USB.MANUFACTURER,
  product: USB.PRODUCT,
  primaryUsagePage: USB.USAGE_PAGE,
  primaryUsage: 0x01,
  transport: "USB",
});

/**
 * Parse an inbound JSON-RPC line, tolerating both compact and long field names.
 * @param {string} line
 * @returns {{id?: number, method?: string, params?: *}}
 */
export function parse(line) {
  const obj = JSON.parse(line);
  const rawId = obj.id ?? obj.i;
  return {
    id: rawId === undefined ? undefined : Number(rawId),
    method: obj.method ?? obj.m,
    params: obj.params ?? obj.p ?? null,
  };
}
