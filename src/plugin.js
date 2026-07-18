"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { execFile, execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const SQLITE = "/usr/bin/sqlite3";
const USER_HOME = os.homedir();
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(USER_HOME, ".codex"));
const STATE_DB = path.resolve(process.env.THREADDECK_STATE_DB || path.join(CODEX_HOME, "state_5.sqlite"));
const GLOBAL_STATE = path.resolve(process.env.THREADDECK_GLOBAL_STATE || path.join(CODEX_HOME, ".codex-global-state.json"));
const SESSION_INDEX = path.resolve(process.env.THREADDECK_SESSION_INDEX || path.join(CODEX_HOME, "session_index.jsonl"));
const PROCESS_REGISTRY = path.resolve(
  process.env.THREADDECK_PROCESS_REGISTRY || path.join(CODEX_HOME, "process_manager", "chat_processes.json")
);
const KEY_BRIDGE = path.join(__dirname, "keybridge");

function resolveCodexBar() {
  const candidates = [
    process.env.CODEXBAR_PATH,
    path.join(USER_HOME, ".local", "bin", "codexbar"),
    "/opt/homebrew/bin/codexbar",
    "/usr/local/bin/codexbar"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Try the next common installation path.
    }
  }
  return "codexbar";
}

const CODEXBAR = resolveCodexBar();

const ACTIONS = {
  weekly: "com.yechan.threaddeck.weekly",
  thread1: "com.yechan.threaddeck.thread1",
  thread2: "com.yechan.threaddeck.thread2",
  thread3: "com.yechan.threaddeck.thread3",
  thread4: "com.yechan.threaddeck.thread4",
  thread5: "com.yechan.threaddeck.thread5",
  thread6: "com.yechan.threaddeck.thread6",
  thread7: "com.yechan.threaddeck.thread7",
  thread8: "com.yechan.threaddeck.thread8",
  sideChat: "com.yechan.threaddeck.sidechat",
  newThread: "com.yechan.threaddeck.newthread",
  voice: "com.yechan.threaddeck.voice",
  send: "com.yechan.threaddeck.send",
  appSwitch: "com.yechan.threaddeck.appswitch",
  mediaPrevious: "com.yechan.threaddeck.media.previous",
  mediaRewind: "com.yechan.threaddeck.media.rewind",
  mediaPlayPause: "com.yechan.threaddeck.media.playpause",
  mediaForward: "com.yechan.threaddeck.media.forward",
  mediaMute: "com.yechan.threaddeck.media.mute",
  mediaVolumeDown: "com.yechan.threaddeck.media.volumedown",
  mediaVolumeUp: "com.yechan.threaddeck.media.volumeup",
  mediaNext: "com.yechan.threaddeck.media.next"
};

const THREAD_ACTIONS = [
  ACTIONS.thread1,
  ACTIONS.thread2,
  ACTIONS.thread3,
  ACTIONS.thread4,
  ACTIONS.thread5,
  ACTIONS.thread6,
  ACTIONS.thread7,
  ACTIONS.thread8
];
const THREAD_COUNT = THREAD_ACTIONS.length;
const THREAD_COMPLETION_PULSE_DURATION_MS = 5200;
const GLOBAL_COMPLETION_PULSE_DURATION_MS = 2600;
const GLOBAL_COMPLETION_FRAME_INTERVAL_MS = 25;
const GLOBAL_COMPLETION_GROUP_COUNT = 2;
const THREAD_SLOT_BY_ACTION = new Map(THREAD_ACTIONS.map((action, index) => [action, index]));
const MEDIA_COMMAND_BY_ACTION = new Map([
  [ACTIONS.mediaPrevious, "media-previous"],
  [ACTIONS.mediaRewind, "media-rewind"],
  [ACTIONS.mediaPlayPause, "media-play-pause"],
  [ACTIONS.mediaForward, "media-forward"],
  [ACTIONS.mediaMute, "media-mute"],
  [ACTIONS.mediaVolumeDown, "media-volume-down"],
  [ACTIONS.mediaVolumeUp, "media-volume-up"],
  [ACTIONS.mediaNext, "media-next"]
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Use fonts already supplied by macOS. The public plugin intentionally does
// not redistribute proprietary font files.
const FONT_STACK = "'.AppleSystemUIFont', 'SF Pro Display', 'SF Pro Text', 'Apple SD Gothic Neo', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const DARK_THEME = Object.freeze({
  canvas: "#000000",
  card: "#000000",
  raised: "#2F2F2F",
  border: "#FFFFFF0D",
  borderStrong: "#FFFFFF1A",
  text: "#F2F6FA",
  textSecondary: "#CDCDCD",
  muted: "#818181",
  blue: "#0285FF",
  green: "#10A37F",
  red: "#FF6764",
  amber: "#F5A524",
  sliderTrack: "#FFFFFF1A"
});
const LIGHT_THEME = Object.freeze({
  canvas: "#F9F9F9",
  card: "#FCFCFC",
  raised: "#ECECEC",
  border: "#0000000D",
  borderStrong: "#0000001A",
  text: "#0D0D0D",
  textSecondary: "#676767",
  muted: "#9B9B9B",
  blue: "#0285FF",
  green: "#10A37F",
  red: "#F93A37",
  amber: "#AC4F23",
  sliderTrack: "#0000001A"
});

