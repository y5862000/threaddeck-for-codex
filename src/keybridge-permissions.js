"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXECUTABLE_MODE = 0o755;

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function runtimeKeyBridgeIsCurrent(runtimePath, expectedDigest, fileSystem = fs) {
  try {
    fileSystem.accessSync(runtimePath, fileSystem.constants.X_OK);
    return sha256(fileSystem.readFileSync(runtimePath)) === expectedDigest;
  } catch {
    return false;
  }
}

function prepareKeyBridgeExecutable(bridgePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const bundledContents = fileSystem.readFileSync(bridgePath);
  const digest = sha256(bundledContents);
  const cacheDirectory = path.resolve(
    options.cacheDirectory
      || process.env.THREADDECK_KEYBRIDGE_CACHE_DIR
      || path.join(os.homedir(), "Library", "Application Support", "ThreadDeck", "bin")
  );
  const runtimePath = path.join(cacheDirectory, `keybridge-${digest}`);

  fileSystem.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync(cacheDirectory, 0o700);
  if (runtimeKeyBridgeIsCurrent(runtimePath, digest, fileSystem)) return runtimePath;

  // Marketplace DRM requires every distributed file to remain immutable.
  // Elgato's FAT-compatible package can still strip a native helper's execute
  // bit, so stage an exact content-addressed copy in the user's writable
  // Application Support directory instead of modifying the plugin bundle.
  const temporaryPath = `${runtimePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, bundledContents, { flag: "wx", mode: 0o700 });
    fileSystem.chmodSync(temporaryPath, EXECUTABLE_MODE);
    fileSystem.renameSync(temporaryPath, runtimePath);
  } finally {
    fileSystem.rmSync(temporaryPath, { force: true });
  }

  if (!runtimeKeyBridgeIsCurrent(runtimePath, digest, fileSystem)) {
    throw new Error("ThreadDeck could not prepare an immutable KeyBridge runtime copy");
  }
  return runtimePath;
}

module.exports = { prepareKeyBridgeExecutable, runtimeKeyBridgeIsCurrent };
