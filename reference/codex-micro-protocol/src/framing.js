// HID report framing for Work Louder / Codex Micro devices.
//
// Every logical message travels as one or more 64-byte HID reports:
//
//   byte 0 : 0x06        report ID
//   byte 1 : channel     1 = debug log, 2 = RPC
//   byte 2 : length      number of payload bytes in this report (0..61)
//   3..63  : payload     up to 61 UTF-8 bytes; longer messages span reports
//
// The receiver concatenates payloads per channel until it sees a newline,
// then hands the complete line to the RPC layer. This mirrors the framing in
// @worklouder/wl-device-kit's WLDeviceCommImpl exactly, so the ChatGPT app's
// bridge cannot tell us apart from real firmware.

export const REPORT_ID = 0x06;
export const REPORT_SIZE = 64; // report ID + 63 data bytes
export const MAX_PAYLOAD = 61; // 64 - (reportID + channel + length)

export const Channel = Object.freeze({
  DEBUG: 1,
  RPC: 2,
});

/**
 * Split a UTF-8 string into one or more 64-byte HID reports on a channel.
 * @param {string} message
 * @param {number} channel
 * @returns {Buffer[]}
 */
export function encode(message, channel = Channel.RPC) {
  const bytes = Buffer.from(message, "utf8");
  const reports = [];
  let offset = 0;

  do {
    const chunk = Math.min(MAX_PAYLOAD, bytes.length - offset);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = channel;
    report[2] = chunk;
    bytes.copy(report, 3, offset, offset + chunk);
    reports.push(report);
    offset += chunk;
  } while (offset < bytes.length);

  return reports;
}

/**
 * Reassembles inbound reports into complete messages, demultiplexed by channel.
 *
 * The two directions are framed differently, mirroring the real firmware:
 *   - RPC channel (host → device): the app sends bare JSON with NO terminator
 *     (`WLRPCClient.sendRpcCall` writes the escaped JSON directly). So we detect
 *     complete objects by scanning for balanced braces — not by newline. Getting
 *     this wrong means every request silently never completes and the app's RPC
 *     queue times out.
 *   - Debug channel: newline-delimited log lines.
 */
export class Reassembler {
  constructor() {
    /** @type {Record<number, string>} */
    this.buffers = { [Channel.DEBUG]: "", [Channel.RPC]: "" };
  }

  /**
   * Push one raw HID report (with or without the leading report-ID byte —
   * some kernels strip it on read, so we detect and normalise).
   * @param {Buffer} report
   * @returns {{channel: number, message: string}[]} completed messages
   */
  push(report) {
    const view = normaliseReport(report);
    const channel = view[0];
    const length = view[1];
    const payload = view.subarray(2, 2 + length).toString("utf8");

    if (this.buffers[channel] === undefined) this.buffers[channel] = "";
    this.buffers[channel] += payload;

    if (channel === Channel.RPC) {
      const { objects, rest } = extractJsonObjects(this.buffers[channel]);
      this.buffers[channel] = rest;
      return objects.map((message) => ({ channel, message }));
    }

    // Debug channel: newline-delimited.
    const out = [];
    const parts = this.buffers[channel].split(/\r?\n/);
    this.buffers[channel] = parts.pop() ?? "";
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push({ channel, message: t });
    }
    return out;
  }
}

/**
 * Extract every complete top-level JSON object from `buf`, returning them plus
 * any trailing incomplete remainder. Scans for balanced `{`/`}` while respecting
 * string literals and escapes, so it works with no delimiter, with newlines, or
 * with several objects back-to-back.
 * @param {string} buf
 * @returns {{objects: string[], rest: string}}
 */
export function extractJsonObjects(buf) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let lastEnd = 0;

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objects.push(buf.slice(start, i + 1));
          lastEnd = i + 1;
          start = -1;
        }
      }
    }
  }

  // Keep the tail from an in-progress object (depth > 0), else drop consumed
  // bytes and any inter-object filler (whitespace/newlines).
  const rest = depth > 0 && start >= 0 ? buf.slice(start) : buf.slice(lastEnd);
  return { objects, rest };
}

/**
 * A report may arrive as 64 bytes ([reportID, channel, len, ...]) or as 63
 * bytes with the report ID already stripped by the kernel ([channel, len, ...]).
 * Return a view whose byte 0 is `channel`.
 * @param {Buffer} report
 */
function normaliseReport(report) {
  if (report.length >= 1 && report[0] === REPORT_ID) {
    return report.subarray(1);
  }
  return report;
}