function systemAppearanceSync() {
  const forced = String(process.env.THREADDECK_APPEARANCE ?? "").toLowerCase();
  if (["dark", "light"].includes(forced)) return forced;
  try {
    const value = execFileSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return value.trim().toLowerCase() === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let appearanceMode = systemAppearanceSync();
let THEME = appearanceMode === "dark" ? DARK_THEME : LIGHT_THEME;
let fixedRenderTimeMs = null;

function renderTimeMs() {
  return Number.isFinite(fixedRenderTimeMs) ? fixedRenderTimeMs : Date.now();
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = argument("-port");
const pluginUUID = argument("-pluginUUID");
const registerEvent = argument("-registerEvent");
const snapshotMode = process.argv.includes("--snapshot");
const demoOutput = argument("--render-demo");
const demoLightOutput = argument("--render-demo-light");

const contexts = new Map();
const contextImages = new Map();
const contextFeedback = new Map();
const statusCache = new Map();
const completionPulseStartedAt = new Map();
const observedCompletionEndMs = new Map();
const voiceHeldContexts = new Set();
const voiceSuspendedMediaPids = new Set();
let socket = null;
let activeUsageRefresh = null;
let activeThreadRefresh = null;
let activeAppearanceRefresh = null;
let threadSlots = Array(THREAD_COUNT).fill(null);
let usageState = { remaining: null, failed: false };
let pulse = false;
let feedbackSerial = 0;
let hasLoadedThreadState = false;
let globalCompletionStartedAtMs = null;
let globalCompletionThreadId = null;
let globalCompletionWasRendered = false;
let globalCompletionRenderGroup = 0;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function setTitle(context, title) {
  send({ event: "setTitle", context, payload: { target: 0, title } });
}

function sendImage(context, svg) {
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  send({ event: "setImage", context, payload: { target: 0, image } });
}

function feedbackOverlaySvg(svg, feedback) {
  const accent = feedback.kind === "error" ? THEME.red : feedback.kind === "success" ? THEME.green : THEME.blue;
  const label = compactLine(feedback.label, 5.2);
  const icon = feedback.kind === "loading"
    ? `<circle cx="27" cy="119" r="2" fill="${accent}" opacity=".4"/><circle cx="34" cy="119" r="2" fill="${accent}" opacity=".7"/><circle cx="41" cy="119" r="2" fill="${accent}"/>`
    : feedback.kind === "error"
      ? `<path d="M29 114L39 124M39 114L29 124" stroke="${accent}" stroke-width="2.3" stroke-linecap="round"/>`
      : `<path d="M28 119L32.5 123L40 114.5" fill="none" stroke="${accent}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;
  const overlay = `
  <rect x="15" y="105" width="114" height="28" rx="10" fill="${THEME.raised}" stroke="${THEME.borderStrong}"/>
  ${icon}
  <text x="84" y="125" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="15.5" font-weight="600" text-anchor="middle">${escapeXml(label)}</text>`;
  return svg.replace("</svg>", `${overlay}\n</svg>`);
}

function setImage(context, svg) {
  contextImages.set(context, svg);
  sendImage(context, composedContextSvg(context, svg));
}

function showFeedback(context, kind, label, durationMs) {
  const token = ++feedbackSerial;
  const feedback = { kind, label, token };
  const duration = Number.isFinite(durationMs) ? durationMs : kind === "loading" ? 16_000 : kind === "error" ? 1_100 : 800;
  contextFeedback.set(context, feedback);
  const baseSvg = contextImages.get(context);
  if (baseSvg) sendImage(context, composedContextSvg(context, baseSvg));
  setTimeout(() => {
    if (contextFeedback.get(context)?.token !== token) return;
    contextFeedback.delete(context);
    const currentSvg = contextImages.get(context);
    if (contexts.has(context) && currentSvg) sendImage(context, composedContextSvg(context, currentSvg));
  }, duration);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function remainingPercent(usedPercent) {
  const used = clampPercent(usedPercent);
  return used === null ? null : 100 - used;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactLine(value, maxWidth = 9.4) {
  const graphemes = Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(value ?? "")), (part) => part.segment);
  let width = 0;
  const shown = [];
  for (const grapheme of graphemes) {
    const nextWidth = visualWidth(grapheme);
    if (shown.length > 0 && width + nextWidth > maxWidth) break;
    shown.push(grapheme);
    width += nextWidth;
  }
  if (shown.length < graphemes.length) {
    while (shown.length > 0 && width + 0.75 > maxWidth) {
      width -= visualWidth(shown.pop());
    }
    shown.push("…");
  }
  return shown.join("").trim();
}

function detailedActivityLabel(activity) {
  const kind = typeof activity === "string" ? "idle" : activity?.kind;
  const fallbacks = {
    request: "요청 분석",
    think: "생각 중",
    search: "자료 검색",
    inspect: "내용 확인",
    edit: "코드 수정",
    command: "명령 실행",
    answer: "답변 작성",
    complete: "작업 완료",
    stopped: "작업 중단",
    error: "오류 확인",
    idle: "상태 확인"
  };
  const refinements = {
    "요청 확인": "요청 분석",
    "웹 확인": "웹 검색·확인",
    "앱 확인": "앱 화면 확인",
    "결과 확인": "도구 결과 확인",
    "파일 수정": "코드 수정",
    "진행 안내": "답변 작성"
  };
  const raw = String(typeof activity === "string" ? activity : activity?.label ?? "").trim();
  if (refinements[raw]) return refinements[raw];
  return raw || fallbacks[kind] || "상태 확인";
}

function isFastServiceTier(value) {
  return ["fast", "priority"].includes(String(value ?? "").toLowerCase());
}

function reasoningEffortProgress(value) {
  const progress = {
    none: 0,
    minimal: 0.12,
    low: 0.24,
    medium: 0.41,
    high: 0.59,
    xhigh: 0.76,
    max: 0.88,
    ultra: 1
  };
  return progress[String(value ?? "").toLowerCase()] ?? 0.41;
}

function reasoningEffortAppearance(value) {
  const ultra = String(value ?? "").toLowerCase() === "ultra";
  return {
    ultra,
    gradientStops: ultra
      ? `<stop stop-color="#8A4FE0"/><stop offset=".32" stop-color="#B15CE8"/><stop offset=".58" stop-color="#C874E8"/><stop offset="1" stop-color="#8A4FE0"/>`
      : `<stop stop-color="#0285FF"/><stop offset="1" stop-color="#0285FF"/>`
  };
}

function seededParticleUnit(index, channel) {
  const value = Math.sin((index + 1) * 12.9898 + (channel + 1) * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function flowingReasoningSlider(accent, label, fast) {
  const trackX = 9;
  const trackY = 8;
  const trackWidth = 126;
  const trackHeight = 28;
  const trackRadius = trackHeight / 2;
  const trackCenterY = trackY + trackHeight / 2;
  const effortProgress = reasoningEffortProgress(label.effort);
  const appearance = reasoningEffortAppearance(label.effort);
  const fillWidth = trackWidth * effortProgress;
  const nowMs = renderTimeMs();
  // Keep the spatial gradient fixed. Ultra only breathes through a stationary
  // center bloom so the color changes softly without looking like a moving band.
  const ambienceCycleMs = fast ? 2600 : 3800;
  const ambiencePhase = (nowMs % ambienceCycleMs) / ambienceCycleMs * Math.PI * 2;
  const ambienceOpacity = appearance.ultra ? 0.05 + (Math.sin(ambiencePhase - Math.PI / 2) + 1) * 0.045 : 0;
  const edgeFade = (position, width = 0.16) => Math.max(0, Math.min(1, position / width, (1 - position) / width));
  const particlePadding = 3;
  const particleFlowWidth = Math.max(0, fillWidth - particlePadding * 2);
  const particleCycleMs = fast ? 820 : 2600;
  const particlePhase = (nowMs % particleCycleMs) / particleCycleMs;
  const particleCount = fast ? 10 : 11;
  const particles = !appearance.ultra || particleFlowWidth < 1 ? "" : Array.from({ length: particleCount }, (_, index) => {
    const random = (channel) => seededParticleUnit(index, channel);
    const loopAngle = particlePhase * Math.PI * 2;
    let position;
    let x;
    let y;
    let radius;
    let baseOpacity;
    if (fast) {
      // Each particle starts at a stable pseudo-random offset and follows its
      // own shallow lane while the group still communicates fast forward flow.
      position = (random(0) - particlePhase + 1) % 1;
      const xWobbleFrequency = 1 + Math.floor(random(1) * 3);
      const yWobbleFrequency = 1 + Math.floor(random(2) * 4);
      x = trackX + particlePadding + position * particleFlowWidth
        + Math.sin(loopAngle * xWobbleFrequency + random(3) * Math.PI * 2) * (0.2 + random(4) * 0.38);
      y = trackCenterY + (random(5) - 0.5) * 10.5
        + Math.sin(loopAngle * yWobbleFrequency + random(6) * Math.PI * 2) * (0.45 + random(7) * 0.8);
      radius = 0.94 + random(8) * 0.38;
      baseOpacity = 0.62 + random(9) * 0.2;
    } else {
      // Standard mode uses stable random resting positions plus independent
      // amplitudes, phases, and integer frequencies. The particles feel
      // organic without jumping, and every path still closes cleanly.
      position = 0.04 + random(0) * 0.92;
      const xFrequency = 1 + Math.floor(random(1) * 4);
      const yFrequency = 1 + Math.floor(random(2) * 4);
      const shimmerFrequency = 1 + Math.floor(random(3) * 3);
      const xAmplitude = 0.65 + random(4) * 1.15;
      const yAmplitude = 0.7 + random(5) * 1.2;
      const baseX = trackX + particlePadding + position * particleFlowWidth;
      const baseY = trackCenterY + (random(6) - 0.5) * 11.5;
      x = baseX
        + Math.sin(loopAngle * xFrequency + random(7) * Math.PI * 2) * xAmplitude
        + Math.sin(loopAngle * (xFrequency + 2) + random(8) * Math.PI * 2) * xAmplitude * 0.28;
      y = baseY
        + Math.sin(loopAngle * yFrequency + random(9) * Math.PI * 2) * yAmplitude
        + Math.sin(loopAngle * (yFrequency + 1) + random(10) * Math.PI * 2) * yAmplitude * 0.22;
      radius = 1.02 + random(11) * 0.42
        + Math.sin(loopAngle * shimmerFrequency + random(12) * Math.PI * 2) * 0.08;
      baseOpacity = 0.7 + random(13) * 0.18
        + Math.sin(loopAngle * shimmerFrequency + random(14) * Math.PI * 2) * 0.08;
    }
    const opacity = Math.max(0, Math.min(0.94, baseOpacity * edgeFade(position, fast ? 0.12 : 0.08)));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="#FFFFFF" opacity="${opacity.toFixed(2)}"/>`;
  }).join("");
  const modeIconPath = "M21 14L17.2 20.3H21L19.8 27L26 19H22.3L24.3 14Z";
  const restModeIcon = fast ? `<path d="${modeIconPath}" fill="${THEME.text}" fill-opacity=".88"/>` : "";
  const filledModeIcon = fast ? `<path d="${modeIconPath}" fill="#FFFFFF" fill-opacity=".92"/>` : "";
  const textX = fast ? 30 : 16;
  const fontSize = label.text.length >= 8 ? 14.8 : 16;
  const ambientGlow = appearance.ultra
    ? `<rect x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}" fill="url(#reasoningBloom)" opacity="${ambienceOpacity.toFixed(3)}"/>`
    : "";

  return `
  <defs>
    <clipPath id="reasoningFillClip"><rect x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}"/></clipPath>
    <linearGradient id="reasoningFill" x1="${trackX}" y1="0" x2="${trackX + trackWidth}" y2="0" gradientUnits="userSpaceOnUse">
      ${appearance.gradientStops}
    </linearGradient>
    ${appearance.ultra ? `<linearGradient id="reasoningBloom" x1="${trackX}" y1="0" x2="${trackX + trackWidth}" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF" stop-opacity=".02"/><stop offset=".5" stop-color="#FFD7FF" stop-opacity=".62"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".02"/>
    </linearGradient>` : ""}
  </defs>
  <rect x="${trackX}" y="${trackY}" width="${trackWidth}" height="${trackHeight}" rx="${trackRadius}" fill="${THEME.sliderTrack}"/>
  <g clip-path="url(#reasoningFillClip)">
    <rect x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}" fill="url(#reasoningFill)"/>
    ${ambientGlow}
    ${particles}
  </g>
  ${restModeIcon}
  <text x="${textX}" y="27" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" text-anchor="start" clip-path="url(#headerClip)">${escapeXml(label.text)}</text>
  <g clip-path="url(#reasoningFillClip)">
    ${filledModeIcon}
    <text x="${textX}" y="27" fill="#FFFFFF" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" text-anchor="start" clip-path="url(#headerClip)">${escapeXml(label.text)}</text>
  </g>`;
}

function completionPulseState(threadId, nowMs = Date.now()) {
  const startedAtMs = completionPulseStartedAt.get(threadId);
  if (!Number.isFinite(startedAtMs)) return null;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  if (elapsedMs >= THREAD_COMPLETION_PULSE_DURATION_MS) return null;
  const progress = elapsedMs / THREAD_COMPLETION_PULSE_DURATION_MS;
  // The completed thread gets three deliberate pulses with a slow tail so it
  // remains unmistakable even when the deck is only in peripheral vision.
  const wave = 0.5 + 0.5 * Math.cos(progress * Math.PI * 6);
  const envelope = Math.pow(1 - progress, 0.38);
  const strength = wave * envelope;
  return { elapsedMs, progress, strength };
}

function globalCompletionPulseState(nowMs = Date.now()) {
  if (!Number.isFinite(globalCompletionStartedAtMs)) return null;
  const elapsedMs = Math.max(0, nowMs - globalCompletionStartedAtMs);
  if (elapsedMs >= GLOBAL_COMPLETION_PULSE_DURATION_MS) return null;
  const progress = elapsedMs / GLOBAL_COMPLETION_PULSE_DURATION_MS;
  // Never drop fully to black between the two breaths. A shallow floor looks
  // smoother on Neo's LCD keys and avoids making sparse frames feel like a
  // stutter while the whole deck is being updated.
  const breath = 0.5 + 0.5 * Math.cos(progress * Math.PI * 4);
  const wave = 0.28 + 0.72 * breath;
  const envelope = Math.pow(1 - progress, 0.62);
  return { elapsedMs, progress, strength: wave * envelope };
}

function globalCompletionChrome(effect) {
  if (!effect || effect.strength < 0.002) return "";
  const strength = effect.strength;
  const tintOpacity = (0.17 * strength).toFixed(3);
  const outerOpacity = (0.9 * strength).toFixed(3);
  const innerOpacity = (0.36 * strength).toFixed(3);
  const outerWidth = (1.8 + strength * 2.4).toFixed(2);
  return `
  <rect x="4.8" y="4.8" width="134.4" height="134.4" rx="15.6" fill="${THEME.green}" fill-opacity="${tintOpacity}"/>
  <rect x="5.4" y="5.4" width="133.2" height="133.2" rx="15" fill="none" stroke="${THEME.green}" stroke-opacity="${outerOpacity}" stroke-width="${outerWidth}"/>
  <rect x="9" y="9" width="126" height="126" rx="12" fill="none" stroke="${THEME.text}" stroke-opacity="${innerOpacity}" stroke-width="1"/>`;
}

function contextThreadId(context) {
  const slot = THREAD_SLOT_BY_ACTION.get(contexts.get(context));
  return slot === undefined ? null : threadSlots[slot]?.id ?? null;
}

function applyGlobalCompletion(svg, effect) {
  const chrome = globalCompletionChrome(effect);
  return chrome ? svg.replace("</svg>", `${chrome}\n</svg>`) : svg;
}

function composedContextSvg(context, svg, nowMs = Date.now()) {
  let rendered = svg;
  const globalEffect = globalCompletionPulseState(nowMs);
  if (globalEffect && contextThreadId(context) !== globalCompletionThreadId) {
    rendered = applyGlobalCompletion(rendered, globalEffect);
  }
  const feedback = contextFeedback.get(context);
  return feedback ? feedbackOverlaySvg(rendered, feedback) : rendered;
}

function completionPulseChrome(effect) {
  if (!effect || effect.strength < 0.002) return "";
  const strength = effect.strength;
  const tintOpacity = (0.24 * strength).toFixed(3);
  const outerOpacity = (0.98 * strength).toFixed(3);
  const innerOpacity = (0.68 * strength).toFixed(3);
  const outerWidth = (2.4 + strength * 3.6).toFixed(2);
  const innerWidth = (1.1 + strength * 1.9).toFixed(2);
  return `
  <rect x="4.8" y="4.8" width="134.4" height="134.4" rx="15.6" fill="${THEME.green}" fill-opacity="${tintOpacity}"/>
  <rect x="4.8" y="4.8" width="134.4" height="134.4" rx="15.6" fill="none" stroke="${THEME.green}" stroke-opacity="${outerOpacity}" stroke-width="${outerWidth}"/>
  <rect x="8" y="8" width="128" height="128" rx="13" fill="none" stroke="${THEME.green}" stroke-opacity="${innerOpacity}" stroke-width="${innerWidth}"/>`;
}

function threadHeader(accent, status, statusLabel, activity, pulsing = false, reasoningEffort = null, serviceTier = null, completionEffect = null) {
  if (status === "completed") {
    const strength = completionEffect?.strength ?? 0;
    const fillOpacity = (0.7 * strength).toFixed(3);
    const strokeOpacity = (0.98 * strength).toFixed(3);
    const brightCheckOpacity = (0.96 * strength).toFixed(3);
    const checkWidth = (3.4 + 0.9 * strength).toFixed(2);
    return `
  <rect x="9" y="8" width="126" height="28" rx="14" fill="${THEME.raised}"/>
  <rect x="9" y="8" width="126" height="28" rx="14" fill="${THEME.green}" fill-opacity="${fillOpacity}" stroke="${THEME.green}" stroke-opacity="${strokeOpacity}"/>
  <path d="M61 22L68 28L83 16" fill="none" stroke="${THEME.green}" stroke-width="${checkWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M61 22L68 28L83 16" fill="none" stroke="${THEME.text}" stroke-opacity="${brightCheckOpacity}" stroke-width="${checkWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const info = typeof activity === "string" ? { kind: "idle", label: activity } : activity ?? { kind: "idle", label: "상태 확인 중" };
  const opacity = pulsing ? (pulse ? 1 : 0.5) : 1;
  const fast = status === "working" && isFastServiceTier(serviceTier);
  const activityLabel = detailedActivityLabel(info);
  const label = compactLine(status === "working" ? activityLabel : statusLabel, fast ? 5.7 : 6.8);
  if (status === "working") {
    return flowingReasoningSlider(accent, { text: label, effort: reasoningEffort }, fast);
  }
  const textX = fast ? 34 : 72;
  const anchor = fast ? "start" : "middle";
  const fontSize = label.length >= 9 ? 14.8 : 16;
  const modeIcon = fast
    ? `<path d="M23 12L16 23H22L20 32L30 19H24L27 12Z" fill="${accent}" opacity="${opacity}"/>`
    : "";
  return `
  <rect x="9" y="8" width="126" height="28" rx="14" fill="${THEME.raised}"/>
  ${modeIcon}
  <text x="${textX}" y="27" fill="${["error", "stopped"].includes(status) ? accent : THEME.textSecondary}" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" text-anchor="${anchor}" clip-path="url(#headerClip)">${escapeXml(label)}</text>`;
}

function shell(accent, content, header = "", chrome = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" shape-rendering="geometricPrecision" text-rendering="optimizeLegibility">
  <defs>
    <clipPath id="headerClip"><rect x="9" y="8" width="126" height="28" rx="14"/></clipPath>
  </defs>
  <rect width="144" height="144" fill="${THEME.canvas}"/>
  <rect x="4" y="4" width="136" height="136" rx="16" fill="${THEME.card}" stroke="${THEME.border}"/>
  ${chrome}
  ${header}
  ${content}
</svg>`;
}

function mixRgb(from, to, ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
}

function usageAccent(value, failed = false) {
  if (failed) return THEME.red;
  if (value === null) return THEME.muted;
  const red = [255, 103, 100];
  const amber = [245, 165, 36];
  const green = [16, 163, 127];
  const color = value <= 50
    ? mixRgb(red, amber, value / 50)
    : mixRgb(amber, green, (value - 50) / 50);
  return `rgb(${color.join(", ")})`;
}

function usageSvg(remaining, failed = false) {
  const value = clampPercent(remaining);
  const accent = usageAccent(value, failed);
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const dash = value === null ? 0 : (circumference * value) / 100;
  const shown = value === null ? "--" : `${value}`;
  const numberFontSize = shown.length >= 3 ? 40 : 48;
  return shell(accent, `
    <circle cx="72" cy="72" r="${radius}" fill="none" stroke="${THEME.raised}" stroke-width="9.5"/>
    <circle cx="72" cy="72" r="${radius}" fill="none" stroke="${accent}" stroke-width="9.5" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 72 72)"/>
    <circle cx="72" cy="72" r="32" fill="${THEME.card}"/>
    <text x="72" y="86" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${numberFontSize}" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${shown}</text>`);
}

function newThreadSvg() {
  return shell(THEME.text, `
    <g transform="translate(24 24) scale(4)" fill="none" stroke="${THEME.text}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
    </g>`);
}

function voiceSvg(active = false) {
  const accent = active ? THEME.green : THEME.text;
  const chrome = active ? `
    <rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.green}" fill-opacity=".12" stroke="${THEME.green}" stroke-opacity=".88" stroke-width="2.5"/>` : "";
  return shell(accent, `
    <rect x="56" y="28" width="32" height="59" rx="16" fill="${accent}"/>
    <path d="M40 68V77C40 94.7 54.3 109 72 109C89.7 109 104 94.7 104 77V68" fill="none" stroke="${accent}" stroke-width="6.2" stroke-linecap="round"/>
    <path d="M72 109V120M56 120H88" fill="none" stroke="${accent}" stroke-width="6.2" stroke-linecap="round"/>`, "", chrome);
}

function sendSvg() {
  return shell(THEME.text, `
    <circle cx="72" cy="72" r="41" fill="${THEME.text}"/>
    <path d="M72 96V48M52.5 67.5L72 48L91.5 67.5" fill="none" stroke="${THEME.card}" stroke-width="5.7" stroke-linecap="round" stroke-linejoin="round"/>`);
}

function appSwitchSvg() {
  return shell(THEME.text, `
    <path d="M34 72H101M78 49L101 72L78 95M111 48V96" fill="none" stroke="${THEME.text}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
}

function sideChatSvg() {
  return shell(THEME.text, `
    <path d="M72 36C94 36 111 51.8 111 72.5C111 80.8 108.3 88.4 103.5 94.2L107 110L91.5 105.3C85.8 108.4 79.2 110 72 110C50 110 33 93.9 33 72.5C33 51.8 50 36 72 36Z" fill="none" stroke="${THEME.text}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M72 52V92M52 72H92" fill="none" stroke="${THEME.text}" stroke-width="5.5" stroke-linecap="round"/>`);
}

function mediaActionSvg(action) {
  let icon = "";
  if (action === ACTIONS.mediaPrevious) {
    icon = `<rect x="34" y="43" width="7" height="58" rx="3.5" fill="${THEME.text}"/><path d="M103 43L45 72L103 101Z" fill="${THEME.text}"/>`;
  } else if (action === ACTIONS.mediaRewind) {
    icon = `<path d="M72 43L30 72L72 101ZM114 43L72 72L114 101Z" fill="${THEME.text}"/>`;
  } else if (action === ACTIONS.mediaPlayPause) {
    icon = `<path d="M30 43L78 72L30 101Z" fill="${THEME.text}"/><rect x="88" y="43" width="9" height="58" rx="4.5" fill="${THEME.text}"/><rect x="105" y="43" width="9" height="58" rx="4.5" fill="${THEME.text}"/>`;
  } else if (action === ACTIONS.mediaForward) {
    icon = `<path d="M30 43L72 72L30 101ZM72 43L114 72L72 101Z" fill="${THEME.text}"/>`;
  } else if (action === ACTIONS.mediaMute) {
    icon = `<path d="M29 60H50L74 40V104L50 84H29Z" fill="${THEME.text}"/><path d="M84 57L114 87M114 57L84 87" fill="none" stroke="${THEME.text}" stroke-width="6" stroke-linecap="round"/>`;
  } else if (action === ACTIONS.mediaVolumeDown) {
    icon = `<path d="M34 60H54L78 40V104L54 84H34Z" fill="${THEME.text}"/><path d="M89 58C99 65 99 79 89 86" fill="none" stroke="${THEME.text}" stroke-width="6" stroke-linecap="round"/>`;
  } else if (action === ACTIONS.mediaVolumeUp) {
    icon = `<path d="M25 60H46L70 40V104L46 84H25Z" fill="${THEME.text}"/><path d="M82 57C93 65 93 79 82 87M96 44C116 59 116 85 96 100" fill="none" stroke="${THEME.text}" stroke-width="5.8" stroke-linecap="round"/>`;
  } else if (action === ACTIONS.mediaNext) {
    icon = `<path d="M41 43L99 72L41 101Z" fill="${THEME.text}"/><rect x="103" y="43" width="7" height="58" rx="3.5" fill="${THEME.text}"/>`;
  }
  return icon ? shell(THEME.text, icon) : null;
}

function staticActionSvg(action, context = null) {
  if (action === ACTIONS.newThread) return newThreadSvg();
  if (action === ACTIONS.voice) return voiceSvg(context ? voiceHeldContexts.has(context) : false);
  if (action === ACTIONS.send) return sendSvg();
  if (action === ACTIONS.appSwitch) return appSwitchSvg();
  if (action === ACTIONS.sideChat) return sideChatSvg();
  if (MEDIA_COMMAND_BY_ACTION.has(action)) return mediaActionSvg(action);
  return null;
}

function currentActionSvg(action, context = null) {
  if (action === ACTIONS.weekly) return usageSvg(usageState.remaining, usageState.failed);
  const slot = THREAD_SLOT_BY_ACTION.get(action);
  if (slot !== undefined) return threadSvg(threadSlots[slot], slot);
  return staticActionSvg(action, context);
}

function runKeyBridge(command, context = null) {
  execFile(KEY_BRIDGE, [command], { timeout: 2000 }, (error) => {
    if (!error) return;
    if (context) showFeedback(context, "error", "키 입력 실패");
    console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
  });
}

function runKeyBridgeSync(command, context = null) {
  try {
    execFileSync(KEY_BRIDGE, [command], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch (error) {
    if (context) showFeedback(context, "error", "키 입력 실패");
    console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

function isPausableMediaBundle(bundleId) {
  return [
    /^com\.apple\.(Music|Podcasts|TV|QuickTimePlayerX)$/i,
    /^com\.spotify\.client$/i,
    /^com\.google\.Chrome/i,
    /^com\.apple\.(Safari|WebKit)/i,
    /^company\.thebrowser\.Browser/i,
    /^com\.brave\.Browser/i,
    /^com\.microsoft\.edgemac/i,
    /^com\.vivaldi\.Vivaldi/i,
    /^com\.operasoftware\.Opera/i,
    /^org\.mozilla\.firefox/i,
    /^org\.videolan\.vlc/i,
    /^com\.colliderli\.iina/i,
    /^tv\.plex/i,
    /^com\.plexamp/i
  ].some((pattern) => pattern.test(bundleId));
}

function runningMediaProcessesSync() {
  try {
    const output = execFileSync(KEY_BRIDGE, ["audio-processes"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    }).trim();
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => {
        const [pidText, bundleId = ""] = line.split("\t");
        return { pid: Number(pidText), bundleId: bundleId.trim() };
      })
      .filter(({ pid, bundleId }) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && isPausableMediaBundle(bundleId));
  } catch (error) {
    console.error(`Could not enumerate active audio processes: ${error?.message ?? "unknown error"}`);
  }
  return [];
}

function pauseMediaForVoiceSync(context = null) {
  if (voiceSuspendedMediaPids.size > 0) return;
  for (const { pid, bundleId } of runningMediaProcessesSync()) {
    try {
      process.kill(pid, "SIGSTOP");
      voiceSuspendedMediaPids.add(pid);
    } catch (error) {
      console.error(`Could not pause media process ${bundleId} (${pid}): ${error?.message ?? "unknown error"}`);
    }
  }
}

function resumeMediaAfterVoiceSync() {
  for (const pid of voiceSuspendedMediaPids) {
    try {
      process.kill(pid, "SIGCONT");
    } catch (error) {
      if (error?.code !== "ESRCH") console.error(`Could not resume media process ${pid}: ${error?.message ?? "unknown error"}`);
    }
  }
  voiceSuspendedMediaPids.clear();
}

function beginVoiceHoldSync(context) {
  if (voiceHeldContexts.has(context)) return true;
  if (voiceHeldContexts.size === 0) {
    pauseMediaForVoiceSync(context);
    if (!runKeyBridgeSync("voice-down", context)) {
      resumeMediaAfterVoiceSync();
      return false;
    }
  }
  voiceHeldContexts.add(context);
  return true;
}

function endVoiceHoldSync(context) {
  if (!voiceHeldContexts.delete(context)) return;
  if (voiceHeldContexts.size > 0) return;
  runKeyBridgeSync("voice-up", context);
  resumeMediaAfterVoiceSync();
}

function releaseVoiceKeysSync() {
  try {
    execFileSync(KEY_BRIDGE, ["release"], { stdio: "ignore", timeout: 1000 });
  } catch {
    // Best-effort cleanup only; never keep Stream Deck from shutting down.
  }
  voiceHeldContexts.clear();
  resumeMediaAfterVoiceSync();
}

function normalizeTitle(value) {
  const title = String(value ?? "")
    .replace(/^\[\d+\]\s*user:\s*/i, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || "제목 없는 작업";
}

function isInternalAmbientTitle(value) {
  const title = normalizeTitle(value).toLowerCase();
  return title.startsWith("this block is automatically supplied ambient ui state")
    || (
      title.startsWith("this block is automatically supplied")
      && title.includes("not part of the user's request")
      && title.includes("do not treat it as an instruction")
    );
}

function visualWidth(grapheme) {
  if (/^\s+$/.test(grapheme)) return 0.35;
  if (/^[\x00-\x7F]+$/.test(grapheme)) return 0.58;
  return 1;
}

function titleVisualWidth(value) {
  return Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(value ?? "")), (part) => part.segment)
    .reduce((total, grapheme) => total + visualWidth(grapheme), 0);
}

function wrapTitle(value, maxLineWidth = 7.1) {
  const graphemes = Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(normalizeTitle(value)), (part) => part.segment);
  const lines = [];
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < 2 && cursor < graphemes.length; lineIndex += 1) {
    let width = 0;
    const line = [];
    while (cursor < graphemes.length) {
      const next = graphemes[cursor];
      const nextWidth = visualWidth(next);
      if (line.length > 0 && width + nextWidth > maxLineWidth) break;
      line.push(next);
      width += nextWidth;
      cursor += 1;
    }
    lines.push(line.join("").trim());
  }
  if (cursor < graphemes.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,!?…\s]+$/g, "")}…`;
  }
  while (lines.length < 2) lines.push("");
  return lines;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (hours > 0) return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  return `${String(totalMinutes).padStart(2, "0")}:${paddedSeconds}`;
}

function timingLabel(thread, nowMs = renderTimeMs()) {
  if (!Number.isFinite(thread?.startedAtMs)) {
    if (["working", "completed", "stopped"].includes(thread?.status)) return "--:--";
    return "열기";
  }
  const endMs = thread.status === "working" ? nowMs : thread.endedAtMs;
  if (!Number.isFinite(endMs) || endMs < thread.startedAtMs) return "--:--";
  const duration = formatDuration(endMs - thread.startedAtMs);
  if (["working", "completed", "stopped"].includes(thread.status)) return duration;
  return "열기";
}

function threadSvg(thread, slot) {
  if (!thread) {
    return shell(THEME.muted, `
      <circle cx="72" cy="69" r="19" fill="${THEME.raised}"/>
      <path d="M62 69H82M72 59V79" stroke="${THEME.muted}" stroke-width="2.5" stroke-linecap="round"/>
      <text x="72" y="114" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="19.5" font-weight="600" text-anchor="middle">작업 없음</text>`,
      threadHeader(THEME.muted, "idle", "대기", { kind: "idle", label: "작업 대기" }));
  }

  const styles = {
    working: { accent: THEME.blue, label: "작업중" },
    completed: { accent: THEME.green, label: "완료" },
    stopped: { accent: THEME.red, label: "중단" },
    idle: { accent: THEME.muted, label: "대기" },
    error: { accent: THEME.amber, label: "오류" }
  };
  const style = styles[thread.status] ?? styles.idle;
  const completionEffect = thread.status === "completed" ? completionPulseState(thread.id) : null;
  const completionStrength = completionEffect?.strength ?? 0;
  const completionTimeChrome = completionEffect ? `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.green}" fill-opacity="${(0.32 * completionStrength).toFixed(3)}" stroke="${THEME.green}" stroke-opacity="${(0.78 * completionStrength).toFixed(3)}" stroke-width="${(1 + completionStrength * 1.2).toFixed(2)}"/>` : "";
  const completionTimeText = completionEffect ? `
    <text x="72" y="125.5" fill="${THEME.text}" fill-opacity="${(0.82 * completionStrength).toFixed(3)}" font-family="${FONT_STACK}" font-size="21" font-weight="650" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(timingLabel(thread))}</text>` : "";
  const titleFontSize = 20.5;
  const titleX = thread.pinned ? 78 : 72;
  const [line1, line2] = wrapTitle(thread.title, thread.pinned ? 4.9 : 5.75);
  const hasSecondTitleLine = Boolean(line2);
  const titleLine1Y = hasSecondTitleLine ? 65 : 79;
  const pinYOffset = hasSecondTitleLine ? 0 : 13;
  const elapsedLabel = timingLabel(thread);
  const activity = thread.activity ?? {
    kind: thread.status === "completed" ? "complete" : thread.status === "stopped" ? "stopped" : thread.status === "error" ? "error" : thread.status === "working" ? "think" : "idle",
    label: thread.status === "completed" ? "작업 종료" : thread.status === "stopped" ? "마지막 활동" : thread.status === "error" ? "상태 확인" : thread.status === "working" ? "생각 중" : "다시 열기"
  };
  const firstLineWidth = titleVisualWidth(line1) * titleFontSize;
  const pinX = Math.max(12, Math.round(titleX - firstLineWidth / 2 - 13));
  const pinIcon = thread.pinned ? `
    <path d="M${pinX + 2} ${49 + pinYOffset}H${pinX + 10}L${pinX + 8} ${54 + pinYOffset}L${pinX + 11} ${58 + pinYOffset}H${pinX + 1}L${pinX + 4} ${54 + pinYOffset}Z" fill="${THEME.textSecondary}"/>
    <path d="M${pinX + 6} ${58 + pinYOffset}V${66 + pinYOffset}" stroke="${THEME.textSecondary}" stroke-width="1.7" stroke-linecap="round"/>` : "";
  return shell(style.accent, `
    ${pinIcon}
    <text x="${titleX}" y="${titleLine1Y}" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line1)}</text>
    ${hasSecondTitleLine ? `<text x="72" y="89" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line2)}</text>` : ""}
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.raised}"/>
    ${completionTimeChrome}
    <text x="72" y="125.5" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="21" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>
    ${completionTimeText}`,
    threadHeader(style.accent, thread.status, style.label, activity, thread.status === "working", thread.reasoningEffort, thread.serviceTier, completionEffect),
    completionPulseChrome(completionEffect));
}

