"use strict";

const { execFile } = require("node:child_process");
const { open } = require("node:fs/promises");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const READ_SIZE = 64 * 1024;

// Electron's public schema-v1 fuse wire stores EnableNodeCliInspectArguments
// at index 3. Every copy (including other universal-binary slices) must agree.
async function readNodeCliInspectFuse(handle, options = {}) {
  const chunkSize = Math.max(1, Math.min(READ_SIZE, Math.trunc(options.chunkSize ?? READ_SIZE)));
  const chunk = Buffer.alloc(chunkSize);
  let pending = Buffer.alloc(0);
  let found = false;
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    const bytes = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let offset = 0;
    let incomplete = -1;
    while ((offset = bytes.indexOf(FUSE_SENTINEL, offset)) !== -1) {
      const header = offset + FUSE_SENTINEL.length;
      if (bytes.length < header + 2) {
        incomplete = offset;
        break;
      }
      const version = bytes[header];
      const count = bytes[header + 1];
      if (version !== 1 || count < 4) return false;
      if (bytes.length < header + 2 + count) {
        incomplete = offset;
        break;
      }
      const wire = bytes.subarray(header + 2, header + 2 + count);
      if (wire[3] !== 0x31 || wire.some((state) => ![0x30, 0x31, 0x72].includes(state))) return false;
      found = true;
      offset += 1;
    }
    if (bytesRead === 0) return incomplete === -1 && found;
    // An incomplete record is at most sentinel + two header bytes + 254 wire
    // bytes. Otherwise only a possible split sentinel needs to survive a read.
    pending = Buffer.from(bytes.subarray(incomplete === -1
      ? Math.max(0, bytes.length - FUSE_SENTINEL.length + 1)
      : incomplete));
  }
}

function numericIdentity(value) {
  return /^(?:0x[\da-f]+|\d+)$/i.test(value ?? "") ? BigInt(value) : null;
}

function loadedFramework(main, output) {
  const app = String(main.command ?? "").match(
    /^((?:\/[^/\r\n]+)*\/(?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/[^/\s]+(?:\s|$)/
  )?.[1];
  if (!app) return null;
  const prefix = `${app}/Contents/Frameworks/`;
  const mappings = new Map();
  let record = null;
  let pid = main.pid;
  let invalid = false;
  const finishRecord = () => {
    if (record?.f !== "txt" || !record.n?.startsWith(prefix)) return;
    const relative = record.n.slice(prefix.length);
    if (!/^([^/]+ Framework)\.framework\/(?:Versions\/[^/]+\/)?\1$/.test(relative)) return;
    const dev = numericIdentity(record.D);
    const ino = numericIdentity(record.i);
    if (record.invalid || pid !== main.pid || dev === null || ino === null) {
      invalid = true;
      return;
    }
    const key = `${dev}:${ino}`;
    if (!mappings.has(key)) mappings.set(key, { path: record.n, dev, ino });
  };
  for (const line of String(output ?? "").split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "f" || field === "p") {
      finishRecord();
      record = field === "f" ? { f: value } : null;
      if (field === "p") pid = Number(value);
    } else if (record && ["D", "i", "n"].includes(field)) {
      if (record[field] !== undefined) record.invalid = true;
      record[field] = value;
    }
  }
  finishRecord();
  return !invalid && mappings.size === 1 ? mappings.values().next().value : null;
}

async function supportsNodeCliInspectArguments(main, options = {}) {
  let handle;
  try {
    const result = await (options.execFile ?? execFileAsync)("/usr/sbin/lsof", [
      "-nP", "-a", "-p", String(main.pid), "-d", "txt", "-FfniD"
    ], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
    const mapping = loadedFramework(main, result?.stdout ?? result ?? "");
    if (!mapping) return false;
    handle = await (options.open ?? open)(mapping.path, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== mapping.dev || before.ino !== mapping.ino) return false;
    if (!await readNodeCliInspectFuse(handle, options)) return false;
    const after = await handle.stat({ bigint: true });
    return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => before[key] === after[key]);
  } catch {
    // Missing/unknown fuses and inspection failures are not permission to send
    // SIGUSR1: that signal can terminate Electron when inspector support is off.
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = {
  readNodeCliInspectFuse,
  supportsNodeCliInspectArguments
};
