import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const markdownFiles = [
  ...fs.readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, name)),
  ...fs.readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, "docs", name))
];
const failures = [];

function checkTarget(file, target) {
  if (/^(?:https?:|mailto:|#)/.test(target)) return;
  const decoded = decodeURIComponent(target.split("#", 1)[0]);
  if (!decoded) return;
  const resolved = path.resolve(path.dirname(file), decoded);
  if (!fs.existsSync(resolved)) {
    failures.push(`${path.relative(root, file)}: missing ${target}`);
  }
}

for (const file of markdownFiles) {
  const contents = fs.readFileSync(file, "utf8");
  for (const match of contents.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) checkTarget(file, match[1]);
  for (const match of contents.matchAll(/(?:href|src)="([^"]+)"/g)) checkTarget(file, match[1]);
}

const requiredImages = [
  "docs/media/neo-preview.svg",
  "docs/media/neo-preview-light.svg",
  "docs/media/neo-preview.png",
  "docs/media/neo-preview-light.png",
  "docs/media/threaddeck-overview.gif",
  "docs/media/task-hold-to-talk.gif",
  "docs/media/voice-hold-to-dictate.gif",
  "docs/media/send-long-press.gif",
  "docs/media/app-launcher-long-press.gif",
  "docs/media/quota-key.png",
  "docs/media/working-task-key.png",
  "docs/media/completed-task-key.png",
  "docs/media/side-chat-key.png"
];
for (const image of requiredImages) {
  const target = path.join(root, image);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) failures.push(`${image}: missing or empty`);
}

for (const image of ["docs/media/neo-preview.svg", "docs/media/neo-preview-light.svg"]) {
  const contents = fs.readFileSync(path.join(root, image), "utf8");
  const roundedClips = contents.match(/<clipPath id="demoKeyClip\d+">/g) ?? [];
  const clippedKeys = contents.match(/clip-path="url\(#demoKeyClip\d+\)"/g) ?? [];
  if (roundedClips.length !== 8 || clippedKeys.length !== 8) {
    failures.push(`${image}: expected eight rounded documentation key masks`);
  }
}

function gifMetadata(buffer) {
  if (buffer.length < 14) throw new Error("truncated logical screen descriptor");
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (!/^GIF8[79]a$/.test(signature)) throw new Error(`invalid signature ${signature || "empty"}`);
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  let offset = 13;
  const requireBytes = (count, label) => {
    if (offset + count > buffer.length) throw new Error(`truncated ${label}`);
  };
  const globalColorPacked = buffer[10];
  if (globalColorPacked & 0x80) {
    const tableLength = 3 * (1 << ((globalColorPacked & 0x07) + 1));
    requireBytes(tableLength, "global color table");
    offset += tableLength;
  }

  const readSubBlocks = (label) => {
    let totalLength = 0;
    const blocks = [];
    while (true) {
      requireBytes(1, `${label} block size`);
      const length = buffer[offset++];
      if (length === 0) break;
      requireBytes(length, `${label} block data`);
      blocks.push(buffer.subarray(offset, offset + length));
      totalLength += length;
      offset += length;
    }
    return { blocks, totalLength };
  };

  let frameCount = 0;
  const frameDelays = [];
  let loopCount = null;
  let foundTrailer = false;
  while (offset < buffer.length) {
    const introducer = buffer[offset++];
    if (introducer === 0x3B) {
      foundTrailer = true;
      break;
    }
    if (introducer === 0x2C) {
      requireBytes(9, "image descriptor");
      const packed = buffer[offset + 8];
      offset += 9;
      if (packed & 0x80) {
        const tableLength = 3 * (1 << ((packed & 0x07) + 1));
        requireBytes(tableLength, "local color table");
        offset += tableLength;
      }
      requireBytes(1, "LZW minimum code size");
      offset += 1;
      const imageData = readSubBlocks("image data");
      if (imageData.totalLength === 0) throw new Error("empty image data");
      frameCount += 1;
      continue;
    }
    if (introducer !== 0x21) throw new Error(`unexpected block introducer 0x${introducer.toString(16)}`);

    requireBytes(1, "extension label");
    const label = buffer[offset++];
    if (label === 0xF9) {
      requireBytes(1, "graphic control block size");
      const blockLength = buffer[offset++];
      if (blockLength !== 4) throw new Error(`invalid graphic control length ${blockLength}`);
      requireBytes(5, "graphic control data");
      frameDelays.push(buffer.readUInt16LE(offset + 1));
      offset += 4;
      if (buffer[offset++] !== 0) throw new Error("missing graphic control terminator");
      continue;
    }

    requireBytes(1, "extension header size");
    const headerLength = buffer[offset++];
    requireBytes(headerLength, "extension header");
    const header = buffer.subarray(offset, offset + headerLength);
    offset += headerLength;
    const data = readSubBlocks("extension data");
    if (label === 0xFF && header.toString("ascii") === "NETSCAPE2.0") {
      const loopBlock = data.blocks.find((block) => block.length === 3 && block[0] === 1);
      if (loopBlock) loopCount = loopBlock.readUInt16LE(1);
    }
  }

  if (!foundTrailer) throw new Error("missing GIF trailer");
  if (offset !== buffer.length) throw new Error(`${buffer.length - offset} trailing bytes after GIF trailer`);
  if (frameDelays.length !== frameCount) {
    throw new Error(`${frameCount} frames but ${frameDelays.length} graphic-control delays`);
  }
  return { signature, width, height, frameCount, frameDelays, loopCount };
}

const expectedGifMetadata = new Map([
  ["docs/media/threaddeck-overview.gif", { width: 960, height: 507, frames: 200, delay: 3 }],
  ["docs/media/task-hold-to-talk.gif", { width: 960, height: 420, frames: 120, delay: 5 }],
  ["docs/media/voice-hold-to-dictate.gif", { width: 960, height: 420, frames: 104, delay: 5 }],
  ["docs/media/send-long-press.gif", { width: 960, height: 420, frames: 108, delay: 5 }],
  ["docs/media/app-launcher-long-press.gif", { width: 960, height: 420, frames: 100, delay: 5 }]
]);
for (const [image, expected] of expectedGifMetadata) {
  const target = path.join(root, image);
  if (!fs.existsSync(target)) continue;
  try {
    const actual = gifMetadata(fs.readFileSync(target));
    const delaysMatch = actual.frameDelays.every((delay) => delay === expected.delay);
    if (actual.width !== expected.width || actual.height !== expected.height
        || actual.frameCount !== expected.frames || !delaysMatch || actual.loopCount !== 0) {
      failures.push(
        `${image}: expected ${expected.width}x${expected.height}, ${expected.frames} frames, `
        + `${expected.delay} cs delay, loop 0; found ${actual.width}x${actual.height}, `
        + `${actual.frameCount} frames, delays ${[...new Set(actual.frameDelays)].join(",")}, loop ${actual.loopCount}`
      );
    }
  } catch (error) {
    failures.push(`${image}: invalid GIF structure: ${error?.message ?? "unknown error"}`);
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Documentation verification passed: ${markdownFiles.length} Markdown files and ${requiredImages.length} images checked.`);

export { gifMetadata };
