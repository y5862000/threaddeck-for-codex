"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { execFile, execFileSync, spawn } = require("node:child_process");
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
const CODEX_DESKTOP_LOG_ROOT = path.resolve(
  process.env.THREADDECK_CODEX_LOG_ROOT || path.join(USER_HOME, "Library", "Logs", "com.openai.codex")
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
  mediaNext: "com.yechan.threaddeck.media.next",
  pagePrevious: "com.yechan.threaddeck.page.previous",
  pageNext: "com.yechan.threaddeck.page.next"
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
const THREAD_REFRESH_RETRY_DELAYS_MS = [120, 360];
const THREAD_REFRESH_STARTUP_ERROR_FAILURES = 3;
const GLOBAL_COMPLETION_PULSE_DURATION_MS = 2600;
const GLOBAL_COMPLETION_FRAME_INTERVAL_MS = 80;
const GLOBAL_COMPLETION_GROUP_COUNT = 2;
const COMPLETION_STARTUP_GRACE_MS = 15_000;
const COMPLETION_OBSERVATION_OVERLAP_MS = 1_500;
const SEND_LONG_PRESS_MS = 600;
const THREAD_VOICE_LONG_PRESS_MS = 550;
const THREAD_VOICE_FOCUS_SETTLE_MS = 90;
const VOICE_TRANSCRIPTION_POLL_INTERVAL_MS = 100;
const VOICE_TEXT_PROBE_INTERVAL_MS = 200;
const VOICE_TRANSCRIPTION_STABLE_MS = 450;
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 20_000;
const VOICE_AUTO_SUBMIT_STABLE_MS = 750;
const VOICE_SUBMIT_VERIFY_DELAYS_MS = [180, 280, 440];
const VOICE_START_VERIFY_MS = 1_500;
const VOICE_COMPLETE_DISPLAY_MS = 900;
const VOICE_ERROR_DISPLAY_MS = 1_300;
const VOICE_TARGET_OPEN_HINT_MS = 120_000;
const QUEUE_ZERO_CONFIRM_MS = 1_200;
const SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS = 8_000;
const SIDE_CHAT_TARGET_REFRESH_DELAYS_MS = [180, 500, 1_000, 1_800, 3_000, 4_800];
const SIDE_CHAT_TARGET_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const APP_SERVER_SESSION_CACHE_MS = 5_000;
const APP_SERVER_START_TOLERANCE_MS = 5_000;
const DESKTOP_LOG_PATH_CACHE_MS = 5_000;
const SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES = 64 * 1024 * 1024;
const REMOTE_LIFECYCLE_LOG_SEARCH_LIMIT_BYTES = 32 * 1024 * 1024;
const REMOTE_REASONING_PROBE_CACHE_MS = 5_000;
const REMOTE_REASONING_TURN_TOLERANCE_MS = 5_000;
const REASONING_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const QUEUED_MESSAGE_DELETE_LABELS = [
  "대기열에 있는 메시지 삭제",
  "Delete queued message"
];
const QUEUED_MESSAGE_ACTION_LABELS = [
  "대기열에 있는 메시지 액션",
  "Queued message actions"
];
const THREAD_REFRESH_ERROR_STATE = Object.freeze({
  title: "상태를 읽지 못함",
  status: "error",
  pinned: false,
  activity: { kind: "error", label: "상태 확인" }
});
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
const PAGE_DIRECTION_BY_ACTION = new Map([
  [ACTIONS.pagePrevious, -1],
  [ACTIONS.pageNext, 1]
]);
const DISTRIBUTED_PROFILE_NAME = "profiles/threaddeck-neo";
const DEFAULT_PROFILE_PAGE_COUNT = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Use fonts already supplied by macOS. The public plugin intentionally does
// not redistribute proprietary font files.
const FONT_STACK = "'.AppleSystemUIFont', 'SF Pro Display', 'SF Pro Text', 'Apple SD Gothic Neo', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const DARK_THEME = Object.freeze({
  canvas: "#000000",
  card: "#000000",
  raised: "#2F2F2F",
  border: "rgba(255, 255, 255, 0.05)",
  borderStrong: "rgba(255, 255, 255, 0.10)",
  text: "#F2F6FA",
  textSecondary: "#CDCDCD",
  muted: "#818181",
  blue: "#0285FF",
  green: "#10A37F",
  red: "#FF6764",
  amber: "#F5A524",
  sliderTrack: "rgba(255, 255, 255, 0.10)"
});
const LIGHT_THEME = Object.freeze({
  canvas: "#F4F4F4",
  card: "#FFFFFF",
  raised: "#E7E7E7",
  border: "rgba(0, 0, 0, 0.10)",
  borderStrong: "rgba(0, 0, 0, 0.18)",
  text: "#0D0D0D",
  textSecondary: "#5F5F5F",
  muted: "#737373",
  blue: "#006FCC",
  green: "#087F68",
  red: "#C02623",
  amber: "#AC4F23",
  sliderTrack: "rgba(0, 0, 0, 0.12)"
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
const completionContractMode = process.argv.includes("--verify-completion");
const refreshResilienceContractMode = process.argv.includes("--verify-refresh-resilience");
const threadSelectionContractMode = process.argv.includes("--verify-thread-selection");
const usageCacheContractMode = process.argv.includes("--verify-usage-cache");
const voiceSubmitContractMode = process.argv.includes("--verify-voice-submit");
const remoteLifecycleContractMode = process.argv.includes("--verify-remote-lifecycle");
const demoOutput = argument("--render-demo");
const demoLightOutput = argument("--render-demo-light");
const demoAnimationDirectory = argument("--render-demo-animation");
const pluginStartedAtMs = Date.now();

const contexts = new Map();
const contextImages = new Map();
const contextSentImages = new Map();
const contextFeedback = new Map();
const statusCache = new Map();
const completionPulseStartedAt = new Map();
const completionPulseReasonByThreadId = new Map();
const observedCompletionEndMs = new Map();
const voiceHeldContexts = new Set();
const voiceSuspendedMediaPids = new Set();
const voiceStateByContext = new Map();
const voiceStateResetAtMs = new Map();
const voiceTranscriptionByContext = new Map();
const voiceTargetThreadByContext = new Map();
const voiceStartVerificationTimers = new Map();
const sendPressStartedAt = new Map();
const sendLongPressTimers = new Map();
const sendLongPressArmedContexts = new Set();
const threadPressByContext = new Map();
let socket = null;
let activeUsageRefresh = null;
let activeThreadRefresh = null;
let activeAppearanceRefresh = null;
let threadSlots = Array(THREAD_COUNT).fill(null);
let usageState = { remaining: null, failed: false };
let hasLoadedUsageState = false;
let pulse = false;
let feedbackSerial = 0;
let hasLoadedThreadState = false;
let consecutiveThreadRefreshFailures = 0;
let threadRefreshUnavailable = false;
let lastThreadTransitionScanAtMs = pluginStartedAtMs - COMPLETION_STARTUP_GRACE_MS;
let globalCompletionStartedAtMs = null;
let globalCompletionThreadId = null;
let globalCompletionWasRendered = false;
let globalCompletionRenderGroup = 0;
let globalCompletionInitialFanoutPending = false;
let mostRecentThreadId = null;
let lastOpenedThreadId = null;
let lastOpenedThreadAtMs = null;
let knownSideChatIds = new Set();
let pendingSideChatTarget = null;
let appServerSessionCache = { checkedAtMs: 0, startedAtMs: null };
let desktopLogPathCache = { checkedAtMs: 0, path: null, paths: [] };
let accessibilityTrustCache = { checkedAtMs: 0, trusted: null };
let pinnedIdsCache = [];
let remoteThreadRowsCache = [];
let sideChatSessionStartMs = null;
const sideChatParentById = new Map();
const sideChatLifecycleCache = new Map();
const closedSideChatAtMs = new Map();
const sideChatCloseLogOffsets = new Map();
const remoteLifecycleCache = new Map();
const remoteLifecycleLogOffsets = new Map();
const remoteReasoningEffortByThreadId = new Map();
const queueStateByThreadId = new Map();
let remoteReasoningProbe = { threadId: null, checkedAtMs: 0 };

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function setTitle(context, title) {
  send({ event: "setTitle", context, payload: { target: 0, title } });
}

function sendImage(context, svg) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (contextSentImages.get(context) === svg) return false;
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  send({ event: "setImage", context, payload: { target: 0, image } });
  contextSentImages.set(context, svg);
  return true;
}

function feedbackOverlaySvg(svg, feedback) {
  const accent = feedback.kind === "error" ? THEME.red : feedback.kind === "success" ? THEME.green : THEME.blue;
  const label = compactLine(feedback.label, 6.2);
  const labelWidth = Math.max(1, titleVisualWidth(label));
  const labelFontSize = Math.max(12.5, Math.min(15.5, 76 / labelWidth)).toFixed(1);
  const icon = feedback.kind === "loading"
    ? `<circle cx="27" cy="119" r="2" fill="${accent}" opacity=".4"/><circle cx="34" cy="119" r="2" fill="${accent}" opacity=".7"/><circle cx="41" cy="119" r="2" fill="${accent}"/>`
    : feedback.kind === "error"
      ? `<path d="M29 114L39 124M39 114L29 124" stroke="${accent}" stroke-width="2.3" stroke-linecap="round"/>`
      : `<path d="M28 119L32.5 123L40 114.5" fill="none" stroke="${accent}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;
  const overlay = `
  <rect x="15" y="105" width="114" height="28" rx="10" fill="${THEME.raised}" stroke="${THEME.borderStrong}"/>
  ${icon}
  <text x="84" y="125" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${escapeXml(label)}</text>`;
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

function clearFeedback(context) {
  if (!contextFeedback.delete(context)) return;
  const currentSvg = contextImages.get(context);
  if (contexts.has(context) && currentSvg) sendImage(context, composedContextSvg(context, currentSvg));
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

function normalizedReasoningEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return REASONING_EFFORT_VALUES.has(normalized) ? normalized : null;
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
  // Missing remote metadata must not masquerade as Medium. An empty track is
  // deliberately distinct until Codex exposes or ThreadDeck observes the
  // task's real composer setting.
  return progress[normalizedReasoningEffort(value)] ?? 0;
}

function reasoningEffortAppearance(value) {
  const ultra = String(value ?? "").toLowerCase() === "ultra";
  const lightUltra = appearanceMode === "light";
  return {
    ultra,
    gradientStops: ultra
      ? lightUltra
        ? `<stop stop-color="#7040C7"/><stop offset=".32" stop-color="#8647CE"/><stop offset=".58" stop-color="#984FCF"/><stop offset="1" stop-color="#7040C7"/>`
        : `<stop stop-color="#8A4FE0"/><stop offset=".32" stop-color="#B15CE8"/><stop offset=".58" stop-color="#C874E8"/><stop offset="1" stop-color="#8A4FE0"/>`
      : `<stop stop-color="${THEME.blue}"/><stop offset="1" stop-color="${THEME.blue}"/>`
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

function completionPulseState(threadId, nowMs = renderTimeMs()) {
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

function visibleCompletionPulseState(thread, nowMs = renderTimeMs()) {
  if (!thread?.id) return null;
  const reason = completionPulseReasonByThreadId.get(thread.id);
  if (thread.status !== "completed" && reason !== "queue-advance") return null;
  return completionPulseState(thread.id, nowMs);
}

function globalCompletionPulseState(nowMs = renderTimeMs()) {
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
  const tintOpacity = (0.34 * strength).toFixed(3);
  const outerOpacity = (0.96 * strength).toFixed(3);
  const innerOpacity = (0.48 * strength).toFixed(3);
  const outerWidth = (2.2 + strength * 2.8).toFixed(2);
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

function composedContextSvg(context, svg, nowMs = renderTimeMs()) {
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
    const baseFillOpacity = appearanceMode === "light" ? 0.14 : 0;
    const baseStrokeOpacity = appearanceMode === "light" ? 0.58 : 0;
    const fillOpacity = (baseFillOpacity + (0.7 - baseFillOpacity) * strength).toFixed(3);
    const strokeOpacity = (baseStrokeOpacity + (0.98 - baseStrokeOpacity) * strength).toFixed(3);
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

function usageAccent(value, failed = false) {
  if (failed || value === null) return THEME.muted;
  return THEME.text;
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
    <text x="72" y="89" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${numberFontSize}" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${shown}</text>`);
}

function newThreadSvg() {
  return shell(THEME.text, `
    <g transform="translate(24 24) scale(4)" fill="none" stroke="${THEME.text}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
    </g>`);
}

function voiceSvg(state = "idle", nowMs = renderTimeMs()) {
  const normalizedState = ["recording", "transcribing", "submitting", "complete", "sent", "error"].includes(state) ? state : "idle";
  const transcribingPhase = ((nowMs % 1_800) / 1_800) * Math.PI * 2;
  const transcribingBreath = 0.5 - 0.5 * Math.cos(transcribingPhase);
  const transcribingStrokeOpacity = (0.24 + transcribingBreath * 0.18).toFixed(3);
  const transcribingFillOpacity = (0.018 + transcribingBreath * 0.022).toFixed(3);
  const dotOpacity = (offset) => (0.34 + 0.66 * (0.5 + 0.5 * Math.sin(transcribingPhase + offset))).toFixed(3);
  const accent = normalizedState === "recording"
    ? THEME.amber
    : normalizedState === "complete" || normalizedState === "sent"
      ? THEME.green
    : normalizedState === "transcribing"
      ? THEME.text
      : normalizedState === "submitting"
        ? THEME.text
      : normalizedState === "error"
        ? THEME.amber
        : THEME.text;
  const chrome = normalizedState === "recording"
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.amber}" fill-opacity=".12" stroke="${THEME.amber}" stroke-opacity=".88" stroke-width="2.5"/>`
    : normalizedState === "transcribing"
      ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity="${transcribingFillOpacity}" stroke="${THEME.textSecondary}" stroke-opacity="${transcribingStrokeOpacity}" stroke-width="2.2"/>`
      : normalizedState === "submitting"
        ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity=".035" stroke="${THEME.textSecondary}" stroke-opacity=".48" stroke-width="2.2"/>`
      : normalizedState === "complete" || normalizedState === "sent"
        ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.green}" fill-opacity=".12" stroke="${THEME.green}" stroke-opacity=".82" stroke-width="2.5"/>`
        : normalizedState === "error"
          ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.amber}" fill-opacity=".09" stroke="${THEME.amber}" stroke-opacity=".72" stroke-width="2.2"/>`
          : "";
  const status = normalizedState === "recording"
    ? `<circle cx="110" cy="32" r="7" fill="${THEME.amber}"/><circle cx="110" cy="32" r="11" fill="none" stroke="${THEME.amber}" stroke-opacity=".28" stroke-width="3"/>`
    : normalizedState === "transcribing"
      ? `<rect x="94" y="20" width="32" height="23" rx="11.5" fill="${THEME.raised}" stroke="${THEME.border}"/>
         <circle cx="103" cy="31.5" r="2.2" fill="${THEME.text}" fill-opacity="${dotOpacity(0)}"/>
         <circle cx="110" cy="31.5" r="2.2" fill="${THEME.text}" fill-opacity="${dotOpacity(-2.1)}"/>
         <circle cx="117" cy="31.5" r="2.2" fill="${THEME.text}" fill-opacity="${dotOpacity(-4.2)}"/>`
    : normalizedState === "submitting"
      ? `<circle cx="109" cy="33" r="15" fill="${THEME.raised}" stroke="${THEME.borderStrong}"/>
         <path d="M109 41V24M102.5 30.5L109 24L115.5 30.5" fill="none" stroke="${THEME.text}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : normalizedState === "complete" || normalizedState === "sent"
      ? `<circle cx="109" cy="33" r="15" fill="${THEME.green}"/><path d="M102 33L107 38L116 27" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : normalizedState === "error"
      ? `<circle cx="109" cy="33" r="15" fill="${THEME.amber}"/><path d="M109 24V35" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/><circle cx="109" cy="41" r="2" fill="#FFFFFF"/>`
      : "";
  return shell(accent, `
    <rect x="56" y="28" width="32" height="59" rx="16" fill="${accent}"/>
    <path d="M40 68V77C40 94.7 54.3 109 72 109C89.7 109 104 94.7 104 77V68" fill="none" stroke="${accent}" stroke-width="6.2" stroke-linecap="round"/>
    <path d="M72 109V120M56 120H88" fill="none" stroke="${accent}" stroke-width="6.2" stroke-linecap="round"/>
    ${status}`, "", chrome);
}

