"use strict";

const fs = require("node:fs");

function ensureKeyBridgeExecutable(bridgePath, fileSystem = fs) {
  try {
    fileSystem.accessSync(bridgePath, fileSystem.constants.X_OK);
    return false;
  } catch {
    // Elgato's .streamDeckPlugin packer currently stores entries as FAT ZIP
    // files, so the executable bit on native helpers can be lost when the
    // package is installed. The JavaScript entry point still runs under the
    // Stream Deck Node runtime and can restore the helper before first use.
  }

  fileSystem.chmodSync(bridgePath, 0o755);
  fileSystem.accessSync(bridgePath, fileSystem.constants.X_OK);
  return true;
}

module.exports = { ensureKeyBridgeExecutable };
