// Agent-slot state colors, reverse-engineered from the ChatGPT app's status →
// packed-RGB function (`Vf` in its main bundle). These are the colors the app
// pushes to the device over v.oai.thstatus, so at runtime we simply paint what
// the app sends. This table is kept for reference and for the offline/keyboard
// demo mode, where we synthesise the same colors ourselves.
//
// The app derives a slot's status from the thread's latest turn:
//   failed                    -> "error"
//   pending | in_progress     -> "working"   (shown as "thinking")
//   has unread completed turn -> "unread"     (shown as "complete")
//   otherwise                 -> "idle"
//   awaiting approval/response-> "awaiting-*" (shown as "needs input")

/** status id -> packed 0xRRGGBB integer (as the firmware receives it). */
export const STATE_COLOR = Object.freeze({
  idle: 16777215, //          0xFFFFFF  white
  working: 3166206, //        0x304FFE  blue     ("thinking")
  unread: 65356, //           0x00FF4C  green    ("complete")
  "awaiting-approval": 16739584, // 0xFF6D00 amber ("needs input")
  "awaiting-response": 16739584, // 0xFF6D00 amber ("needs input")
  error: 16711731, //         0xFF0033  pink     ("error")
  off: 0, //                  0x000000  off
});

/** Friendly label -> status id, matching the on-device legend. */
export const LABEL_TO_STATE = Object.freeze({
  idle: "idle",
  thinking: "working",
  complete: "unread",
  "needs-input": "awaiting-approval",
  error: "error",
  off: "off",
});

/** Unpack a packed-RGB integer into { r, g, b }. */
export function toRgb(color) {
  const c = color >>> 0;
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

/** Look up the RGB for a state id (or friendly label). */
export function stateRgb(state) {
  const id = STATE_COLOR[state] !== undefined ? state : LABEL_TO_STATE[state];
  return toRgb(STATE_COLOR[id] ?? 0);
}