function voiceTargetStateForThread(threadId) {
  if (!threadId) return null;
  for (const [context, targetThreadId] of voiceTargetThreadByContext) {
    if (targetThreadId !== threadId) continue;
    const state = voiceHeldContexts.has(context) ? "recording" : voiceStateByContext.get(context);
    if (state && state !== "idle") return state;
  }
  return null;
}

function voiceTargetOverlaySvg(state, nowMs = renderTimeMs()) {
  if (!state || state === "idle") return "";
  const transcribingPhase = ((nowMs % 1_800) / 1_800) * Math.PI * 2;
  const transcribingBreath = 0.5 - 0.5 * Math.cos(transcribingPhase);
  const transcribingStrokeOpacity = (0.26 + transcribingBreath * 0.2).toFixed(3);
  const transcribingFillOpacity = (0.018 + transcribingBreath * 0.024).toFixed(3);
  const dotOpacity = (offset) => (0.34 + 0.66 * (0.5 + 0.5 * Math.sin(transcribingPhase + offset))).toFixed(3);
  const accent = state === "recording"
    ? THEME.amber
    : state === "transcribing"
    ? THEME.textSecondary
    : state === "submitting"
      ? THEME.textSecondary
    : state === "error"
      ? THEME.amber
      : THEME.green;
  const neutralState = state === "transcribing" || state === "submitting";
  const border = state === "transcribing"
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity="${transcribingFillOpacity}" stroke="${THEME.textSecondary}" stroke-opacity="${transcribingStrokeOpacity}" stroke-width="2.2"/>`
    : state === "submitting"
      ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity=".035" stroke="${THEME.textSecondary}" stroke-opacity=".52" stroke-width="2.4"/>`
    : `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${accent}" fill-opacity=".11" stroke="${accent}" stroke-opacity=".95" stroke-width="4.2"/>`;
  const badgeGlyph = state === "complete" || state === "sent"
    ? `<path d="M113 22L118 27L127 16" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : state === "error"
      ? `<path d="M120 15V24" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/><circle cx="120" cy="29" r="1.8" fill="#FFFFFF"/>`
      : state === "transcribing"
        ? `<circle cx="114" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(0)}"/>
           <circle cx="120" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(-2.1)}"/>
           <circle cx="126" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(-4.2)}"/>`
      : state === "submitting"
        ? `<path d="M120 29V16M115 21L120 16L125 21" fill="none" stroke="${THEME.text}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="117" y="14" width="6" height="11" rx="3" fill="#FFFFFF"/><path d="M113.5 22V23C113.5 26.6 116.4 29.5 120 29.5C123.6 29.5 126.5 26.6 126.5 23V22M120 29.5V33" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>`;
  const bannerLabel = state === "recording"
    ? "말하는 중"
    : state === "transcribing"
      ? "받아쓰기 중"
      : state === "submitting"
        ? "제출 중"
        : state === "sent"
          ? "전송 완료"
          : state === "complete"
            ? "입력 완료"
          : "입력 실패";
  const bannerTextColor = state === "recording" || state === "error"
    ? THEME.amber
    : state === "complete" || state === "sent"
      ? THEME.green
      : THEME.text;
  const bannerStroke = state === "recording" || state === "error"
    ? THEME.amber
    : state === "complete" || state === "sent"
      ? THEME.green
      : THEME.borderStrong;
  return `${border}
    <rect x="9" y="8" width="126" height="28" rx="14" fill="${THEME.raised}" stroke="${bannerStroke}" stroke-opacity=".72"/>
    <text x="62" y="27" fill="${bannerTextColor}" font-family="${FONT_STACK}" font-size="15.5" font-weight="650" text-anchor="middle">${bannerLabel}</text>
    <circle cx="120" cy="23" r="13" fill="${neutralState ? THEME.raised : accent}" stroke="${neutralState ? THEME.border : THEME.card}" stroke-width="2"/>
    ${badgeGlyph}`;
}

function applyVoiceTargetOverlay(svg, threadId, nowMs = renderTimeMs()) {
  const overlay = voiceTargetOverlaySvg(voiceTargetStateForThread(threadId), nowMs);
  return overlay ? svg.replace("</svg>", `${overlay}\n</svg>`) : svg;
}

function sendSvg(longPressArmed = false) {
  const accent = longPressArmed ? THEME.blue : THEME.text;
  const chrome = longPressArmed
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.blue}" fill-opacity=".10" stroke="${THEME.blue}" stroke-opacity=".92" stroke-width="3"/>`
    : "";
  return shell(accent, `
    <circle cx="72" cy="72" r="41" fill="${accent}"/>
    <path d="M72 96V48M52.5 67.5L72 48L91.5 67.5" fill="none" stroke="${THEME.card}" stroke-width="5.7" stroke-linecap="round" stroke-linejoin="round"/>`, "", chrome);
}

function cancelSendPress(context, restoreImage = false) {
  const timer = sendLongPressTimers.get(context);
  if (timer) clearTimeout(timer);
  sendLongPressTimers.delete(context);
  sendPressStartedAt.delete(context);
  sendLongPressArmedContexts.delete(context);
  if (restoreImage && contexts.get(context) === ACTIONS.send) setImage(context, sendSvg(false));
}

function beginSendPress(context) {
  if (sendPressStartedAt.has(context)) return;
  sendPressStartedAt.set(context, Date.now());
  const timer = setTimeout(() => {
    if (!sendPressStartedAt.has(context) || contexts.get(context) !== ACTIONS.send) return;
    sendLongPressArmedContexts.add(context);
    setImage(context, sendSvg(true));
  }, SEND_LONG_PRESS_MS);
  sendLongPressTimers.set(context, timer);
}

function endSendPress(context) {
  const startedAtMs = sendPressStartedAt.get(context);
  if (!Number.isFinite(startedAtMs)) return;
  const longPress = Date.now() - startedAtMs >= SEND_LONG_PRESS_MS;
  cancelSendPress(context, true);
  runKeyBridge(longPress ? "send-command" : "send", context);
}

function cancelThreadPress(context, releaseVoice = true) {
  const state = threadPressByContext.get(context);
  if (!state) return;
  state.held = false;
  if (state.timer) clearTimeout(state.timer);
  threadPressByContext.delete(context);
  if (releaseVoice && state.voiceStarted) endVoiceHoldSync(context, false);
}

function beginThreadPress(context, slot) {
  if (threadPressByContext.has(context)) return;
  const thread = threadSlots[slot];
  if (!thread?.id) {
    showFeedback(context, "error", "작업 없음");
    return;
  }

  const state = {
    slot,
    threadId: thread.id,
    held: true,
    armed: false,
    voiceStarted: false,
    timer: null,
    openPromise: openThread(context, slot)
  };
  threadPressByContext.set(context, state);
  state.timer = setTimeout(async () => {
    if (threadPressByContext.get(context) !== state || !state.held) return;
    state.armed = true;
    const opened = await state.openPromise;
    if (threadPressByContext.get(context) !== state || !state.held || !opened) {
      threadPressByContext.delete(context);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, THREAD_VOICE_FOCUS_SETTLE_MS));
    if (threadPressByContext.get(context) !== state || !state.held) {
      threadPressByContext.delete(context);
      return;
    }
    clearFeedback(context);
    state.voiceStarted = beginVoiceHoldSync(context, {
      targetThreadId: state.threadId,
      autoSubmit: true
    });
    if (!state.voiceStarted) threadPressByContext.delete(context);
  }, THREAD_VOICE_LONG_PRESS_MS);
}

