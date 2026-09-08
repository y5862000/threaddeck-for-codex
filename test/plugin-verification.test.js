"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const guard = path.join(__dirname, "helpers/deny-live-io.cjs");
const plugin = process.env.THREADDECK_VERIFY_PLUGIN ?? path.join(root, "src/plugin.js");

for (const mode of ["completion", "refresh-resilience", "usage-cache", "voice-submit", "interactions", "approvals"]) {
  test(`--verify-${mode} passes without live host I/O`, { timeout: 30_000 }, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--require", guard, plugin, `--verify-${mode}`
    ], {
      cwd: root,
      env: { ...process.env, THREADDECK_APPEARANCE: "light", THREADDECK_LANGUAGE: "en" },
      timeout: 25_000,
      maxBuffer: 1024 * 1024
    });
    assert.equal(stderr, "");
    const report = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(report.passed, true);
  });
}