async function readUsage() {
  const { stdout } = await execFileAsync(
    CODEXBAR,
    ["usage", "--provider", "codex", "--source", "auto", "--format", "json", "--json-only"],
    { timeout: 15000, maxBuffer: 1024 * 1024 }
  );
  const rows = JSON.parse(stdout);
  const codex = Array.isArray(rows) ? rows.find((row) => row?.provider === "codex") : null;
  if (!codex?.usage) throw new Error("Codex usage was not returned");
  return codex.usage;
}

async function readPinnedIds() {
  try {
    const state = JSON.parse(await fs.readFile(GLOBAL_STATE, "utf8"));
    const ids = Array.isArray(state?.["pinned-thread-ids"]) ? state["pinned-thread-ids"] : [];
    return [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
  } catch {
    return [];
  }
}

async function readThreadRows() {
  const query = `SELECT id, title, cwd, rollout_path, recency_at, updated_at FROM threads WHERE archived=0 AND (agent_path IS NULL OR agent_path='') ORDER BY recency_at DESC, updated_at DESC;`;
  const { stdout } = await execFileAsync(SQLITE, ["-readonly", "-json", STATE_DB, query], {
    timeout: 4000,
    maxBuffer: 4 * 1024 * 1024
  });
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(rows) ? rows : [];
}

async function readSidebarThreadNames() {
  const names = new Map();
  try {
    const content = await fs.readFile(SESSION_INDEX, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const name = typeof row?.thread_name === "string" ? row.thread_name.trim() : "";
        if (UUID_PATTERN.test(row?.id ?? "") && name) names.set(row.id, name);
      } catch {
        // Ignore a partially written row and retain the last valid sidebar title.
      }
    }
  } catch {
    // The SQLite title remains available as a fallback.
  }
  return names;
}

