"use strict";

/*
 * The loopback Codex discovery and renderer feature-activation strategy
 * is adapted in part from dazer1234/codex-stream-deck,
 * Copyright (c) 2026 Dazer, under the MIT License. The complete upstream
 * notice ships in licenses/codex-deck-MIT.txt and reference/codex-deck/.
 */

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const STATE_ROOT = path.join(os.homedir(), "Library", "Application Support", "ThreadDeck");
const POLICY_PATH = path.join(STATE_ROOT, "codex-micro-bootstrap-v1.json");
const BRIDGE_STATE_PATH = path.join(STATE_ROOT, "codex-micro-bridge.json");
const DEFAULT_POLL_MS = 2500;
const DEFAULT_STARTUP_GRACE_MS = 30_000;
const DEFAULT_UNBRIDGED_STABLE_MS = 8000;

function createBootstrapPolicy(nowMs = Date.now()) {
  return {
    version: 1,
    initialized: false,
    startupGraceUntilMs: nowMs + DEFAULT_STARTUP_GRACE_MS,
    lastGeneration: null,
    preservedInitialGeneration: null,
    stoppedSinceMs: null,
    normalLaunchGeneration: null,
    hadHealthyBridge: false,
    unbridgedGeneration: null,
    unbridgedSinceMs: null
  };
}

function normalizeBootstrapPolicy(value, nowMs = Date.now()) {
  const fallback = createBootstrapPolicy(nowMs);
  if (!value || typeof value !== "object" || value.version !== 1) return fallback;
  return {
    ...fallback,
    ...value,
    startupGraceUntilMs: nowMs + DEFAULT_STARTUP_GRACE_MS,
    stoppedSinceMs: null,
    unbridgedGeneration: null,
    unbridgedSinceMs: null
  };
}

function evaluateBootstrapPolicy(policy, observation, options = {}) {
  const startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  const stableMs = options.stableMs ?? DEFAULT_UNBRIDGED_STABLE_MS;
  const next = { ...policy };
  const nowMs = observation.nowMs;
  const generation = observation.generation ?? null;
  const bridgeHealthy = observation.bridgeHealthy === true;

  if (!policy.initialized) {
    next.initialized = true;
    next.startupGraceUntilMs = Math.max(
      Number(next.startupGraceUntilMs) || 0,
      nowMs + startupGraceMs
    );
    next.lastGeneration = generation;
    if (!generation) {
      next.stoppedSinceMs = nowMs;
      return { policy: next, action: { type: "wait", reason: "codex-not-running" } };
    }
    if (bridgeHealthy) {
      next.hadHealthyBridge = true;
      return { policy: next, action: { type: "reuse", reason: "healthy-bridge" } };
    }
    next.preservedInitialGeneration = generation;
    return { policy: next, action: { type: "preserve", reason: "initial-session" } };
  }

  if (!generation) {
    if (next.stoppedSinceMs == null) next.stoppedSinceMs = nowMs;
    next.lastGeneration = null;
    next.preservedInitialGeneration = null;
    next.unbridgedGeneration = null;
    next.unbridgedSinceMs = null;
    next.normalLaunchGeneration = null;
    return { policy: next, action: { type: "wait", reason: "codex-not-running" } };
  }

  const previousGeneration = next.lastGeneration;
  const observedStoppedInterval = next.stoppedSinceMs != null;
  const generationChanged = previousGeneration != null && previousGeneration !== generation;
  next.lastGeneration = generation;
  next.stoppedSinceMs = null;
  if (observedStoppedInterval) next.normalLaunchGeneration = generation;

  if (bridgeHealthy) {
    next.hadHealthyBridge = true;
    next.preservedInitialGeneration = null;
    next.unbridgedGeneration = null;
    next.unbridgedSinceMs = null;
    next.normalLaunchGeneration = null;
    return { policy: next, action: { type: "reuse", reason: "healthy-bridge" } };
  }

  if (next.unbridgedGeneration !== generation) {
    next.unbridgedGeneration = generation;
    next.unbridgedSinceMs = nowMs;
  }
  if (previousGeneration == null
      && next.preservedInitialGeneration == null
      && !next.hadHealthyBridge
      && !observedStoppedInterval
      && nowMs < next.startupGraceUntilMs) {
    next.preservedInitialGeneration = generation;
    return { policy: next, action: { type: "preserve", reason: "startup-race" } };
  }
  if (generation === next.preservedInitialGeneration
      && !generationChanged
      && !observedStoppedInterval) {
    return { policy: next, action: { type: "preserve", reason: "initial-session" } };
  }
  if (next.unbridgedSinceMs == null || nowMs - next.unbridgedSinceMs < stableMs) {
    return { policy: next, action: { type: "wait", reason: "confirm-unbridged" } };
  }

  const shouldRecover = generationChanged
    || observedStoppedInterval
    || next.normalLaunchGeneration === generation
    || next.hadHealthyBridge
    || nowMs >= next.startupGraceUntilMs;
  if (!shouldRecover) {
    return { policy: next, action: { type: "wait", reason: "startup-grace" } };
  }
  return {
    policy: next,
    action: {
      type: "preserve",
      reason: generationChanged
        ? "generation-changed"
        : observedStoppedInterval
          ? "normal-launch-after-stop"
          : next.normalLaunchGeneration === generation
            ? "normal-launch-after-stop"
          : next.hadHealthyBridge
            ? "healthy-bridge-lost"
            : "unbridged-launch"
    }
  };
}

