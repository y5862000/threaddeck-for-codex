"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { execFile, execFileSync, spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const {
  compactLine,
  normalizeTitle,
  stringFingerprint,
  titleFingerprints,
  titleVariants,
  titleVisualWidth,
  wrapTitle
} = require("./text");
const {
  comparableTextInputStates,
  parseTextInputState,
  sameTextInputState,
  voiceDraftReturnedToBaseline
} = require("./text-input");
const {
  UUID_PATTERN,
  threadRecencyMs,
  timingLabel: formatTimingLabel,
  uuidV7TimestampMs
} = require("./time");
const {
  applyRemoteActivityLogLine: applyRemoteActivityLogLineToStore,
  applyRemoteLifecycleLogLine: applyRemoteLifecycleLogLineToStore,
  deriveRemoteStatus,
  normalizedReasoningEffort,
  observeRemoteRuntimeEnd: observeRemoteRuntimeEndInStore,
  parseCodexReasoningState,
  reasoningEffortForRemoteThread: reasoningEffortForRemoteThreadInStore,
} = require("./remote-state");
const { selectTopThreadRows: selectThreadRows } = require("./thread-selection");
const { isInternalThreadRecord } = require("./thread-privacy");
const { parseCodexQueueWindows, queueCountForWindow } = require("./queue-state");
const {
  canContinueLogCursor,
  consumeLogBytes,
  logFileIdentity,
  nextLogBoundary
} = require("./log-lines");
const {
  pinnedThreadIdsFromState,
  promptHistoryFromState,
  remoteThreadRowsFromState
} = require("./codex-state");
const { consumeLifecycleLines } = require("./local-lifecycle");
const {
  ACTIONS,
  APP_SERVER_SESSION_CACHE_MS,
  APP_SERVER_START_TOLERANCE_MS,
  COMPLETION_OBSERVATION_OVERLAP_MS,
  COMPLETION_STARTUP_GRACE_MS,
  DEFAULT_PROFILE_PAGE_COUNT,
  DESKTOP_LOG_PATH_CACHE_MS,
  DISTRIBUTED_PROFILE_NAME,
  GLOBAL_COMPLETION_FRAME_INTERVAL_MS,
  GLOBAL_COMPLETION_GROUP_COUNT,
  GLOBAL_COMPLETION_PULSE_DURATION_MS,
  MEDIA_COMMAND_BY_ACTION,
  PAGE_DIRECTION_BY_ACTION,
  QUEUE_ZERO_CONFIRM_MS,
  SEND_LONG_PRESS_MS,
  SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES,
  SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS,
  SIDE_CHAT_TARGET_LOG_TAIL_BYTES,
  SIDE_CHAT_TARGET_REFRESH_DELAYS_MS,
  THREAD_ACTIONS,
  THREAD_COMPLETION_PULSE_DURATION_MS,
  THREAD_COUNT,
  THREAD_REFRESH_ERROR_STATE,
  THREAD_REFRESH_RETRY_DELAYS_MS,
  THREAD_REFRESH_STARTUP_ERROR_FAILURES,
  THREAD_SLOT_BY_ACTION,
  THREAD_VOICE_FOCUS_PREP_LEAD_MS,
  THREAD_VOICE_FOCUS_SETTLE_MS,
  THREAD_VOICE_LONG_PRESS_MS,
  VOICE_AUTO_SUBMIT_STABLE_MS,
  VOICE_COMPLETE_DISPLAY_MS,
  VOICE_ERROR_DISPLAY_MS,
  VOICE_START_VERIFY_MS,
  VOICE_SUBMIT_VERIFY_DELAYS_MS,
  VOICE_TARGET_OPEN_HINT_MS,
  VOICE_TEXT_PROBE_INTERVAL_MS,
  VOICE_TRANSCRIPTION_POLL_INTERVAL_MS,
  VOICE_TRANSCRIPTION_STABLE_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MS
} = require("./config");

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