function endThreadPress(context) {
  const state = threadPressByContext.get(context);
  if (!state) return;
  state.held = false;
  if (state.timer) clearTimeout(state.timer);
  if (state.voiceStarted) endVoiceHoldSync(context, true);
  if (!state.armed || state.voiceStarted) threadPressByContext.delete(context);
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

function pageNavigationSvg(action) {
  const direction = PAGE_DIRECTION_BY_ACTION.get(action);
  if (!direction) return null;
  const chevron = direction < 0 ? "M92 42L62 72L92 102" : "M52 42L82 72L52 102";
  const railX = direction < 0 ? 48 : 96;
  return shell(THEME.text, `
    <path d="${chevron}" fill="none" stroke="${THEME.text}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${railX} 43V101" fill="none" stroke="${THEME.text}" stroke-width="7" stroke-linecap="round"/>`);
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
  if (action === ACTIONS.voice) {
    const state = context
      ? voiceHeldContexts.has(context) ? "recording" : voiceStateByContext.get(context) ?? "idle"
      : "idle";
    return voiceSvg(state);
  }
  if (action === ACTIONS.send) return sendSvg(context ? sendLongPressArmedContexts.has(context) : false);
  if (action === ACTIONS.appSwitch) return appSwitchSvg();
  if (action === ACTIONS.sideChat) return sideChatSvg();
  if (MEDIA_COMMAND_BY_ACTION.has(action)) return mediaActionSvg(action);
  if (PAGE_DIRECTION_BY_ACTION.has(action)) return pageNavigationSvg(action);
  return null;
}

function currentActionSvg(action, context = null) {
  if (action === ACTIONS.weekly) return usageSvg(usageState.remaining, usageState.failed);
  const slot = THREAD_SLOT_BY_ACTION.get(action);
  if (slot !== undefined) return threadSvg(displayedThreadSlot(slot), slot);
  return staticActionSvg(action, context);
}

function displayedThreadSlot(slot) {
  if (threadRefreshUnavailable && !hasLoadedThreadState) return THREAD_REFRESH_ERROR_STATE;
  return threadSlots[slot];
}

function runKeyBridge(command, context = null) {
  if (!accessibilityTrustedSync()) {
    if (context) showFeedback(context, "error", "손쉬운 사용", 2200);
    console.error(`Key bridge ${command} needs Stream Deck Accessibility permission`);
    return false;
  }
  execFile(KEY_BRIDGE, [command], { timeout: 2000 }, (error) => {
    if (!error) return;
    if (context) showFeedback(context, "error", "키 입력 실패");
    console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
  });
  return true;
}

function runKeyBridgeSync(command, context = null, options = {}) {
  const quiet = Boolean(options.quiet);
  const releasesHeldKeys = command === "voice-up" || command === "release";
  if (!releasesHeldKeys && !accessibilityTrustedSync()) {
    if (!quiet) {
      if (context) showFeedback(context, "error", "손쉬운 사용", 2200);
      console.error(`Key bridge ${command} needs Stream Deck Accessibility permission`);
    }
    return false;
  }
  try {
    execFileSync(KEY_BRIDGE, [command], {
      stdio: "ignore",
      timeout: command === "voice-up" || command.startsWith("codex-") ? 2500 : 1000
    });
    return true;
  } catch (error) {
    if (!quiet) {
      if (context) showFeedback(context, "error", "키 입력 실패");
      console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
    }
    return false;
  }
}

function accessibilityTrustedSync(nowMs = Date.now()) {
  const cacheMs = accessibilityTrustCache.trusted ? 30_000 : 2_000;
  if (typeof accessibilityTrustCache.trusted === "boolean"
      && nowMs - accessibilityTrustCache.checkedAtMs < cacheMs) {
    return accessibilityTrustCache.trusted;
  }
  let trusted = false;
  try {
    execFileSync(KEY_BRIDGE, ["accessibility-preflight"], {
      stdio: "ignore",
      timeout: 800
    });
    trusted = true;
  } catch {
    trusted = false;
  }
  accessibilityTrustCache = { checkedAtMs: nowMs, trusted };
  return trusted;
}

function keyBridgeExitCode(error) {
  const value = Number(error?.exitCode ?? error?.code);
  return Number.isInteger(value) ? value : null;
}

function runKeyBridgeWithInput(command, args, input, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const child = spawn(KEY_BRIDGE, [command, ...args], {
      stdio: ["pipe", "ignore", "ignore"]
    });
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Key bridge ${command} timed out`));
    }, timeoutMs);
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) finish();
      else {
        const error = new Error(`Key bridge ${command} exited with ${signal ?? code ?? "unknown status"}`);
        error.exitCode = Number.isInteger(code) ? code : null;
        finish(error);
      }
    });
    // Remote titles may contain user text. Keep them on stdin so they never
    // appear in process listings or command-line diagnostics.
    child.stdin.on("error", () => {});
    child.stdin.end(String(input ?? ""), "utf8");
  });
}

function parseTextInputState(command, output) {
  const focusedMatch = output.match(/^(\d+)\t([0-9a-f]{16})$/i);
  if (command === "focused-text-state" && focusedMatch) {
    return {
      source: "focused",
      candidates: 1,
      length: Number(focusedMatch[1]),
      hash: focusedMatch[2].toLowerCase()
    };
  }
  const aggregateMatch = output.match(/^(\d+)\t(\d+)\t([0-9a-f]{16})$/i);
  if (command === "editable-text-state" && aggregateMatch) {
    return {
      source: "aggregate",
      candidates: Number(aggregateMatch[1]),
      length: Number(aggregateMatch[2]),
      hash: aggregateMatch[3].toLowerCase()
    };
  }
  return null;
}

function sameTextInputState(left, right) {
  return Boolean(left && right)
    && left.source === right.source
    && left.candidates === right.candidates
    && left.length === right.length
    && left.hash === right.hash;
}

function comparableTextInputStates(left, right) {
  return Boolean(left && right) && left.source === right.source;
}

function textInputStateSync() {
  for (const command of ["focused-text-state", "editable-text-state"]) {
    try {
      const output = execFileSync(KEY_BRIDGE, [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 700,
        maxBuffer: 128
      }).trim();
      const state = parseTextInputState(command, output);
      if (state) return state;
    } catch {
      // Codex currently does not expose a conventional focused text area on
      // every build. Fall through to the aggregate editable-region probe.
    }
  }
  return null;
}

function contextSupportsVoice(context) {
  const action = contexts.get(context);
  return action === ACTIONS.voice || THREAD_SLOT_BY_ACTION.has(action);
}

function renderVoiceContextState(context, state, nowMs = Date.now()) {
  if (contexts.get(context) === ACTIONS.voice) setImage(context, voiceSvg(state, nowMs));
  const targetThreadId = voiceTargetThreadByContext.get(context);
  if (targetThreadId) renderVoiceTargetThreadContexts(targetThreadId, nowMs);
}

function setVoiceVisualState(context, state, durationMs = null, nowMs = Date.now()) {
  if (state === "idle") voiceStateByContext.delete(context);
  else voiceStateByContext.set(context, state);
  if (Number.isFinite(durationMs)) voiceStateResetAtMs.set(context, nowMs + durationMs);
  else voiceStateResetAtMs.delete(context);
  renderVoiceContextState(context, state, nowMs);
  if (state === "idle") voiceTargetThreadByContext.delete(context);
}

function cancelVoiceTranscription(context, resetVisual = false) {
  voiceTranscriptionByContext.delete(context);
  voiceStateResetAtMs.delete(context);
  if (resetVisual || voiceTargetThreadByContext.has(context)) setVoiceVisualState(context, "idle");
}

function bindPendingVoiceContextsToThread(threadId, nowMs = Date.now()) {
  if (!threadId) return;
  lastOpenedThreadId = threadId;
  lastOpenedThreadAtMs = nowMs;
  for (const context of voiceTranscriptionByContext.keys()) {
    if (contexts.get(context) !== ACTIONS.voice || voiceTargetThreadByContext.has(context)) continue;
    voiceTargetThreadByContext.set(context, threadId);
  }
}

async function readPendingSideChatIdFromDesktopLog(requestedAtMs, knownIds) {
  try {
    const filePath = await readLatestDesktopLogPath();
    if (!filePath) return null;
    const stat = await fs.stat(filePath);
    const length = Math.min(stat.size, SIDE_CHAT_TARGET_LOG_TAIL_BYTES);
    if (length <= 0) return null;
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    try {
      await handle.read(buffer, 0, length, stat.size - length);
    } finally {
      await handle.close();
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes("method=thread/inject_items")) continue;
      const timestampMs = Date.parse(line.slice(0, 24));
      if (!Number.isFinite(timestampMs) || timestampMs + APP_SERVER_START_TOLERANCE_MS < requestedAtMs) continue;
      const match = line.match(/conversationId=([0-9a-f-]{36})/i);
      const threadId = match?.[1] ?? null;
      const createdAtMs = threadId ? uuidV7TimestampMs(threadId) : null;
      if (!threadId || knownIds.has(threadId)
          || !Number.isFinite(createdAtMs)
          || createdAtMs + APP_SERVER_START_TOLERANCE_MS < requestedAtMs) continue;
      return threadId;
    }
  } catch {
    // The prompt-history path below remains available if the desktop log is
    // rotating or briefly unavailable while the side chat is being created.
  }
  return null;
}

async function resolvePendingSideChatTarget(sideChats, nowMs = Date.now()) {
  if (!pendingSideChatTarget) return;
  const { requestedAtMs, knownIds } = pendingSideChatTarget;
  const listedCandidate = sideChats
    .filter((thread) => !knownIds.has(thread.id)
      && Number.isFinite(thread.createdAtMs)
      && thread.createdAtMs + APP_SERVER_START_TOLERANCE_MS >= requestedAtMs)
    .sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a))[0];
  const targetThreadId = listedCandidate?.id
    ?? await readPendingSideChatIdFromDesktopLog(requestedAtMs, knownIds);
  if (targetThreadId) {
    pendingSideChatTarget = null;
    bindPendingVoiceContextsToThread(targetThreadId, nowMs);
    return;
  }
  if (nowMs - requestedAtMs >= SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS) {
    pendingSideChatTarget = null;
  }
}

function scheduleSideChatTargetRefreshes(requestedAtMs) {
  for (const delayMs of SIDE_CHAT_TARGET_REFRESH_DELAYS_MS) {
    setTimeout(() => {
      if (pendingSideChatTarget?.requestedAtMs !== requestedAtMs) return;
      void refreshThreads();
    }, delayMs);
  }
}

function resolveVoiceTargetThreadId(nowMs = Date.now()) {
  if (pendingSideChatTarget) {
    if (nowMs - pendingSideChatTarget.requestedAtMs < SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS) return null;
    pendingSideChatTarget = null;
  }
  const visibleIds = new Set(threadSlots.filter(Boolean).map((thread) => thread.id));
  if (lastOpenedThreadId && Number.isFinite(lastOpenedThreadAtMs)
      && nowMs - lastOpenedThreadAtMs <= VOICE_TARGET_OPEN_HINT_MS
      && visibleIds.has(lastOpenedThreadId)) {
    return lastOpenedThreadId;
  }
  return mostRecentThreadId && visibleIds.has(mostRecentThreadId) ? mostRecentThreadId : null;
}

function voiceSubmissionStillCurrent(context, targetThreadId) {
  return contexts.has(context)
    && voiceStateByContext.get(context) === "submitting"
    && voiceTargetThreadByContext.get(context) === targetThreadId;
}

function voiceDraftReturnedToBaseline(current, tracker) {
  if (!current || !tracker?.lastObserved) return false;
  if (tracker.baseline && sameTextInputState(current, tracker.baseline)) return true;
  return comparableTextInputStates(current, tracker.lastObserved)
    && tracker.lastObserved.length > 0
    && current.length === 0;
}

async function waitForVoiceDraftReset(context, targetThreadId, tracker, options = {}) {
  const stateReader = options.stateReader ?? textInputStateSync;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const delays = options.delays ?? VOICE_SUBMIT_VERIFY_DELAYS_MS;
  let stableResetCandidate = null;
  let stableResetObservations = 0;
  for (const delayMs of delays) {
    await sleep(delayMs);
    if (!voiceSubmissionStillCurrent(context, targetThreadId)) return false;
    const current = stateReader();
    if (voiceDraftReturnedToBaseline(current, tracker)) return true;
    const changedAfterSubmit = comparableTextInputStates(current, tracker.lastObserved)
      && !sameTextInputState(current, tracker.lastObserved);
    if (!changedAfterSubmit) {
      stableResetCandidate = null;
      stableResetObservations = 0;
      continue;
    }
    if (sameTextInputState(current, stableResetCandidate)) stableResetObservations += 1;
    else {
      stableResetCandidate = current;
      stableResetObservations = 1;
    }
    // A composer that contained text before dictation may reset to a
    // placeholder rather than the exact baseline fingerprint. Require the new
    // post-submit state to remain unchanged across all three probes before
    // accepting that form of reset.
    if (stableResetObservations >= 3) return true;
  }
  return false;
}

async function submitCompletedVoiceTranscription(context, targetThreadId, tracker, options = {}) {
  const openApp = options.openApp
    ?? (() => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 }));
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const bridge = options.bridge ?? runKeyBridgeSync;
  const waitForDraftReset = options.waitForDraftReset ?? waitForVoiceDraftReset;
  const scheduleRefresh = options.scheduleRefresh ?? (() => setTimeout(() => void refreshThreads(), 500));
  try {
    await openApp();
    await sleep(140);
    if (!voiceSubmissionStillCurrent(context, targetThreadId)) return;

    const clickedSubmit = bridge("codex-submit-composer", null, { quiet: true });
    let confirmed = clickedSubmit
      && await waitForDraftReset(context, targetThreadId, tracker, options);
    if (!confirmed && voiceSubmissionStillCurrent(context, targetThreadId)) {
      // The explicit button is preferred, but Codex can rebuild the composer
      // between transcription and submission. Refocus the draft and retry with
      // Return, then verify the draft actually cleared before showing success.
      bridge("codex-focus-composer", null, { quiet: true });
      if (!bridge("send", context)) {
        failVoiceTranscription(context);
        return;
      }
      confirmed = await waitForDraftReset(context, targetThreadId, tracker, options);
    }
    if (!voiceSubmissionStillCurrent(context, targetThreadId)) return;
    if (!confirmed) {
      failVoiceTranscription(context);
      console.error("Codex dictated message submission could not be confirmed");
      return;
    }
    setVoiceVisualState(context, "sent", VOICE_COMPLETE_DISPLAY_MS);
    scheduleRefresh();
  } catch (error) {
    failVoiceTranscription(context);
    console.error(`Could not submit dictated Codex message: ${error?.message ?? "unknown error"}`);
  }
}

function completeVoiceTranscription(context, nowMs = Date.now()) {
  const tracker = voiceTranscriptionByContext.get(context);
  voiceTranscriptionByContext.delete(context);
  if (tracker?.autoSubmit && tracker.targetThreadId) {
    setVoiceVisualState(context, "submitting", null, nowMs);
    void submitCompletedVoiceTranscription(context, tracker.targetThreadId, tracker);
    return;
  }
  setVoiceVisualState(context, "complete", VOICE_COMPLETE_DISPLAY_MS, nowMs);
}

function failVoiceTranscription(context, nowMs = Date.now()) {
  voiceTranscriptionByContext.delete(context);
  setVoiceVisualState(context, "error", VOICE_ERROR_DISPLAY_MS, nowMs);
}

function updateVoiceTranscriptionStates(nowMs = Date.now(), options = {}) {
  const stateReader = options.stateReader ?? textInputStateSync;
  const completionHandler = options.completionHandler ?? completeVoiceTranscription;
  for (const [context, tracker] of voiceTranscriptionByContext) {
    if (!contexts.has(context) || !contextSupportsVoice(context)) {
      cancelVoiceTranscription(context);
      continue;
    }
    if (!Number.isFinite(tracker.releasedAtMs)) continue;

    if (Number.isFinite(tracker.lastProbeAtMs)
        && nowMs - tracker.lastProbeAtMs < VOICE_TEXT_PROBE_INTERVAL_MS) {
      renderVoiceContextState(context, "transcribing", nowMs);
      continue;
    }
    tracker.lastProbeAtMs = nowMs;

    const current = stateReader();
    const comparableToBaseline = comparableTextInputStates(current, tracker.baseline);
    const changedFromBaseline = comparableToBaseline
      && !sameTextInputState(current, tracker.baseline)
      && current.length > 0;
    if (changedFromBaseline) {
      if (!sameTextInputState(current, tracker.lastObserved)) {
        tracker.lastObserved = current;
        tracker.stableSinceMs = nowMs;
      } else if (Number.isFinite(tracker.stableSinceMs)
          && nowMs - tracker.stableSinceMs >= (tracker.autoSubmit
            ? VOICE_AUTO_SUBMIT_STABLE_MS
            : VOICE_TRANSCRIPTION_STABLE_MS)) {
        completionHandler(context, nowMs);
        continue;
      }
    } else if (comparableToBaseline) {
      tracker.lastObserved = current;
      tracker.stableSinceMs = null;
    } else {
      // A button or search field can become focused while Codex finalizes the
      // transcript. Never treat a switch between focused and aggregate probes
      // as text input; wait for the composer state to become comparable again.
      tracker.stableSinceMs = null;
    }

    if (nowMs - tracker.releasedAtMs >= VOICE_TRANSCRIPTION_TIMEOUT_MS) {
      failVoiceTranscription(context, nowMs);
      continue;
    }
    renderVoiceContextState(context, "transcribing", nowMs);
  }

  for (const [context, resetAtMs] of voiceStateResetAtMs) {
    if (nowMs < resetAtMs) continue;
    setVoiceVisualState(context, "idle", null, nowMs);
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

function codexAudioInputActiveSync() {
  try {
    const output = execFileSync(KEY_BRIDGE, ["audio-input-processes"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    });
    return output.split(/\r?\n/).some((line) => {
      const [, bundleId = ""] = line.split("\t");
      return bundleId.trim().startsWith("com.openai.codex");
    });
  } catch {
    return false;
  }
}

function clearVoiceStartVerification(context) {
  const timer = voiceStartVerificationTimers.get(context);
  if (timer) clearTimeout(timer);
  voiceStartVerificationTimers.delete(context);
}

function verifyVoiceStarted(context) {
  clearVoiceStartVerification(context);
  if (!voiceHeldContexts.has(context) || codexAudioInputActiveSync()) return;

  const failedContexts = [...voiceHeldContexts];
  voiceHeldContexts.clear();
  for (const failedContext of failedContexts) clearVoiceStartVerification(failedContext);
  runKeyBridgeSync("voice-up", context);
  resumeMediaAfterVoiceSync();
  for (const failedContext of failedContexts) failVoiceTranscription(failedContext);
  console.error("Codex audio input did not start after the push-to-talk shortcut");
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

function beginVoiceHoldSync(context, options = {}) {
  if (voiceHeldContexts.has(context)) return true;
  cancelVoiceTranscription(context);
  voiceStateByContext.delete(context);
  const targetThreadId = options.targetThreadId ?? resolveVoiceTargetThreadId();
  if (targetThreadId) voiceTargetThreadByContext.set(context, targetThreadId);
  // Start with the composer focused so both the baseline and the final
  // transcript come from the same accessibility element.
  runKeyBridgeSync("codex-focus-composer", null, { quiet: true });
  const baseline = textInputStateSync();
  voiceTranscriptionByContext.set(context, {
    baseline,
    lastObserved: baseline,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: null,
    autoSubmit: Boolean(options.autoSubmit),
    targetThreadId: targetThreadId ?? null
  });
  if (voiceHeldContexts.size === 0) {
    pauseMediaForVoiceSync(context);
    if (!runKeyBridgeSync("voice-down", context)) {
      resumeMediaAfterVoiceSync();
      failVoiceTranscription(context);
      return false;
    }
  }
  voiceHeldContexts.add(context);
  setVoiceVisualState(context, "recording");
  clearVoiceStartVerification(context);
  voiceStartVerificationTimers.set(
    context,
    setTimeout(() => verifyVoiceStarted(context), VOICE_START_VERIFY_MS)
  );
  return true;
}

function endVoiceHoldSync(context, trackTranscription = true) {
  clearVoiceStartVerification(context);
  if (!voiceHeldContexts.delete(context)) return;
  if (voiceHeldContexts.size > 0) return;
  const released = runKeyBridgeSync("voice-up", context);
  resumeMediaAfterVoiceSync();
  if (!trackTranscription) {
    cancelVoiceTranscription(context, true);
    return;
  }
  if (!released) {
    failVoiceTranscription(context);
    return;
  }
  const tracker = voiceTranscriptionByContext.get(context) ?? {
    baseline: textInputStateSync(),
    lastObserved: null,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: null,
    autoSubmit: false,
    targetThreadId: voiceTargetThreadByContext.get(context) ?? null
  };
  if (!tracker.baseline) tracker.baseline = textInputStateSync();
  tracker.lastObserved = tracker.baseline;
  tracker.stableSinceMs = null;
  tracker.lastProbeAtMs = null;
  tracker.releasedAtMs = Date.now();
  voiceTranscriptionByContext.set(context, tracker);
  setVoiceVisualState(context, "transcribing");
}

function releaseVoiceKeysSync() {
  try {
    execFileSync(KEY_BRIDGE, ["release"], { stdio: "ignore", timeout: 1000 });
  } catch {
    // Best-effort cleanup only; never keep Stream Deck from shutting down.
  }
  voiceHeldContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  for (const timer of voiceStartVerificationTimers.values()) clearTimeout(timer);
  voiceStartVerificationTimers.clear();
  for (const state of threadPressByContext.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  threadPressByContext.clear();
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

function stringFingerprint(value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${bytes.length}:${hash.toString(16).padStart(16, "0")}`;
}

function titleVariants(value) {
  const title = String(value ?? "");
  return new Set([title, title.normalize("NFC"), title.normalize("NFD")]);
}

function titleFingerprints(value) {
  return new Set([...titleVariants(value)].map(stringFingerprint));
}

const QUEUED_MESSAGE_DELETE_FINGERPRINTS = new Set(QUEUED_MESSAGE_DELETE_LABELS.map(stringFingerprint));
const QUEUED_MESSAGE_ACTION_FINGERPRINTS = new Set(QUEUED_MESSAGE_ACTION_LABELS.map(stringFingerprint));

function parseCodexQueueWindows(output) {
  const windows = [];
  let current = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const [kind, value, rawCount] = line.split("\t");
    if (kind === "window") {
      current = {
        index: Number(value),
        focused: rawCount === "1",
        headers: new Set(),
        buttons: new Map()
      };
      windows.push(current);
    } else if (kind === "header" && current && value) {
      current.headers.add(value);
    } else if (kind === "button" && current && value) {
      const count = Number.parseInt(rawCount, 10);
      if (Number.isFinite(count) && count > 0) current.buttons.set(value, count);
    } else if (kind === "end") {
      current = null;
    }
  }
  return windows;
}

async function readCodexQueueWindows() {
  try {
    const { stdout } = await execFileAsync(KEY_BRIDGE, ["codex-queue-state"], {
      timeout: 1800,
      maxBuffer: 64 * 1024
    });
    return parseCodexQueueWindows(stdout);
  } catch {
    return [];
  }
}

function queueCountForWindow(window) {
  let deleteCount = 0;
  let actionCount = 0;
  for (const fingerprint of QUEUED_MESSAGE_DELETE_FINGERPRINTS) {
    deleteCount = Math.max(deleteCount, window.buttons.get(fingerprint) ?? 0);
  }
  for (const fingerprint of QUEUED_MESSAGE_ACTION_FINGERPRINTS) {
    actionCount = Math.max(actionCount, window.buttons.get(fingerprint) ?? 0);
  }
  return Math.max(deleteCount, actionCount);
}

function matchQueueWindowThread(window, threads) {
  const candidates = threads.filter((thread) => {
    for (const fingerprint of titleFingerprints(thread.title)) {
      if (window.headers.has(fingerprint)) return true;
    }
    return false;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find((thread) => thread.id === lastOpenedThreadId)
      ?? [...candidates].sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a))[0];
  }
  return null;
}