function parseCodexMainProcess(output, appPath = null) {
  const executable = appPath
    ? path.join(appPath, "Contents", "MacOS") + path.sep
    : null;
  for (const rawLine of String(output ?? "").split("\n")) {
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedAt = match[3].trim();
    const command = match[4].trim();
    if (ppid !== 1 || !command.includes(".app/Contents/MacOS/")) continue;
    if (executable && !command.startsWith(executable)) continue;
    if (!executable && !/\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\//.test(command)) continue;
    return {
      pid,
      ppid,
      startedAt,
      command,
      generation: `${pid}:${startedAt}:${command.split(" --")[0]}`
    };
  }
  return null;
}

function parseLoopbackDebugPort(command) {
  const text = String(command ?? "");
  if (!/(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(text)) {
    return null;
  }
  const port = Number(text.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function codexAppCandidates(searchOutput, homeDirectory = os.homedir()) {
  return [...new Set([
    ...String(searchOutput ?? "").split("\n").map((value) => value.trim()),
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(homeDirectory, "Applications", "ChatGPT.app"),
    path.join(homeDirectory, "Applications", "Codex.app")
  ])].filter((value) => value.endsWith(".app"));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, filePath);
}

class CodexMicroBootstrap {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.execFile = options.execFile ?? execFileAsync;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.policyPath = options.policyPath ?? POLICY_PATH;
    this.bridgeStatePath = options.bridgeStatePath ?? BRIDGE_STATE_PATH;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.onStatus = options.onStatus ?? (() => {});
    this.policy = null;
    this.timer = null;
    this.activeTick = null;
    this.closed = false;
    this.lastStatusKey = "";
  }

  status(state, detail = null, extra = {}) {
    const value = { state, detail, atMs: this.now(), ...extra };
    const key = `${state}:${detail ?? ""}:${extra.port ?? ""}`;
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.onStatus(value);
    }
    return value;
  }

  async start() {
    if (this.platform !== "darwin" || this.timer || this.closed) return false;
    this.policy = normalizeBootstrapPolicy(await readJson(this.policyPath), this.now());
    await this.tick();
    if (!this.closed) {
      this.timer = setInterval(() => void this.tick(), this.pollMs);
      this.timer.unref?.();
    }
    return true;
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.closed) return null;
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.performTick().finally(() => {
      this.activeTick = null;
    });
    return this.activeTick;
  }

  async performTick() {
    try {
      const appPath = await this.discoverAppPath();
      const main = await this.findMainProcess(appPath);
      const port = await this.healthyDebugPort(main);
      const decision = evaluateBootstrapPolicy(this.policy ?? createBootstrapPolicy(this.now()), {
        nowMs: this.now(),
        generation: main?.generation ?? null,
        bridgeHealthy: port != null
      });
      this.policy = decision.policy;
      await atomicWriteJson(this.policyPath, this.policy);
      if (port != null) {
        await atomicWriteJson(this.bridgeStatePath, {
          port,
          updatedAt: new Date(this.now()).toISOString(),
          managedBy: "ThreadDeck"
        });
        return this.status("connected", decision.action.reason, { port });
      }
      await this.removeStaleBridgeState();
      if (decision.action.type === "preserve") {
        return this.status("restart-needed", decision.action.reason);
      }
      if (!main) return this.status("stopped", decision.action.reason);
      return this.status("waiting", decision.action.reason);
    } catch (error) {
      return this.status("error", error?.message ?? "Micro bootstrap failed");
    }
  }

  async discoverAppPath() {
    let searchOutput = "";
    try {
      const result = await this.execFile("/usr/bin/mdfind", [
        "kMDItemCFBundleIdentifier == 'com.openai.codex'"
      ], { timeout: 3000, maxBuffer: 128 * 1024 });
      searchOutput = result?.stdout ?? result ?? "";
    } catch {
      // The fixed application folders below remain available when Spotlight
      // indexing is disabled or still catching up after an app update.
    }
    for (const appPath of codexAppCandidates(searchOutput)) {
      try {
        const result = await this.execFile("/usr/bin/plutil", [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          path.join(appPath, "Contents", "Info.plist")
        ], { timeout: 1500, maxBuffer: 4096 });
        if (String(result?.stdout ?? result ?? "").trim() === "com.openai.codex") {
          return appPath;
        }
      } catch {
        // Ignore stale Spotlight rows and continue to the next candidate.
      }
    }
    throw new Error("Codex Desktop is not installed.");
  }

  async findMainProcess(appPath) {
    const result = await this.execFile("/bin/ps", [
      "-axo", "pid=,ppid=,lstart=,command="
    ], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
    return parseCodexMainProcess(result?.stdout ?? result ?? "", appPath);
  }

  async healthyDebugPort(main) {
    const port = parseLoopbackDebugPort(main?.command);
    if (!port || typeof this.fetch !== "function") return null;
    try {
      const [version, targets] = await Promise.all([
        this.fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(750)
        }),
        this.fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(750)
        })
      ]);
      if (!version.ok || !targets.ok) return null;
      const rows = await targets.json();
      return Array.isArray(rows)
        && rows.some((target) => target?.type === "page" && target?.url?.startsWith("app://"))
        ? port
        : null;
    } catch {
      return null;
    }
  }

  async removeStaleBridgeState() {
    const existing = await readJson(this.bridgeStatePath);
    if (existing) await fs.rm(this.bridgeStatePath, { force: true });
  }

}

module.exports = {
  BRIDGE_STATE_PATH,
  CodexMicroBootstrap,
  DEFAULT_UNBRIDGED_STABLE_MS,
  POLICY_PATH,
  codexAppCandidates,
  createBootstrapPolicy,
  evaluateBootstrapPolicy,
  normalizeBootstrapPolicy,
  parseCodexMainProcess,
  parseLoopbackDebugPort
};