const REMOTE_APP_ACTIVATION_SETTLE_MS = 80;
const REMOTE_APP_ACTIVATION_RETRY_MS = 180;
const REMOTE_LIFECYCLE_LOG_SEARCH_LIMIT_BYTES = 32 * 1024 * 1024;
const REMOTE_REASONING_PROBE_CACHE_MS = 5_000;
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
const usageCacheContractMode = process.argv.includes("--verify-usage-cache");
const voiceSubmitContractMode = process.argv.includes("--verify-voice-submit");
const demoOutput = argument("--render-demo");
const demoLightOutput = argument("--render-demo-light");
const demoAnimationDirectory = argument("--render-demo-animation");
const gestureAnimationDirectory = argument("--render-gesture-animations");
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
const voiceSessionIdByContext = new Map();
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
let nextVoiceSessionId = 0;
let appServerSessionCache = { checkedAtMs: 0, startedAtMs: null };
let desktopLogPathCache = { checkedAtMs: 0, path: null, paths: [] };
let accessibilityTrustCache = { checkedAtMs: 0, trusted: null };
let pinnedIdsCache = [];
let remoteThreadRowsCache = [];
let sideChatRowsCache = [];
let sideChatSessionStartMs = null;
const sideChatParentById = new Map();
const sideChatLifecycleCache = new Map();
const closedSideChatAtMs = new Map();
const sideChatCloseLogOffsets = new Map();
const remoteLifecycleCache = new Map();
const remoteLifecycleLogCursors = new Map();
const remoteReasoningEffortByThreadId = new Map();
const remoteRuntimeObservationByThreadId = new Map();
const remoteActivityByThreadId = new Map();
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
    startedAtMs: Date.now(),
    held: true,
    armed: false,
    voiceStarted: false,
    timer: null,
    openPromise: null,
    focusPromise: null
  };
  threadPressByContext.set(context, state);
  state.openPromise = openThread(context, slot);
  state.focusPromise = state.openPromise.then(async (opened) => {
    if (!opened || threadPressByContext.get(context) !== state || !state.held) return false;
    // Prepare focus close to the hold threshold instead of blocking the key-up
    // event after it. This keeps short presses cancellable while removing the
    // full composer-discovery cost from the start of a genuine voice hold.
    const earliestFocusAtMs = state.startedAtMs
      + THREAD_VOICE_LONG_PRESS_MS
      - THREAD_VOICE_FOCUS_PREP_LEAD_MS;
    const delayMs = Math.max(
      THREAD_VOICE_FOCUS_SETTLE_MS,
      earliestFocusAtMs - Date.now()
    );
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (threadPressByContext.get(context) !== state || !state.held) return false;
    return runKeyBridgeAwaited("codex-focus-composer", null, { quiet: true });
  });
  state.timer = setTimeout(async () => {
    if (threadPressByContext.get(context) !== state || !state.held) return;
    state.armed = true;
    const opened = await state.openPromise;
    if (threadPressByContext.get(context) !== state || !state.held || !opened) {
      threadPressByContext.delete(context);
      return;
    }
    const composerFocused = await state.focusPromise;
    if (threadPressByContext.get(context) !== state || !state.held) {
      threadPressByContext.delete(context);
      return;
    }
    clearFeedback(context);
    state.voiceStarted = beginVoiceHoldSync(context, {
      targetThreadId: state.threadId,
      autoSubmit: true,
      composerAlreadyFocused: composerFocused
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

async function runKeyBridgeAwaited(command, context = null, options = {}) {
  const quiet = Boolean(options.quiet);
  if (!accessibilityTrustedSync()) {
    if (!quiet) {
      if (context) showFeedback(context, "error", "손쉬운 사용", 2200);
      console.error(`Key bridge ${command} needs Stream Deck Accessibility permission`);
    }
    return false;
  }
  try {
    await execFileAsync(KEY_BRIDGE, [command], {
      timeout: command.startsWith("codex-") ? 2500 : 1000,
      maxBuffer: 64 * 1024
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

function claimVoiceSession(context) {
  // Codex exposes one global composer and one push-to-talk shortcut. Starting
  // a hold from any key therefore supersedes every earlier transcription or
  // submit, even when Stream Deck assigned those keys different contexts.
  for (const previousContext of voiceSessionIdByContext.keys()) {
    if (previousContext !== context) cancelVoiceTranscription(previousContext, true);
  }
  voiceSessionIdByContext.clear();
  const sessionId = ++nextVoiceSessionId;
  voiceSessionIdByContext.set(context, sessionId);
  return sessionId;
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

function voiceSubmissionStillCurrent(context, targetThreadId, sessionId) {
  return contexts.has(context)
    && voiceStateByContext.get(context) === "submitting"
    && voiceTargetThreadByContext.get(context) === targetThreadId
    && Number.isInteger(sessionId)
    && voiceSessionIdByContext.get(context) === sessionId;
}

async function waitForVoiceDraftReset(context, targetThreadId, tracker, options = {}) {
  const stateReader = options.stateReader ?? textInputStateSync;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const delays = options.delays ?? VOICE_SUBMIT_VERIFY_DELAYS_MS;
  let stableResetCandidate = null;
  let stableResetObservations = 0;
  for (const delayMs of delays) {
    await sleep(delayMs);
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return false;
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
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;

    const clickedSubmit = bridge("codex-submit-composer", null, { quiet: true });
    let confirmed = clickedSubmit
      && await waitForDraftReset(context, targetThreadId, tracker, options);
    if (!confirmed && voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) {
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
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;
    if (!confirmed) {
      failVoiceTranscription(context);
      console.error("Codex dictated message submission could not be confirmed");
      return;
    }
    setVoiceVisualState(context, "sent", VOICE_COMPLETE_DISPLAY_MS);
    scheduleRefresh();
  } catch (error) {
    if (voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) {
      failVoiceTranscription(context);
      console.error(`Could not submit dictated Codex message: ${error?.message ?? "unknown error"}`);
    }
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

function supersedeHeldVoiceSync(context, bridge = runKeyBridgeSync) {
  const previousContexts = [...voiceHeldContexts].filter((heldContext) => heldContext !== context);
  if (previousContexts.length === 0) return false;

  // The Codex push-to-talk shortcut and composer are global. A second key
  // cannot safely share the physical hold with the first key because either
  // release order could then attribute the transcript to the wrong task.
  voiceHeldContexts.clear();
  for (const previousContext of previousContexts) clearVoiceStartVerification(previousContext);
  bridge("voice-up", previousContexts.at(-1));
  return true;
}

function beginVoiceHoldSync(context, options = {}) {
  if (voiceHeldContexts.has(context)) return true;
  const bridge = options.bridge ?? runKeyBridgeSync;
  const stateReader = options.stateReader ?? textInputStateSync;
  const pauseMedia = options.pauseMedia ?? pauseMediaForVoiceSync;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoiceSync;
  supersedeHeldVoiceSync(context, bridge);
  cancelVoiceTranscription(context);
  voiceStateByContext.delete(context);
  const sessionId = claimVoiceSession(context);
  const targetThreadId = options.targetThreadId ?? resolveVoiceTargetThreadId();
  if (targetThreadId) voiceTargetThreadByContext.set(context, targetThreadId);
  // Start with the composer focused so both the baseline and the final
  // transcript come from the same accessibility element.
  if (!options.composerAlreadyFocused) {
    bridge("codex-focus-composer", null, { quiet: true });
  }
  let baseline = stateReader();
  if (!baseline && options.composerAlreadyFocused) {
    // The prepared focus can become stale if Codex replaces the composer DOM
    // during the final navigation frame. Retry only in that exceptional case.
    bridge("codex-focus-composer", null, { quiet: true });
    baseline = stateReader();
  }
  voiceTranscriptionByContext.set(context, {
    baseline,
    lastObserved: baseline,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: null,
    autoSubmit: Boolean(options.autoSubmit),
    targetThreadId: targetThreadId ?? null,
    sessionId
  });
  if (voiceHeldContexts.size === 0) {
    pauseMedia(context);
    if (!bridge("voice-down", context)) {
      resumeMedia();
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

function endVoiceHoldSync(context, trackTranscription = true, options = {}) {
  const bridge = options.bridge ?? runKeyBridgeSync;
  const stateReader = options.stateReader ?? textInputStateSync;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoiceSync;
  clearVoiceStartVerification(context);
  if (!voiceHeldContexts.delete(context)) return;
  if (voiceHeldContexts.size > 0) return;
  const released = bridge("voice-up", context);
  resumeMedia();
  if (!trackTranscription) {
    cancelVoiceTranscription(context, true);
    return;
  }
  if (!released) {
    failVoiceTranscription(context);
    return;
  }
  const tracker = voiceTranscriptionByContext.get(context) ?? {
    baseline: stateReader(),
    lastObserved: null,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: null,
    autoSubmit: false,
    targetThreadId: voiceTargetThreadByContext.get(context) ?? null,
    sessionId: voiceSessionIdByContext.get(context) ?? ++nextVoiceSessionId
  };
  voiceSessionIdByContext.set(context, tracker.sessionId);
  if (!tracker.baseline) tracker.baseline = stateReader();
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
  voiceSessionIdByContext.clear();
  for (const timer of voiceStartVerificationTimers.values()) clearTimeout(timer);
  voiceStartVerificationTimers.clear();
  for (const state of threadPressByContext.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  threadPressByContext.clear();
  resumeMediaAfterVoiceSync();
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

function timingLabel(thread, nowMs = renderTimeMs()) {
  return formatTimingLabel(thread, nowMs);
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

async function readGlobalStateSnapshot() {
  return JSON.parse(await fs.readFile(GLOBAL_STATE, "utf8"));
}

async function readPinnedIds(globalStatePromise = readGlobalStateSnapshot()) {
  try {
    const state = await globalStatePromise;
    pinnedIdsCache = pinnedThreadIdsFromState(state);
    return [...pinnedIdsCache];
  } catch {
    // Codex can rewrite the JSON state while this poll is reading it. Keep the
    // previous explicit pin set so pinned remote tasks do not disappear for a
    // single frame.
    return [...pinnedIdsCache];
  }
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
    sideChatRowsCache = [];
    sideChatParentById.clear();
    sideChatLifecycleCache.clear();
    closedSideChatAtMs.clear();
    sideChatCloseLogOffsets.clear();
  }
  appServerSessionCache = { checkedAtMs: nowMs, startedAtMs };
  return startedAtMs;
}

async function readEphemeralSideChats(
  persistentRowsOrIds,
  parentId,
  globalStatePromise = null
) {
  const sessionStartedAtMs = await readAppServerSessionStartMs();
  if (!Number.isFinite(sessionStartedAtMs)) return [];
  const persistentIds = persistentRowsOrIds instanceof Set
    ? persistentRowsOrIds
    : new Set(persistentRowsOrIds.map((row) => row.id));

  try {
    const state = await (globalStatePromise ?? readGlobalStateSnapshot());
    const promptHistory = promptHistoryFromState(state);
    if (!promptHistory) return sideChatRowsCache.filter((thread) => !persistentIds.has(thread.id));
    const sideChats = [];

    for (const [id, prompts] of Object.entries(promptHistory)) {
      if (!UUID_PATTERN.test(id) || persistentIds.has(id) || !Array.isArray(prompts)) continue;
      const createdAtMs = uuidV7TimestampMs(id);
      if (!Number.isFinite(createdAtMs)
          || createdAtMs + APP_SERVER_START_TOLERANCE_MS < sessionStartedAtMs) continue;
      const firstPrompt = prompts.find((prompt) => typeof prompt === "string" && prompt.trim());
      if (!firstPrompt || isInternalThreadRecord({ title: firstPrompt })) continue;
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
    sideChatRowsCache = sideChats.sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
    return [...sideChatRowsCache];
  } catch {
    return sideChatRowsCache.filter((thread) => !persistentIds.has(thread.id));
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

function applyRemoteActivityLogLine(line, activities = remoteActivityByThreadId) {
  return applyRemoteActivityLogLineToStore(line, activities);
}

function applyRemoteLifecycleLogLine(line, lifecycles = remoteLifecycleCache) {
  return applyRemoteLifecycleLogLineToStore(line, lifecycles);
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

  for (const { filePath } of files) {
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      const stat = await handle.stat();
      const previous = remoteLifecycleLogCursors.get(filePath) ?? null;
      let observedBoundary = Buffer.alloc(0);
      if (Number.isSafeInteger(previous?.offset)
          && previous.offset >= 0
          && previous.offset <= stat.size
          && Buffer.isBuffer(previous.boundaryBytes)
          && previous.boundaryBytes.length > 0) {
        const boundaryLength = Math.min(previous.boundaryBytes.length, previous.offset);
        observedBoundary = Buffer.alloc(boundaryLength);
        const { bytesRead } = await handle.read(
          observedBoundary,
          0,
          boundaryLength,
          previous.offset - boundaryLength
        );
        observedBoundary = observedBoundary.subarray(0, bytesRead);
      }
      const continuing = canContinueLogCursor(previous, stat, observedBoundary);
      const start = continuing
        ? previous.offset
        : Math.max(0, stat.size - REMOTE_LIFECYCLE_LOG_SEARCH_LIMIT_BYTES);
      if (start >= stat.size) {
        if (!continuing) {
          remoteLifecycleLogCursors.set(filePath, {
            offset: stat.size,
            fileIdentity: logFileIdentity(stat),
            boundaryBytes: Buffer.alloc(0),
            lineState: null
          });
        }
        continue;
      }

      let discardLeadingPartial = false;
      if (!continuing && start > 0) {
        const previousByte = Buffer.alloc(1);
        const { bytesRead } = await handle.read(previousByte, 0, 1, start - 1);
        discardLeadingPartial = bytesRead !== 1 || previousByte[0] !== 0x0a;
      }
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const chunk = buffer.subarray(0, bytesRead);
      const { lines, state: lineState } = consumeLogBytes(
        continuing ? previous.lineState : null,
        chunk,
        { discardLeadingPartial }
      );
      for (const line of lines) {
        applyRemoteLifecycleLogLine(line);
        applyRemoteActivityLogLine(line);
      }
      remoteLifecycleLogCursors.set(filePath, {
        offset: start + bytesRead,
        fileIdentity: logFileIdentity(stat),
        boundaryBytes: nextLogBoundary(continuing ? previous.boundaryBytes : null, chunk),
        lineState
      });
    } catch {
      // Preserve the last parsed lifecycle while a Desktop log rotates.
    } finally {
      try {
        await handle?.close();
      } catch {
        // The read result above remains usable even if a rotating handle closes late.
      }
    }
  }
  for (const filePath of remoteLifecycleLogCursors.keys()) {
    if (activePaths.has(filePath)) continue;
    const finalLineBytes = remoteLifecycleLogCursors.get(filePath)?.lineState?.carryBytes;
    if (Buffer.isBuffer(finalLineBytes) && finalLineBytes.length > 0) {
      const finalLine = finalLineBytes.toString("utf8");
      applyRemoteLifecycleLogLine(finalLine);
      applyRemoteActivityLogLine(finalLine);
    }
    remoteLifecycleLogCursors.delete(filePath);
  }
  return remoteLifecycleCache;
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
  return reasoningEffortForRemoteThreadInStore(
    thread,
    lifecycle,
    remoteReasoningEffortByThreadId
  );
}

function observeRemoteRuntimeEnd(
  thread,
  lifecycle,
  nowMs = Date.now(),
  observations = remoteRuntimeObservationByThreadId
) {
  return observeRemoteRuntimeEndInStore(thread, lifecycle, nowMs, observations);
}

function remoteStatusForThread(
  thread,
  nowMs = Date.now(),
  runtimeObservations = remoteRuntimeObservationByThreadId,
  remoteActivities = remoteActivityByThreadId
) {
  const lifecycle = remoteLifecycleCache.get(thread.id) ?? null;
  return deriveRemoteStatus(thread, {
    nowMs,
    lifecycle,
    reasoningEfforts: remoteReasoningEffortByThreadId,
    runtimeObservations,
    activities: remoteActivities
  });
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
  const query = `SELECT id, title, cwd, rollout_path, recency_at, updated_at, source, thread_source, agent_path FROM threads WHERE archived=0 AND COALESCE(thread_source, '') <> 'subagent' AND (agent_path IS NULL OR agent_path='') AND lower(COALESCE(source, '')) <> 'subagent' AND COALESCE(source, '') NOT LIKE '%"subagent"%' ORDER BY recency_at DESC, updated_at DESC;`;
  const { stdout } = await execFileAsync(SQLITE, ["-readonly", "-json", STATE_DB, query], {
    timeout: 4000,
    maxBuffer: 4 * 1024 * 1024
  });
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(rows) ? rows : [];
}

async function readPersistentThreadIds() {
  const query = "SELECT id FROM threads;";
  const { stdout } = await execFileAsync(SQLITE, ["-readonly", "-json", STATE_DB, query], {
    timeout: 4000,
    maxBuffer: 2 * 1024 * 1024
  });
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => row?.id)
      .filter((id) => typeof id === "string" && UUID_PATTERN.test(id))
  );
}

async function readRemoteThreadRows(globalStatePromise = readGlobalStateSnapshot()) {
  try {
    remoteThreadRowsCache = remoteThreadRowsFromState(await globalStatePromise);
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
  return selectThreadRows(localRows, remoteRows, openSideChats, pinnedIds, THREAD_COUNT);
}

async function readTopThreads() {
  const queueWindowsPromise = readCodexQueueWindows();
  const globalStatePromise = readGlobalStateSnapshot();
  const [rows, persistentIds, remoteRows, pinnedIds, activeThreadIds, sidebarNames] = await Promise.all([
    readThreadRows(),
    readPersistentThreadIds(),
    readRemoteThreadRows(globalStatePromise),
    readPinnedIds(globalStatePromise),
    readActiveThreadIds(),
    readSidebarThreadNames()
  ]);
  const localRows = rows
    .filter((row) => !isInternalThreadRecord(row))
    .map((row) => ({ ...row, title: sidebarNames.get(row.id) ?? row.title }))
    .filter((row) => !isInternalThreadRecord(row));
  const sideChats = await readEphemeralSideChats(
    persistentIds,
    localRows[0]?.id ?? null,
    globalStatePromise
  );
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
      await new Promise((resolve) => setTimeout(resolve, REMOTE_APP_ACTIVATION_SETTLE_MS));
      let opened = false;
      let lastError = null;
      let sawAmbiguousTitle = false;
      for (let attempt = 0; attempt < 2 && !opened && !sawAmbiguousTitle; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, REMOTE_APP_ACTIVATION_RETRY_MS));
        }
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
      voiceSessionIdByContext.delete(message.context);
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
  voiceHeldContexts.clear();
  voiceStateByContext.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  sendLongPressArmedContexts.clear();
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
  else if (animated && elapsedMs >= 2_550 && elapsedMs < 2_850) voiceState = "submitting";
  else if (animated && elapsedMs >= 2_850 && elapsedMs < 3_200) voiceState = "sent";

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
  let workingThreadSvg = threadSvg(workingThread, 0);
  if (voiceState !== "idle") {
    workingThreadSvg = workingThreadSvg.replace(
      "</svg>",
      `${voiceTargetOverlaySvg(voiceState, nowMs)}\n</svg>`
    );
  }
  const keySvgs = [
    usageSvg(74, false),
    sideChatSvg(),
    newThreadSvg(),
    sendSvg(),
    workingThreadSvg,
    appSwitchSvg(),
    voiceSvg("idle", nowMs),
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

function documentationImage(svg, x, y, size) {
  const data = Buffer.from(svg).toString("base64");
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${data}"/>`;
}

function gestureStageRows(stages, activeStage, accent) {
  const rowHeight = 47;
  return stages.map((stage, index) => {
    const y = 92 + index * rowHeight;
    const active = index === activeStage;
    const completed = index < activeStage;
    const fill = active ? accent : completed ? "#6F7782" : "#3A3A3C";
    const text = active ? "#FFFFFF" : completed ? "#D6D9DE" : "#9A9EA5";
    return `<g>
      ${active ? `<rect x="390" y="${y - 25}" width="526" height="40" rx="12" fill="${accent}" fill-opacity=".14" stroke="${accent}" stroke-opacity=".52"/>` : ""}
      <circle cx="415" cy="${y - 5}" r="8" fill="${fill}"/>
      ${completed ? `<path d="M411 ${y - 5}L414 ${y - 2}L420 ${y - 9}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
      <text x="439" y="${y + 1}" fill="${text}" font-family="${FONT_STACK}" font-size="18" font-weight="${active ? 650 : 520}">${escapeXml(stage)}</text>
    </g>`;
  }).join("\n");
}

function gesturePreviewSvg({ title, subtitle, keySvg, stages, activeStage, accent, result }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420" text-rendering="optimizeLegibility">
  <rect width="960" height="420" rx="32" fill="#1C1C1E"/>
  <text x="42" y="48" fill="#F2F6FA" font-family="${FONT_STACK}" font-size="27" font-weight="700">${escapeXml(title)}</text>
  <text x="42" y="76" fill="#AEB3BA" font-family="${FONT_STACK}" font-size="16.5" font-weight="500">${escapeXml(subtitle)}</text>
  <rect x="42" y="98" width="300" height="274" rx="24" fill="#28282A" stroke="#3A3A3C"/>
  ${documentationImage(keySvg, 80, 113, 224)}
  <rect x="72" y="337" width="240" height="26" rx="13" fill="${accent}" fill-opacity=".14" stroke="${accent}" stroke-opacity=".55"/>
  <text x="192" y="355" fill="${accent}" font-family="${FONT_STACK}" font-size="14.5" font-weight="650" text-anchor="middle">${escapeXml(result)}</text>
  ${gestureStageRows(stages, activeStage, accent)}
  <rect x="390" y="375" width="526" height="3" rx="1.5" fill="#343438"/>
  <rect x="390" y="375" width="${Math.max(3, 526 * ((activeStage + 1) / stages.length))}" height="3" rx="1.5" fill="${accent}"/>
  </svg>\n`;
}

function demoGestureThread(nowMs, voiceState = "idle") {
  const thread = {
    id: DEMO_WORKING_ID,
    title: "릴리스 준비",
    pinned: true,
    status: "working",
    startedAtMs: DEMO_EPOCH_MS - 4 * 60_000 - 12_000,
    endedAtMs: null,
    activity: { kind: "edit", label: "코드 수정" },
    reasoningEffort: "ultra",
    serviceTier: "priority",
    queueCount: 1
  };
  const base = threadSvg(thread, 0);
  if (voiceState === "idle") return base;
  return base.replace("</svg>", `${voiceTargetOverlaySvg(voiceState, nowMs)}\n</svg>`);
}

function taskHoldGestureFrame(nowMs, elapsedMs) {
  const holdSeconds = (THREAD_VOICE_LONG_PRESS_MS / 1000).toFixed(2);
  const stages = [
    `Hold ${holdSeconds} s · ${holdSeconds}초 길게`,
    "Speak · 말하기",
    "Release · 놓기",
    "Transcribe · 받아쓰기",
    "Submit · 자동 전송",
    "Sent · 전송 확인"
  ];
  let state = "idle";
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = OPEN · 짧게 = 작업 열기";
  if (elapsedMs >= 1_400 && elapsedMs < 2_650) {
    state = "recording";
    activeStage = 1;
    accent = THEME.amber;
    result = "KEEP HOLDING · 계속 누르기";
  } else if (elapsedMs >= 2_650 && elapsedMs < 3_150) {
    state = "transcribing";
    activeStage = 2;
    accent = THEME.textSecondary;
    result = "RELEASED · 녹음 종료";
  } else if (elapsedMs >= 3_150 && elapsedMs < 3_950) {
    state = "transcribing";
    activeStage = 3;
    accent = THEME.textSecondary;
    result = "DRAFT STABILIZING · 초안 확인 중";
  } else if (elapsedMs >= 3_950 && elapsedMs < 4_750) {
    state = "submitting";
    activeStage = 4;
    accent = THEME.blue;
    result = "AUTO SUBMIT · 자동 전송";
  } else if (elapsedMs >= 4_750 && elapsedMs < 5_750) {
    state = "sent";
    activeStage = 5;
    accent = THEME.green;
    result = "SEND VERIFIED · 전송 확인";
  }
  return gesturePreviewSvg({
    title: "Task key · 작업 버튼",
    subtitle: "Tap to open, or hold to dictate and submit",
    keySvg: demoGestureThread(nowMs, state),
    stages,
    activeStage,
    accent,
    result
  });
}

function voiceHoldGestureFrame(nowMs, elapsedMs) {
  const stages = [
    "Press · 누르기",
    "Speak while held · 누른 채 말하기",
    "Release · 놓기",
    "Transcribe · 받아쓰기",
    "Draft ready · 초안 완료"
  ];
  let state = "idle";
  let activeStage = 0;
  let accent = THEME.text;
  let result = "PRESS = RECORD · 누르면 즉시 녹음";
  if (elapsedMs >= 800 && elapsedMs < 2_300) {
    state = "recording";
    activeStage = 1;
    accent = THEME.amber;
    result = "KEEP HOLDING · 누르는 동안 녹음";
  } else if (elapsedMs >= 2_300 && elapsedMs < 2_800) {
    state = "transcribing";
    activeStage = 2;
    accent = THEME.textSecondary;
    result = "RELEASED · 녹음 종료";
  } else if (elapsedMs >= 2_800 && elapsedMs < 3_800) {
    state = "transcribing";
    activeStage = 3;
    accent = THEME.textSecondary;
    result = "DRAFT ONLY · 자동 전송 안 함";
  } else if (elapsedMs >= 3_800 && elapsedMs < 4_900) {
    state = "complete";
    activeStage = 4;
    accent = THEME.green;
    result = "REVIEW IN COMPOSER · 작성창에서 확인";
  }
  return gesturePreviewSvg({
    title: "Microphone · 전용 마이크",
    subtitle: "Push to talk; the transcript stays in the composer",
    keySvg: voiceSvg(state, nowMs),
    stages,
    activeStage,
    accent,
    result
  });
}

function sendHoldGestureFrame(nowMs, elapsedMs) {
  const holdSeconds = (SEND_LONG_PRESS_MS / 1000).toFixed(1);
  const stages = [
    "Tap and release · 짧게 눌렀다 놓기",
    "Return",
    `Hold ${holdSeconds} s · ${holdSeconds}초 길게`,
    "Blue = armed · 파랑 = 준비",
    "Release · 놓아 실행"
  ];
  let armed = false;
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = RETURN · 짧게 = Return";
  if (elapsedMs >= 650 && elapsedMs < 1_450) {
    activeStage = 1;
    accent = THEME.green;
    result = "KEYSTROKE: RETURN";
  } else if (elapsedMs >= 2_150 && elapsedMs < 2_750) {
    activeStage = 2;
    result = "KEEP HOLDING · 계속 누르기";
  } else if (elapsedMs >= 2_750 && elapsedMs < 4_050) {
    armed = true;
    activeStage = 3;
    accent = THEME.blue;
    result = "ARMED: COMMAND + RETURN";
  } else if (elapsedMs >= 4_050 && elapsedMs < 4_950) {
    activeStage = 4;
    accent = THEME.blue;
    result = "KEYSTROKE: COMMAND + RETURN";
  }
  return gesturePreviewSvg({
    title: "Send key · 보내기 버튼",
    subtitle: "The action fires when the key is released",
    keySvg: sendSvg(armed),
    stages,
    activeStage,
    accent,
    result
  });
}

function appLauncherGuideSvg(quitArmed = false) {
  const accent = quitArmed ? THEME.red : THEME.text;
  const chrome = quitArmed
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.red}" fill-opacity=".10" stroke="${THEME.red}" stroke-opacity=".9" stroke-width="3"/>`
    : "";
  return shell(accent, `
    <rect x="34" y="32" width="76" height="80" rx="17" fill="none" stroke="${accent}" stroke-width="5"/>
    <rect x="49" y="47" width="18" height="18" rx="5" fill="${accent}"/>
    <rect x="77" y="47" width="18" height="18" rx="5" fill="${accent}" opacity=".72"/>
    <rect x="49" y="75" width="18" height="18" rx="5" fill="${accent}" opacity=".72"/>
    <rect x="77" y="75" width="18" height="18" rx="5" fill="${accent}"/>
    <text x="72" y="129" fill="${accent}" font-family="${FONT_STACK}" font-size="14" font-weight="700" text-anchor="middle">APP</text>`, "", chrome);
}

function appLauncherGestureFrame(nowMs, elapsedMs) {
  const stages = [
    "Tap · 짧게 누르기",
    "Open or front · 열기/앞으로",
    "Hold · 길게 누르기",
    "Quit action · 앱 종료",
    "Release · 놓기"
  ];
  let quitArmed = false;
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = OPEN / FRONT · 짧게 = 열기";
  if (elapsedMs >= 900 && elapsedMs < 1_700) {
    activeStage = 1;
    accent = THEME.green;
    result = "APP OPENED OR FOCUSED · 앱 활성화";
  } else if (elapsedMs >= 2_000 && elapsedMs < 3_100) {
    activeStage = 2;
    result = "KEEP HOLDING · 계속 누르기";
  } else if (elapsedMs >= 3_100 && elapsedMs < 4_150) {
    quitArmed = true;
    activeStage = 3;
    accent = THEME.red;
    result = "LONG PRESS = QUIT · 길게 = 종료";
  } else if (elapsedMs >= 4_150 && elapsedMs < 4_800) {
    activeStage = 4;
    accent = THEME.red;
    result = "QUIT REQUESTED · 앱 종료 요청";
  }
  return gesturePreviewSvg({
    title: "App launcher · 앱 실행",
    subtitle: "Neutral guide for the bundled Stream Deck Open Application action",
    keySvg: appLauncherGuideSvg(quitArmed),
    stages,
    activeStage,
    accent,
    result
  });
}

function renderGestureAnimations(outputDirectory, mode = "dark") {
  appearanceMode = mode;
  THEME = mode === "dark" ? DARK_THEME : LIGHT_THEME;
  const resolvedDirectory = path.resolve(outputDirectory);
  const framesPerSecond = 10;
  const scenarios = [
    { name: "task-hold-to-talk", durationMs: 6_000, render: taskHoldGestureFrame },
    { name: "voice-hold-to-dictate", durationMs: 5_200, render: voiceHoldGestureFrame },
    { name: "send-long-press", durationMs: 5_400, render: sendHoldGestureFrame },
    { name: "app-launcher-long-press", durationMs: 5_000, render: appLauncherGestureFrame }
  ];
  for (const scenario of scenarios) {
    const scenarioDirectory = path.join(resolvedDirectory, scenario.name);
    fsSync.mkdirSync(scenarioDirectory, { recursive: true });
    for (const entry of fsSync.readdirSync(scenarioDirectory)) {
      if (/^frame-\d{3}\.svg$/.test(entry)) fsSync.unlinkSync(path.join(scenarioDirectory, entry));
    }
    const frameCount = Math.ceil(scenario.durationMs / 1000 * framesPerSecond);
    for (let index = 0; index < frameCount; index += 1) {
      resetDemoEffects();
      const elapsedMs = Math.round(index / framesPerSecond * 1000);
      const nowMs = DEMO_EPOCH_MS + elapsedMs;
      fixedRenderTimeMs = nowMs;
      const frame = scenario.render(nowMs, elapsedMs);
      fsSync.writeFileSync(path.join(scenarioDirectory, `frame-${String(index).padStart(3, "0")}.svg`), frame);
    }
    console.log(`Rendered ${frameCount} ${scenario.name} animation frames in ${scenarioDirectory}`);
  }
  fixedRenderTimeMs = null;
  resetDemoEffects();
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

  const sideChatCreatedAtMs = Date.now();
  const timestampHex = sideChatCreatedAtMs.toString(16).padStart(12, "0").slice(-12);
  const sideChatId = `${timestampHex.slice(0, 8)}-${timestampHex.slice(8)}-7000-8000-000000000001`;
  const sideChatState = {
    "electron-persisted-atom-state": {
      "prompt-history": { [sideChatId]: ["임시 사이드 작업"] }
    }
  };
  const savedAppServerSessionCache = appServerSessionCache;
  const savedSideChatSessionStartMs = sideChatSessionStartMs;
  const savedSideChatRowsCache = sideChatRowsCache;
  const savedSideChatParents = new Map(sideChatParentById);
  let sideChatCachePreserved = false;
  let persistentSideChatReentryBlocked = false;
  try {
    const sessionStartedAtMs = sideChatCreatedAtMs - 1_000;
    appServerSessionCache = { checkedAtMs: Date.now(), startedAtMs: sessionStartedAtMs };
    sideChatSessionStartMs = sessionStartedAtMs;
    sideChatRowsCache = [];
    sideChatParentById.clear();
    const persistentRows = [stableThread];
    const first = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve(sideChatState)
    );
    const afterReadFailure = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.reject(new Error("simulated global-state rewrite"))
    );
    const afterSemanticFailure = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve({ "electron-persisted-atom-state": "{partial" })
    );
    const afterValidEmptyState = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve({
        "electron-persisted-atom-state": { "prompt-history": {} }
      })
    );
    const blockedPersistentId = await readEphemeralSideChats(
      new Set([stableThread.id, sideChatId]),
      stableThread.id,
      Promise.resolve(sideChatState)
    );
    sideChatCachePreserved = first[0]?.id === sideChatId
      && afterReadFailure[0]?.id === sideChatId
      && afterSemanticFailure[0]?.id === sideChatId
      && afterValidEmptyState.length === 0
      && sideChatRowsCache.length === 0;
    persistentSideChatReentryBlocked = blockedPersistentId.length === 0;
  } finally {
    appServerSessionCache = savedAppServerSessionCache;
    sideChatSessionStartMs = savedSideChatSessionStartMs;
    sideChatRowsCache = savedSideChatRowsCache;
    sideChatParentById.clear();
    for (const [id, parentId] of savedSideChatParents) sideChatParentById.set(id, parentId);
  }

  const passed = recoveredInsideRefresh
    && keptLastGoodList
    && oneOffStartupHidden
    && startupErrorStable
    && sideChatCachePreserved
    && persistentSideChatReentryBlocked;
  console.log(JSON.stringify({
    passed,
    retryAttempts,
    keptLastGoodList,
    oneOffStartupHidden,
    sideChatCachePreserved,
    persistentSideChatReentryBlocked,
    startupErrorAfterFailures: startupErrorStable ? THREAD_REFRESH_STARTUP_ERROR_FAILURES : null
  }));
  if (!passed) process.exitCode = 1;
  socket = null;
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
  voiceSessionIdByContext.clear();
  contexts.set(context, ACTIONS.thread1);

  const sessionId = ++nextVoiceSessionId;
  voiceSessionIdByContext.set(context, sessionId);

  const tracker = {
    baseline,
    lastObserved: baseline,
    stableSinceMs: null,
    lastProbeAtMs: null,
    releasedAtMs: 1_000,
    autoSubmit: true,
    targetThreadId,
    sessionId
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

  const staleCommands = [];
  voiceStateByContext.set(context, "submitting");
  voiceSessionIdByContext.set(context, ++nextVoiceSessionId);
  await submitCompletedVoiceTranscription(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    openApp: async () => {},
    sleep: async () => {},
    bridge(command) {
      staleCommands.push(command);
      return true;
    },
    scheduleRefresh: () => {}
  });
  const staleSubmissionIgnored = staleCommands.length === 0
    && voiceStateByContext.get(context) === "submitting";

  const otherContext = "voice-submit-other-context";
  contexts.set(otherContext, ACTIONS.thread2);
  const crossContextSessionId = ++nextVoiceSessionId;
  voiceSessionIdByContext.clear();
  voiceSessionIdByContext.set(context, crossContextSessionId);
  voiceStateByContext.set(context, "submitting");
  voiceTargetThreadByContext.set(context, targetThreadId);
  voiceTranscriptionByContext.set(context, {
    ...tracker,
    sessionId: crossContextSessionId
  });
  const crossContextCommands = [];
  await submitCompletedVoiceTranscription(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript,
    sessionId: crossContextSessionId
  }, {
    openApp: async () => {
      claimVoiceSession(otherContext);
    },
    sleep: async () => {},
    bridge(command) {
      crossContextCommands.push(command);
      return true;
    },
    scheduleRefresh: () => {}
  });
  const crossContextSubmissionIgnored = crossContextCommands.length === 0
    && !voiceSessionIdByContext.has(context)
    && voiceSessionIdByContext.has(otherContext)
    && !voiceTranscriptionByContext.has(context)
    && !voiceStateByContext.has(context)
    && !voiceTargetThreadByContext.has(context);

  const otherTargetThreadId = "00000000-0000-4000-8000-000000000021";
  function verifyOverlappingHoldReleaseOrder(releaseOrder) {
    voiceHeldContexts.clear();
    voiceTranscriptionByContext.clear();
    voiceStateByContext.clear();
    voiceStateResetAtMs.clear();
    voiceTargetThreadByContext.clear();
    voiceSessionIdByContext.clear();
    const overlapCommands = [];
    let resumeCount = 0;
    const bridge = (command, commandContext) => {
      overlapCommands.push(`${command}:${commandContext ?? "none"}`);
      return true;
    };
    const baseOptions = {
      autoSubmit: true,
      composerAlreadyFocused: true,
      bridge,
      stateReader: () => baseline,
      pauseMedia: () => {},
      resumeMedia: () => { resumeCount += 1; }
    };
    const firstStarted = beginVoiceHoldSync(context, {
      ...baseOptions,
      targetThreadId
    });
    const secondStarted = beginVoiceHoldSync(otherContext, {
      ...baseOptions,
      targetThreadId: otherTargetThreadId
    });
    for (const releasedContext of releaseOrder) {
      endVoiceHoldSync(releasedContext, true, baseOptions);
    }
    const ownerTracker = voiceTranscriptionByContext.get(otherContext);
    const passed = firstStarted
      && secondStarted
      && overlapCommands.join(",") === [
        `voice-down:${context}`,
        `voice-up:${context}`,
        `voice-down:${otherContext}`,
        `voice-up:${otherContext}`
      ].join(",")
      && voiceHeldContexts.size === 0
      && voiceTranscriptionByContext.size === 1
      && !voiceTranscriptionByContext.has(context)
      && ownerTracker?.targetThreadId === otherTargetThreadId
      && Number.isFinite(ownerTracker?.releasedAtMs)
      && voiceSessionIdByContext.size === 1
      && voiceSessionIdByContext.get(otherContext) === ownerTracker?.sessionId
      && resumeCount === 1;
    for (const heldContext of voiceStartVerificationTimers.keys()) {
      clearVoiceStartVerification(heldContext);
    }
    return passed;
  }
  const overlappingOldThenNewRelease = verifyOverlappingHoldReleaseOrder([
    context,
    otherContext
  ]);
  const overlappingNewThenOldRelease = verifyOverlappingHoldReleaseOrder([
    otherContext,
    context
  ]);

  const passed = Boolean(baseline && transcript && buttonFocusFallback)
    && ignoredFocusTypeChange
    && detectedStableTranscript
    && rejectedUnchangedDraft
    && acceptedStableReset
    && retriedUnconfirmedSubmit
    && successRequiresConfirmation
    && staleSubmissionIgnored
    && crossContextSubmissionIgnored
    && overlappingOldThenNewRelease
    && overlappingNewThenOldRelease;
  console.log(JSON.stringify({
    passed,
    ignoredFocusTypeChange,
    detectedStableTranscript,
    rejectedUnchangedDraft,
    acceptedStableReset,
    retriedUnconfirmedSubmit,
    successRequiresConfirmation,
    staleSubmissionIgnored,
    crossContextSubmissionIgnored,
    overlappingOldThenNewRelease,
    overlappingNewThenOldRelease
  }));
  if (!passed) process.exitCode = 1;
  voiceHeldContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  socket = null;
}

function installShutdownHandlers() {
  process.once("SIGTERM", () => {
    releaseVoiceKeysSync();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    releaseVoiceKeysSync();
    process.exit(0);
  });
  process.on("exit", releaseVoiceKeysSync);
}

function runSelectedMode() {
  if (completionContractMode) {
    verifyCompletionFanout();
  } else if (refreshResilienceContractMode) {
    verifyThreadRefreshResilience().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
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
  } else if (demoOutput || demoLightOutput || demoAnimationDirectory || gestureAnimationDirectory) {
    if (gestureAnimationDirectory) renderGestureAnimations(gestureAnimationDirectory, "dark");
    else if (demoAnimationDirectory) renderDemoAnimation(demoAnimationDirectory, "dark");
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
}

function main() {
  installShutdownHandlers();
  runSelectedMode();
}

if (require.main === module) main();

module.exports = { main };
