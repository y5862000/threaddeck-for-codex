"use strict";

// Preload before plugin imports: a missed fixture dependency must fail the
// subprocess before it can activate Codex, send input, or signal its inspector.
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const root = path.resolve(__dirname, "../..");
const writeDiagnostic = fs.writeSync.bind(fs);

function deny(operation) {
  writeDiagnostic(2, `${new Error(`Live I/O forbidden in verification: ${operation}`).stack}\n`);
  process.exit(86);
}

const childProcess = require("node:child_process");
for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  childProcess[name] = () => deny(`child_process.${name}`);
}
process.kill = () => deny("process.kill");
require("node:net").Socket.prototype.connect = () => deny("net.Socket.connect");
globalThis.fetch = () => deny("fetch");
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() { deny("WebSocket"); }
};

function allowRepositoryRead(value) {
  if (typeof value === "number") return;
  const filename = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) deny("host file read");
}

for (const target of [fs, fs.promises]) {
  for (const name of ["readFile", "readFileSync", "readdir", "readdirSync", "createReadStream"]) {
    if (typeof target[name] !== "function") continue;
    const original = target[name].bind(target);
    target[name] = (filename, ...args) => {
      allowRepositoryRead(filename);
      return original(filename, ...args);
    };
  }
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync",
    "rename", "renameSync", "rm", "rmSync", "unlink", "unlinkSync", "copyFile", "copyFileSync",
    "chmod", "chmodSync", "createWriteStream", "open", "openSync"]) {
    if (typeof target[name] === "function") target[name] = () => deny(`fs.${name}`);
  }
}