function applyQueueState(threads, windows, nowMs = Date.now()) {
  const observedIds = new Set();
  for (const window of windows) {
    const thread = matchQueueWindowThread(window, threads);
    if (!thread?.id) continue;
    observedIds.add(thread.id);
    const count = queueCountForWindow(window);
    const cached = queueStateByThreadId.get(thread.id);
    if (count > 0) {
      queueStateByThreadId.set(thread.id, {
        count,
        observedAtMs: nowMs,
        turnStartedAtMs: Number.isFinite(thread.startedAtMs) ? thread.startedAtMs : null,
        zeroObservedAtMs: null
      });
    } else if (!cached) {
      queueStateByThreadId.delete(thread.id);
    } else {
      const turnAdvanced = Number.isFinite(thread.startedAtMs)
        && Number.isFinite(cached.turnStartedAtMs)
        && thread.startedAtMs > cached.turnStartedAtMs + 1000;
      const zeroConfirmed = Number.isFinite(cached.zeroObservedAtMs)
        && nowMs - cached.zeroObservedAtMs >= QUEUE_ZERO_CONFIRM_MS;
      if (turnAdvanced) {
        const nextCount = Math.max(0, cached.count - 1);
        if (nextCount === 0) queueStateByThreadId.delete(thread.id);
        else queueStateByThreadId.set(thread.id, {
          ...cached,
          count: nextCount,
          observedAtMs: nowMs,
          turnStartedAtMs: thread.startedAtMs,
          zeroObservedAtMs: nowMs
        });
      } else if (zeroConfirmed) {
        queueStateByThreadId.delete(thread.id);
      } else {
        queueStateByThreadId.set(thread.id, {
          ...cached,
          observedAtMs: nowMs,
          zeroObservedAtMs: nowMs
        });
      }
    }
  }

  for (const thread of threads) {
    if (observedIds.has(thread.id)) continue;
    const cached = queueStateByThreadId.get(thread.id);
    if (!cached || !Number.isFinite(thread.startedAtMs) || !Number.isFinite(cached.turnStartedAtMs)) continue;
    if (thread.startedAtMs <= cached.turnStartedAtMs + 1000) continue;
    const nextCount = Math.max(0, cached.count - 1);
    if (nextCount === 0) queueStateByThreadId.delete(thread.id);
    else queueStateByThreadId.set(thread.id, {
      ...cached,
      count: nextCount,
      turnStartedAtMs: thread.startedAtMs,
      zeroObservedAtMs: null
    });
  }

  return threads.map((thread) => ({
    ...thread,
    queueCount: queueStateByThreadId.get(thread.id)?.count ?? 0
  }));
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

function queueBadgeSvg(thread) {
  const queueCount = Math.max(0, Number.parseInt(thread?.queueCount, 10) || 0);
  if (queueCount === 0) return "";
  const label = queueCount > 9 ? "9+" : `+${queueCount}`;
  return `
    <rect x="88" y="108" width="31" height="19" rx="9.5" fill="${THEME.amber}" fill-opacity=".18" stroke="${THEME.amber}" stroke-opacity=".62"/>
    <text x="103.5" y="122.5" fill="${THEME.amber}" font-family="${FONT_STACK}" font-size="14.5" font-weight="700" font-variant-numeric="tabular-nums" text-anchor="middle">${label}</text>`;
}

function ephemeralThreadSvg(thread) {
  const styles = {
    working: { accent: THEME.blue, label: "작업중" },
    completed: { accent: THEME.green, label: "완료" },
    stopped: { accent: THEME.red, label: "중단" },
    idle: { accent: THEME.muted, label: "대기" },
    error: { accent: THEME.amber, label: "오류" }
  };
  const style = styles[thread.status] ?? styles.idle;
  const completionEffect = visibleCompletionPulseState(thread);
  const completionStrength = completionEffect?.strength ?? 0;
  const completionTimeChrome = completionEffect ? `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.green}" fill-opacity="${(0.32 * completionStrength).toFixed(3)}" stroke="${THEME.green}" stroke-opacity="${(0.78 * completionStrength).toFixed(3)}" stroke-width="${(1 + completionStrength * 1.2).toFixed(2)}"/>` : "";
  const timingX = thread.queueCount > 0 ? 53 : 72;
  const completionTimeText = completionEffect ? `
    <text x="${timingX}" y="125.5" fill="${THEME.text}" fill-opacity="${(0.82 * completionStrength).toFixed(3)}" font-family="${FONT_STACK}" font-size="21" font-weight="650" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(timingLabel(thread))}</text>` : "";
  const titleFontSize = 20.5;
  const titleX = 79;
  const [line1, line2] = wrapTitle(thread.title, 5.05);
  const hasSecondTitleLine = Boolean(line2);
  const titleLine1Y = hasSecondTitleLine ? 65 : 79;
  const iconYOffset = hasSecondTitleLine ? 0 : 14;
  const activity = thread.activity ?? {
    kind: thread.status === "completed" ? "complete" : thread.status === "working" ? "think" : "idle",
    label: thread.status === "completed" ? "작업 종료" : thread.status === "working" ? "생각 중" : "다시 열기"
  };
  const rendered = shell(style.accent, `
    <path d="M15 ${52 + iconYOffset}H25C28.3 ${52 + iconYOffset} 31 ${54.7 + iconYOffset} 31 ${58 + iconYOffset}V${59.5 + iconYOffset}C31 ${62.8 + iconYOffset} 28.3 ${65.5 + iconYOffset} 25 ${65.5 + iconYOffset}H20.5L16.5 ${68.5 + iconYOffset}V${65.1 + iconYOffset}C14.4 ${64.3 + iconYOffset} 13 ${62.2 + iconYOffset} 13 ${59.5 + iconYOffset}V${58 + iconYOffset}C13 ${54.7 + iconYOffset} 13.7 ${52 + iconYOffset} 15 ${52 + iconYOffset}Z" fill="none" stroke="${THEME.textSecondary}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M22 ${55.5 + iconYOffset}V62M18.8 ${58.8 + iconYOffset}H25.2" stroke="${THEME.textSecondary}" stroke-width="1.7" stroke-linecap="round"/>
    <text x="${titleX}" y="${titleLine1Y}" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line1)}</text>
    ${hasSecondTitleLine ? `<text x="${titleX}" y="89" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line2)}</text>` : ""}
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.raised}"/>
    ${completionTimeChrome}
    <text x="${timingX}" y="125.5" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="21" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(timingLabel(thread))}</text>
    ${queueBadgeSvg(thread)}
    ${completionTimeText}`,
    threadHeader(style.accent, thread.status, style.label, activity, thread.status === "working", thread.reasoningEffort, thread.serviceTier, completionEffect),
    completionPulseChrome(completionEffect));
  return applyVoiceTargetOverlay(rendered, thread.id);
}

function threadSvg(thread, slot) {
  if (!thread) {
    return shell(THEME.muted, `
      <circle cx="72" cy="69" r="19" fill="${THEME.raised}"/>
      <path d="M62 69H82M72 59V79" stroke="${THEME.muted}" stroke-width="2.5" stroke-linecap="round"/>
      <text x="72" y="114" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="19.5" font-weight="600" text-anchor="middle">작업 없음</text>`,
      threadHeader(THEME.muted, "idle", "대기", { kind: "idle", label: "작업 대기" }));
  }
  if (thread.ephemeral) return ephemeralThreadSvg(thread);

  const styles = {
    working: { accent: THEME.blue, label: "작업중" },
    completed: { accent: THEME.green, label: "완료" },
    stopped: { accent: THEME.red, label: "중단" },
    idle: { accent: THEME.muted, label: "대기" },
    error: { accent: THEME.amber, label: "오류" }
  };
  const style = styles[thread.status] ?? styles.idle;
  const completionEffect = visibleCompletionPulseState(thread);
  const completionStrength = completionEffect?.strength ?? 0;
  const completionTimeChrome = completionEffect ? `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.green}" fill-opacity="${(0.32 * completionStrength).toFixed(3)}" stroke="${THEME.green}" stroke-opacity="${(0.78 * completionStrength).toFixed(3)}" stroke-width="${(1 + completionStrength * 1.2).toFixed(2)}"/>` : "";
  const timingX = thread.queueCount > 0 ? 53 : 72;
  const completionTimeText = completionEffect ? `
    <text x="${timingX}" y="125.5" fill="${THEME.text}" fill-opacity="${(0.82 * completionStrength).toFixed(3)}" font-family="${FONT_STACK}" font-size="21" font-weight="650" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(timingLabel(thread))}</text>` : "";
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
  const rendered = shell(style.accent, `
    ${pinIcon}
    <text x="${titleX}" y="${titleLine1Y}" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line1)}</text>
    ${hasSecondTitleLine ? `<text x="72" y="89" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="600" text-anchor="middle">${escapeXml(line2)}</text>` : ""}
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.raised}"/>
    ${completionTimeChrome}
    <text x="${timingX}" y="125.5" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="21" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>
    ${queueBadgeSvg(thread)}
    ${completionTimeText}`,
    threadHeader(style.accent, thread.status, style.label, activity, thread.status === "working", thread.reasoningEffort, thread.serviceTier, completionEffect),
    completionPulseChrome(completionEffect));
  return applyVoiceTargetOverlay(rendered, thread.id);
}

async function readUsage() {
  const { stdout } = await execFileAsync(
    CODEXBAR,
    ["usage", "--provider", "codex", "--source", "oauth", "--format", "json", "--json-only"],
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
    pinnedIdsCache = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
    return [...pinnedIdsCache];
  } catch {
    // Codex can rewrite the JSON state while this poll is reading it. Keep the
    // previous explicit pin set so pinned remote tasks do not disappear for a
    // single frame.
    return [...pinnedIdsCache];
  }
}

function uuidV7TimestampMs(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const compact = id.replaceAll("-", "").toLowerCase();
  if (compact[12] !== "7") return null;
  const timestampMs = Number.parseInt(compact.slice(0, 12), 16);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function threadRecencyMs(thread) {
  const raw = Number(thread?.recency_at ?? thread?.updated_at ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 100_000_000_000 ? raw : raw * 1000;
}

async function readAppServerSessionStartMs(nowMs = Date.now()) {
  if (nowMs - appServerSessionCache.checkedAtMs < APP_SERVER_SESSION_CACHE_MS) {
    return appServerSessionCache.startedAtMs;
  }

  let startedAtMs = null;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,lstart=,command="], {
      timeout: 1500,
      maxBuffer: 2 * 1024 * 1024
    });
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\d+\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) continue;
      const command = match[2];
      if (!command.includes(".app/Contents/Resources/codex") || !command.includes("app-server")) continue;
      const isDesktopSession = command.includes("--analytics-default-enabled")
        || !command.includes("--listen stdio://");
      if (!isDesktopSession) continue;
      const candidate = Date.parse(match[1]);
      if (Number.isFinite(candidate)) startedAtMs = Math.max(startedAtMs ?? 0, candidate);
    }
  } catch {
    // Fail closed: without the live desktop session boundary, old prompt
    // history must not be mistaken for an active temporary side chat.
  }

  if (Number.isFinite(startedAtMs) && startedAtMs !== sideChatSessionStartMs) {
    sideChatSessionStartMs = startedAtMs;
    sideChatParentById.clear();
    sideChatLifecycleCache.clear();
    closedSideChatAtMs.clear();
    sideChatCloseLogOffsets.clear();
  }
  appServerSessionCache = { checkedAtMs: nowMs, startedAtMs };
  return startedAtMs;
}

async function readEphemeralSideChats(persistentRows, parentId) {
  const sessionStartedAtMs = await readAppServerSessionStartMs();
  if (!Number.isFinite(sessionStartedAtMs)) return [];

  try {
    const state = JSON.parse(await fs.readFile(GLOBAL_STATE, "utf8"));
    const promptHistory = state?.["electron-persisted-atom-state"]?.["prompt-history"];
    if (!promptHistory || typeof promptHistory !== "object") return [];
    const persistentIds = new Set(persistentRows.map((row) => row.id));
    const sideChats = [];

    for (const [id, prompts] of Object.entries(promptHistory)) {
      if (!UUID_PATTERN.test(id) || persistentIds.has(id) || !Array.isArray(prompts)) continue;
      const createdAtMs = uuidV7TimestampMs(id);
      if (!Number.isFinite(createdAtMs)
          || createdAtMs + APP_SERVER_START_TOLERANCE_MS < sessionStartedAtMs) continue;
      const firstPrompt = prompts.find((prompt) => typeof prompt === "string" && prompt.trim());
      if (!firstPrompt || isInternalAmbientTitle(firstPrompt)) continue;
      const rememberedParentId = sideChatParentById.get(id) ?? parentId ?? null;
      if (rememberedParentId) sideChatParentById.set(id, rememberedParentId);
      sideChats.push({
        id,
        title: normalizeTitle(firstPrompt),
        cwd: "",
        rollout_path: null,
        recency_at: Math.floor(createdAtMs / 1000),
        updated_at: Math.floor(createdAtMs / 1000),
        createdAtMs,
        promptCount: prompts.filter((prompt) => typeof prompt === "string" && prompt.trim()).length,
        parentId: rememberedParentId,
        ephemeral: true,
        pinned: false
      });
    }

    const activeSideChatIds = new Set(sideChats.map((thread) => thread.id));
    for (const id of sideChatParentById.keys()) {
      if (!activeSideChatIds.has(id)) sideChatParentById.delete(id);
    }
    // Prompt history is persisted asynchronously and can briefly omit an
    // entry while Codex rewrites the state file. Keep lifecycle/close memory
    // for the lifetime of the app-server session so a closed side chat cannot
    // flash back into the list after one transient read.
    return sideChats.sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
  } catch {
    return [];
  }
}

function datedLogDirectory(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(CODEX_DESKTOP_LOG_ROOT, year, month, day);
}

async function readCurrentDesktopLogPaths(nowMs = Date.now()) {
  if (nowMs - desktopLogPathCache.checkedAtMs < DESKTOP_LOG_PATH_CACHE_MS) {
    return desktopLogPathCache.paths;
  }

  const logs = [];
  const dates = [new Date(nowMs), new Date(nowMs - 24 * 60 * 60 * 1000)];
  for (const date of dates) {
    const directory = datedLogDirectory(date);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^codex-desktop-.*\.log$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stat = await fs.stat(filePath);
        logs.push({ path: filePath, name: entry.name, mtimeMs: stat.mtimeMs });
      } catch {
        // A rotating log may disappear between directory enumeration and stat.
      }
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = logs[0] ?? null;
  const sessionPrefix = latest?.name.match(/^(codex-desktop-[0-9a-f-]{36}-\d+)-/i)?.[1] ?? null;
  const paths = sessionPrefix
    ? logs.filter((log) => log.name.startsWith(`${sessionPrefix}-`)).map((log) => log.path)
    : latest ? [latest.path] : [];
  desktopLogPathCache = { checkedAtMs: nowMs, path: paths[0] ?? null, paths };
  return paths;
}

async function readLatestDesktopLogPath(nowMs = Date.now()) {
  return (await readCurrentDesktopLogPaths(nowMs))[0] ?? null;
}

function remoteTurnStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["inprogress", "in_progress", "running", "active"].includes(status)) return "working";
  if (["completed", "complete", "succeeded", "success"].includes(status)) return "completed";
  if (["interrupted", "cancelled", "canceled", "aborted", "stopped"].includes(status)) return "stopped";
  if (["failed", "error"].includes(status)) return "error";
  return null;
}