async function readActiveThreadIds() {
  const active = new Set();
  try {
    const rows = JSON.parse(await fs.readFile(PROCESS_REGISTRY, "utf8"));
    if (!Array.isArray(rows)) return active;
    for (const row of rows) {
      const pid = Number(row?.osPid);
      if (!UUID_PATTERN.test(row?.conversationId ?? "") || !Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        active.add(row.conversationId);
      } catch {
        // Ignore stale process registry entries.
      }
    }
  } catch {
    // A missing registry simply means there are no known background commands.
  }
  return active;
}

function classifyToolActivity(input) {
  const text = String(input ?? "");
  if (!text) return null;
  if (/tools\.apply_patch|const\s+patch\s*=|\*\*\* Begin Patch/i.test(text)) return { kind: "edit", label: "코드 수정" };
  if (/tools\.update_plan/i.test(text)) return { kind: "edit", label: "계획 정리" };
  if (/tools\.(?:web__run|web\.run)|tools\.mcp__.*(?:search|browse)/i.test(text)) return { kind: "search", label: "웹 검색" };
  if (/tools\.(?:view_image|image_gen__imagegen)/i.test(text)) return { kind: "inspect", label: /imagegen/i.test(text) ? "이미지 생성" : "이미지 확인" };
  if (/mcp__node_repl__js|sky\.(?:get_app_state|click|press_key|set_value|type_text|scroll)/i.test(text)) {
    return /get_app_state/i.test(text) ? { kind: "inspect", label: "앱 화면 확인" } : { kind: "command", label: "앱 조작" };
  }
  if (!/tools\.exec_command/i.test(text)) return { kind: "command", label: "도구 실행" };
  if (/StreamDeck\/Plugins|com\.elgato\.StreamDeck\/Plugins/i.test(text) && /\b(?:cp|ditto|rsync)\b/i.test(text)) return { kind: "command", label: "플러그인 설치" };
  if (/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|pytest|node\s+--test|cargo\s+test|go\s+test|vitest|jest/i.test(text)) return { kind: "command", label: "테스트 실행" };
  if (/node\s+--check|tsc\s+--noEmit|eslint|ruff\s+check|mypy/i.test(text)) return { kind: "inspect", label: "코드 검증" };
  if (/\bxmllint\b/i.test(text)) return { kind: "inspect", label: "화면 구조 검증" };
  if (/\bshasum\b/i.test(text)) return { kind: "inspect", label: "설치 파일 확인" };
  if (/rollout-|session_index\.jsonl|\.jsonl/i.test(text) && /\b(?:tail|jq)\b/i.test(text)) return { kind: "inspect", label: "활동 기록 확인" };
  if (/\bsqlite3\b/i.test(text)) return { kind: "inspect", label: "작업 목록 확인" };
  if (/\bcodexbar\b/i.test(text)) return { kind: "inspect", label: "사용량 확인" };
  if (/\b(?:rg|grep|find|fd|mdfind)\b/i.test(text)) return { kind: "search", label: "파일 검색" };
  if (/\b(?:sed|head|tail|jq|ls|stat)\b/i.test(text)) return { kind: "inspect", label: "파일 내용 확인" };
  if (/\b(?:ps|pgrep|lsof)\b/i.test(text)) return { kind: "inspect", label: "실행 상태 확인" };
  if (/\b(?:python|python3)\b/i.test(text)) return { kind: "command", label: "Python 실행" };
  if (/\b(?:npm|pnpm|yarn|bun)\b/i.test(text)) return { kind: "command", label: "패키지 명령" };
  if (/\b(?:mkdir|cp|mv|rsync)\b/i.test(text)) return { kind: "edit", label: "파일 정리" };
  return { kind: "command", label: "명령 실행" };
}

function activityFromEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.type === "event_msg") {
    if (payload.type === "task_complete" || payload.type === "turn_aborted") return null;
    if (payload.type === "task_started" || payload.type === "user_message") return { kind: "request", label: "요청 분석" };
    if (payload.type === "patch_apply_end") return { kind: payload.success === false ? "error" : "edit", label: payload.success === false ? "수정 실패" : "코드 수정" };
    if (payload.type === "mcp_tool_call_end") {
      const server = String(payload?.invocation?.server ?? "");
      if (/node_repl/i.test(server)) return { kind: "inspect", label: "앱 화면 확인" };
      if (/web|browser|chrome/i.test(server)) return { kind: "search", label: "웹 결과 확인" };
      return { kind: "inspect", label: "도구 결과 확인" };
    }
    if (payload.type === "agent_reasoning") return { kind: "think", label: "생각 중" };
    if (payload.type === "context_compacted") return { kind: "edit", label: "대화 정리" };
    if (payload.type === "agent_message") return payload.phase === "final_answer"
      ? { kind: "answer", label: "답변 완료" }
      : { kind: "answer", label: "답변 작성" };
    return null;
  }
  if (event?.type === "response_item") {
    if (payload.type === "custom_tool_call") return classifyToolActivity(payload.input);
    if (payload.type === "reasoning") return { kind: "think", label: "생각 중" };
  }
  return null;
}

function consumeLifecycleLines(lines, lifecycle) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!lifecycle.activity) lifecycle.activity = activityFromEvent(event);
    if (event?.type === "turn_context") {
      const effort = event?.payload?.effort;
      if (!lifecycle.reasoningEffort && typeof effort === "string") lifecycle.reasoningEffort = effort;
    }
    if (event?.type !== "event_msg") {
      if (lifecycle.foundStart && lifecycle.reasoningEffort && lifecycle.serviceTier !== undefined) return true;
      continue;
    }
    const type = event?.payload?.type;
    if (type === "thread_settings_applied") {
      const settings = event?.payload?.thread_settings ?? {};
      if (!lifecycle.reasoningEffort && typeof settings.reasoning_effort === "string") {
        lifecycle.reasoningEffort = settings.reasoning_effort;
      }
      if (lifecycle.serviceTier === undefined && Object.hasOwn(settings, "service_tier")) {
        lifecycle.serviceTier = typeof settings.service_tier === "string" ? settings.service_tier : "default";
      }
    }
    const timestampMs = Date.parse(event?.timestamp ?? "");
    const validTimestamp = Number.isFinite(timestampMs) ? timestampMs : null;
    if (!lifecycle.status) {
      if (type === "task_complete") {
        lifecycle.status = "completed";
        lifecycle.endedAtMs = validTimestamp;
      } else if (type === "turn_aborted") {
        lifecycle.status = "stopped";
        lifecycle.endedAtMs = validTimestamp;
      } else if (type === "task_started" || type === "user_message") {
        lifecycle.status = "working";
      }
    }
    if (lifecycle.status && type === "task_started" && !lifecycle.foundStart) {
      lifecycle.startedAtMs = validTimestamp;
      lifecycle.foundStart = true;
    }
    if (lifecycle.foundStart && lifecycle.reasoningEffort && lifecycle.serviceTier !== undefined) return true;
  }
  return false;
}

async function scanLatestStatus(filePath, maxSearchBytes = 64 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, "r");
  const chunkSize = 512 * 1024;
  let cursor = stat.size;
  let searched = 0;
  let carry = "";
  const lifecycle = {
    status: null,
    startedAtMs: null,
    endedAtMs: null,
    activity: null,
    reasoningEffort: null,
    serviceTier: undefined,
    foundStart: false
  };
  try {
    while (cursor > 0 && searched < maxSearchBytes) {
      const length = Math.min(chunkSize, cursor, maxSearchBytes - searched);
      const start = cursor - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = `${buffer.toString("utf8")}${carry}`;
      const lines = text.split("\n");
      carry = lines.shift() ?? "";
      const foundStart = consumeLifecycleLines(lines, lifecycle);
      if (foundStart) return { ...lifecycle, serviceTier: lifecycle.serviceTier ?? "default", size: stat.size, mtimeMs: stat.mtimeMs };
      cursor = start;
      searched += length;
    }
    consumeLifecycleLines([carry], lifecycle);
    return {
      ...lifecycle,
      status: lifecycle.status ?? "idle",
      serviceTier: lifecycle.serviceTier ?? "default",
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } finally {
    await handle.close();
  }
}

async function statusForThread(thread, activeThreadIds) {
  const isActive = activeThreadIds.has(thread.id);
  if (!thread.rollout_path) return {
    status: isActive ? "working" : "idle",
    startedAtMs: null,
    endedAtMs: null,
    reasoningEffort: null,
    serviceTier: "default",
    activity: isActive ? { kind: "command", label: "백그라운드" } : { kind: "idle", label: "다시 열기" }
  };
  try {
    const stat = await fs.stat(thread.rollout_path);
    const cached = statusCache.get(thread.id);
    const scanned = cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs
      ? cached
      : await scanLatestStatus(thread.rollout_path);
    if (scanned !== cached) statusCache.set(thread.id, scanned);
    // A live child process can outlast the Codex turn that launched it. Once the
    // rollout records a terminal event, keep that terminal state and its end
    // timestamp instead of letting the process registry restart the timer.
    if (!isActive || ["completed", "stopped"].includes(scanned.status)) return scanned;
    return {
      ...scanned,
      status: "working",
      endedAtMs: null,
      activity: scanned.status === "working" ? scanned.activity : { kind: "command", label: "백그라운드" }
    };
  } catch {
    return {
      status: isActive ? "working" : "error",
      startedAtMs: null,
      endedAtMs: null,
      reasoningEffort: null,
      serviceTier: "default",
      activity: isActive ? { kind: "command", label: "백그라운드" } : { kind: "error", label: "상태 확인" }
    };
  }
}