function applyRemoteLifecycleLogLine(line, lifecycles = remoteLifecycleCache) {
  if (typeof line !== "string" || !line) return false;
  const timestampMs = Date.parse(line.slice(0, 24));
  if (!Number.isFinite(timestampMs)) return false;

  const update = (threadId, next) => {
    if (!UUID_PATTERN.test(threadId ?? "")) return false;
    const previous = lifecycles.get(threadId);
    if (previous && timestampMs + REMOTE_REASONING_TURN_TOLERANCE_MS < previous.observedAtMs) return false;
    const nextStartedAtMs = Number.isFinite(next.startedAtMs)
      ? next.startedAtMs
      : previous?.startedAtMs ?? null;
    if (previous && Number.isFinite(previous.startedAtMs)
        && Number.isFinite(nextStartedAtMs)
        && nextStartedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < previous.startedAtMs) {
      return false;
    }
    lifecycles.set(threadId, {
      status: next.status ?? previous?.status ?? "idle",
      startedAtMs: nextStartedAtMs,
      endedAtMs: Object.hasOwn(next, "endedAtMs") ? next.endedAtMs : previous?.endedAtMs ?? null,
      latestTurnId: Object.hasOwn(next, "latestTurnId")
        ? next.latestTurnId
        : previous?.latestTurnId ?? null,
      terminalObservedAtMs: Object.hasOwn(next, "terminalObservedAtMs")
        ? next.terminalObservedAtMs
        : previous?.terminalObservedAtMs ?? null,
      observedAtMs: Math.max(timestampMs, previous?.observedAtMs ?? 0)
    });
    return true;
  };

  if (line.includes("maybe_resume_success")) {
    const threadId = line.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const turnId = line.match(/latestTurnId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const status = remoteTurnStatus(line.match(/latestTurnStatus=([^ ]+)/i)?.[1]);
    const startedAtMs = uuidV7TimestampMs(turnId);
    if (!threadId || !turnId || !status || !Number.isFinite(startedAtMs)) return false;
    const terminal = ["completed", "stopped", "error"].includes(status);
    const resumed = {
      status,
      startedAtMs,
      latestTurnId: turnId,
      terminalObservedAtMs: terminal ? timestampMs : null
    };
    if (status === "working") resumed.endedAtMs = null;
    return update(threadId, resumed);
  }

  if (line.includes("Reasoning summary turn-start config resolved")) {
    const threadId = line.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
    return update(threadId, {
      status: "working",
      startedAtMs: timestampMs,
      endedAtMs: null,
      latestTurnId: null,
      terminalObservedAtMs: null
    });
  }

  if (line.includes("Reasoning summary") && line.includes("turnId=")) {
    const threadId = line.match(/threadId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const turnId = line.match(/turnId=([0-9a-f-]{36})/i)?.[1] ?? null;
    const startedAtMs = uuidV7TimestampMs(turnId);
    if (!threadId || !turnId || !Number.isFinite(startedAtMs)) return false;
    return update(threadId, {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      latestTurnId: turnId,
      terminalObservedAtMs: null
    });
  }

  if (line.includes("[desktop-notifications] show turn-complete")) {
    const threadId = line.match(/(?:conversationId|threadId)=([0-9a-f-]{36})/i)?.[1] ?? null;
    return update(threadId, {
      status: "completed",
      endedAtMs: timestampMs,
      terminalObservedAtMs: timestampMs
    });
  }
  return false;
}

async function refreshRemoteLifecyclesFromLogs(nowMs = Date.now()) {
  let paths;
  try {
    paths = await readCurrentDesktopLogPaths(nowMs);
  } catch {
    return remoteLifecycleCache;
  }
  const files = [];
  for (const filePath of paths) {
    try {
      const stat = await fs.stat(filePath);
      files.push({ filePath, stat });
    } catch {
      // A rotated log can disappear between discovery and inspection.
    }
  }
  files.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  const activePaths = new Set(files.map(({ filePath }) => filePath));

  for (const { filePath, stat } of files) {
    const previousSize = remoteLifecycleLogOffsets.get(filePath);
    const start = Number.isFinite(previousSize) && previousSize <= stat.size
      ? Math.max(0, previousSize - 1024)
      : Math.max(0, stat.size - REMOTE_LIFECYCLE_LOG_SEARCH_LIMIT_BYTES);
    if (start >= stat.size) continue;
    try {
      const length = stat.size - start;
      const handle = await fs.open(filePath, "r");
      const buffer = Buffer.alloc(length);
      try {
        await handle.read(buffer, 0, length, start);
      } finally {
        await handle.close();
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      for (const line of lines) applyRemoteLifecycleLogLine(line);
      remoteLifecycleLogOffsets.set(filePath, stat.size);
    } catch {
      // Preserve the last parsed lifecycle while a Desktop log rotates.
    }
  }
  for (const filePath of remoteLifecycleLogOffsets.keys()) {
    if (!activePaths.has(filePath)) remoteLifecycleLogOffsets.delete(filePath);
  }
  return remoteLifecycleCache;
}

function parseCodexReasoningState(output) {
  const effort = String(output ?? "").match(/(?:^|\s)effort=(none|minimal|low|medium|high|xhigh|max|ultra)(?:\s|$)/i)?.[1];
  return normalizedReasoningEffort(effort);
}

async function refreshVisibleRemoteReasoningEffort(threads, queueWindows, nowMs = Date.now()) {
  const focusedWindow = queueWindows.find((window) => window.focused)
    ?? (queueWindows.length === 1 ? queueWindows[0] : null);
  const focusedThread = focusedWindow ? matchQueueWindowThread(focusedWindow, threads) : null;
  // Only bind a composer value when the focused window header identifies the
  // exact remote task. A recent click is not enough: navigation can fail while
  // leaving a local composer's controls on screen.
  const thread = focusedThread?.remote ? focusedThread : null;
  if (!thread?.id) return null;
  if (remoteReasoningProbe.threadId === thread.id
      && nowMs - remoteReasoningProbe.checkedAtMs < REMOTE_REASONING_PROBE_CACHE_MS) {
    return remoteReasoningEffortByThreadId.get(thread.id)?.effort ?? null;
  }
  remoteReasoningProbe = { threadId: thread.id, checkedAtMs: nowMs };
  try {
    const { stdout } = await execFileAsync(KEY_BRIDGE, ["codex-reasoning-state"], {
      timeout: 1800,
      maxBuffer: 4096
    });
    const effort = parseCodexReasoningState(stdout);
    if (!effort) return null;
    const lifecycle = remoteLifecycleCache.get(thread.id);
    remoteReasoningEffortByThreadId.set(thread.id, {
      effort,
      observedAtMs: nowMs,
      turnStartedAtMs: Number.isFinite(lifecycle?.startedAtMs) ? lifecycle.startedAtMs : null
    });
    return effort;
  } catch {
    return remoteReasoningEffortByThreadId.get(thread.id)?.effort ?? null;
  }
}

function reasoningEffortForRemoteThread(thread, lifecycle) {
  const summaryEffort = normalizedReasoningEffort(thread.reasoningEffort);
  if (summaryEffort) return summaryEffort;
  const observed = remoteReasoningEffortByThreadId.get(thread.id);
  const observedEffort = normalizedReasoningEffort(observed?.effort);
  if (!observedEffort) return null;
  if (Number.isFinite(lifecycle?.startedAtMs)
      && observed.observedAtMs + REMOTE_REASONING_TURN_TOLERANCE_MS < lifecycle.startedAtMs) {
    return null;
  }
  if (Number.isFinite(lifecycle?.startedAtMs)
      && Number.isFinite(observed.turnStartedAtMs)
      && Math.abs(observed.turnStartedAtMs - lifecycle.startedAtMs) > REMOTE_REASONING_TURN_TOLERANCE_MS) {
    return null;
  }
  return observedEffort;
}

function remoteStatusForThread(thread) {
  const runtimeStatus = thread.threadRuntimeStatus ?? { type: "notLoaded" };
  const lifecycle = remoteLifecycleCache.get(thread.id) ?? null;
  const startedAtMs = Number.isFinite(lifecycle?.startedAtMs) ? lifecycle.startedAtMs : null;
  const summaryEndMs = Number.isFinite(thread.updatedAtMs)
    && Number.isFinite(startedAtMs)
    && thread.updatedAtMs >= startedAtMs
    ? thread.updatedAtMs
    : null;
  const reasoningEffort = reasoningEffortForRemoteThread(thread, lifecycle);
  const serviceTier = typeof thread.serviceTier === "string" ? thread.serviceTier : "default";

  if (runtimeStatus.type === "active") {
    const flags = Array.isArray(runtimeStatus.activeFlags) ? runtimeStatus.activeFlags : [];
    const waitingOnApproval = flags.includes("waitingOnApproval");
    const waitingOnUserInput = flags.includes("waitingOnUserInput");
    return {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: waitingOnApproval
        ? { kind: "request", label: "원격 승인 대기" }
        : waitingOnUserInput
          ? { kind: "request", label: "원격 입력 대기" }
          : { kind: "command", label: "원격 작업" }
    };
  }
  if (runtimeStatus.type === "systemError") {
    return {
      status: "error",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: { kind: "error", label: "원격 오류" }
    };
  }

  // The remote summary's updatedAt is the server-side latest-turn update. It
  // provides the actual end boundary, while UUIDv7 gives the turn start even
  // after the remote host has disconnected or the Desktop app has resumed.
  if (Number.isFinite(startedAtMs) && lifecycle?.status === "working" && !summaryEndMs) {
    return {
      status: "working",
      startedAtMs,
      endedAtMs: null,
      reasoningEffort,
      serviceTier,
      activity: { kind: "command", label: "원격 작업" }
    };
  }
  if (Number.isFinite(startedAtMs)
      && (summaryEndMs || ["completed", "stopped", "error"].includes(lifecycle?.status))) {
    const status = lifecycle?.status === "stopped"
      ? "stopped"
      : lifecycle?.status === "error"
        ? "error"
        : "completed";
    const endedAtMs = summaryEndMs
      ?? lifecycle?.endedAtMs
      ?? lifecycle?.terminalObservedAtMs
      ?? null;
    return {
      status,
      startedAtMs,
      endedAtMs,
      reasoningEffort,
      serviceTier,
      activity: status === "stopped"
        ? { kind: "stopped", label: "원격 작업 중단" }
        : status === "error"
          ? { kind: "error", label: "원격 오류" }
          : { kind: "complete", label: thread.hasUnreadTurn ? "원격 완료 확인" : "원격 작업 종료" }
    };
  }
  return {
    status: "idle",
    startedAtMs: null,
    endedAtMs: null,
    reasoningEffort,
    serviceTier,
    activity: {
      kind: thread.hasUnreadTurn ? "answer" : "idle",
      label: thread.hasUnreadTurn ? "원격 확인 필요" : "원격 열기"
    }
  };
}

async function refreshClosedSideChatsFromLogs(threads) {
  if (threads.length === 0) return;
  const candidateIds = new Set(threads.map((thread) => thread.id));
  const filePaths = await readCurrentDesktopLogPaths();

  for (const filePath of filePaths) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const previousSize = sideChatCloseLogOffsets.get(filePath);
    const start = Number.isFinite(previousSize) && previousSize <= stat.size
      ? Math.max(0, previousSize - 512)
      : 0;
    if (start >= stat.size) continue;

    const handle = await fs.open(filePath, "r");
    const chunkSize = 512 * 1024;
    let cursor = start;
    let carry = "";
    try {
      while (cursor < stat.size) {
        const length = Math.min(chunkSize, stat.size - cursor);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, cursor);
        cursor += length;
        const lines = `${carry}${buffer.toString("utf8")}`.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.includes("method=thread/unsubscribe")) continue;
          const threadId = line.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
          if (!threadId || !candidateIds.has(threadId)) continue;
          const timestampMs = Date.parse(line.slice(0, 24));
          closedSideChatAtMs.set(threadId, Number.isFinite(timestampMs) ? timestampMs : Date.now());
        }
      }
      if (carry.includes("method=thread/unsubscribe")) {
        const threadId = carry.match(/conversationId=([0-9a-f-]{36})/i)?.[1] ?? null;
        if (threadId && candidateIds.has(threadId)) {
          const timestampMs = Date.parse(carry.slice(0, 24));
          closedSideChatAtMs.set(threadId, Number.isFinite(timestampMs) ? timestampMs : Date.now());
        }
      }
      sideChatCloseLogOffsets.set(filePath, stat.size);
    } finally {
      await handle.close();
    }
  }
}

function sideChatLifecycleFallback(promptCount = 0) {
  return {
    status: "idle",
    startedAtMs: null,
    endedAtMs: null,
    reasoningEffort: null,
    serviceTier: "default",
    activity: { kind: "idle", label: "사이드챗" },
    promptCount
  };
}

async function scanSideChatLifecycles(filePath, threads) {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, "r");
  const states = new Map(threads.map((thread) => [thread.id, {
    id: thread.id,
    promptCount: thread.promptCount ?? 0,
    firstEvent: null,
    startedAtMs: null,
    endedAtMs: null,
    done: false
  }]));
  const chunkSize = 512 * 1024;
  let cursor = stat.size;
  let searched = 0;
  let carry = "";

  const consumeLine = (line) => {
    if (!line) return;
    const timestampMs = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(timestampMs)) return;
    for (const state of states.values()) {
      if (state.done || !line.includes(state.id)) continue;
      // Only an explicit unsubscribe is terminal. "no rollout found" can be
      // emitted temporarily by dictation/queued-follow-up helpers while the
      // same side chat is still open and may receive another turn.
      const isClosed = line.includes("method=thread/unsubscribe");
      const isStart = line.includes("Reasoning summary turn-start config resolved");
      const isComplete = line.includes("IAB_LIFECYCLE ended browser use session activity")
        || line.includes("[desktop-notifications] show turn-complete");
      if (!isClosed && !isStart && !isComplete) continue;

      if (!state.firstEvent) {
        state.firstEvent = isClosed ? "closed" : isStart ? "start" : "complete";
        if (isClosed) {
          state.endedAtMs = timestampMs;
          state.done = true;
        } else if (isStart) {
          state.startedAtMs = timestampMs;
          state.done = true;
        } else {
          state.endedAtMs = timestampMs;
        }
      } else if (state.firstEvent === "complete" && isStart) {
        state.startedAtMs = timestampMs;
        state.done = true;
      }
    }
  };

  try {
    while (cursor > 0 && searched < SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES
        && [...states.values()].some((state) => !state.done)) {
      const length = Math.min(chunkSize, cursor, SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES - searched);
      const start = cursor - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = `${buffer.toString("utf8")}${carry}`.split("\n");
      carry = lines.shift() ?? "";
      for (let index = lines.length - 1; index >= 0; index -= 1) consumeLine(lines[index]);
      cursor = start;
      searched += length;
    }
    if (cursor === 0) consumeLine(carry);
  } finally {
    await handle.close();
  }

  const lifecycles = new Map();
  for (const state of states.values()) {
    let lifecycle;
    if (state.firstEvent === "closed") {
      lifecycle = {
        status: "closed",
        startedAtMs: null,
        endedAtMs: state.endedAtMs,
        reasoningEffort: null,
        serviceTier: "default",
        activity: { kind: "idle", label: "닫힘" },
        promptCount: state.promptCount
      };
    } else if (state.firstEvent === "start" && Number.isFinite(state.startedAtMs)) {
      lifecycle = {
        status: "working",
        startedAtMs: state.startedAtMs,
        endedAtMs: null,
        reasoningEffort: null,
        serviceTier: "default",
        activity: { kind: "think", label: "생각 중" },
        promptCount: state.promptCount
      };
    } else if (state.firstEvent === "complete") {
      lifecycle = {
        status: "completed",
        startedAtMs: state.startedAtMs,
        endedAtMs: state.endedAtMs,
        reasoningEffort: null,
        serviceTier: "default",
        activity: { kind: "complete", label: "작업 종료" },
        promptCount: state.promptCount
      };
    } else {
      lifecycle = sideChatLifecycleFallback(state.promptCount);
    }
    lifecycles.set(state.id, lifecycle);
  }
  return lifecycles;
}