async function readTopThreads() {
  const [rows, pinnedIds, activeThreadIds, sidebarNames] = await Promise.all([
    readThreadRows(),
    readPinnedIds(),
    readActiveThreadIds(),
    readSidebarThreadNames()
  ]);
  const visibleRows = rows
    .map((row) => ({ ...row, title: sidebarNames.get(row.id) ?? row.title }))
    .filter((row) => !isInternalAmbientTitle(row.title));
  const byId = new Map(visibleRows.map((row) => [row.id, row]));
  const selected = [];
  const selectedIds = new Set();

  for (const id of pinnedIds) {
    const row = byId.get(id);
    if (!row || selectedIds.has(id)) continue;
    selected.push({ ...row, pinned: true });
    selectedIds.add(id);
    if (selected.length === THREAD_COUNT) break;
  }

  for (const row of visibleRows) {
    if (selected.length === THREAD_COUNT) break;
    if (selectedIds.has(row.id)) continue;
    selected.push({ ...row, pinned: false });
    selectedIds.add(row.id);
  }

  const lifecycles = await Promise.all(selected.map((thread) => statusForThread(thread, activeThreadIds)));
  return selected.map((thread, index) => ({ ...thread, ...lifecycles[index] }));
}

async function readSystemAppearance() {
  const forced = String(process.env.THREADDECK_APPEARANCE ?? "").toLowerCase();
  if (["dark", "light"].includes(forced)) return forced;
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
      timeout: 1500,
      maxBuffer: 4096
    });
    return stdout.trim().toLowerCase() === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

async function refreshAppearance() {
  if (!activeAppearanceRefresh) {
    activeAppearanceRefresh = (async () => {
      try {
        const nextMode = await readSystemAppearance();
        if (nextMode === appearanceMode) return false;
        appearanceMode = nextMode;
        THEME = appearanceMode === "dark" ? DARK_THEME : LIGHT_THEME;
        renderUsageContexts();
        renderThreadContexts();
        renderStaticContexts();
        return true;
      } finally {
        activeAppearanceRefresh = null;
      }
    })();
  }
  return activeAppearanceRefresh;
}

function renderUsageContexts() {
  for (const [context, action] of contexts) {
    if (action === ACTIONS.weekly) setImage(context, usageSvg(usageState.remaining, usageState.failed));
  }
}

function renderStaticContexts() {
  for (const [context, action] of contexts) {
    const svg = staticActionSvg(action, context);
    if (svg) setImage(context, svg);
  }
}

function startCompletionEffects(threadId, nowMs = Date.now()) {
  completionPulseStartedAt.set(threadId, nowMs);
  globalCompletionStartedAtMs = nowMs;
  globalCompletionThreadId = threadId;
  globalCompletionWasRendered = false;
  globalCompletionRenderGroup = 0;
}

function renderGlobalCompletionContexts(nowMs = Date.now()) {
  const effect = globalCompletionPulseState(nowMs);
  if (effect) {
    // Update alternating halves every 25 ms. Each plugin-owned key receives a
    // steady 20 fps animation, while Stream Deck sees small image bursts
    // instead of every SVG arriving at once. The completed key is rendered
    // here too, preventing its old 30 fps loop from starving nearby buttons.
    globalCompletionWasRendered = true;
    const entries = [...contexts.entries()];
    const renderGroup = globalCompletionRenderGroup;
    globalCompletionRenderGroup = (globalCompletionRenderGroup + 1) % GLOBAL_COMPLETION_GROUP_COUNT;
    for (let index = 0; index < entries.length; index += 1) {
      if (index % GLOBAL_COMPLETION_GROUP_COUNT !== renderGroup) continue;
      const [context, action] = entries[index];
      const svg = currentActionSvg(action, context) ?? contextImages.get(context);
      if (!svg) continue;
      contextImages.set(context, svg);
      sendImage(context, composedContextSvg(context, svg, nowMs));
    }
    return true;
  }

  if (!globalCompletionWasRendered) return false;
  globalCompletionWasRendered = false;
  globalCompletionStartedAtMs = null;
  globalCompletionThreadId = null;
  globalCompletionRenderGroup = 0;
  for (const [context, action] of contexts) {
    const svg = currentActionSvg(action, context) ?? contextImages.get(context);
    if (!svg) continue;
    contextImages.set(context, svg);
    sendImage(context, composedContextSvg(context, svg, nowMs));
  }
  return false;
}

async function refreshUsage(feedbackContext) {
  if (feedbackContext) showFeedback(feedbackContext, "loading", "사용량 확인");
  if (!activeUsageRefresh) {
    activeUsageRefresh = (async () => {
      try {
        const usage = await readUsage();
        const remaining = remainingPercent(usage?.secondary?.usedPercent);
        usageState = { remaining, failed: false };
        renderUsageContexts();
        return true;
      } catch (error) {
        usageState = { remaining: null, failed: true };
        renderUsageContexts();
        console.error(`Codex usage refresh failed: ${error?.message ?? "unknown error"}`);
        return false;
      } finally {
        activeUsageRefresh = null;
      }
    })();
  }
  const succeeded = await activeUsageRefresh;
  if (feedbackContext) {
    showFeedback(feedbackContext, succeeded ? "success" : "error", succeeded ? "갱신 완료" : "갱신 실패");
  }
  return succeeded;
}

function renderThreadContexts() {
  for (const [context, action] of contexts) {
    const slot = THREAD_SLOT_BY_ACTION.get(action);
    if (slot !== undefined) setImage(context, threadSvg(threadSlots[slot], slot));
  }
}

function renderAnimatedThreadContexts(nowMs = Date.now()) {
  for (const [context, action] of contexts) {
    const slot = THREAD_SLOT_BY_ACTION.get(action);
    const thread = slot === undefined ? null : threadSlots[slot];
    const completionStartedAtMs = thread?.id ? completionPulseStartedAt.get(thread.id) : null;
    const completionAnimating = Number.isFinite(completionStartedAtMs)
      && nowMs - completionStartedAtMs < THREAD_COMPLETION_PULSE_DURATION_MS;
    if (
      (thread?.status === "working" && String(thread.reasoningEffort ?? "").toLowerCase() === "ultra")
      || completionAnimating
    ) {
      setImage(context, threadSvg(threadSlots[slot], slot));
    } else if (Number.isFinite(completionStartedAtMs)) {
      completionPulseStartedAt.delete(thread.id);
      setImage(context, threadSvg(threadSlots[slot], slot));
    }
  }
}

function trackCompletionTransitions(previousThreads, nextThreads, nowMs = Date.now()) {
  const previousById = new Map(previousThreads.filter(Boolean).map((thread) => [thread.id, thread]));
  if (!hasLoadedThreadState) {
    for (const thread of nextThreads) {
      if (thread?.status === "completed" && Number.isFinite(thread.endedAtMs)) {
        observedCompletionEndMs.set(thread.id, thread.endedAtMs);
      }
    }
    hasLoadedThreadState = true;
    return;
  }

  const visibleIds = new Set(nextThreads.filter(Boolean).map((thread) => thread.id));
  for (const thread of nextThreads) {
    if (!thread?.id) continue;
    if (thread.status === "working") {
      completionPulseStartedAt.delete(thread.id);
      continue;
    }
    if (thread.status !== "completed") continue;

    const previous = previousById.get(thread.id);
    const knownEndMs = observedCompletionEndMs.get(thread.id);
    const hasNewEndMarker = Number.isFinite(thread.endedAtMs)
      && Number.isFinite(knownEndMs)
      && thread.endedAtMs !== knownEndMs;
    const justTransitioned = previous && previous.status !== "completed";
    if (justTransitioned || hasNewEndMarker) startCompletionEffects(thread.id, nowMs);
    if (Number.isFinite(thread.endedAtMs)) observedCompletionEndMs.set(thread.id, thread.endedAtMs);
  }

  for (const threadId of completionPulseStartedAt.keys()) {
    if (!visibleIds.has(threadId)) completionPulseStartedAt.delete(threadId);
  }
}

async function refreshThreads(feedbackContext) {
  if (!activeThreadRefresh) {
    activeThreadRefresh = (async () => {
      try {
        const threads = await readTopThreads();
        pulse = !pulse;
        const nextThreadSlots = THREAD_ACTIONS.map((_, index) => threads[index] ?? null);
        trackCompletionTransitions(threadSlots, nextThreadSlots);
        threadSlots = nextThreadSlots;
        renderThreadContexts();
        if (feedbackContext) showFeedback(feedbackContext, "success", "목록 갱신");
        return true;
      } catch (error) {
        for (const [context, action] of contexts) {
          const slot = THREAD_SLOT_BY_ACTION.get(action);
          if (slot !== undefined) setImage(context, threadSvg({ title: "상태를 읽지 못함", status: "error", pinned: false }, slot));
        }
        if (feedbackContext) showFeedback(feedbackContext, "error", "갱신 실패");
        console.error(`Codex thread refresh failed: ${error?.message ?? "unknown error"}`);
        return false;
      } finally {
        activeThreadRefresh = null;
      }
    })();
  }
  return activeThreadRefresh;
}

async function openThread(context, slot) {
  const thread = threadSlots[slot];
  if (!thread?.id) {
    showFeedback(context, "error", "작업 없음");
    return;
  }
  showFeedback(context, "loading", "여는 중");
  try {
    await execFileAsync("/usr/bin/open", [`codex://threads/${thread.id}`], { timeout: 5000 });
    showFeedback(context, "success", "전환 완료");
    setTimeout(() => void refreshThreads(), 1000);
  } catch (error) {
    showFeedback(context, "error", "열기 실패");
    console.error(`Could not open Codex thread: ${error?.message ?? "unknown error"}`);
  }
}

async function openNewThread(context) {
  try {
    await execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!runKeyBridgeSync("new-thread", context)) return;
  } catch (error) {
    showFeedback(context, "error", "열기 실패");
    console.error(`Could not open a new Codex thread: ${error?.message ?? "unknown error"}`);
  }
}

async function openSideChat(context) {
  try {
    await execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!runKeyBridgeSync("side-chat", context)) return;
  } catch (error) {
    showFeedback(context, "error", "열기 실패");
    console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
  }
}

function registerPlugin() {
  if (!port || !pluginUUID || !registerEvent) process.exit(1);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.addEventListener("open", () => {
    send({ event: registerEvent, uuid: pluginUUID });
  });

  socket.addEventListener("message", async (event) => {
    let raw = event.data;
    if (typeof raw !== "string") {
      if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString("utf8");
      else if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
      else if (raw && typeof raw.text === "function") raw = await raw.text();
      else raw = String(raw);
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.event === "willAppear" && Object.values(ACTIONS).includes(message.action)) {
      contexts.set(message.context, message.action);
      if (message.action === ACTIONS.weekly) {
        // Stream Deck restores the last dynamic key image before a plugin has
        // reconnected. Replace it synchronously so stale usage never flashes.
        setImage(message.context, usageSvg(usageState.remaining, usageState.failed));
        void refreshUsage();
      } else if (THREAD_SLOT_BY_ACTION.has(message.action)) {
        // In particular, do not leave a previously rendered thread visible
        // while SQLite and rollout state are being read on startup.
        const slot = THREAD_SLOT_BY_ACTION.get(message.action);
        setImage(message.context, threadSvg(null, slot));
        void refreshThreads();
      } else {
        const svg = staticActionSvg(message.action, message.context);
        if (svg) setImage(message.context, svg);
      }
    } else if (message.event === "willDisappear") {
      endVoiceHoldSync(message.context);
      contexts.delete(message.context);
      contextImages.delete(message.context);
      contextFeedback.delete(message.context);
    } else if (message.event === "keyDown" && contexts.has(message.context)) {
      const action = contexts.get(message.context);
      if (action === ACTIONS.voice && !voiceHeldContexts.has(message.context)) {
        if (beginVoiceHoldSync(message.context)) {
          setImage(message.context, voiceSvg(true));
        }
      } else if (action === ACTIONS.send) {
        runKeyBridge("send", message.context);
      } else if (action === ACTIONS.appSwitch) {
        runKeyBridge("app-switch", message.context);
      } else if (MEDIA_COMMAND_BY_ACTION.has(action)) {
        runKeyBridge(MEDIA_COMMAND_BY_ACTION.get(action), message.context);
      }
    } else if (message.event === "keyUp" && contexts.has(message.context)) {
      const action = contexts.get(message.context);
      if (action === ACTIONS.voice) {
        endVoiceHoldSync(message.context);
        setImage(message.context, voiceSvg(false));
      } else if (action === ACTIONS.send || action === ACTIONS.appSwitch || MEDIA_COMMAND_BY_ACTION.has(action)) {
        // These are dispatched on keyDown so their response feels immediate.
      } else if (action === ACTIONS.weekly) {
        void refreshUsage(message.context);
      } else if (action === ACTIONS.newThread) {
        void openNewThread(message.context);
      } else if (action === ACTIONS.sideChat) {
        void openSideChat(message.context);
      } else {
        const slot = THREAD_SLOT_BY_ACTION.get(action);
        if (slot !== undefined) void openThread(message.context, slot);
      }
    }
  });

  setInterval(() => {
    if ([...contexts.values()].some((action) => THREAD_SLOT_BY_ACTION.has(action))) renderThreadContexts();
  }, 1000);

  setInterval(() => {
    const nowMs = Date.now();
    if (!globalCompletionPulseState(nowMs) && [...contexts.values()].some((action) => THREAD_SLOT_BY_ACTION.has(action))) {
      renderAnimatedThreadContexts(nowMs);
    }
  }, 33);

  setInterval(() => {
    if (contexts.size > 0) renderGlobalCompletionContexts(Date.now());
  }, GLOBAL_COMPLETION_FRAME_INTERVAL_MS);

  setInterval(() => {
    if ([...contexts.values()].some((action) => THREAD_SLOT_BY_ACTION.has(action))) void refreshThreads();
  }, 3000);

  setInterval(() => {
    if ([...contexts.values()].includes(ACTIONS.weekly)) void refreshUsage();
  }, 60_000);

  setInterval(() => {
    if (contexts.size > 0) void refreshAppearance();
  }, 2000);
}

function renderDemo(outputPath, mode = "dark") {
  appearanceMode = mode;
  THEME = mode === "dark" ? DARK_THEME : LIGHT_THEME;
  const nowMs = 1_800_000_000_000;
  fixedRenderTimeMs = nowMs;
  const keySvgs = [
    usageSvg(74, false),
    sideChatSvg(),
    newThreadSvg(),
    sendSvg(),
    threadSvg({
      id: "00000000-0000-4000-8000-000000000001",
      title: "리팩터링",
      pinned: true,
      status: "working",
      startedAtMs: nowMs - 4 * 60_000 - 12_000,
      endedAtMs: null,
      activity: { kind: "edit", label: "코드 수정" },
      reasoningEffort: "ultra",
      serviceTier: "priority"
    }, 0),
    appSwitchSvg(),
    voiceSvg(false),
    threadSvg({
      id: "00000000-0000-4000-8000-000000000002",
      title: "빌드 검증",
      pinned: false,
      status: "completed",
      startedAtMs: nowMs - 12 * 60_000 - 17_000,
      endedAtMs: nowMs - 10 * 60_000,
      activity: { kind: "complete", label: "작업 완료" },
      reasoningEffort: "high",
      serviceTier: "default"
    }, 1)
  ];
  const margin = 28;
  const gap = 18;
  const keySize = 144;
  const width = margin * 2 + keySize * 4 + gap * 3;
  const height = margin * 2 + keySize * 2 + gap;
  const images = keySvgs.map((svg, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = margin + column * (keySize + gap);
    const y = margin + row * (keySize + gap);
    const data = Buffer.from(svg).toString("base64");
    return `<image x="${x}" y="${y}" width="${keySize}" height="${keySize}" href="data:image/svg+xml;base64,${data}"/>`;
  }).join("\n  ");
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="34" fill="#2F2F2F"/>
  ${images}
</svg>\n`;
  const resolvedOutput = path.resolve(outputPath);
  fsSync.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fsSync.writeFileSync(resolvedOutput, preview);
  fixedRenderTimeMs = null;
  console.log(`Rendered ${resolvedOutput}`);
}

process.once("SIGTERM", () => {
  releaseVoiceKeysSync();
  process.exit(0);
});
process.once("SIGINT", () => {
  releaseVoiceKeysSync();
  process.exit(0);
});
process.on("exit", releaseVoiceKeysSync);

if (demoOutput || demoLightOutput) {
  renderDemo(demoOutput || demoLightOutput, demoLightOutput ? "light" : "dark");
} else if (snapshotMode) {
  readTopThreads()
    .then((threads) => {
      console.log(JSON.stringify(threads.map(({ id, title, pinned, status, startedAtMs, endedAtMs, activity, reasoningEffort, serviceTier }) => ({
        id,
        title: normalizeTitle(title),
        pinned,
        status,
        activity,
        reasoningEffort,
        serviceTier,
        speed: isFastServiceTier(serviceTier) ? "fast" : "standard",
        timing: timingLabel({ status, startedAtMs, endedAtMs })
      })), null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
} else {
  registerPlugin();
}