async function readSideChatLifecycles(threads) {
  const result = new Map();
  await refreshClosedSideChatsFromLogs(threads);
  for (const thread of threads) {
    const closedAtMs = closedSideChatAtMs.get(thread.id);
    if (!Number.isFinite(closedAtMs)) continue;
    const lifecycle = {
      status: "closed",
      startedAtMs: null,
      endedAtMs: closedAtMs,
      reasoningEffort: null,
      serviceTier: "default",
      activity: { kind: "idle", label: "닫힘" },
      promptCount: thread.promptCount ?? 0
    };
    sideChatLifecycleCache.set(thread.id, lifecycle);
    result.set(thread.id, lifecycle);
  }
  // Always recheck visible side chats. A queued follow-up can already be in
  // prompt history while the previous turn is completing, so caching that
  // completed state by prompt count alone could hide the next turn's start.
  const needsScan = threads.filter((thread) => !closedSideChatAtMs.has(thread.id));
  if (needsScan.length === 0) return result;

  try {
    const filePath = await readLatestDesktopLogPath();
    if (!filePath) throw new Error("desktop log unavailable");
    const scanned = await scanSideChatLifecycles(filePath, needsScan);
    for (const thread of needsScan) {
      const lifecycle = scanned.get(thread.id) ?? sideChatLifecycleFallback(thread.promptCount ?? 0);
      if (lifecycle.status === "closed" && Number.isFinite(lifecycle.endedAtMs)) {
        closedSideChatAtMs.set(thread.id, lifecycle.endedAtMs);
      }
      sideChatLifecycleCache.set(thread.id, lifecycle);
      result.set(thread.id, lifecycle);
    }
  } catch {
    for (const thread of needsScan) {
      const cached = sideChatLifecycleCache.get(thread.id);
      const lifecycle = cached ?? sideChatLifecycleFallback(thread.promptCount ?? 0);
      result.set(thread.id, lifecycle);
    }
  }
  return result;
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

async function readRemoteThreadRows() {
  try {
    const state = JSON.parse(await fs.readFile(GLOBAL_STATE, "utf8"));
    const persistedValue = state?.["electron-persisted-atom-state"];
    const persisted = typeof persistedValue === "string"
      ? JSON.parse(persistedValue)
      : persistedValue;
    if (!persisted || typeof persisted !== "object") return [];

    const byId = new Map();
    for (const [key, summaries] of Object.entries(persisted)) {
      if (!key.startsWith("remote-thread-summaries-v2:") || !Array.isArray(summaries)) continue;
      const cachedHostId = key.slice("remote-thread-summaries-v2:".length);
      for (const summary of summaries) {
        const id = summary?.conversationId;
        const hostId = typeof summary?.hostId === "string" && summary.hostId
          ? summary.hostId
          : cachedHostId;
        const title = typeof summary?.title === "string" ? summary.title.trim() : "";
        if (!UUID_PATTERN.test(id ?? "") || !hostId || hostId === "local" || !title) continue;

        const updatedAt = Number(summary?.recencyAt ?? summary?.updatedAt ?? 0);
        const createdAt = Number(summary?.createdAt ?? updatedAt);
        const updatedAtMs = updatedAt > 100_000_000_000 ? updatedAt : updatedAt * 1000;
        const existing = byId.get(id);
        if (existing && threadRecencyMs(existing) >= updatedAtMs) {
          continue;
        }
        byId.set(id, {
          id,
          hostId,
          remote: true,
          title,
          cwd: typeof summary?.cwd === "string" ? summary.cwd : "",
          rollout_path: null,
          recency_at: updatedAt,
          updated_at: Number(summary?.updatedAt ?? updatedAt),
          updatedAtMs,
          createdAtMs: createdAt > 100_000_000_000 ? createdAt : createdAt * 1000,
          hasUnreadTurn: Boolean(summary?.hasUnreadTurn),
          threadRuntimeStatus: summary?.threadRuntimeStatus ?? { type: "notLoaded" },
          reasoningEffort: normalizedReasoningEffort(summary?.reasoningEffort)
            ?? normalizedReasoningEffort(summary?.latestReasoningEffort),
          serviceTier: typeof summary?.serviceTier === "string" ? summary.serviceTier : "default",
          workspaceKind: summary?.workspaceKind ?? "project"
        });
      }
    }
    remoteThreadRowsCache = [...byId.values()].sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
    return [...remoteThreadRowsCache];
  } catch {
    // Preserve pinned remote candidates through one partially written Codex
    // state snapshot. A later valid empty snapshot still clears the cache.
    return [...remoteThreadRowsCache];
  }
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
  if (thread.remote) return remoteStatusForThread(thread);
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

function selectTopThreadRows(localRows, remoteRows, openSideChats, pinnedIds) {
  const localIds = new Set(localRows.map((row) => row.id));
  const pinnedIdSet = new Set(pinnedIds);
  const pinnedRemoteRows = remoteRows.filter((row) => !localIds.has(row.id)
    && pinnedIdSet.has(row.id)
    && !isInternalAmbientTitle(row.title));
  const selectablePersistentRows = [...localRows, ...pinnedRemoteRows];
  const recentRows = [...localRows, ...openSideChats]
    .sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
  const byId = new Map(selectablePersistentRows.map((row) => [row.id, row]));
  const selected = [];
  const selectedIds = new Set();

  for (const id of pinnedIds) {
    const row = byId.get(id);
    if (!row || selectedIds.has(id)) continue;
    selected.push({ ...row, pinned: true });
    selectedIds.add(id);
    if (selected.length === THREAD_COUNT) break;
  }

  for (const row of recentRows) {
    if (selected.length === THREAD_COUNT) break;
    if (selectedIds.has(row.id)) continue;
    selected.push({ ...row, pinned: false });
    selectedIds.add(row.id);
  }

  return {
    selected,
    byId,
    mostRecentId: recentRows[0]?.id ?? null
  };
}

async function readTopThreads() {
  const queueWindowsPromise = readCodexQueueWindows();
  const [rows, remoteRows, pinnedIds, activeThreadIds, sidebarNames] = await Promise.all([
    readThreadRows(),
    readRemoteThreadRows(),
    readPinnedIds(),
    readActiveThreadIds(),
    readSidebarThreadNames()
  ]);
  const localRows = rows
    .map((row) => ({ ...row, title: sidebarNames.get(row.id) ?? row.title }))
    .filter((row) => !isInternalAmbientTitle(row.title));
  const sideChats = await readEphemeralSideChats(localRows, localRows[0]?.id ?? null);
  const sideChatLifecycles = await readSideChatLifecycles(sideChats);
  const openSideChats = sideChats.filter((thread) => !closedSideChatAtMs.has(thread.id)
    && sideChatLifecycles.get(thread.id)?.status !== "closed");
  await resolvePendingSideChatTarget(openSideChats);
  knownSideChatIds = new Set(sideChats.map((thread) => thread.id));
  for (const thread of sideChats) {
    if (sideChatLifecycles.get(thread.id)?.status === "closed") sideChatParentById.delete(thread.id);
  }
  const selection = selectTopThreadRows(localRows, remoteRows, openSideChats, pinnedIds);
  const { selected, byId } = selection;
  mostRecentThreadId = selection.mostRecentId;
  const [queueWindows] = await Promise.all([
    queueWindowsPromise,
    refreshRemoteLifecyclesFromLogs()
  ]);
  await refreshVisibleRemoteReasoningEffort(selected, queueWindows);

  const persistentThreads = selected.filter((thread) => !thread.ephemeral);
  const persistentLifecycles = await Promise.all(
    persistentThreads.map((thread) => statusForThread(thread, activeThreadIds))
  );
  const lifecycleById = new Map(
    persistentThreads.map((thread, index) => [thread.id, persistentLifecycles[index]])
  );

  // Side chats do not have rollout JSONL files. Their desktop log provides
  // reliable turn start/end timestamps, while the parent thread provides the
  // model's reasoning effort and service tier used by the shared composer.
  const ephemeralThreads = selected.filter((thread) => thread.ephemeral);
  const ephemeralLifecycles = sideChatLifecycles;
  const missingParentRows = [...new Set(ephemeralThreads.map((thread) => thread.parentId).filter(Boolean))]
    .filter((id) => !lifecycleById.has(id))
    .map((id) => byId.get(id))
    .filter(Boolean);
  const missingParentLifecycles = await Promise.all(
    missingParentRows.map((thread) => statusForThread(thread, activeThreadIds))
  );
  missingParentRows.forEach((thread, index) => lifecycleById.set(thread.id, missingParentLifecycles[index]));

  const hydratedThreads = selected.map((thread) => {
    if (!thread.ephemeral) return { ...thread, ...lifecycleById.get(thread.id) };
    const lifecycle = ephemeralLifecycles.get(thread.id) ?? sideChatLifecycleFallback(thread.promptCount ?? 0);
    const parentLifecycle = lifecycleById.get(thread.parentId);
    return {
      ...thread,
      ...lifecycle,
      reasoningEffort: lifecycle.reasoningEffort ?? parentLifecycle?.reasoningEffort ?? "medium",
      serviceTier: lifecycle.serviceTier !== "default"
        ? lifecycle.serviceTier
        : parentLifecycle?.serviceTier ?? "default"
    };
  });
  return applyQueueState(hydratedThreads, queueWindows);
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

function startCompletionEffects(threadId, nowMs = Date.now(), reason = "completion") {
  completionPulseStartedAt.set(threadId, nowMs);
  completionPulseReasonByThreadId.set(threadId, reason);
  globalCompletionStartedAtMs = nowMs;
  globalCompletionThreadId = threadId;
  globalCompletionWasRendered = false;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = true;
}

function clearCompletionEffect(threadId) {
  completionPulseStartedAt.delete(threadId);
  completionPulseReasonByThreadId.delete(threadId);
}

function renderGlobalCompletionContexts(nowMs = Date.now()) {
  const effect = globalCompletionPulseState(nowMs);
  if (effect) {
    // Guarantee one strong frame on every visible plugin-owned key, then
    // update alternating halves at a device-safe rate. Splitting the very
    // first frame allowed the completed task's own animation to reach Neo
    // while acknowledgements for the other keys remained queued.
    globalCompletionWasRendered = true;
    const entries = [...contexts.entries()];
    const renderGroup = globalCompletionRenderGroup;
    globalCompletionRenderGroup = (globalCompletionRenderGroup + 1) % GLOBAL_COMPLETION_GROUP_COUNT;
    for (let index = 0; index < entries.length; index += 1) {
      if (!globalCompletionInitialFanoutPending
          && index % GLOBAL_COMPLETION_GROUP_COUNT !== renderGroup) continue;
      const [context, action] = entries[index];
      const svg = currentActionSvg(action, context) ?? contextImages.get(context);
      if (!svg) continue;
      contextImages.set(context, svg);
      sendImage(context, composedContextSvg(context, svg, nowMs));
    }
    globalCompletionInitialFanoutPending = false;
    return true;
  }

  if (!globalCompletionWasRendered) return false;
  globalCompletionWasRendered = false;
  globalCompletionStartedAtMs = null;
  globalCompletionThreadId = null;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = false;
  for (const [context, action] of contexts) {
    const svg = currentActionSvg(action, context) ?? contextImages.get(context);
    if (!svg) continue;
    contextImages.set(context, svg);
    sendImage(context, composedContextSvg(context, svg, nowMs));
  }
  return false;
}

async function refreshUsage(feedbackContext, options = {}) {
  if (feedbackContext) showFeedback(feedbackContext, "loading", "확인 중");
  if (!activeUsageRefresh) {
    activeUsageRefresh = (async () => {
      try {
        const reader = typeof options.reader === "function" ? options.reader : readUsage;
        const usage = await reader();
        const remaining = remainingPercent(usage?.secondary?.usedPercent);
        if (remaining === null) throw new Error("Codex weekly usage was not returned");
        usageState = { remaining, failed: false };
        hasLoadedUsageState = true;
        renderUsageContexts();
        return true;
      } catch (error) {
        // A transient OAuth/network miss must not replace a known percentage
        // with an error card when the user changes pages.
        if (!hasLoadedUsageState) {
          usageState = { remaining: null, failed: true };
          renderUsageContexts();
        }
        const preservedState = hasLoadedUsageState ? "; keeping the last good value" : "";
        console.error(`Codex usage refresh failed${preservedState}: ${error?.message ?? "unknown error"}`);
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
    if (slot !== undefined) setImage(context, threadSvg(displayedThreadSlot(slot), slot));
  }
}

function renderVoiceTargetThreadContexts(targetThreadId, nowMs = Date.now()) {
  if (!targetThreadId) return;
  for (const [context, action] of contexts) {
    const slot = THREAD_SLOT_BY_ACTION.get(action);
    if (slot === undefined || threadSlots[slot]?.id !== targetThreadId) continue;
    const svg = threadSvg(threadSlots[slot], slot);
    contextImages.set(context, svg);
    sendImage(context, composedContextSvg(context, svg, nowMs));
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
      clearCompletionEffect(thread.id);
      setImage(context, threadSvg(threadSlots[slot], slot));
    }
  }
}

function trackCompletionTransitions(previousThreads, nextThreads, nowMs = Date.now()) {
  const previousById = new Map(previousThreads.filter(Boolean).map((thread) => [thread.id, thread]));
  if (!hasLoadedThreadState) {
    for (const thread of nextThreads) {
      if (thread?.status === "completed" && Number.isFinite(thread.endedAtMs)) {
        const completedDuringStartup = thread.endedAtMs >= pluginStartedAtMs - COMPLETION_STARTUP_GRACE_MS
          && thread.endedAtMs <= nowMs + APP_SERVER_START_TOLERANCE_MS;
        if (completedDuringStartup) startCompletionEffects(thread.id, nowMs, "completion");
        observedCompletionEndMs.set(thread.id, thread.endedAtMs);
      }
    }
    hasLoadedThreadState = true;
    lastThreadTransitionScanAtMs = nowMs;
    return;
  }

  const unseenCompletionFloorMs = lastThreadTransitionScanAtMs - COMPLETION_OBSERVATION_OVERLAP_MS;
  const visibleIds = new Set(nextThreads.filter(Boolean).map((thread) => thread.id));
  for (const thread of nextThreads) {
    if (!thread?.id) continue;
    const previous = previousById.get(thread.id);
    const previousQueueCount = Math.max(0, Number.parseInt(previous?.queueCount, 10) || 0);
    const nextQueueCount = Math.max(0, Number.parseInt(thread.queueCount, 10) || 0);
    const queueAdvanced = Boolean(previous) && previousQueueCount > nextQueueCount;

    if (thread.status === "working") {
      if (queueAdvanced) {
        startCompletionEffects(thread.id, nowMs, "queue-advance");
      } else {
        const startedAtMs = completionPulseStartedAt.get(thread.id);
        const keepQueuePulse = completionPulseReasonByThreadId.get(thread.id) === "queue-advance"
          && Number.isFinite(startedAtMs)
          && nowMs - startedAtMs < THREAD_COMPLETION_PULSE_DURATION_MS;
        if (!keepQueuePulse) clearCompletionEffect(thread.id);
      }
      continue;
    }
    if (thread.status !== "completed") {
      if (queueAdvanced) startCompletionEffects(thread.id, nowMs, "queue-advance");
      continue;
    }

    const knownEndMs = observedCompletionEndMs.get(thread.id);
    const hasNewEndMarker = Number.isFinite(thread.endedAtMs)
      && (
        (Number.isFinite(knownEndMs) && thread.endedAtMs !== knownEndMs)
        || (!Number.isFinite(knownEndMs)
          && thread.endedAtMs >= unseenCompletionFloorMs
          && thread.endedAtMs <= nowMs + APP_SERVER_START_TOLERANCE_MS)
      );
    const justTransitioned = previous && previous.status !== "completed";
    if (justTransitioned || hasNewEndMarker) startCompletionEffects(thread.id, nowMs, "completion");
    else if (queueAdvanced) startCompletionEffects(thread.id, nowMs, "queue-advance");
    if (Number.isFinite(thread.endedAtMs)) observedCompletionEndMs.set(thread.id, thread.endedAtMs);
  }

  for (const threadId of completionPulseStartedAt.keys()) {
    if (!visibleIds.has(threadId)) clearCompletionEffect(threadId);
  }
  lastThreadTransitionScanAtMs = nowMs;
}

async function readTopThreadsWithRetries(reader, retryDelays = THREAD_REFRESH_RETRY_DELAYS_MS) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await reader();
    } catch (error) {
      lastError = error;
      const delayMs = retryDelays[attempt];
      if (Number.isFinite(delayMs) && delayMs >= 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown refresh failure"));
}

async function refreshThreads(feedbackContext, options = {}) {
  if (!activeThreadRefresh) {
    activeThreadRefresh = (async () => {
      try {
        const reader = typeof options.reader === "function" ? options.reader : readTopThreads;
        const retryDelays = Array.isArray(options.retryDelays)
          ? options.retryDelays
          : THREAD_REFRESH_RETRY_DELAYS_MS;
        const threads = await readTopThreadsWithRetries(reader, retryDelays);
        consecutiveThreadRefreshFailures = 0;
        threadRefreshUnavailable = false;
        pulse = !pulse;
        const nextThreadSlots = THREAD_ACTIONS.map((_, index) => threads[index] ?? null);
        trackCompletionTransitions(threadSlots, nextThreadSlots);
        threadSlots = nextThreadSlots;
        renderThreadContexts();
        if (feedbackContext) showFeedback(feedbackContext, "success", "목록 갱신");
        return true;
      } catch (error) {
        consecutiveThreadRefreshFailures += 1;
        const wasUnavailable = threadRefreshUnavailable;
        if (!hasLoadedThreadState
            && consecutiveThreadRefreshFailures >= THREAD_REFRESH_STARTUP_ERROR_FAILURES) {
          threadRefreshUnavailable = true;
        }
        if (threadRefreshUnavailable !== wasUnavailable) renderThreadContexts();
        if (feedbackContext) showFeedback(feedbackContext, "error", "갱신 실패");
        const preservedState = hasLoadedThreadState
          ? "keeping the last good task list"
          : threadRefreshUnavailable
            ? "showing a stable startup error"
            : "waiting for another startup attempt";
        console.error(`Codex thread refresh failed (${consecutiveThreadRefreshFailures} consecutive; ${preservedState}): ${error?.message ?? "unknown error"}`);
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
    return false;
  }
  if (thread.ephemeral) {
    return openListedSideChat(context, thread);
  }
  if (thread.remote && !accessibilityTrustedSync()) {
    showFeedback(context, "error", "손쉬운 사용", 2200);
    return false;
  }
  pendingSideChatTarget = null;
  lastOpenedThreadId = thread.id;
  lastOpenedThreadAtMs = Date.now();
  showFeedback(context, "loading", "여는 중");
  try {
    if (thread.remote) {
      await execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 350));
      let opened = false;
      let lastError = null;
      let sawAmbiguousTitle = false;
      for (const fingerprint of titleFingerprints(thread.title)) {
        try {
          await execFileAsync(KEY_BRIDGE, ["codex-open-thread", thread.id, fingerprint], {
            timeout: 4000,
            maxBuffer: 64 * 1024
          });
          opened = true;
          break;
        } catch (error) {
          if (keyBridgeExitCode(error) === 3) sawAmbiguousTitle = true;
          lastError = error;
        }
      }
      // Remote rows outside the currently expanded sidebar are not mounted in
      // Chromium's accessibility tree. Codex's unified task search includes
      // every connected host, and pressing its exact result runs Codex's own
      // host activation before navigation.
      if (!opened) {
        for (const title of titleVariants(thread.title)) {
          try {
            await runKeyBridgeWithInput(
              "codex-search-thread",
              [thread.id, stringFingerprint(title)],
              title
            );
            opened = true;
            break;
          } catch (error) {
            if (keyBridgeExitCode(error) === 3) sawAmbiguousTitle = true;
            lastError = error;
          }
        }
      }
      if (!opened && sawAmbiguousTitle && keyBridgeExitCode(lastError) !== 3) {
        const ambiguousError = new Error("remote thread title is ambiguous");
        ambiguousError.exitCode = 3;
        lastError = ambiguousError;
      }
      if (!opened) throw lastError ?? new Error("remote thread row unavailable");
      showFeedback(context, "success", "원격 전환");
      setTimeout(() => void refreshThreads(), 1000);
      return true;
    }
    await execFileAsync("/usr/bin/open", [`codex://threads/${thread.id}`], { timeout: 5000 });
    showFeedback(context, "success", "전환 완료");
    setTimeout(() => void refreshThreads(), 1000);
    return true;
  } catch (error) {
    const exitCode = keyBridgeExitCode(error);
    const label = thread.remote
      ? exitCode === 3 ? "제목 중복" : "원격 확인"
      : "열기 실패";
    showFeedback(context, "error", label, thread.remote ? 1800 : undefined);
    console.error(`Could not open Codex ${thread.remote ? "remote " : ""}thread: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

async function openListedSideChat(context, thread) {
  pendingSideChatTarget = null;
  lastOpenedThreadId = thread.id;
  lastOpenedThreadAtMs = Date.now();
  showFeedback(context, "loading", "사이드챗 열기");
  try {
    // A listed side chat already has a live conversation id. Replaying the
    // Option+Command+S creation shortcut here opens a new side chat instead of
    // focusing the listed one. The normal Codex thread deep link also accepts
    // these ephemeral ids while their app-server session is alive.
    await execFileAsync("/usr/bin/open", [`codex://threads/${thread.id}`], { timeout: 5000 });
    showFeedback(context, "success", "사이드챗 전환");
    setTimeout(() => void refreshThreads(), 1000);
    return true;
  } catch (error) {
    showFeedback(context, "error", "열기 실패");
    console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

async function openNewThread(context) {
  try {
    pendingSideChatTarget = null;
    lastOpenedThreadId = null;
    lastOpenedThreadAtMs = null;
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
    pendingSideChatTarget = null;
    const requestedAtMs = Date.now();
    lastOpenedThreadId = null;
    lastOpenedThreadAtMs = null;
    await execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!runKeyBridgeSync("side-chat", context)) return;
    pendingSideChatTarget = { requestedAtMs, knownIds: new Set(knownSideChatIds) };
    scheduleSideChatTargetRefreshes(requestedAtMs);
  } catch (error) {
    showFeedback(context, "error", "열기 실패");
    console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
  }
}

function switchProfilePage(context, device, action, settings = {}) {
  const direction = PAGE_DIRECTION_BY_ACTION.get(action);
  if (!direction || !device) return;

  const configuredCount = Number(settings.pageCount);
  const pageCount = Number.isInteger(configuredCount) && configuredCount > 0
    ? configuredCount
    : DEFAULT_PROFILE_PAGE_COUNT;
  const configuredPage = Number(settings.currentPage);
  const currentPage = Number.isInteger(configuredPage) && configuredPage >= 0 && configuredPage < pageCount
    ? configuredPage
    : direction < 0 ? 0 : pageCount - 1;
  const page = (currentPage + direction + pageCount) % pageCount;

  const message = {
    event: "switchToProfile",
    // switchToProfile is a plugin-level command; Stream Deck rejects an
    // action-instance context here even though key events provide one.
    context: pluginUUID,
    device,
    payload: {
      profile: DISTRIBUTED_PROFILE_NAME,
      page
    }
  };
  send(message);
}

function registerPlugin() {
  if (!port || !pluginUUID || !registerEvent) process.exit(1);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.addEventListener("open", () => {
    send({ event: registerEvent, uuid: pluginUUID });
    // CodexBar takes several seconds on a cold request. Prime the cache while
    // the current Stream Deck page is rendering so the usage page can appear
    // with a value immediately.
    void refreshUsage();
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
      if (!hasLoadedUsageState) void refreshUsage();
      // Completion monitoring must have a baseline even when the active page
      // contains only usage, media, or navigation actions.
      if (!hasLoadedThreadState) void refreshThreads();
      if (message.action === ACTIONS.weekly) {
        // Stream Deck restores the last dynamic key image before a plugin has
        // reconnected. Replace it synchronously so stale usage never flashes.
        setImage(message.context, usageSvg(usageState.remaining, usageState.failed));
        void refreshUsage();
      } else if (THREAD_SLOT_BY_ACTION.has(message.action)) {
        // Replace Stream Deck's persisted image with this process's current
        // last-good state. On first startup this is the neutral placeholder.
        const slot = THREAD_SLOT_BY_ACTION.get(message.action);
        setImage(message.context, threadSvg(displayedThreadSlot(slot), slot));
        void refreshThreads();
      } else {
        const svg = staticActionSvg(message.action, message.context);
        if (svg) setImage(message.context, svg);
      }
    } else if (message.event === "willDisappear") {
      endVoiceHoldSync(message.context, false);
      cancelThreadPress(message.context, false);
      cancelVoiceTranscription(message.context);
      cancelSendPress(message.context);
      voiceStateByContext.delete(message.context);
      contexts.delete(message.context);
      contextImages.delete(message.context);
      contextSentImages.delete(message.context);
      contextFeedback.delete(message.context);
    } else if (message.event === "keyDown" && contexts.has(message.context)) {
      const action = contexts.get(message.context);
      if (action === ACTIONS.voice && !voiceHeldContexts.has(message.context)) {
        beginVoiceHoldSync(message.context);
      } else if (action === ACTIONS.send) {
        beginSendPress(message.context);
      } else if (THREAD_SLOT_BY_ACTION.has(action)) {
        beginThreadPress(message.context, THREAD_SLOT_BY_ACTION.get(action));
      } else if (action === ACTIONS.appSwitch) {
        runKeyBridge("app-switch", message.context);
      } else if (MEDIA_COMMAND_BY_ACTION.has(action)) {
        runKeyBridge(MEDIA_COMMAND_BY_ACTION.get(action), message.context);
      }
    } else if (message.event === "keyUp" && contexts.has(message.context)) {
      const action = contexts.get(message.context);
      if (action === ACTIONS.voice) {
        endVoiceHoldSync(message.context);
      } else if (action === ACTIONS.send) {
        endSendPress(message.context);
      } else if (THREAD_SLOT_BY_ACTION.has(action)) {
        endThreadPress(message.context);
      } else if (action === ACTIONS.appSwitch || MEDIA_COMMAND_BY_ACTION.has(action)) {
        // These are dispatched on keyDown so their response feels immediate.
      } else if (PAGE_DIRECTION_BY_ACTION.has(action)) {
        switchProfilePage(message.context, message.device, action, message.payload?.settings);
      } else if (action === ACTIONS.weekly) {
        void refreshUsage(message.context);
      } else if (action === ACTIONS.newThread) {
        void openNewThread(message.context);
      } else if (action === ACTIONS.sideChat) {
        void openSideChat(message.context);
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
    // Keep completion detection alive on every plugin-owned page. Previously
    // it stopped on the media page because that page has no thread cards.
    if (contexts.size > 0) void refreshThreads();
  }, 3000);

  setInterval(() => {
    // Keep the cached value warm on every ThreadDeck page, not only after the
    // usage key has appeared. This removes the multi-second page-switch wait.
    if (contexts.size > 0) void refreshUsage();
  }, 60_000);

  setInterval(() => {
    if (contexts.size > 0) void refreshAppearance();
  }, 2000);

  setInterval(() => {
    if (voiceTranscriptionByContext.size > 0 || voiceStateResetAtMs.size > 0) {
      updateVoiceTranscriptionStates();
    }
  }, VOICE_TRANSCRIPTION_POLL_INTERVAL_MS);
}

const DEMO_EPOCH_MS = 1_800_000_000_000;
const DEMO_WORKING_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_COMPLETED_ID = "00000000-0000-4000-8000-000000000002";

function resetDemoEffects() {
  completionPulseStartedAt.clear();
  completionPulseReasonByThreadId.clear();
  voiceStateByContext.clear();
  voiceTargetThreadByContext.clear();
  globalCompletionStartedAtMs = null;
  globalCompletionThreadId = null;
  globalCompletionWasRendered = false;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = false;
}

function demoPreviewSvg(keySvgs) {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="34" fill="#2F2F2F"/>
  ${images}
</svg>\n`;
}

function demoKeySvgs(nowMs, elapsedMs = 0, animated = false) {
  resetDemoEffects();
  fixedRenderTimeMs = nowMs;
  const completionStartMs = DEMO_EPOCH_MS + 3_200;
  const hasCompleted = animated && elapsedMs >= 3_200;
  const queueCount = animated && elapsedMs >= 2_500 ? 2 : 3;
  let voiceState = "idle";
  if (animated && elapsedMs >= 1_000 && elapsedMs < 1_900) voiceState = "recording";
  else if (animated && elapsedMs >= 1_900 && elapsedMs < 2_550) voiceState = "transcribing";
  else if (animated && elapsedMs >= 2_550 && elapsedMs < 3_200) voiceState = "sent";

  if (hasCompleted) {
    completionPulseStartedAt.set(DEMO_WORKING_ID, completionStartMs);
    completionPulseReasonByThreadId.set(DEMO_WORKING_ID, "completion");
    globalCompletionStartedAtMs = completionStartMs;
    globalCompletionThreadId = DEMO_WORKING_ID;
  }

  const workingThread = {
    id: DEMO_WORKING_ID,
    title: "릴리스 준비",
    pinned: true,
    status: hasCompleted ? "completed" : "working",
    startedAtMs: DEMO_EPOCH_MS - 4 * 60_000 - 12_000,
    endedAtMs: hasCompleted ? completionStartMs : null,
    activity: hasCompleted
      ? { kind: "complete", label: "작업 완료" }
      : elapsedMs >= 2_550
        ? { kind: "inspect", label: "코드 검증" }
        : { kind: "edit", label: "코드 수정" },
    reasoningEffort: "ultra",
    serviceTier: "priority",
    queueCount: hasCompleted ? 0 : queueCount
  };
  const completedThread = {
    id: DEMO_COMPLETED_ID,
    title: "문서 이미지",
    pinned: false,
    status: "completed",
    startedAtMs: DEMO_EPOCH_MS - 12 * 60_000 - 17_000,
    endedAtMs: DEMO_EPOCH_MS - 10 * 60_000,
    activity: { kind: "complete", label: "작업 완료" },
    reasoningEffort: "high",
    serviceTier: "default",
    queueCount: 0
  };
  const keySvgs = [
    usageSvg(74, false),
    sideChatSvg(),
    newThreadSvg(),
    sendSvg(),
    threadSvg(workingThread, 0),
    appSwitchSvg(),
    voiceSvg(voiceState, nowMs),
    threadSvg(completedThread, 1)
  ];
  const globalEffect = globalCompletionPulseState(nowMs);
  if (globalEffect) {
    for (let index = 0; index < keySvgs.length; index += 1) {
      if (index !== 4) keySvgs[index] = applyGlobalCompletion(keySvgs[index], globalEffect);
    }
  }
  return keySvgs;
}

function renderDemo(outputPath, mode = "dark") {
  appearanceMode = mode;
  THEME = mode === "dark" ? DARK_THEME : LIGHT_THEME;
  const resolvedOutput = path.resolve(outputPath);
  fsSync.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fsSync.writeFileSync(resolvedOutput, demoPreviewSvg(demoKeySvgs(DEMO_EPOCH_MS)));
  fixedRenderTimeMs = null;
  resetDemoEffects();
  console.log(`Rendered ${resolvedOutput}`);
}

function renderDemoAnimation(outputDirectory, mode = "dark") {
  appearanceMode = mode;
  THEME = mode === "dark" ? DARK_THEME : LIGHT_THEME;
  const resolvedDirectory = path.resolve(outputDirectory);
  const framesPerSecond = 12;
  const durationMs = 6_000;
  const frameCount = durationMs / 1000 * framesPerSecond;
  fsSync.mkdirSync(resolvedDirectory, { recursive: true });
  for (const entry of fsSync.readdirSync(resolvedDirectory)) {
    if (/^frame-\d{3}\.svg$/.test(entry)) fsSync.unlinkSync(path.join(resolvedDirectory, entry));
  }
  for (let index = 0; index < frameCount; index += 1) {
    const elapsedMs = Math.round(index / framesPerSecond * 1000);
    const nowMs = DEMO_EPOCH_MS + elapsedMs;
    const frame = demoPreviewSvg(demoKeySvgs(nowMs, elapsedMs, true));
    fsSync.writeFileSync(path.join(resolvedDirectory, `frame-${String(index).padStart(3, "0")}.svg`), frame);
  }
  fixedRenderTimeMs = null;
  resetDemoEffects();
  console.log(`Rendered ${frameCount} animation frames in ${resolvedDirectory}`);
}

function verifyCompletionFanout() {
  const nowMs = DEMO_EPOCH_MS + 10_000;
  const targetId = DEMO_COMPLETED_ID;
  const actions = [
    ACTIONS.weekly,
    ACTIONS.thread1,
    ACTIONS.sideChat,
    ACTIONS.newThread,
    ACTIONS.voice,
    ACTIONS.send,
    ACTIONS.appSwitch,
    ACTIONS.pagePrevious
  ];
  const messages = [];
  socket = {
    readyState: WebSocket.OPEN,
    send(raw) {
      messages.push(JSON.parse(raw));
    }
  };
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  actions.forEach((action, index) => contexts.set(`completion-context-${index}`, action));
  threadSlots = Array(THREAD_COUNT).fill(null);
  threadSlots[0] = {
    id: targetId,
    title: "완료 전파 검증",
    pinned: false,
    status: "completed",
    startedAtMs: nowMs - 20_000,
    endedAtMs: nowMs,
    activity: { kind: "complete", label: "작업 완료" },
    reasoningEffort: "medium",
    serviceTier: "default",
    queueCount: 0
  };
  fixedRenderTimeMs = nowMs;
  startCompletionEffects(targetId, nowMs, "completion");
  renderGlobalCompletionContexts(nowMs);

  const imageMessages = messages.filter((message) => message.event === "setImage");
  const counts = new Map();
  let globalChromeCount = 0;
  for (const message of imageMessages) {
    counts.set(message.context, (counts.get(message.context) ?? 0) + 1);
    const image = String(message.payload?.image ?? "");
    const encoded = image.startsWith("data:image/svg+xml;base64,")
      ? image.slice("data:image/svg+xml;base64,".length)
      : "";
    const svg = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    if (svg.includes(`<rect x="5.4" y="5.4"`) && svg.includes(`stroke="${THEME.green}"`)) {
      globalChromeCount += 1;
    }
  }
  const allContextsSentOnce = actions.every((_, index) => counts.get(`completion-context-${index}`) === 1);
  const passed = imageMessages.length === actions.length
    && allContextsSentOnce
    && globalChromeCount === actions.length - 1
    && globalCompletionInitialFanoutPending === false;
  console.log(JSON.stringify({
    passed,
    visibleContexts: actions.length,
    firstFrameImages: imageMessages.length,
    nonTargetGlobalChrome: globalChromeCount
  }));
  if (!passed) process.exitCode = 1;
  fixedRenderTimeMs = null;
  resetDemoEffects();
}

async function verifyThreadRefreshResilience() {
  const context = "refresh-resilience-context";
  const stableThread = {
    id: "00000000-0000-4000-8000-000000000003",
    title: "마지막 정상 작업",
    pinned: false,
    status: "idle",
    startedAtMs: null,
    endedAtMs: null,
    activity: { kind: "idle", label: "다시 열기" },
    reasoningEffort: "medium",
    serviceTier: "default",
    queueCount: 0
  };
  socket = { readyState: WebSocket.OPEN, send() {} };
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  contexts.set(context, ACTIONS.thread1);
  threadSlots = Array(THREAD_COUNT).fill(null);
  threadSlots[0] = stableThread;
  hasLoadedThreadState = true;
  consecutiveThreadRefreshFailures = 0;
  threadRefreshUnavailable = false;
  renderThreadContexts();

  let retryAttempts = 0;
  const recovered = await refreshThreads(null, {
    reader: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) throw new Error("simulated transient read failure");
      return [stableThread];
    },
    retryDelays: [0]
  });
  const recoveredInsideRefresh = recovered
    && retryAttempts === 2
    && threadSlots[0] === stableThread
    && !threadRefreshUnavailable;

  const lastGoodThread = threadSlots[0];
  const lastGoodSvg = contextImages.get(context);
  const originalConsoleError = console.error;
  let failedRefreshResult;
  let keptLastGoodList;
  let oneOffStartupHidden;
  let startupErrorStable;
  try {
    console.error = () => {};
    failedRefreshResult = await refreshThreads(null, {
      reader: async () => { throw new Error("simulated persistent read failure"); },
      retryDelays: []
    });
    keptLastGoodList = failedRefreshResult === false
      && threadSlots[0] === lastGoodThread
      && !threadRefreshUnavailable
      && contextImages.get(context) === lastGoodSvg
      && !contextImages.get(context)?.includes("상태를 읽지 못함");

    hasLoadedThreadState = false;
    consecutiveThreadRefreshFailures = 0;
    threadRefreshUnavailable = false;
    threadSlots = Array(THREAD_COUNT).fill(null);
    contextImages.clear();
    contextSentImages.clear();
    for (let failure = 1; failure < THREAD_REFRESH_STARTUP_ERROR_FAILURES; failure += 1) {
      await refreshThreads(null, {
        reader: async () => { throw new Error("simulated startup read failure"); },
        retryDelays: []
      });
    }
    oneOffStartupHidden = !threadRefreshUnavailable && !contextImages.has(context);
    await refreshThreads(null, {
      reader: async () => { throw new Error("simulated startup read failure"); },
      retryDelays: []
    });
    const startupErrorSvg = contextImages.get(context);
    renderThreadContexts();
    startupErrorStable = threadRefreshUnavailable
      && displayedThreadSlot(0) === THREAD_REFRESH_ERROR_STATE
      && contextImages.get(context) === startupErrorSvg;
  } finally {
    console.error = originalConsoleError;
  }

  const passed = recoveredInsideRefresh
    && keptLastGoodList
    && oneOffStartupHidden
    && startupErrorStable;
  console.log(JSON.stringify({
    passed,
    retryAttempts,
    keptLastGoodList,
    oneOffStartupHidden,
    startupErrorAfterFailures: startupErrorStable ? THREAD_REFRESH_STARTUP_ERROR_FAILURES : null
  }));
  if (!passed) process.exitCode = 1;
  socket = null;
}

function verifyThreadSelectionPolicy() {
  const localRecent = {
    id: "00000000-0000-4000-8000-000000000010",
    title: "로컬 최근 작업",
    recency_at: 400
  };
  const localPinned = {
    id: "00000000-0000-4000-8000-000000000011",
    title: "로컬 고정 작업",
    recency_at: 300
  };
  const pinnedRemote = {
    id: "00000000-0000-4000-8000-000000000012",
    title: "원격 고정 작업",
    recency_at: 500,
    remote: true
  };
  const unpinnedRemote = {
    id: "00000000-0000-4000-8000-000000000013",
    title: "원격 최근 작업",
    recency_at: 600,
    remote: true
  };
  const sideChat = {
    id: "00000000-0000-4000-8000-000000000014",
    title: "로컬 사이드챗",
    recency_at: 450,
    ephemeral: true
  };
  const pinnedIds = [pinnedRemote.id, localPinned.id];
  const selected = selectTopThreadRows(
    [localRecent, localPinned],
    [unpinnedRemote, pinnedRemote],
    [sideChat],
    pinnedIds
  );
  const selectedIds = selected.selected.map((thread) => thread.id);
  const onlyPinnedRemoteIncluded = selectedIds.includes(pinnedRemote.id)
    && !selectedIds.includes(unpinnedRemote.id)
    && selected.selected.filter((thread) => thread.remote).every((thread) => thread.pinned);
  const localRecentsFillRemainingSlots = selectedIds.join(",") === [
    pinnedRemote.id,
    localPinned.id,
    sideChat.id,
    localRecent.id
  ].join(",");
  const dedicatedVoiceTargetsLocalRecency = selected.mostRecentId === sideChat.id;

  const afterRemoteUnpin = selectTopThreadRows(
    [localRecent, localPinned],
    [unpinnedRemote, pinnedRemote],
    [sideChat],
    [localPinned.id]
  );
  const unpinnedRemoteRemoved = afterRemoteUnpin.selected.every((thread) => !thread.remote);

  const localWinsDuplicate = selectTopThreadRows(
    [localRecent],
    [{ ...pinnedRemote, id: localRecent.id }],
    [],
    [localRecent.id]
  ).selected[0];
  const localRecordWins = localWinsDuplicate?.id === localRecent.id
    && !localWinsDuplicate.remote
    && localWinsDuplicate.pinned;
  const passed = onlyPinnedRemoteIncluded
    && localRecentsFillRemainingSlots
    && dedicatedVoiceTargetsLocalRecency
    && unpinnedRemoteRemoved
    && localRecordWins;
  console.log(JSON.stringify({
    passed,
    onlyPinnedRemoteIncluded,
    localRecentsFillRemainingSlots,
    unpinnedRemoteRemoved,
    localRecordWins
  }));
  if (!passed) process.exitCode = 1;
}

function verifyRemoteLifecyclePolicy() {
  const threadId = "019f0000-0000-7000-8000-000000000001";
  const turnId = "019f77d5-d319-7000-8000-000000000002";
  const startedAtMs = uuidV7TimestampMs(turnId);
  const startConfigMs = startedAtMs - 192;
  const reasoningObservedMs = startedAtMs + 3_200;
  const endedAtMs = startedAtMs + 9 * 60_000 + 22_000;
  const lifecycles = new Map();
  applyRemoteLifecycleLogLine(
    `${new Date(startConfigMs).toISOString()} info [electron-message-handler] Reasoning summary turn-start config resolved conversationId=${threadId}`,
    lifecycles
  );
  applyRemoteLifecycleLogLine(
    `${new Date(reasoningObservedMs).toISOString()} info [electron-message-handler] Reasoning summary item threadId=${threadId} turnId=${turnId}`,
    lifecycles
  );
  const parsed = lifecycles.get(threadId);
  remoteLifecycleCache.clear();
  remoteReasoningEffortByThreadId.clear();
  remoteLifecycleCache.set(threadId, parsed);
  remoteReasoningEffortByThreadId.set(threadId, {
    effort: "high",
    observedAtMs: reasoningObservedMs,
    turnStartedAtMs: startedAtMs
  });

  const active = remoteStatusForThread({
    id: threadId,
    remote: true,
    updatedAtMs: startedAtMs - 10_000,
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    reasoningEffort: null,
    serviceTier: "default"
  });
  const completed = remoteStatusForThread({
    id: threadId,
    remote: true,
    updatedAtMs: endedAtMs,
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: true,
    reasoningEffort: null,
    serviceTier: "default"
  });

  applyRemoteLifecycleLogLine(
    `${new Date(endedAtMs + 2_000).toISOString()} info [electron-message-handler] maybe_resume_success conversationId=${threadId} latestTurnId=${turnId} latestTurnStatus=interrupted`,
    remoteLifecycleCache
  );
  const stopped = remoteStatusForThread({
    id: threadId,
    remote: true,
    updatedAtMs: endedAtMs,
    threadRuntimeStatus: { type: "idle" },
    reasoningEffort: null,
    serviceTier: "default"
  });

  remoteReasoningEffortByThreadId.set(threadId, {
    effort: "medium",
    observedAtMs: startedAtMs - REMOTE_REASONING_TURN_TOLERANCE_MS - 1,
    turnStartedAtMs: startedAtMs - 60_000
  });
  const staleEffortRejected = reasoningEffortForRemoteThread(
    { id: threadId, reasoningEffort: null },
    remoteLifecycleCache.get(threadId)
  ) === null;
  const summaryEffortPreferred = reasoningEffortForRemoteThread(
    { id: threadId, reasoningEffort: "max" },
    remoteLifecycleCache.get(threadId)
  ) === "max";
  const queueWindows = parseCodexQueueWindows("window\t2\t1\nend\nwindow\t3\t0\nend\n");
  const focusedWindowParsed = queueWindows.length === 2
    && queueWindows[0].index === 2
    && queueWindows[0].focused
    && !queueWindows[1].focused;

  const passed = Number.isFinite(startedAtMs)
    && parsed?.status === "working"
    && parsed.startedAtMs === startedAtMs
    && active.status === "working"
    && active.startedAtMs === startedAtMs
    && active.reasoningEffort === "high"
    && completed.status === "completed"
    && completed.endedAtMs === endedAtMs
    && timingLabel(completed, endedAtMs) === "09:22"
    && stopped.status === "stopped"
    && stopped.startedAtMs === startedAtMs
    && staleEffortRejected
    && summaryEffortPreferred
    && focusedWindowParsed
    && parseCodexReasoningState("effort=ultra confidence=120 visited=800") === "ultra"
    && parseCodexReasoningState("effort=unknown confidence=0 visited=800") === null
    && reasoningEffortProgress(null) === 0;
  console.log(JSON.stringify({
    passed,
    uuidStartRecovered: parsed?.startedAtMs === startedAtMs,
    activeTimingRecovered: active.startedAtMs === startedAtMs,
    completedDuration: timingLabel(completed, endedAtMs),
    stoppedStatusRecovered: stopped.status === "stopped",
    staleEffortRejected,
    summaryEffortPreferred,
    focusedWindowParsed,
    unknownEffortProgress: reasoningEffortProgress(null)
  }));
  remoteLifecycleCache.clear();
  remoteReasoningEffortByThreadId.clear();
  if (!passed) process.exitCode = 1;
}

async function verifyUsageCachePolicy() {
  const weeklyContext = "usage-cache-weekly";
  socket = { readyState: WebSocket.OPEN, send() {} };
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  activeUsageRefresh = null;
  usageState = { remaining: null, failed: false };
  hasLoadedUsageState = false;

  // Simulate the plugin starting on a different page: the background refresh
  // must populate a value even though no usage key is currently visible.
  contexts.set("usage-cache-other-page", ACTIONS.voice);
  const prefetched = await refreshUsage(null, {
    reader: async () => ({ secondary: { usedPercent: 37 } })
  });
  contexts.set(weeklyContext, ACTIONS.weekly);
  renderUsageContexts();
  const firstVisibleSvg = contextImages.get(weeklyContext) ?? "";
  const instantOnAppear = prefetched
    && hasLoadedUsageState
    && usageState.remaining === 63
    && firstVisibleSvg.includes(">63</text>");

  const lastGoodSvg = firstVisibleSvg;
  const originalConsoleError = console.error;
  let preservedAfterFailure = false;
  let initialFailureIsVisible = false;
  try {
    console.error = () => {};
    const failedRefresh = await refreshUsage(null, {
      reader: async () => { throw new Error("simulated usage outage"); }
    });
    preservedAfterFailure = failedRefresh === false
      && hasLoadedUsageState
      && usageState.remaining === 63
      && !usageState.failed
      && contextImages.get(weeklyContext) === lastGoodSvg;

    activeUsageRefresh = null;
    usageState = { remaining: null, failed: false };
    hasLoadedUsageState = false;
    contextImages.clear();
    contextSentImages.clear();
    const initialFailure = await refreshUsage(null, {
      reader: async () => { throw new Error("simulated first usage outage"); }
    });
    initialFailureIsVisible = initialFailure === false
      && !hasLoadedUsageState
      && usageState.failed
      && (contextImages.get(weeklyContext) ?? "").includes(">--</text>");
  } finally {
    console.error = originalConsoleError;
  }

  const passed = instantOnAppear && preservedAfterFailure && initialFailureIsVisible;
  console.log(JSON.stringify({
    passed,
    prefetchedRemaining: instantOnAppear ? 63 : null,
    instantOnAppear,
    preservedAfterFailure,
    initialFailureIsVisible
  }));
  if (!passed) process.exitCode = 1;
  socket = null;
}

async function verifyVoiceSubmissionPolicy() {
  const context = "voice-submit-context";
  const targetThreadId = "00000000-0000-4000-8000-000000000020";
  const baseline = parseTextInputState("focused-text-state", "29\taaaaaaaaaaaaaaaa");
  const transcript = parseTextInputState("focused-text-state", "18\tbbbbbbbbbbbbbbbb");
  const buttonFocusFallback = parseTextInputState(
    "editable-text-state",
    "7\t0\tcccccccccccccccc"
  );
  socket = { readyState: WebSocket.OPEN, send() {} };
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  contexts.set(context, ACTIONS.thread1);

  const tracker = {
    baseline,
    lastObserved: baseline,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: 1_000,
    autoSubmit: true,
    targetThreadId
  };
  voiceTranscriptionByContext.set(context, tracker);
  let completions = 0;
  updateVoiceTranscriptionStates(1_200, {
    stateReader: () => buttonFocusFallback,
    completionHandler: () => { completions += 1; }
  });
  const ignoredFocusTypeChange = completions === 0 && tracker.stableSinceMs === null;
  updateVoiceTranscriptionStates(1_400, {
    stateReader: () => transcript,
    completionHandler: () => { completions += 1; }
  });
  updateVoiceTranscriptionStates(2_200, {
    stateReader: () => transcript,
    completionHandler: () => { completions += 1; }
  });
  const detectedStableTranscript = completions === 1;
  voiceTranscriptionByContext.clear();

  voiceStateByContext.set(context, "submitting");
  voiceTargetThreadByContext.set(context, targetThreadId);
  const alternateEmptyComposer = parseTextInputState(
    "focused-text-state",
    "29\tdddddddddddddddd"
  );
  const rejectedUnchangedDraft = !(await waitForVoiceDraftReset(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    stateReader: () => transcript,
    sleep: async () => {},
    delays: [0, 0, 0]
  }));
  const acceptedStableReset = await waitForVoiceDraftReset(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    stateReader: () => alternateEmptyComposer,
    sleep: async () => {},
    delays: [0, 0, 0]
  });
  const commands = [];
  let verificationAttempts = 0;
  await submitCompletedVoiceTranscription(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    openApp: async () => {},
    sleep: async () => {},
    bridge(command) {
      commands.push(command);
      return true;
    },
    waitForDraftReset: async () => {
      verificationAttempts += 1;
      return verificationAttempts >= 2;
    },
    scheduleRefresh: () => {}
  });
  const retriedUnconfirmedSubmit = commands.join(",")
    === "codex-submit-composer,codex-focus-composer,send";
  const successRequiresConfirmation = verificationAttempts === 2
    && voiceStateByContext.get(context) === "sent";

  const passed = Boolean(baseline && transcript && buttonFocusFallback)
    && ignoredFocusTypeChange
    && detectedStableTranscript
    && rejectedUnchangedDraft
    && acceptedStableReset
    && retriedUnconfirmedSubmit
    && successRequiresConfirmation;
  console.log(JSON.stringify({
    passed,
    ignoredFocusTypeChange,
    detectedStableTranscript,
    rejectedUnchangedDraft,
    acceptedStableReset,
    retriedUnconfirmedSubmit,
    successRequiresConfirmation
  }));
  if (!passed) process.exitCode = 1;
  socket = null;
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

if (completionContractMode) {
  verifyCompletionFanout();
} else if (refreshResilienceContractMode) {
  verifyThreadRefreshResilience().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (threadSelectionContractMode) {
  verifyThreadSelectionPolicy();
} else if (usageCacheContractMode) {
  verifyUsageCachePolicy().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (voiceSubmitContractMode) {
  verifyVoiceSubmissionPolicy().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (remoteLifecycleContractMode) {
  verifyRemoteLifecyclePolicy();
} else if (demoOutput || demoLightOutput || demoAnimationDirectory) {
  if (demoAnimationDirectory) renderDemoAnimation(demoAnimationDirectory, "dark");
  else renderDemo(demoOutput || demoLightOutput, demoLightOutput ? "light" : "dark");
} else if (snapshotMode) {
  readTopThreads()
    .then((threads) => {
      console.log(JSON.stringify(threads.map(({ id, title, pinned, ephemeral, remote, status, startedAtMs, endedAtMs, activity, reasoningEffort, serviceTier, queueCount }) => ({
        id,
        title: normalizeTitle(title),
        pinned,
        ephemeral: Boolean(ephemeral),
        remote: Boolean(remote),
        status,
        activity,
        reasoningEffort,
        serviceTier,
        queueCount,
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
