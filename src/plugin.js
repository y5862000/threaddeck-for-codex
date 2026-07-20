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
  applyGoalTerminalCutoff,
  freezeGoal,
  goalElapsedMs,
  goalIdentity,
  goalIsUnfinished,
  normalizeGoalRecord,
  normalizeGoalStatus,
  parseCodexGoalState,
  unfreezeGoal
} = require("./goal-state");
const {
  applyRemoteActivityLogLine: applyRemoteActivityLogLineToStore,
  applyRemoteLifecycleLogLine: applyRemoteLifecycleLogLineToStore,
  composerStateForRemoteThread,
  deriveRemoteStatus,
  normalizedReasoningEffort,
  normalizedServiceTier,
  observeRemoteRuntimeEnd: observeRemoteRuntimeEndInStore,
  parseCodexComposerState,
  recordRemoteComposerStateObservation,
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
const { ensureKeyBridgeExecutable } = require("./keybridge-permissions");
const {
  ACTIONS,
  APP_SERVER_SESSION_CACHE_MS,
  APP_SERVER_START_TOLERANCE_MS,
  COMPLETION_OBSERVATION_OVERLAP_MS,
  COMPLETION_STARTUP_GRACE_MS,
  CURRENT_THREAD_SLOT,
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
  THREAD_COMPLETION_PULSE_DURATION_MS,
  THREAD_COUNT,
  THREAD_REFRESH_ERROR_STATE,
  THREAD_REFRESH_RETRY_DELAYS_MS,
  THREAD_REFRESH_STARTUP_ERROR_FAILURES,
  THREAD_SLOT_BY_ACTION,
  THREAD_VOICE_FOCUS_PREP_LEAD_MS,
  THREAD_VOICE_FOCUS_SETTLE_MS,
  THREAD_VOICE_LONG_PRESS_MS,
  UNREAD_COMPLETION_FRAME_INTERVAL_MS,
  UNREAD_COMPLETION_GROUP_COUNT,
  UNREAD_COMPLETION_PULSE_PERIOD_MS,
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
const VOICE_RELEASE_RETRY_DELAYS_MS = [180, 650];
const VOICE_START_UNKNOWN_RETRY_DELAYS_MS = [120, 300, 600];
const VOICE_MEDIA_RESUME_DEBOUNCE_MS = 120;
const VOICE_MEDIA_REASSERT_DELAY_MS = 120;
const VOICE_MEDIA_REASSERT_ATTEMPTS = 3;
const SQLITE = "/usr/bin/sqlite3";
const USER_HOME = os.homedir();
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(USER_HOME, ".codex"));
const STATE_DB = path.resolve(process.env.THREADDECK_STATE_DB || path.join(CODEX_HOME, "state_5.sqlite"));
const GOALS_DB = path.resolve(process.env.THREADDECK_GOALS_DB || path.join(CODEX_HOME, "goals_1.sqlite"));
const REMOTE_GOAL_CACHE_PATH = path.resolve(
  process.env.THREADDECK_REMOTE_GOAL_CACHE
    || path.join(USER_HOME, "Library", "Application Support", "ThreadDeck", "remote-goals-v1.json")
);
const UNREAD_COMPLETION_CACHE_PATH = path.resolve(
  process.env.THREADDECK_UNREAD_COMPLETION_CACHE
    || path.join(USER_HOME, "Library", "Application Support", "ThreadDeck", "unread-completions-v1.json")
);
const GLOBAL_STATE = path.resolve(process.env.THREADDECK_GLOBAL_STATE || path.join(CODEX_HOME, ".codex-global-state.json"));
const SESSION_INDEX = path.resolve(process.env.THREADDECK_SESSION_INDEX || path.join(CODEX_HOME, "session_index.jsonl"));
const PROCESS_REGISTRY = path.resolve(
  process.env.THREADDECK_PROCESS_REGISTRY || path.join(CODEX_HOME, "process_manager", "chat_processes.json")
);
const CODEX_DESKTOP_LOG_ROOT = path.resolve(
  process.env.THREADDECK_CODEX_LOG_ROOT || path.join(USER_HOME, "Library", "Logs", "com.openai.codex")
);
const KEY_BRIDGE = path.join(__dirname, "keybridge");
const RUNTIME_TRACE_PATH = path.resolve(
  process.env.THREADDECK_TRACE_PATH
    || path.join(USER_HOME, "Library", "Logs", "ThreadDeck", "runtime.jsonl")
);
const RUNTIME_TRACE_MAX_BYTES = 256 * 1024;
const RUNTIME_TRACE_FIELDS = new Set([
  "slot",
  "remote",
  "strategy",
  "phase",
  "result",
  "reason",
  "elapsedMs",
  "coalesced",
  "mediaPaused",
  "baselineReady",
  "held"
]);

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

const REMOTE_APP_ACTIVATION_RETRY_MS = 180;
const REMOTE_DIRECT_READY_POLL_DELAYS_MS = [0, 70, 120, 200, 320];
const REMOTE_READY_POLL_DELAYS_MS = [0, 90, 160, 260, 420, 680];
const REMOTE_LIFECYCLE_LOG_SEARCH_LIMIT_BYTES = 32 * 1024 * 1024;
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
const interactionContractMode = process.argv.includes("--verify-interactions");
const keyBridgePermissionContractMode = process.argv.includes("--verify-keybridge-permission");
const demoOutput = argument("--render-demo");
const demoLightOutput = argument("--render-demo-light");
const completedKeyOutput = argument("--render-completed-key");
const demoAnimationDirectory = argument("--render-demo-animation");
const gestureAnimationDirectory = argument("--render-gesture-animations");
const GOAL_PROBE_CACHE_MS = 2_000;
const GOAL_NONE_CONFIRMATIONS = 2;
const REMOTE_GOAL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const pluginStartedAtMs = Date.now();
const runtimeTraceEnabled = !snapshotMode
  && !completionContractMode
  && !refreshResilienceContractMode
  && !usageCacheContractMode
  && !voiceSubmitContractMode
  && !interactionContractMode
  && !keyBridgePermissionContractMode
  && !demoOutput
  && !demoLightOutput
  && !completedKeyOutput
  && !demoAnimationDirectory
  && !gestureAnimationDirectory;

const contexts = new Map();
const contextImages = new Map();
const contextSentImages = new Map();
const contextFeedback = new Map();
const statusCache = new Map();
const completionPulseStartedAt = new Map();
const unreadCompletionByThreadId = new Map();
const observedCompletionEndMs = new Map();
const completionQueueBarrierMsByThreadId = new Map();
const pendingCompletionByThreadId = new Map();
const voiceHeldContexts = new Set();
const voiceReleasePendingContexts = new Set();
const voiceMediaPauseOwners = new Set();
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
// Ranked slots always preserve the user-visible Top Task 1-8 ordering. The
// independently selectable Current Task action resolves through
// `primaryThreadRow`, so switching tasks never silently renumbers the list.
let threadSlots = Array(THREAD_COUNT).fill(null);
let primaryThreadId = null;
let primaryThreadRow = null;
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
let unreadCompletionRenderGroup = 0;
let lastUnreadCompletionFrameAtMs = 0;
let mostRecentThreadId = null;
let lastOpenedThreadId = null;
let lastOpenedThreadAtMs = null;
let knownSideChatIds = new Set();
let pendingSideChatTarget = null;
let nextVoiceSessionId = 0;
let voiceMediaPaused = false;
let voiceMediaTransitionTail = Promise.resolve();
let voiceMediaOwnerGeneration = 0;
let voiceMediaResumeReassertPending = false;
let voiceReleaseRetryGeneration = 0;
let voiceReleaseRetryState = null;
let voiceReleaseProbeOnly = false;
let voiceReleaseAttemptInFlight = null;
let shutdownCleanupStarted = false;
let shutdownCleanupResult = true;
let activeRemoteNavigation = null;
let activeDeepLinkNavigation = null;
let activeComposerCreation = null;
let activeFastModeRefresh = null;
let activeFastModeUpdate = null;
let fastModeRevision = 0;

function currentThreadForDisplay(rankedThreads = threadSlots, currentRow = primaryThreadRow) {
  if (primaryThreadId) {
    const fresh = rankedThreads.find((thread) => thread?.id === primaryThreadId);
    if (fresh) return fresh;
    if (currentRow?.id === primaryThreadId) return currentRow;
  }
  return currentRow?.id ? currentRow : rankedThreads.find(Boolean) ?? null;
}

function threadForSlot(slot) {
  return slot === CURRENT_THREAD_SLOT
    ? currentThreadForDisplay()
    : threadSlots[slot] ?? null;
}

function threadForAction(action) {
  const slot = THREAD_SLOT_BY_ACTION.get(action);
  return slot === undefined ? null : threadForSlot(slot);
}

function combinedVisibleThreads(currentThread = currentThreadForDisplay(), rankedThreads = threadSlots) {
  const seen = new Set();
  const rows = [];
  for (const thread of [currentThread, ...rankedThreads]) {
    if (!thread?.id || seen.has(thread.id)) continue;
    seen.add(thread.id);
    rows.push(thread);
  }
  return rows;
}
let fastModeState = {
  threadId: null,
  enabled: null,
  available: null,
  failed: false
};
let appServerSessionCache = { checkedAtMs: 0, startedAtMs: null };
let desktopLogPathCache = { checkedAtMs: 0, path: null, paths: [] };
let accessibilityTrustCache = { checkedAtMs: 0, trusted: null };
let runtimeTraceTail = Promise.resolve();
let pinnedIdsCache = [];
let remoteThreadRowsCache = [];
let sideChatRowsCache = [];

function runtimeTrace(event, fields = {}) {
  if (!runtimeTraceEnabled) return;
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!RUNTIME_TRACE_FIELDS.has(key)) continue;
    if (typeof value === "boolean" || Number.isFinite(value)) safeFields[key] = value;
    else if (typeof value === "string" && value.length <= 48) safeFields[key] = value;
  }
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    event: String(event).slice(0, 64),
    ...safeFields
  })}\n`;
  runtimeTraceTail = runtimeTraceTail.then(async () => {
    await fs.mkdir(path.dirname(RUNTIME_TRACE_PATH), { recursive: true });
    try {
      const stat = await fs.stat(RUNTIME_TRACE_PATH);
      if (stat.size >= RUNTIME_TRACE_MAX_BYTES) await fs.truncate(RUNTIME_TRACE_PATH, 0);
    } catch {
      // The first trace event creates the file below.
    }
    await fs.appendFile(RUNTIME_TRACE_PATH, line, "utf8");
  }).catch(() => {
    // Diagnostics must never interfere with Stream Deck input handling.
  });
}
let sideChatSessionStartMs = null;
const sideChatParentById = new Map();
const sideChatLifecycleCache = new Map();
const closedSideChatAtMs = new Map();
const sideChatCloseLogOffsets = new Map();
const remoteLifecycleCache = new Map();
const remoteLifecycleLogCursors = new Map();
const remoteComposerStateByThreadId = new Map();
const remoteRuntimeObservationByThreadId = new Map();
const remoteActivityByThreadId = new Map();
const queueStateByThreadId = new Map();
let goalRowsCache = new Map();
const observedGoalByThreadId = new Map();
const displayedGoalByThreadId = new Map();
const goalTerminalCutoffByThreadId = new Map();
const confirmedGoalAbsentByThreadId = new Map();
let remoteGoalCacheLoaded = false;
let remoteGoalCacheLoadPromise = null;
let remoteGoalCacheWriteTail = Promise.resolve();
let unreadCompletionCacheLoaded = false;
let unreadCompletionCacheLoadPromise = null;
let unreadCompletionCacheWriteTail = Promise.resolve();
let remoteComposerProbe = { threadId: null, turnKey: null };
let goalProbe = { threadId: null, checkedAtMs: 0, absentCount: 0 };

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
  const restModeIcon = fast ? `<path data-mode="fast" d="${modeIconPath}" fill="${THEME.text}" fill-opacity=".88"/>` : "";
  const filledModeIcon = fast ? `<path data-mode="fast" d="${modeIconPath}" fill="#FFFFFF" fill-opacity=".92"/>` : "";
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

function unreadCompletionPulseState(threadId, nowMs = renderTimeMs()) {
  const unread = unreadCompletionByThreadId.get(threadId);
  if (!unread) return null;
  const persistentStartedAtMs = unread.markedAtMs + THREAD_COMPLETION_PULSE_DURATION_MS;
  const elapsedMs = Math.max(0, nowMs - persistentStartedAtMs);
  const phase = (elapsedMs % UNREAD_COMPLETION_PULSE_PERIOD_MS)
    / UNREAD_COMPLETION_PULSE_PERIOD_MS;
  const breath = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  // Keep a visible green floor between breaths. The initial completion fan-out
  // is deliberately stronger; this slower task-only pulse means "not viewed".
  const strength = 0.3 + 0.5 * breath;
  return {
    elapsedMs,
    progress: phase,
    strength,
    persistent: true,
    unread: true
  };
}

function visibleCompletionPulseState(thread, nowMs = renderTimeMs()) {
  if (!thread?.id || thread.status !== "completed") return null;
  return completionPulseState(thread.id, nowMs)
    ?? unreadCompletionPulseState(thread.id, nowMs);
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
  return threadForAction(contexts.get(context))?.id ?? null;
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
  const fast = isFastServiceTier(serviceTier);
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
  const activityLabel = detailedActivityLabel(info);
  const label = compactLine(status === "working" ? activityLabel : statusLabel, fast ? 5.7 : 6.8);
  if (status === "working") {
    return flowingReasoningSlider(accent, { text: label, effort: reasoningEffort }, fast);
  }
  const textX = fast ? 34 : 72;
  const anchor = fast ? "start" : "middle";
  const fontSize = label.length >= 9 ? 14.8 : 16;
  const modeIcon = fast
    ? `<path data-mode="fast" d="M23 12L16 23H22L20 32L30 19H24L27 12Z" fill="${accent}" opacity="${opacity}"/>`
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
    : state === "preparing"
      ? THEME.blue
      : state === "transcribing"
        ? THEME.textSecondary
        : state === "submitting"
          ? THEME.textSecondary
          : state === "error"
            ? THEME.amber
            : THEME.green;
  const neutralState = state === "preparing" || state === "transcribing" || state === "submitting";
  const border = state === "preparing"
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.blue}" fill-opacity=".05" stroke="${THEME.blue}" stroke-opacity=".62" stroke-width="2.4"/>`
    : state === "transcribing"
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity="${transcribingFillOpacity}" stroke="${THEME.textSecondary}" stroke-opacity="${transcribingStrokeOpacity}" stroke-width="2.2"/>`
    : state === "submitting"
      ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.text}" fill-opacity=".035" stroke="${THEME.textSecondary}" stroke-opacity=".52" stroke-width="2.4"/>`
    : `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${accent}" fill-opacity=".11" stroke="${accent}" stroke-opacity=".95" stroke-width="4.2"/>`;
  const badgeGlyph = state === "complete" || state === "sent"
    ? `<path d="M113 22L118 27L127 16" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : state === "error"
      ? `<path d="M120 15V24" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/><circle cx="120" cy="29" r="1.8" fill="#FFFFFF"/>`
      : state === "preparing"
        ? `<circle cx="114" cy="23" r="1.65" fill="${THEME.text}" fill-opacity=".42"/>
           <circle cx="120" cy="23" r="1.65" fill="${THEME.text}" fill-opacity=".7"/>
           <circle cx="126" cy="23" r="1.65" fill="${THEME.text}"/>`
        : state === "transcribing"
        ? `<circle cx="114" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(0)}"/>
           <circle cx="120" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(-2.1)}"/>
           <circle cx="126" cy="23" r="1.65" fill="${THEME.text}" fill-opacity="${dotOpacity(-4.2)}"/>`
      : state === "submitting"
        ? `<path d="M120 29V16M115 21L120 16L125 21" fill="none" stroke="${THEME.text}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="117" y="14" width="6" height="11" rx="3" fill="#FFFFFF"/><path d="M113.5 22V23C113.5 26.6 116.4 29.5 120 29.5C123.6 29.5 126.5 26.6 126.5 23V22M120 29.5V33" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>`;
  const bannerLabel = state === "recording"
    ? "말하는 중"
    : state === "preparing"
      ? "전환 준비"
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

function releaseThreadMediaPause(state, context) {
  if (!state?.mediaPauseStarted || state.mediaPauseReleased) return;
  // A failed native voice-up deliberately keeps this context's media lease.
  // Some Stream Deck lifecycle paths tear down the press state immediately
  // after ending voice; never let that secondary cleanup bypass the confirmed
  // release gate and resume playback into a microphone that may still be live.
  if (voiceReleasePendingContexts.has(context)) return;
  state.mediaPauseReleased = true;
  void state.resumeMedia(context);
}

function cancelThreadPress(context, releaseVoice = true) {
  const state = threadPressByContext.get(context);
  if (!state) return;
  state.held = false;
  if (state.timer) clearTimeout(state.timer);
  if (threadPressByContext.get(context) === state) threadPressByContext.delete(context);
  if (releaseVoice && state.voiceStarted) state.endVoice(context, false);
  else releaseThreadMediaPause(state, context);
  if (voiceStateByContext.get(context) === "preparing") setVoiceVisualState(context, "idle");
}

function beginThreadPress(context, slot, options = {}) {
  if (threadPressByContext.has(context)) return;
  const thread = options.thread ?? threadForSlot(slot);
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
    mediaPauseStarted: false,
    mediaPauseReleased: false,
    mediaPausePromise: null,
    timer: null,
    openPromise: null,
    focusPromise: null,
    pauseMedia: options.pauseMedia ?? pauseMediaForVoice,
    resumeMedia: options.resumeMedia ?? resumeMediaAfterVoice,
    beginVoice: options.beginVoice ?? beginVoiceHoldSync,
    endVoice: options.endVoice ?? endVoiceHoldSync,
    focusComposer: options.focusComposer
      ?? (() => runKeyBridgeAwaited("codex-focus-composer", null, { quiet: true })),
    sleep: options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    schedule: options.schedule ?? setTimeout
  };
  threadPressByContext.set(context, state);
  const open = options.openThread ?? openThread;
  state.openPromise = Promise.resolve(open(context, slot, { thread }));
  state.focusPromise = state.openPromise.then(async (opened) => {
    if (!opened || threadPressByContext.get(context) !== state || !state.held) return false;
    // Prepare focus close to the hold threshold instead of blocking the key-up
    // event after it. This keeps short presses cancellable while removing the
    // full composer-discovery cost from the start of a genuine voice hold.
    const earliestFocusAtMs = state.startedAtMs
      + THREAD_VOICE_LONG_PRESS_MS
      - THREAD_VOICE_FOCUS_PREP_LEAD_MS;
    const initialDelayMs = Math.max(
      THREAD_VOICE_FOCUS_SETTLE_MS,
      earliestFocusAtMs - Date.now()
    );
    const retryDelaysMs = [initialDelayMs, 90, 160, 280];
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) await state.sleep(delayMs);
      if (threadPressByContext.get(context) !== state || !state.held) return false;
      if (await state.focusComposer()) return true;
    }
    return false;
  });
  state.timer = state.schedule(async () => {
    if (threadPressByContext.get(context) !== state || !state.held) return;
    state.armed = true;
    state.mediaPauseStarted = true;
    state.mediaPausePromise = state.pauseMedia(context);
    voiceTargetThreadByContext.set(context, state.threadId);
    setVoiceVisualState(context, "preparing");
    runtimeTrace("thread-hold", {
      slot: slot + 1,
      remote: Boolean(thread.remote),
      phase: "armed",
      held: true
    });
    const opened = await state.openPromise;
    if (threadPressByContext.get(context) !== state || !state.held || !opened) {
      if (threadPressByContext.get(context) === state) threadPressByContext.delete(context);
      releaseThreadMediaPause(state, context);
      if (voiceStateByContext.get(context) === "preparing") setVoiceVisualState(context, "idle");
      return;
    }
    const composerFocused = await state.focusPromise;
    if (threadPressByContext.get(context) !== state || !state.held) {
      if (threadPressByContext.get(context) === state) threadPressByContext.delete(context);
      releaseThreadMediaPause(state, context);
      if (voiceStateByContext.get(context) === "preparing") setVoiceVisualState(context, "idle");
      return;
    }
    clearFeedback(context);
    state.voiceStarted = state.beginVoice(context, {
      targetThreadId: state.threadId,
      autoSubmit: true,
      requireBaseline: true,
      composerAlreadyFocused: composerFocused,
      pauseMedia: () => state.mediaPausePromise
    });
    if (!state.voiceStarted && threadPressByContext.get(context) === state) {
      threadPressByContext.delete(context);
      releaseThreadMediaPause(state, context);
    }
  }, THREAD_VOICE_LONG_PRESS_MS);
}

function endThreadPress(context) {
  const state = threadPressByContext.get(context);
  if (!state) return;
  state.held = false;
  if (state.timer) clearTimeout(state.timer);
  threadPressByContext.delete(context);
  if (state.voiceStarted) state.endVoice(context, true);
  else releaseThreadMediaPause(state, context);
  if (!state.voiceStarted && voiceStateByContext.get(context) === "preparing") {
    setVoiceVisualState(context, "idle");
  }
  runtimeTrace("thread-hold", {
    slot: state.slot + 1,
    phase: "release",
    result: state.voiceStarted ? "recording" : state.armed ? "cancelled-before-start" : "tap",
    held: false
  });
}

function appSwitchSvg() {
  return shell(THEME.text, `
    <path d="M34 72H101M78 49L101 72L78 95M111 48V96" fill="none" stroke="${THEME.text}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
}

function fastModeSvg(state = fastModeState, activeThreadId = primaryThreadId) {
  const confirmed = Boolean(activeThreadId)
    && state?.threadId === activeThreadId
    && typeof state?.enabled === "boolean";
  const enabled = confirmed && state.enabled;
  const unavailable = state?.available === false;
  const failed = Boolean(state?.failed);
  const status = enabled
    ? "on"
    : confirmed
      ? "off"
      : unavailable
        ? "unavailable"
        : failed
          ? "error"
          : "unknown";
  const warningLabel = unavailable
    ? "사용 불가"
    : failed
      ? "상태 오류"
      : confirmed
        ? ""
        : "확인 필요";
  const warning = Boolean(warningLabel);
  const accent = enabled ? THEME.green : warning ? THEME.amber : THEME.muted;
  // Keep one sharp apex instead of closing the path across a horizontal top
  // edge. The old silhouette looked cropped even though it was inside the
  // viewBox. Normal states use the full key; warnings reserve the bottom row
  // for actionable text.
  const boltPath = warning
    ? "M80 20L50 70H68L60 108L98 58H78Z"
    : "M83 15L42 80H66L56 130L105 59H80Z";
  const bolt = enabled
    ? `<path data-mode="fast" d="${boltPath}" fill="${accent}"/>`
    : `<path data-mode="fast" d="${boltPath}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  const warningText = warning
    ? `<rect x="25" y="113" width="94" height="22" rx="11" fill="${THEME.raised}"/>
    <text x="72" y="129" fill="${accent}" font-family="${FONT_STACK}" font-size="14.5" font-weight="700" text-anchor="middle">${escapeXml(warningLabel)}</text>`
    : "";
  return shell(accent, `
    <g data-fast-state="${status}">${bolt}</g>
    ${warningText}`);
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
  if (action === ACTIONS.fastMode) return fastModeSvg();
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
  return threadForSlot(slot);
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

function primeAccessibilityTrust() {
  execFile(KEY_BRIDGE, ["accessibility-preflight"], { timeout: 800 }, (error) => {
    accessibilityTrustCache = {
      checkedAtMs: Date.now(),
      trusted: !error
    };
  });
}

function keyBridgeExitCode(error) {
  const value = Number(error?.exitCode ?? error?.code);
  return Number.isInteger(value) ? value : null;
}

function abortedOperationError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedOperationError();
}

function sleepWithSignal(delayMs, signal = null) {
  if (signal?.aborted) return Promise.reject(abortedOperationError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedOperationError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runKeyBridgeWithInput(command, args, input, options = {}) {
  const timeoutMs = Number.isFinite(options) ? options : options.timeoutMs ?? 6000;
  const signal = Number.isFinite(options) ? null : options.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortedOperationError());
  return new Promise((resolve, reject) => {
    const child = spawn(KEY_BRIDGE, [command, ...args], {
      stdio: ["pipe", "ignore", "ignore"]
    });
    let settled = false;
    let timer = null;
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(abortedOperationError());
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Key bridge ${command} timed out`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
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
  const visibleIds = new Set(combinedVisibleThreads().map((thread) => thread.id));
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

async function voiceTargetIsFocused(targetThreadId, options = {}) {
  const thread = combinedVisibleThreads().find((candidate) => candidate?.id === targetThreadId);
  if (!thread) return false;
  // Submission safety needs the same identity-aware focused-header probe used
  // after remote navigation. In particular, a title-only queue match cannot
  // distinguish two tasks with the same visible title; ambiguous rows must be
  // verified by their UUID before any dictated text is submitted.
  return threadIsFocused(thread, options);
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
  const targetFocused = options.targetFocused ?? voiceTargetIsFocused;
  const requireTargetFocus = async (phase) => {
    if (await targetFocused(targetThreadId)) return true;
    failVoiceTranscription(context);
    runtimeTrace("voice-submit", { phase, result: "not-focused" });
    return false;
  };
  try {
    await openApp();
    await sleep(140);
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;
    if (!await requireTargetFocus("target-check")) return;

    const clickedSubmit = bridge("codex-submit-composer", null, { quiet: true });
    let confirmed = clickedSubmit
      && await waitForDraftReset(context, targetThreadId, tracker, options);
    if (!confirmed && voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) {
      // The explicit button is preferred, but Codex can rebuild the composer
      // between transcription and submission. Refocus the draft and retry with
      // Return, then verify the draft actually cleared before showing success.
      // Recheck immediately before that fallback so a task switch during the
      // first confirmation wait can never submit into the new task.
      if (!await requireTargetFocus("fallback-target-check")) return;
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

function parseAudioInputState(output) {
  const state = String(output ?? "").trim().toLowerCase();
  return state === "active" || state === "inactive" || state === "unknown"
    ? state
    : "unknown";
}

function codexAudioInputStateSync() {
  let output = "";
  try {
    output = execFileSync(KEY_BRIDGE, ["audio-input-state"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    });
  } catch (error) {
    output = error?.stdout ?? "";
  }
  return parseAudioInputState(output);
}

function clearVoiceStartVerification(context) {
  const timer = voiceStartVerificationTimers.get(context);
  if (timer) clearTimeout(timer);
  voiceStartVerificationTimers.delete(context);
}

function normalizeVoiceReleaseOutcome(value) {
  if (value === true) return "inactive";
  if (value === false || value == null) return "unconfirmed-no-action";
  const match = String(value).match(
    /(?:outcome=)?(inactive|unconfirmed-no-action|unconfirmed-after-stop-action|unknown-possible-action|unknown)/i
  );
  return match ? match[1].toLowerCase() : "unknown";
}

function nativeVoiceReleaseOutcomeSync(context, options = {}) {
  if (options.probeOnly) {
    const stateReader = options.audioInputState ?? codexAudioInputStateSync;
    const state = parseAudioInputState(stateReader());
    return state === "inactive" ? "inactive" : state;
  }

  let output = "";
  let succeeded = false;
  try {
    output = execFileSync(KEY_BRIDGE, ["voice-up"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2500,
      maxBuffer: 1024
    });
    succeeded = true;
  } catch (error) {
    output = error?.stdout ?? "";
  }
  return classifyNativeVoiceReleaseOutput(output, succeeded);
}

function classifyNativeVoiceReleaseOutput(output, succeeded) {
  const rawOutput = String(output ?? "").trim();
  const outcome = normalizeVoiceReleaseOutcome(rawOutput);
  // Compatibility with a previously built helper that returned only an exit
  // status. A successful legacy voice-up is confirmed. Empty output on failure
  // stays unknown: the process may have timed out after pressing Stop but
  // before flushing its final outcome, so another full voice-up is unsafe.
  if (outcome === "unknown" && succeeded) return "inactive";
  if (outcome === "unknown" && !rawOutput) return "unknown-possible-action";
  if (outcome === "unknown" && !/(?:outcome=)?unknown/i.test(rawOutput)) {
    return "unknown-possible-action";
  }
  return outcome;
}

async function codexAudioInputStateAsync() {
  let output = "";
  try {
    const result = await execFileAsync(KEY_BRIDGE, ["audio-input-state"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024
    });
    output = result.stdout;
  } catch (error) {
    output = error?.stdout ?? "";
  }
  return parseAudioInputState(output);
}

async function nativeVoiceReleaseOutcomeAsync(options = {}) {
  if (options.probeOnly) {
    const stateReader = options.audioInputState ?? codexAudioInputStateAsync;
    const state = parseAudioInputState(await stateReader());
    return state === "inactive" ? "inactive" : state;
  }

  let output = "";
  let succeeded = false;
  try {
    const result = await execFileAsync(KEY_BRIDGE, ["voice-up"], {
      encoding: "utf8",
      timeout: 2500,
      maxBuffer: 1024
    });
    output = result.stdout;
    succeeded = true;
  } catch (error) {
    output = error?.stdout ?? "";
  }
  return classifyNativeVoiceReleaseOutput(output, succeeded);
}

function voiceReleaseOutcomeSync(context, options = {}) {
  if (typeof options.releaseVoice === "function") {
    try {
      return normalizeVoiceReleaseOutcome(options.releaseVoice(context, {
        probeOnly: voiceReleaseProbeOnly
      }));
    } catch {
      return "unknown-possible-action";
    }
  }
  if (options.bridge) {
    try {
      if (voiceReleaseProbeOnly) {
        const stateReader = options.audioInputState ?? codexAudioInputStateSync;
        const state = parseAudioInputState(stateReader());
        return state === "inactive" ? "inactive" : state;
      }
      return options.bridge("voice-up", context, { quiet: Boolean(options.quiet) })
        ? "inactive"
        : "unconfirmed-no-action";
    } catch {
      return "unknown-possible-action";
    }
  }
  return nativeVoiceReleaseOutcomeSync(context, {
    probeOnly: voiceReleaseProbeOnly,
    audioInputState: options.audioInputState
  });
}

async function voiceReleaseOutcomeAsync(context, options = {}) {
  if (typeof options.releaseVoice === "function") {
    try {
      return normalizeVoiceReleaseOutcome(await options.releaseVoice(context, {
        probeOnly: voiceReleaseProbeOnly
      }));
    } catch {
      return "unknown-possible-action";
    }
  }
  if (options.bridge) {
    try {
      if (voiceReleaseProbeOnly) {
        const stateReader = options.audioInputState ?? codexAudioInputStateAsync;
        const state = parseAudioInputState(await stateReader());
        return state === "inactive" ? "inactive" : state;
      }
      return await options.bridge("voice-up", context, { quiet: Boolean(options.quiet) })
        ? "inactive"
        : "unconfirmed-no-action";
    } catch {
      return "unknown-possible-action";
    }
  }
  return nativeVoiceReleaseOutcomeAsync({
    probeOnly: voiceReleaseProbeOnly,
    audioInputState: options.audioInputState
  });
}

function cancelVoiceReleaseRetry() {
  const state = voiceReleaseRetryState;
  voiceReleaseRetryState = null;
  voiceReleaseRetryGeneration += 1;
  if (state?.timer != null) {
    try {
      state.clearSchedule(state.timer);
    } catch {
      // A stale generation check still prevents the callback from acting.
    }
  }
}

function scheduleVoiceReleaseRetry(context, releaseContexts, options = {}) {
  const pendingContexts = [...new Set(releaseContexts)]
    .filter((pendingContext) => voiceReleasePendingContexts.has(pendingContext));
  if (pendingContexts.length === 0) return;
  cancelVoiceReleaseRetry();
  const generation = ++voiceReleaseRetryGeneration;
  const state = {
    generation,
    context,
    contexts: pendingContexts,
    attempt: 0,
    timer: null,
    delays: options.retryDelays ?? VOICE_RELEASE_RETRY_DELAYS_MS,
    schedule: options.retrySchedule ?? setTimeout,
    clearSchedule: options.retryClearSchedule ?? clearTimeout,
    bridge: options.bridge,
    releaseVoice: options.releaseVoice,
    audioInputState: options.audioInputState,
    resumeMedia: options.resumeMedia,
    onSuccess: options.onRetrySuccess
  };
  voiceReleaseRetryState = state;

  const scheduleNext = () => {
    if (voiceReleaseRetryState !== state || state.generation !== voiceReleaseRetryGeneration) return;
    if (state.attempt >= state.delays.length) {
      voiceReleaseRetryState = null;
      voiceReleaseRetryGeneration += 1;
      return;
    }
    const delayMs = state.delays[state.attempt];
    state.timer = state.schedule(async () => {
      if (voiceReleaseRetryState !== state || state.generation !== voiceReleaseRetryGeneration) return;
      state.timer = null;
      const stillPending = state.contexts.filter((pendingContext) => (
        voiceReleasePendingContexts.has(pendingContext)
      ));
      if (stillPending.length === 0) {
        cancelVoiceReleaseRetry();
        return;
      }
      const onSuccess = state.onSuccess;
      const released = await confirmVoiceReleaseAsync(state.context, stillPending, {
        bridge: state.bridge,
        releaseVoice: state.releaseVoice,
        audioInputState: state.audioInputState,
        resumeMedia: state.resumeMedia,
        scheduleRetry: false,
        quiet: true,
        isCurrent: () => voiceReleaseRetryState === state
          && state.generation === voiceReleaseRetryGeneration
      });
      if (released == null) return;
      if (released) {
        try {
          onSuccess?.();
        } catch {
          // The release is safe even if a now-removed Stream Deck context can
          // no longer update its transcription visual.
        }
        return;
      }
      if (voiceReleaseRetryState !== state
          || state.generation !== voiceReleaseRetryGeneration) return;
      state.attempt += 1;
      scheduleNext();
    }, Math.max(0, delayMs));
  };
  scheduleNext();
}

function applyVoiceReleaseOutcome(context, releaseContexts, outcome, options = {}) {
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  const affectedContexts = [...new Set(releaseContexts)].filter(Boolean);
  if (affectedContexts.length === 0 && !options.force) return true;

  const commandContext = context ?? affectedContexts.at(-1) ?? null;
  const released = outcome === "inactive";
  if (outcome === "unconfirmed-after-stop-action" || outcome === "unknown-possible-action") {
    voiceReleaseProbeOnly = true;
  }
  else if (released) voiceReleaseProbeOnly = false;
  runtimeTrace("voice-hold", {
    phase: "release",
    result: released ? "released" : "failed"
  });

  for (const affectedContext of affectedContexts) {
    clearVoiceStartVerification(affectedContext);
    voiceHeldContexts.delete(affectedContext);
    if (!released) voiceReleasePendingContexts.add(affectedContext);
    else voiceReleasePendingContexts.delete(affectedContext);
  }
  if (!released) {
    if (options.markFailure !== false) {
      for (const affectedContext of affectedContexts) {
        // Keep the error visible while release is unresolved. A timed reset
        // would hide an active pending-release gate and discard its task hint.
        setVoiceVisualState(affectedContext, "error");
      }
    }
    if (options.scheduleRetry !== false) {
      scheduleVoiceReleaseRetry(commandContext, affectedContexts, options);
    }
    return false;
  }

  if (voiceReleasePendingContexts.size === 0) cancelVoiceReleaseRetry();

  if (options.releaseMedia !== false) {
    for (const affectedContext of affectedContexts) {
      try {
        void resumeMedia(affectedContext);
      } catch {
        // The serialized media lease keeps its state when a resume operation
        // fails. Voice release itself is still confirmed and safe to continue.
      }
    }
  }
  return true;
}

function markVoiceReleasePendingWhileInFlight(releaseContexts, options = {}) {
  const affectedContexts = [...new Set(releaseContexts)].filter(Boolean);
  for (const affectedContext of affectedContexts) {
    clearVoiceStartVerification(affectedContext);
    voiceHeldContexts.delete(affectedContext);
    voiceReleasePendingContexts.add(affectedContext);
    if (options.markFailure !== false) setVoiceVisualState(affectedContext, "error");
  }
  return false;
}

function confirmVoiceReleaseSync(context, releaseContexts, options = {}) {
  const affectedContexts = [...new Set(releaseContexts)].filter(Boolean);
  if (affectedContexts.length === 0 && !options.force) return true;
  // A scheduled native helper may be polling CoreAudio or have already pressed
  // Stop. Never overlap it with another full release attempt from a key event.
  if (voiceReleaseAttemptInFlight) {
    return markVoiceReleasePendingWhileInFlight(affectedContexts, options);
  }
  const commandContext = context ?? affectedContexts.at(-1) ?? null;
  const outcome = voiceReleaseOutcomeSync(commandContext, options);
  return applyVoiceReleaseOutcome(commandContext, affectedContexts, outcome, options);
}

async function confirmVoiceReleaseAsync(context, releaseContexts, options = {}) {
  const affectedContexts = [...new Set(releaseContexts)].filter(Boolean);
  if (affectedContexts.length === 0 && !options.force) return true;
  if (voiceReleaseAttemptInFlight) return false;
  const commandContext = context ?? affectedContexts.at(-1) ?? null;
  const attempt = { generation: voiceReleaseRetryGeneration };
  voiceReleaseAttemptInFlight = attempt;
  let outcome;
  try {
    outcome = await voiceReleaseOutcomeAsync(commandContext, options);
  } finally {
    if (voiceReleaseAttemptInFlight === attempt) voiceReleaseAttemptInFlight = null;
  }
  if (typeof options.isCurrent === "function" && !options.isCurrent()) return null;
  return applyVoiceReleaseOutcome(commandContext, affectedContexts, outcome, options);
}

function verifyVoiceStarted(context, options = {}) {
  clearVoiceStartVerification(context);
  const audioInputState = options.audioInputState ?? codexAudioInputStateSync;
  const reportError = options.reportError ?? ((message) => console.error(message));
  if (!voiceHeldContexts.has(context)) return;
  const inputState = parseAudioInputState(audioInputState());
  if (inputState === "active") return;
  if (inputState === "unknown") {
    const unknownAttempt = options.unknownAttempt ?? 0;
    const unknownRetryDelays = options.unknownRetryDelays
      ?? VOICE_START_UNKNOWN_RETRY_DELAYS_MS;
    if (unknownAttempt < unknownRetryDelays.length) {
      const schedule = options.verificationSchedule ?? setTimeout;
      const timer = schedule(() => verifyVoiceStarted(context, {
        ...options,
        unknownAttempt: unknownAttempt + 1
      }), Math.max(0, unknownRetryDelays[unknownAttempt]));
      voiceStartVerificationTimers.set(context, timer);
      return;
    }
    // Unknown is not evidence that start failed. Keep the held recording and
    // media lease intact; the real key-up will run the confirmed release gate.
    reportError("Codex audio input state could not be verified; waiting for key release");
    return;
  }

  const failedContexts = [...voiceHeldContexts];
  const finalizeFailedStart = () => {
    for (const failedContext of failedContexts) {
      failVoiceTranscription(failedContext);
      voiceSessionIdByContext.delete(failedContext);
    }
  };
  const released = confirmVoiceReleaseSync(context, failedContexts, {
    bridge: options.bridge,
    releaseVoice: options.releaseVoice,
    audioInputState: options.audioInputState,
    resumeMedia: options.resumeMedia,
    retryDelays: options.retryDelays,
    retrySchedule: options.retrySchedule,
    retryClearSchedule: options.retryClearSchedule,
    onRetrySuccess: finalizeFailedStart
  });
  if (released) finalizeFailedStart();
  reportError(released
    ? "Codex audio input did not start after the push-to-talk shortcut"
    : inputState === "unknown"
      ? "Codex audio input state stayed unknown and its release could not be confirmed"
      : "Codex audio input start failed and its release could not be confirmed");
}

function addVoiceMediaPauseOwner(context) {
  if (!context || voiceMediaPauseOwners.has(context)) return false;
  voiceMediaPauseOwners.add(context);
  voiceMediaOwnerGeneration += 1;
  return true;
}

function removeVoiceMediaPauseOwner(context) {
  if (!context || !voiceMediaPauseOwners.delete(context)) return false;
  voiceMediaOwnerGeneration += 1;
  return true;
}

function clearVoiceMediaPauseOwners() {
  if (voiceMediaPauseOwners.size === 0) return false;
  voiceMediaPauseOwners.clear();
  voiceMediaOwnerGeneration += 1;
  voiceMediaResumeReassertPending = false;
  return true;
}

async function pauseMediaForVoice(context = null, options = {}) {
  addVoiceMediaPauseOwner(context);
  const bridge = options.bridge ?? runKeyBridgeAwaited;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const operation = voiceMediaTransitionTail.then(async () => {
    // A key can be released while this operation is waiting behind an earlier
    // transition. Do not pause media for a hold that no longer owns the lease.
    if (context && !voiceMediaPauseOwners.has(context)) return voiceMediaPaused;
    if (voiceMediaPaused) return true;
    try {
      const reassertingResumeRace = voiceMediaResumeReassertPending;
      const attempts = reassertingResumeRace ? VOICE_MEDIA_REASSERT_ATTEMPTS : 1;
      let paused = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (reassertingResumeRace) await sleep(VOICE_MEDIA_REASSERT_DELAY_MS);
        if (context && !voiceMediaPauseOwners.has(context)) return voiceMediaPaused;
        paused = Boolean(await bridge("media-pause-if-playing", null, { quiet: true }));
        if (paused) break;
      }
      if (paused) {
        voiceMediaPaused = true;
        voiceMediaResumeReassertPending = false;
      } else if (!reassertingResumeRace) {
        removeVoiceMediaPauseOwner(context);
      }
      runtimeTrace("voice-media", {
        phase: "pause",
        result: paused ? "paused" : reassertingResumeRace ? "unconfirmed" : "idle",
        mediaPaused: voiceMediaPaused
      });
      return paused;
    } catch {
      if (!voiceMediaResumeReassertPending) removeVoiceMediaPauseOwner(context);
      runtimeTrace("voice-media", { phase: "pause", result: "failed", mediaPaused: voiceMediaPaused });
      return false;
    }
  });
  voiceMediaTransitionTail = operation.catch(() => false);
  return operation;
}

async function resumeMediaAfterVoice(context = null, options = {}) {
  if (context) removeVoiceMediaPauseOwner(context);
  else clearVoiceMediaPauseOwners();
  const requestedGeneration = voiceMediaOwnerGeneration;
  const bridge = options.bridge ?? runKeyBridgeAwaited;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const debounceMs = options.debounceMs ?? VOICE_MEDIA_RESUME_DEBOUNCE_MS;
  const operation = voiceMediaTransitionTail.then(async () => {
    if (voiceMediaPauseOwners.size > 0
        || voiceMediaOwnerGeneration !== requestedGeneration
        || !voiceMediaPaused) return false;
    if (debounceMs > 0) await sleep(debounceMs);
    if (voiceMediaPauseOwners.size > 0
        || voiceMediaOwnerGeneration !== requestedGeneration
        || !voiceMediaPaused) {
      runtimeTrace("voice-media", {
        phase: "resume",
        result: "coalesced",
        mediaPaused: voiceMediaPaused
      });
      return false;
    }
    try {
      const resumed = Boolean(await bridge("media-play-pause", null, { quiet: true }));
      if (!resumed) {
        // Keep ownership of the paused state so a later release or shutdown can
        // retry instead of forgetting media that is still stopped.
        runtimeTrace("voice-media", { phase: "resume", result: "failed", mediaPaused: true });
        return false;
      }
      voiceMediaPaused = false;
      if (voiceMediaPauseOwners.size > 0
          || voiceMediaOwnerGeneration !== requestedGeneration) {
        // The new owner's queued pause uses the state-aware native command.
        // Never issue a blind second play/pause toggle here: that was the
        // audible play-then-pause blip this debounce is designed to avoid.
        voiceMediaResumeReassertPending = true;
        runtimeTrace("voice-media", {
          phase: "resume-race",
          result: "pause-queued",
          mediaPaused: false
        });
        return false;
      }
      runtimeTrace("voice-media", { phase: "resume", result: "resumed", mediaPaused: false });
      return true;
    } catch {
      runtimeTrace("voice-media", { phase: "resume", result: "failed", mediaPaused: true });
      return false;
    }
  });
  voiceMediaTransitionTail = operation.catch(() => false);
  return operation;
}

function supersedeHeldVoiceSync(context, options = {}) {
  const previousContexts = [...new Set([
    ...voiceHeldContexts,
    ...voiceReleasePendingContexts
  ])];
  if (previousContexts.length === 0) return true;

  // The Codex push-to-talk shortcut and composer are global. A second key
  // cannot safely share the physical hold with the first key because either
  // release order could then attribute the transcript to the wrong task. Do
  // not emit the next voice-down until native code has proved audio inactive.
  const finalizeSupersededRelease = () => {
    for (const previousContext of previousContexts) {
      cancelVoiceTranscription(previousContext, true);
      voiceSessionIdByContext.delete(previousContext);
    }
  };
  return confirmVoiceReleaseSync(previousContexts.at(-1), previousContexts, {
    bridge: options.bridge,
    releaseVoice: options.releaseVoice,
    audioInputState: options.audioInputState,
    resumeMedia: options.resumeMedia,
    retryDelays: options.retryDelays,
    retrySchedule: options.retrySchedule,
    retryClearSchedule: options.retryClearSchedule,
    onRetrySuccess: finalizeSupersededRelease
  });
}

function beginVoiceHoldSync(context, options = {}) {
  if (voiceHeldContexts.has(context)) return true;
  const bridge = options.bridge ?? runKeyBridgeSync;
  const stateReader = options.stateReader ?? textInputStateSync;
  const pauseMedia = options.pauseMedia ?? pauseMediaForVoice;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  if (!supersedeHeldVoiceSync(context, { ...options, resumeMedia })) {
    // The previous recording is still possibly active. Leave its media owner
    // intact and fail closed instead of layering another shortcut on top.
    setVoiceVisualState(
      context,
      "error",
      voiceReleasePendingContexts.has(context) ? null : VOICE_ERROR_DISPLAY_MS
    );
    return false;
  }
  void pauseMedia(context);
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
  const baselineRequired = options.requireBaseline ?? Boolean(options.autoSubmit);
  runtimeTrace("voice-hold", {
    phase: "baseline",
    baselineReady: Boolean(baseline),
    held: true
  });
  if (baselineRequired && !baseline) {
    void resumeMedia(context);
    failVoiceTranscription(context);
    runtimeTrace("voice-hold", { phase: "start", result: "no-composer" });
    return false;
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
    if (!bridge("voice-down", context)) {
      void resumeMedia(context);
      failVoiceTranscription(context);
      return false;
    }
  }
  voiceHeldContexts.add(context);
  runtimeTrace("voice-hold", { phase: "recording", result: "started" });
  setVoiceVisualState(context, "recording");
  clearVoiceStartVerification(context);
  voiceStartVerificationTimers.set(
    context,
    setTimeout(() => verifyVoiceStarted(context), VOICE_START_VERIFY_MS)
  );
  return true;
}

function finalizeVoiceRelease(context, releaseContexts, trackTranscription, stateReader) {
  // A delayed release probe can finish after Stream Deck has already removed
  // the key context. Never let the older track=true continuation recreate a
  // transcript/session for a disappeared key.
  const shouldTrackTranscription = trackTranscription && contextSupportsVoice(context);
  for (const releasedContext of releaseContexts) {
    if (releasedContext !== context || !shouldTrackTranscription) {
      cancelVoiceTranscription(releasedContext, true);
      voiceSessionIdByContext.delete(releasedContext);
    }
  }
  if (!shouldTrackTranscription) return true;
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
  return true;
}

function endVoiceHoldSync(context, trackTranscription = true, options = {}) {
  const bridge = options.bridge ?? runKeyBridgeSync;
  const stateReader = options.stateReader ?? textInputStateSync;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  clearVoiceStartVerification(context);
  if (!voiceHeldContexts.has(context) && !voiceReleasePendingContexts.has(context)) return true;
  const releaseContexts = [...new Set([
    ...voiceHeldContexts,
    ...voiceReleasePendingContexts
  ])];
  const finalizeRelease = () => finalizeVoiceRelease(
    context,
    releaseContexts,
    trackTranscription,
    stateReader
  );
  const released = confirmVoiceReleaseSync(context, releaseContexts, {
    bridge: options.bridge,
    releaseVoice: options.releaseVoice,
    audioInputState: options.audioInputState,
    resumeMedia,
    retryDelays: options.retryDelays,
    retrySchedule: options.retrySchedule,
    retryClearSchedule: options.retryClearSchedule,
    onRetrySuccess: finalizeRelease
  });
  if (!released) {
    // Keep the original baseline and media-pause lease so a later key-up, new
    // hold, or shutdown can retry the same confirmed release safely.
    return false;
  }
  return finalizeRelease();
}

function releaseVoiceKeysSync(rawOptions = {}) {
  if (shutdownCleanupStarted) return shutdownCleanupResult;
  shutdownCleanupStarted = true;
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const bridge = options.bridge ?? runKeyBridgeSync;
  cancelVoiceReleaseRetry();
  const releaseContexts = [...new Set([
    ...voiceHeldContexts,
    ...voiceReleasePendingContexts,
    ...voiceMediaPauseOwners
  ])];
  const needsVoiceRelease = releaseContexts.length > 0 || voiceMediaPaused;
  const released = !needsVoiceRelease || confirmVoiceReleaseSync(
    releaseContexts.at(-1) ?? null,
    releaseContexts,
    {
      bridge: options.bridge,
      releaseVoice: options.releaseVoice,
      audioInputState: options.audioInputState,
      force: true,
      quiet: true,
      markFailure: false,
      releaseMedia: false,
      scheduleRetry: false
    }
  );
  if (!released) {
    // voice-up already releases the physical keys first, but retain this
    // best-effort fallback for shutdowns where the helper itself was replaced
    // or could not finish. Never resume media without audio-stop confirmation.
    try {
      bridge("release", null, { quiet: true });
    } catch {
      // Process shutdown must continue; the fail-closed media state remains.
    }
  }
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
  if (released && voiceMediaPaused && bridge("media-play-pause", null, { quiet: true })) {
    voiceMediaPaused = false;
  }
  if (released && !voiceMediaPaused) clearVoiceMediaPauseOwners();
  voiceMediaTransitionTail = Promise.resolve();
  activeRemoteNavigation?.controller.abort();
  activeRemoteNavigation = null;
  activeDeepLinkNavigation?.controller.abort();
  activeDeepLinkNavigation = null;
  activeComposerCreation?.controller.abort();
  activeComposerCreation = null;
  activeFastModeRefresh = null;
  activeFastModeUpdate = null;
  shutdownCleanupResult = released && !voiceMediaPaused;
  return shutdownCleanupResult;
}

async function readCodexQueueWindows(options = {}) {
  try {
    const { stdout } = await execFileAsync(KEY_BRIDGE, ["codex-queue-state"], {
      timeout: 1800,
      maxBuffer: 64 * 1024,
      signal: options.signal
    });
    return parseCodexQueueWindows(stdout);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return [];
  }
}

function queueWindowThreadCandidates(window, threads) {
  return threads.filter((thread) => {
    for (const fingerprint of titleFingerprints(thread.title)) {
      if (window.headers.has(fingerprint)) return true;
    }
    return false;
  });
}

function matchQueueWindowThread(window, threads) {
  const candidates = queueWindowThreadCandidates(window, threads);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find((thread) => thread.id === lastOpenedThreadId)
      ?? [...candidates].sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a))[0];
  }
  return null;
}

function focusedQueueThread(windows, threads) {
  const focusedWindow = windows.find((window) => window.focused)
    ?? (windows.length === 1 ? windows[0] : null);
  return focusedWindow ? matchQueueWindowThread(focusedWindow, threads) : null;
}

async function verifiedCurrentCodexThread(windows, threads, options = {}) {
  const focusedWindow = windows.find((window) => window.focused)
    ?? (windows.length === 1 ? windows[0] : null);
  if (!focusedWindow) return null;
  const candidates = queueWindowThreadCandidates(focusedWindow, threads)
    .sort((left, right) => {
      if (left.id === primaryThreadId) return -1;
      if (right.id === primaryThreadId) return 1;
      return threadRecencyMs(right) - threadRecencyMs(left);
    });
  for (const candidate of candidates) {
    if (await threadIsCurrentInCodex(candidate, options)) return candidate;
  }
  return null;
}

function remoteThreadKeyBridgeCommand(thread, baseCommand) {
  return thread?.titleAmbiguous || thread?.requiresStrictIdentity
    ? `${baseCommand}-strict`
    : baseCommand;
}

async function threadIsFocused(thread, options = {}) {
  return probeCodexThreadIdentity(thread, "codex-focused-thread", options);
}

async function threadIsCurrentInCodex(thread, options = {}) {
  return probeCodexThreadIdentity(thread, "codex-current-thread", options);
}

async function probeCodexThreadIdentity(thread, baseCommand, options = {}) {
  const fingerprints = [...titleFingerprints(thread.title)];
  const command = remoteThreadKeyBridgeCommand(thread, baseCommand);
  const strictIdentity = Boolean(thread.titleAmbiguous || thread.requiresStrictIdentity);
  const args = strictIdentity ? [thread.id] : [thread.id, ...fingerprints];
  const probe = options.probe
    ?? ((probeCommand, probeArgs) => execFileAsync(KEY_BRIDGE, [probeCommand, ...probeArgs], {
      timeout: 1000,
      maxBuffer: 4096,
      signal: options.signal
    }));
  try {
    await probe(command, args);
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}

async function waitForThreadFocused(thread, options = {}) {
  const delays = options.delays ?? REMOTE_READY_POLL_DELAYS_MS;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleepWithSignal(delayMs, options.signal);
    if (await threadIsFocused(thread, {
      ...options,
      force: true,
      nowMs: Date.now()
    })) return true;
  }
  return false;
}

function parseFastModeState(output) {
  const text = String(output ?? "");
  const state = text.match(/(?:^|\s)state=(on|off|unknown)(?:\s|$)/i)?.[1]?.toLowerCase() ?? null;
  const availableMatch = text.match(/(?:^|\s)available=([01])(?:\s|$)/i)?.[1] ?? null;
  const serviceTierAvailableMatch = text.match(
    /(?:^|\s)service_tier_available=([01])(?:\s|$)/i
  )?.[1] ?? null;
  const composerState = parseCodexComposerState(text);
  const enabled = state === "on"
    ? true
    : state === "off"
      ? false
      : composerState.serviceTier === "priority"
        ? true
        : composerState.serviceTier === "default"
          ? false
          : null;
  // `available` on codex-composer-state means either reasoning or speed was
  // readable. Do not mistake a readable effort label for a readable Fast
  // state. The compact picker intentionally hides its bolt from Accessibility.
  const speedAvailable = typeof enabled === "boolean"
    ? serviceTierAvailableMatch === null
      ? availableMatch === null || availableMatch === "1"
      : serviceTierAvailableMatch === "1"
    : state === "unknown" && availableMatch !== null
      ? availableMatch === "1"
      : null;
  const composerEnvelope = /(?:^|\s)(?:reasoning|effort|service_tier|reasoning_available|service_tier_available)=/i
    .test(text);
  if (!state && !composerEnvelope) return null;
  return {
    enabled,
    available: speedAvailable,
    reasoningEffort: composerState.reasoningEffort
  };
}

function fastModeStateFromThread(thread, fallback = null) {
  const threadId = thread?.id ?? null;
  const fallbackMatches = Boolean(threadId)
    && fallback?.threadId === threadId
    && typeof fallback.enabled === "boolean";
  const fallbackReasoning = fallback?.threadId === threadId
    ? normalizedReasoningEffort(fallback?.reasoningEffort)
    : null;
  const serviceTier = normalizedServiceTier(thread?.serviceTier);
  const metadataEnabled = serviceTier ? isFastServiceTier(serviceTier) : null;
  const enabled = fallbackMatches ? fallback.enabled : metadataEnabled;
  return {
    threadId,
    enabled,
    available: typeof enabled === "boolean"
      ? fallbackMatches ? fallback.available ?? true : true
      : null,
    reasoningEffort: fallbackReasoning ?? normalizedReasoningEffort(thread?.reasoningEffort),
    failed: false
  };
}

function mergeFastModeObservation(thread, observed, previous = fastModeState) {
  const threadId = thread?.id ?? previous?.threadId ?? null;
  if (typeof observed?.enabled === "boolean") {
    return {
      threadId,
      ...observed,
      available: observed.available ?? true
    };
  }
  const fallback = fastModeStateFromThread(thread, previous);
  return {
    threadId,
    enabled: fallback.enabled,
    available: typeof fallback.enabled === "boolean"
      ? fallback.available
      : observed?.available ?? null,
    reasoningEffort: normalizedReasoningEffort(observed?.reasoningEffort)
      ?? fallback.reasoningEffort
  };
}

async function queryFastModeState(options = {}) {
  const probe = options.stateProbe
    ?? (() => execFileAsync(KEY_BRIDGE, ["codex-composer-state"], {
      timeout: 2200,
      maxBuffer: 4096
    }));
  let stdout = "";
  try {
    const result = await probe();
    stdout = result?.stdout ?? result ?? "";
  } catch (error) {
    const exitCode = keyBridgeExitCode(error);
    if (![1, 2].includes(exitCode)) throw error;
    stdout = error?.stdout ?? "";
  }
  const parsed = parseFastModeState(stdout);
  if (!parsed) throw new Error("Codex fast mode state was not recognized");
  return parsed;
}

function renderFastModeContexts() {
  for (const [context, action] of contexts) {
    if (action === ACTIONS.fastMode) setImage(context, fastModeSvg());
  }
}

function refreshFastMode(options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => refreshFastMode(options));
  }
  const threadId = options.threadId ?? primaryThreadId;
  if (!threadId) {
    fastModeRevision += 1;
    fastModeState = {
      threadId: null,
      enabled: null,
      available: null,
      failed: false
    };
    renderFastModeContexts();
    return Promise.resolve(false);
  }
  const revision = fastModeRevision;
  if (activeFastModeRefresh?.threadId === threadId
      && activeFastModeRefresh.revision === revision) {
    return activeFastModeRefresh.promise;
  }
  const refresh = { threadId, revision, promise: null };
  refresh.promise = (async () => {
    try {
      const pendingNavigation = currentNavigationPromise();
      if (pendingNavigation) await pendingNavigation;
      if (primaryThreadId !== threadId || fastModeRevision !== revision) return false;
      const thread = combinedVisibleThreads().find((candidate) => candidate.id === threadId)
        ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null);
      // The native speed control is scoped to the focused composer and carries
      // no task id of its own. Never bind another window's mode to the cached
      // Current Task. Contract tests inject a state probe and exercise
      // the cache logic independently of the native identity guard.
      if (!options.stateProbe) {
        if (!thread || !await threadIsFocused(thread)) {
          throw new Error("Codex current task was not focused");
        }
      }
      const observed = await queryFastModeState(options);
      if (primaryThreadId !== threadId || fastModeRevision !== revision) return false;
      const state = mergeFastModeObservation(thread, observed, fastModeState);
      if (options.preserveConfirmedOnUnavailable
          && (!state.available || typeof state.enabled !== "boolean")
          && fastModeState.threadId === threadId
          && typeof fastModeState.enabled === "boolean") return false;
      fastModeState = { threadId, ...state, failed: false };
      applyFocusedRemoteComposerState(thread, state);
      renderFastModeContexts();
      return typeof state.enabled === "boolean";
    } catch (error) {
      if (primaryThreadId !== threadId || fastModeRevision !== revision) return false;
      if (options.preserveConfirmedOnUnavailable
          && fastModeState.threadId === threadId
          && typeof fastModeState.enabled === "boolean") return false;
      fastModeState = {
        threadId,
        enabled: null,
        available: null,
        failed: true
      };
      renderFastModeContexts();
      if (!options.quiet) console.error(`Could not read Codex fast mode: ${error?.message ?? "unknown error"}`);
      return false;
    }
  })().finally(() => {
    if (activeFastModeRefresh === refresh) activeFastModeRefresh = null;
  });
  activeFastModeRefresh = refresh;
  return refresh.promise;
}

function currentNavigationPromise() {
  const pending = [
    activeRemoteNavigation?.promise,
    activeDeepLinkNavigation?.promise,
    activeComposerCreation?.promise
  ].filter(Boolean);
  if (pending.length === 0) return null;
  return Promise.allSettled(pending).then((results) => {
    if (results.some((result) => result.status === "fulfilled")) return true;
    throw results.at(-1)?.reason ?? new Error("task navigation did not complete");
  });
}

function afterFastModeUpdate(startNavigation) {
  const update = activeFastModeUpdate;
  if (!update) return startNavigation();
  // Fast mode is scoped to the focused composer, while the native AX action
  // deliberately accepts no task id. Keep task navigation behind the active
  // toggle so a later button press cannot move focus between its verification
  // and AXPress and accidentally change the next task instead.
  return update.catch(() => false).then(startNavigation);
}

function toggleFastMode(context, options = {}) {
  if (activeFastModeUpdate) return activeFastModeUpdate;
  fastModeRevision += 1;
  const feedback = options.feedback ?? showFeedback;
  const update = (async () => {
    feedback(context, "loading", "FAST 확인");
    const pendingRefresh = activeFastModeRefresh?.promise;
    if (pendingRefresh) {
      try {
        await pendingRefresh;
      } catch {
        // Its revision was invalidated above; the fresh probe below remains
        // authoritative even if the old read failed while being drained.
      }
    }
    const pendingNavigation = currentNavigationPromise();
    if (pendingNavigation) {
      try {
        await pendingNavigation;
      } catch {
        feedback(context, "error", "전환 확인", 1600);
        return false;
      }
    }
    const threadId = primaryThreadId;
    const thread = combinedVisibleThreads().find((candidate) => candidate?.id === threadId)
      ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null);
    if (!thread || !await threadIsFocused(thread, { probe: options.focusProbe })) {
      feedback(context, "error", "작업 확인", 1600);
      return false;
    }

    // Production uses one native transaction: it opens the composer menu
    // once, reads the live state, selects its exact inverse, and returns the
    // applied state. The injected stateProbe/setMode pair remains available
    // for deterministic legacy contract tests.
    const toggleMode = options.toggleMode
      ?? (!options.stateProbe && !options.setMode
        ? () => execFileAsync(KEY_BRIDGE, ["fast-mode-toggle"], {
          timeout: 5000,
          maxBuffer: 4096
        })
        : null);
    if (toggleMode) {
      try {
        const result = await toggleMode();
        const confirmed = parseFastModeState(result?.stdout ?? result ?? "");
        if (primaryThreadId !== threadId
            || !confirmed?.available
            || typeof confirmed.enabled !== "boolean") {
          throw new Error("Codex fast mode toggle result was not confirmed");
        }
        fastModeState = { threadId, ...confirmed, failed: false };
        applyFocusedRemoteComposerState(thread, confirmed);
        renderFastModeContexts();
        // The verified icon itself is the success acknowledgement. Keep text
        // overlays for actionable failures instead of restating on/off.
        clearFeedback(context);
        return true;
      } catch (error) {
        if (primaryThreadId === threadId) {
          fastModeState = {
            threadId,
            enabled: null,
            available: null,
            failed: true
          };
          renderFastModeContexts();
        }
        feedback(context, "error", "변경 실패", 1600);
        console.error(`Could not change Codex fast mode: ${error?.message ?? "unknown error"}`);
        return false;
      }
    }

    let current;
    try {
      // The composer may have been changed directly in Codex since the last
      // Stream Deck render. Re-read before every press so the physical key
      // always inverts the live state instead of acting on a stale cache.
      const state = await queryFastModeState(options);
      current = { threadId, ...state, failed: false };
      if (primaryThreadId === threadId) {
        fastModeState = current;
        renderFastModeContexts();
      }
    } catch (error) {
      feedback(context, "error", "상태 확인", 1600);
      console.error(`Could not prepare Codex fast mode: ${error?.message ?? "unknown error"}`);
      return false;
    }
    if (!current.available || typeof current.enabled !== "boolean") {
      feedback(context, "error", "사용 불가", 1600);
      return false;
    }

    const targetEnabled = !current.enabled;
    const setMode = options.setMode
      ?? ((enabled) => execFileAsync(KEY_BRIDGE, ["fast-mode-set", enabled ? "on" : "off"], {
        // The selector path may need to open a Chromium popover, find one
        // exact option, and poll the resulting composer state twice. Leave
        // enough room for the native fail-closed retries on a busy window.
        timeout: 8000,
        maxBuffer: 4096
      }));
    let setError = null;
    try {
      await setMode(targetEnabled);
    } catch (error) {
      // AXPress may already have applied immediately before a process timeout
      // or a late native verification failure. The authoritative state probe
      // below repairs that result instead of rendering a false failure.
      setError = error;
    }
    try {
      const confirmed = await queryFastModeState(options);
      if (primaryThreadId !== threadId
          || confirmed.enabled !== targetEnabled
          || !confirmed.available) {
        throw new Error("Codex fast mode target was not confirmed");
      }
      fastModeState = { threadId, ...confirmed, failed: false };
      applyFocusedRemoteComposerState(thread, confirmed);
      renderFastModeContexts();
      clearFeedback(context);
      return true;
    } catch (confirmationError) {
      const error = setError ?? confirmationError;
      if (primaryThreadId === threadId) {
        fastModeState = {
          threadId,
          enabled: null,
          available: null,
          failed: true
        };
        renderFastModeContexts();
      }
      feedback(context, "error", "변경 실패", 1600);
      console.error(`Could not change Codex fast mode: ${error?.message ?? "unknown error"}`);
      return false;
    }
  })().finally(() => {
    if (activeFastModeUpdate === update) activeFastModeUpdate = null;
  });
  activeFastModeUpdate = update;
  return update;
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

function goalBadgeSvg(thread) {
  if (!goalIsUnfinished(thread?.goal)) return "";
  const colors = {
    active: THEME.blue,
    paused: THEME.amber,
    blocked: THEME.red,
    usageLimited: THEME.amber,
    budgetLimited: THEME.amber
  };
  const color = colors[thread.goal.status] ?? THEME.textSecondary;
  return `
    <g data-goal="${escapeXml(thread.goal.status)}" transform="translate(14.6 109.2) scale(.69)" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 13V2l8 4-8 4"/>
      <path d="M20.561 10.222a9 9 0 1 1-12.55-5.29"/>
      <path d="M8.002 9.997a5 5 0 1 0 8.9 2.02"/>
    </g>`;
}

function threadTimingBarSvg(thread, completionEffect = null) {
  const queueCount = Math.max(0, Number.parseInt(thread?.queueCount, 10) || 0);
  const hasGoalBadge = goalIsUnfinished(thread?.goal);
  const elapsedLabel = timingLabel(thread);
  const timingX = hasGoalBadge
    ? queueCount > 0 ? 58 : 81
    : queueCount > 0 ? 53 : 72;
  const timingFontSize = hasGoalBadge && queueCount > 0
    ? elapsedLabel.length >= 7 ? 13.5 : 16.5
    : hasGoalBadge && elapsedLabel.length >= 8 ? 18 : 21;
  const completionStrength = completionEffect?.strength ?? 0;
  const completionChrome = completionEffect ? `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.green}" fill-opacity="${(0.32 * completionStrength).toFixed(3)}" stroke="${THEME.green}" stroke-opacity="${(0.78 * completionStrength).toFixed(3)}" stroke-width="${(1 + completionStrength * 1.2).toFixed(2)}"/>` : "";
  const completionText = completionEffect ? `
    <text x="${timingX}" y="125.5" fill="${THEME.text}" fill-opacity="${(0.82 * completionStrength).toFixed(3)}" font-family="${FONT_STACK}" font-size="${timingFontSize}" font-weight="650" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>` : "";
  return `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.raised}"/>
    ${completionChrome}
    ${goalBadgeSvg(thread)}
    <text x="${timingX}" y="125.5" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="${timingFontSize}" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>
    ${queueBadgeSvg(thread)}
    ${completionText}`;
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
    ${threadTimingBarSvg(thread, completionEffect)}`,
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
  const titleFontSize = 20.5;
  const titleX = thread.pinned ? 78 : 72;
  const [line1, line2] = wrapTitle(thread.title, thread.pinned ? 4.9 : 5.75);
  const hasSecondTitleLine = Boolean(line2);
  const titleLine1Y = hasSecondTitleLine ? 65 : 79;
  const pinYOffset = hasSecondTitleLine ? 0 : 13;
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
    ${threadTimingBarSvg(thread, completionEffect)}`,
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

function shouldProbeRemoteComposerState(cachedState, alreadyProbed = false) {
  if (alreadyProbed) return false;
  return !cachedState?.reasoningEffort || !cachedState?.serviceTier;
}

async function refreshVisibleRemoteComposerState(threads, queueWindows, nowMs = Date.now()) {
  const focusedWindow = queueWindows.find((window) => window.focused)
    ?? (queueWindows.length === 1 ? queueWindows[0] : null);
  const focusedThread = focusedWindow ? matchQueueWindowThread(focusedWindow, threads) : null;
  // Only bind a composer value when the focused window header identifies the
  // exact remote task. A recent click is not enough: navigation can fail while
  // leaving a local composer's controls on screen.
  const thread = focusedThread?.remote ? focusedThread : null;
  if (!thread?.id) return null;
  const lifecycle = remoteLifecycleCache.get(thread.id) ?? null;
  const turnKey = lifecycle?.latestTurnId
    ?? (Number.isFinite(lifecycle?.startedAtMs) ? String(lifecycle.startedAtMs) : null);
  if (!turnKey) return null;
  const cachedState = composerStateForRemoteThread(
    thread,
    lifecycle,
    remoteComposerStateByThreadId
  );
  const alreadyProbed = remoteComposerProbe.threadId === thread.id
    && remoteComposerProbe.turnKey === turnKey;
  if (!shouldProbeRemoteComposerState(cachedState, alreadyProbed)) return cachedState;
  // The compact picker exposes reasoning but hides its speed bolt from
  // Accessibility. This is a passive probe: it never opens the picker. Probe
  // only once per exact remote turn and preserve any exact cached speed until
  // an explicit Fast press or lifecycle metadata supplies a newer value.
  remoteComposerProbe = { threadId: thread.id, turnKey };
  try {
    const { stdout } = await execFileAsync(KEY_BRIDGE, ["codex-composer-state"], {
      timeout: 1800,
      maxBuffer: 4096
    });
    const state = parseCodexComposerState(stdout);
    if (!recordRemoteComposerStateObservation(
      thread,
      lifecycle,
      state,
      nowMs,
      remoteComposerStateByThreadId
    )) return null;
    return composerStateForRemoteThread(thread, lifecycle, remoteComposerStateByThreadId);
  } catch {
    return composerStateForRemoteThread(
      thread,
      remoteLifecycleCache.get(thread.id) ?? null,
      remoteComposerStateByThreadId
    );
  }
}

function serializableRemoteGoal(goal) {
  if (!goal?.threadId || !UUID_PATTERN.test(goal.threadId)) return null;
  const status = normalizeGoalStatus(goal.status);
  const timeUsedSeconds = Number.isFinite(goal.timeUsedSeconds)
    ? Math.max(0, goal.timeUsedSeconds)
    : null;
  if (!status || !Number.isFinite(goal.updatedAtMs)) return null;
  return {
    threadId: goal.threadId,
    goalId: goal.goalId ?? null,
    status,
    timeUsedSeconds,
    createdAtMs: Number.isFinite(goal.createdAtMs) ? goal.createdAtMs : null,
    updatedAtMs: goal.updatedAtMs
  };
}

function pruneExpiredRemoteGoals(nowMs = Date.now()) {
  for (const [threadId, goal] of observedGoalByThreadId) {
    if (!Number.isFinite(goal?.updatedAtMs)
        || nowMs - goal.updatedAtMs <= REMOTE_GOAL_CACHE_MAX_AGE_MS) continue;
    observedGoalByThreadId.delete(threadId);
    displayedGoalByThreadId.delete(threadId);
    goalTerminalCutoffByThreadId.delete(threadId);
    confirmedGoalAbsentByThreadId.set(threadId, nowMs);
  }
}

async function loadRemoteGoalCache(nowMs = Date.now()) {
  if (remoteGoalCacheLoaded) return;
  if (remoteGoalCacheLoadPromise) return remoteGoalCacheLoadPromise;
  remoteGoalCacheLoadPromise = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(REMOTE_GOAL_CACHE_PATH, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.goals)) return;
      for (const row of parsed.goals) {
        const goal = serializableRemoteGoal(row);
        if (!goal || nowMs - goal.updatedAtMs > REMOTE_GOAL_CACHE_MAX_AGE_MS) continue;
        const cachedGoal = {
          ...goal,
          source: "accessibility-cache"
        };
        if (cachedGoal.status === "active" && Number.isFinite(cachedGoal.timeUsedSeconds)) {
          // A persisted active snapshot cannot prove the goal kept running
          // while the plugin was offline. Resume only after a fresh focused
          // Accessibility observation of the same task.
          cachedGoal.freezeAtMs = cachedGoal.updatedAtMs;
          cachedGoal.frozenElapsedMs = cachedGoal.timeUsedSeconds * 1000;
          cachedGoal.resumeRequiresObservation = true;
        }
        observedGoalByThreadId.set(goal.threadId, cachedGoal);
      }
    } catch {
      // The cache is optional; focused Accessibility and lifecycle data remain
      // authoritative when it is missing, old, or partially written.
    } finally {
      remoteGoalCacheLoaded = true;
      remoteGoalCacheLoadPromise = null;
    }
  })();
  return remoteGoalCacheLoadPromise;
}

function persistRemoteGoalCache() {
  if (!runtimeTraceEnabled) return;
  pruneExpiredRemoteGoals();
  const goals = [...observedGoalByThreadId.values()]
    .map(serializableRemoteGoal)
    .filter(Boolean);
  const snapshot = `${JSON.stringify({ version: 1, goals })}\n`;
  remoteGoalCacheWriteTail = remoteGoalCacheWriteTail.then(async () => {
    const temporaryPath = `${REMOTE_GOAL_CACHE_PATH}.tmp-${process.pid}`;
    await fs.mkdir(path.dirname(REMOTE_GOAL_CACHE_PATH), { recursive: true });
    try {
      await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, REMOTE_GOAL_CACHE_PATH);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }).catch(() => {
    // Cache persistence must never delay task refresh or button input.
  });
}

function serializableUnreadCompletion(entry) {
  if (!entry?.threadId || !UUID_PATTERN.test(entry.threadId)) return null;
  if (!Number.isFinite(entry.endedAtMs) || !Number.isFinite(entry.markedAtMs)) return null;
  return {
    threadId: entry.threadId,
    endedAtMs: entry.endedAtMs,
    markedAtMs: entry.markedAtMs
  };
}

async function loadUnreadCompletionCache() {
  if (unreadCompletionCacheLoaded) return;
  if (!runtimeTraceEnabled) {
    unreadCompletionCacheLoaded = true;
    return;
  }
  if (unreadCompletionCacheLoadPromise) return unreadCompletionCacheLoadPromise;
  unreadCompletionCacheLoadPromise = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(UNREAD_COMPLETION_CACHE_PATH, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.completions)) return;
      for (const row of parsed.completions) {
        const completion = serializableUnreadCompletion(row);
        if (!completion) continue;
        const previous = unreadCompletionByThreadId.get(completion.threadId);
        if (!previous || completion.endedAtMs >= previous.endedAtMs) {
          unreadCompletionByThreadId.set(completion.threadId, completion);
        }
      }
    } catch {
      // The attention cache is optional. A missing or malformed cache must not
      // interfere with task discovery or completion detection.
    } finally {
      unreadCompletionCacheLoaded = true;
      unreadCompletionCacheLoadPromise = null;
    }
  })();
  return unreadCompletionCacheLoadPromise;
}

function persistUnreadCompletionCache() {
  if (!runtimeTraceEnabled) return;
  const completions = [...unreadCompletionByThreadId.values()]
    .map(serializableUnreadCompletion)
    .filter(Boolean)
    .sort((left, right) => right.markedAtMs - left.markedAtMs)
    .slice(0, 256);
  const snapshot = `${JSON.stringify({ version: 1, completions })}\n`;
  unreadCompletionCacheWriteTail = unreadCompletionCacheWriteTail.then(async () => {
    const temporaryPath = `${UNREAD_COMPLETION_CACHE_PATH}.tmp-${process.pid}`;
    await fs.mkdir(path.dirname(UNREAD_COMPLETION_CACHE_PATH), { recursive: true });
    try {
      await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, UNREAD_COMPLETION_CACHE_PATH);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }).catch(() => {
    // Persistence must never delay task refresh or physical key input.
  });
}

function markUnreadCompletion(threadId, endedAtMs, markedAtMs = Date.now(), options = {}) {
  if (!threadId || !UUID_PATTERN.test(threadId) || !Number.isFinite(endedAtMs)) return false;
  const previous = unreadCompletionByThreadId.get(threadId);
  if (previous && previous.endedAtMs >= endedAtMs) return false;
  unreadCompletionByThreadId.set(threadId, { threadId, endedAtMs, markedAtMs });
  if (options.persist !== false) persistUnreadCompletionCache();
  return true;
}

function clearUnreadCompletion(threadId, options = {}) {
  if (!unreadCompletionByThreadId.delete(threadId)) return false;
  if (options.persist !== false) persistUnreadCompletionCache();
  if (unreadCompletionByThreadId.size === 0) {
    unreadCompletionRenderGroup = 0;
    lastUnreadCompletionFrameAtMs = 0;
  }
  return true;
}

function acknowledgeCompletion(threadId, options = {}) {
  const hadTransientEffect = completionPulseStartedAt.has(threadId)
    || globalCompletionThreadId === threadId;
  const clearedUnread = clearUnreadCompletion(threadId, options);
  if (!clearedUnread && !hadTransientEffect) return false;
  cancelCompletionEffects(threadId);
  if (options.render !== false) renderThreadContexts();
  return true;
}

function reconcileUnreadCompletion(thread) {
  const unread = thread?.id ? unreadCompletionByThreadId.get(thread.id) : null;
  if (!unread) return false;
  const queueCount = Math.max(0, Number.parseInt(thread.queueCount, 10) || 0);
  if (thread.status !== "completed" || queueCount > 0) {
    return clearUnreadCompletion(thread.id);
  }
  return false;
}

function mergeObservedGoal(previous, observed, nowMs) {
  if (!observed?.timeUnknown || !previous) return observed;
  // A completed goal cannot become active again. An unknown-duration state
  // seen after completion therefore belongs to a new goal and must not inherit
  // the previous goal's final accumulated time.
  if (previous.status === "complete") return observed;
  const elapsedMs = goalElapsedMs(previous, nowMs);
  if (observed.status !== "active") {
    return {
      ...freezeGoal(previous, nowMs, observed.status, elapsedMs),
      threadId: observed.threadId,
      source: observed.source,
      timeUnknown: true
    };
  }
  return unfreezeGoal({
    ...previous,
    ...observed,
    goalId: previous.goalId ?? observed.goalId,
    createdAtMs: previous.createdAtMs ?? observed.createdAtMs,
    timeUsedSeconds: Number.isFinite(elapsedMs) ? elapsedMs / 1000 : null,
    updatedAtMs: nowMs
  });
}

async function refreshFocusedGoalState(thread, nowMs = Date.now(), options = {}) {
  if (!thread?.id || !UUID_PATTERN.test(thread.id)) return null;
  if (goalProbe.threadId === thread.id
      && nowMs - goalProbe.checkedAtMs < GOAL_PROBE_CACHE_MS) {
    return observedGoalByThreadId.get(thread.id) ?? null;
  }
  const priorAbsentCount = goalProbe.threadId === thread.id ? goalProbe.absentCount : 0;
  const probe = options.probe
    ?? (() => execFileAsync(KEY_BRIDGE, ["codex-goal-state"], {
      timeout: 1800,
      maxBuffer: 4096
    }));
  let output = "";
  let exitCode = 0;
  try {
    const result = await probe();
    output = String(result?.stdout ?? result ?? "");
  } catch (error) {
    output = String(error?.stdout ?? "");
    exitCode = keyBridgeExitCode(error) ?? 1;
  }

  const observed = parseCodexGoalState(output, nowMs);
  if (observed) {
    const goal = mergeObservedGoal(
      observedGoalByThreadId.get(thread.id) ?? null,
      { ...observed, threadId: thread.id },
      nowMs
    );
    observedGoalByThreadId.set(thread.id, goal);
    confirmedGoalAbsentByThreadId.delete(thread.id);
    goalProbe = { threadId: thread.id, checkedAtMs: nowMs, absentCount: 0 };
    persistRemoteGoalCache();
    return goal;
  }

  const explicitNone = exitCode === 2
    && /(?:^|\s)state=none(?:\s|$)/i.test(output);
  if (!explicitNone) {
    // Accessibility timeout, hidden window, or an older helper: retain the
    // last valid goal rather than flashing the badge and timer off.
    goalProbe = {
      threadId: thread.id,
      checkedAtMs: nowMs,
      absentCount: priorAbsentCount
    };
    return observedGoalByThreadId.get(thread.id) ?? null;
  }

  const absentCount = priorAbsentCount + 1;
  goalProbe = { threadId: thread.id, checkedAtMs: nowMs, absentCount };
  if (absentCount >= GOAL_NONE_CONFIRMATIONS) {
    observedGoalByThreadId.delete(thread.id);
    confirmedGoalAbsentByThreadId.set(thread.id, nowMs);
    persistRemoteGoalCache();
  }
  return observedGoalByThreadId.get(thread.id) ?? null;
}

function goalPredatesWorkingTurn(goal, thread) {
  return goal?.status === "complete"
    && thread?.status === "working"
    && (!Number.isFinite(thread.startedAtMs)
      || !Number.isFinite(goal.updatedAtMs)
      || thread.startedAtMs > goal.updatedAtMs + 1_000);
}

function attachGoalsToThreads(threads, goalSnapshot, nowMs = Date.now()) {
  pruneExpiredRemoteGoals(nowMs);
  return threads.map((thread) => {
    const databaseGoal = goalSnapshot.goals.get(thread.id) ?? null;
    const observedGoal = observedGoalByThreadId.get(thread.id) ?? null;
    const priorGoal = displayedGoalByThreadId.get(thread.id) ?? null;
    let goal = databaseGoal ?? observedGoal;

    if (goalPredatesWorkingTurn(goal, thread)) {
      // Keep a final whole-goal total on the turn that achieved it, but do not
      // let a cleared/completed goal replace the timer of a later normal turn.
      goal = null;
    }

    if (!goal) {
      const databaseConfirmedAbsent = goalSnapshot.fresh && !thread.remote;
      const remoteAbsentAtMs = confirmedGoalAbsentByThreadId.get(thread.id);
      const absenceConfirmed = databaseConfirmedAbsent || Number.isFinite(remoteAbsentAtMs);
      goal = absenceConfirmed ? null : priorGoal;
      if (goalPredatesWorkingTurn(goal, thread)) goal = null;
    }

    if (!goal) {
      displayedGoalByThreadId.delete(thread.id);
      goalTerminalCutoffByThreadId.delete(thread.id);
      return { ...thread, goal: null };
    }

    const cutoffResult = applyGoalTerminalCutoff(
      goal,
      thread,
      goalTerminalCutoffByThreadId.get(thread.id) ?? null,
      nowMs
    );
    goal = cutoffResult.goal;
    if (cutoffResult.cutoff) goalTerminalCutoffByThreadId.set(thread.id, cutoffResult.cutoff);
    else goalTerminalCutoffByThreadId.delete(thread.id);
    displayedGoalByThreadId.set(thread.id, goal);
    return { ...thread, goal };
  });
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
    composerStates: remoteComposerStateByThreadId,
    runtimeObservations,
    activities: remoteActivities
  });
}

function applyFocusedRemoteComposerState(thread, state, nowMs = Date.now()) {
  if (!thread?.remote) return false;
  const serviceTier = state?.available && typeof state.enabled === "boolean"
    ? state.enabled ? "priority" : "default"
    : null;
  const reasoningEffort = normalizedReasoningEffort(state?.reasoningEffort);
  if (!serviceTier && !reasoningEffort) return false;
  const lifecycle = remoteLifecycleCache.get(thread.id) ?? null;
  const recorded = recordRemoteComposerStateObservation(
    thread,
    lifecycle,
    {
      reasoningEffort,
      serviceTier
    },
    nowMs,
    remoteComposerStateByThreadId
  );
  if (!recorded) return false;

  let changed = false;
  const refreshedThread = (candidate) => {
    const base = {
      ...candidate,
      reasoningEffort: Object.hasOwn(candidate, "_remoteSummaryReasoningEffort")
        ? candidate._remoteSummaryReasoningEffort
        : candidate.reasoningEffort,
      serviceTier: Object.hasOwn(candidate, "_remoteSummaryServiceTier")
        ? candidate._remoteSummaryServiceTier
        : candidate.serviceTier
    };
    return {
      ...base,
      ...remoteStatusForThread(base, nowMs),
      _remoteSummaryReasoningEffort: base.reasoningEffort ?? null,
      _remoteSummaryServiceTier: base.serviceTier ?? null
    };
  };
  threadSlots = threadSlots.map((candidate) => {
    if (candidate?.id !== thread.id) return candidate;
    changed = true;
    return refreshedThread(candidate);
  });
  if (primaryThreadRow?.id === thread.id) {
    primaryThreadRow = refreshedThread(primaryThreadRow);
    changed = true;
  }
  if (changed) renderThreadContexts();
  return true;
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

async function readGoalRows() {
  const query = `SELECT thread_id, goal_id, status, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals;`;
  try {
    const { stdout } = await execFileAsync(SQLITE, ["-readonly", "-json", GOALS_DB, query], {
      timeout: 2500,
      maxBuffer: 2 * 1024 * 1024
    });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    const next = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const goal = normalizeGoalRecord(row, { source: "database" });
      if (!goal?.threadId || !UUID_PATTERN.test(goal.threadId)) continue;
      next.set(goal.threadId, goal);
    }
    // A valid empty query is meaningful: Codex has cleared every goal. Only
    // query failures retain the previous snapshot to avoid transient flicker.
    goalRowsCache = next;
    return { goals: new Map(next), fresh: true };
  } catch {
    return { goals: new Map(goalRowsCache), fresh: false };
  }
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
  if (thread.remote) return {
    ...remoteStatusForThread(thread),
    // Keep the source summary separate from the turn-scoped composer overlay.
    // Otherwise a previously rendered Fast/effort value looks like explicit
    // metadata on the next in-memory reconciliation and cannot be cleared.
    _remoteSummaryReasoningEffort: thread.reasoningEffort ?? null,
    _remoteSummaryServiceTier: thread.serviceTier ?? null
  };
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

function primaryFirstThreadRows(rows, candidates = rows, limit = THREAD_COUNT) {
  const distinctRows = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!row?.id || seenIds.has(row.id)) continue;
    distinctRows.push(row);
    seenIds.add(row.id);
  }
  if (!primaryThreadId) return distinctRows.slice(0, limit);

  const freshPrimary = candidates.find((row) => row?.id === primaryThreadId)
    ?? distinctRows.find((row) => row?.id === primaryThreadId)
    ?? null;
  if (freshPrimary) {
    primaryThreadRow = {
      ...(primaryThreadRow?.id === primaryThreadId ? primaryThreadRow : {}),
      ...freshPrimary,
      // A row retained while absent from every current source must use UUID
      // only. Clear that safeguard only after the exact id is observed again.
      requiresStrictIdentity: Boolean(freshPrimary.requiresStrictIdentity)
    };
  } else if (primaryThreadRow?.id === primaryThreadId) {
    primaryThreadRow = {
      ...primaryThreadRow,
      requiresStrictIdentity: true
    };
  }
  if (!primaryThreadRow || primaryThreadRow.id !== primaryThreadId) {
    return distinctRows.slice(0, limit);
  }
  return [
    primaryThreadRow,
    ...distinctRows.filter((row) => row.id !== primaryThreadId)
  ].slice(0, limit);
}

function rememberVerifiedThread(thread, options = {}) {
  if (!thread?.id) return false;
  const changed = primaryThreadId !== thread.id;
  primaryThreadId = thread.id;
  lastOpenedThreadId = thread.id;
  lastOpenedThreadAtMs = options.nowMs ?? Date.now();
  const currentRow = combinedVisibleThreads().find((row) => row?.id === thread.id);
  primaryThreadRow = {
    ...(primaryThreadRow?.id === thread.id ? primaryThreadRow : {}),
    ...(currentRow ?? {}),
    ...thread
  };
  if (changed || fastModeState.threadId !== thread.id) {
    fastModeRevision += 1;
    fastModeState = fastModeStateFromThread(primaryThreadRow);
  }
  if (options.promote !== false) {
    renderThreadContexts();
    renderStaticContexts();
  }
  if (options.refreshFastMode !== false) void refreshFastMode();
  return true;
}

function annotateKnownTitleAmbiguity(selected, candidates) {
  const ownersByFingerprint = new Map();
  for (const candidate of candidates) {
    if (!candidate?.id || !candidate?.title) continue;
    for (const fingerprint of titleFingerprints(candidate.title)) {
      const owners = ownersByFingerprint.get(fingerprint) ?? new Set();
      owners.add(candidate.id);
      ownersByFingerprint.set(fingerprint, owners);
    }
  }
  return selected.map((thread) => ({
    ...thread,
    titleAmbiguous: [...titleFingerprints(thread.title)]
      .some((fingerprint) => (ownersByFingerprint.get(fingerprint)?.size ?? 0) > 1)
  }));
}

async function readTopThreads() {
  const queueWindowsPromise = readCodexQueueWindows();
  const globalStatePromise = readGlobalStateSnapshot();
  const [rows, persistentIds, remoteRows, pinnedIds, activeThreadIds, sidebarNames, goalSnapshot] = await Promise.all([
    readThreadRows(),
    readPersistentThreadIds(),
    readRemoteThreadRows(globalStatePromise),
    readPinnedIds(globalStatePromise),
    readActiveThreadIds(),
    readSidebarThreadNames(),
    readGoalRows(),
    Promise.all([
      loadRemoteGoalCache(),
      loadUnreadCompletionCache()
    ])
  ]);
  const localRows = rows
    .filter((row) => !isInternalThreadRecord(row))
    .map((row) => ({
      ...row,
      title: sidebarNames.get(row.id) ?? row.title,
      remote: false,
      ephemeral: false
    }))
    .filter((row) => !isInternalThreadRecord(row));
  const sideChats = await readEphemeralSideChats(
    persistentIds,
    localRows[0]?.id ?? null,
    globalStatePromise
  );
  const sideChatLifecycles = await readSideChatLifecycles(sideChats);
  const openSideChats = sideChats
    .filter((thread) => !closedSideChatAtMs.has(thread.id)
      && sideChatLifecycles.get(thread.id)?.status !== "closed")
    .map((thread) => ({ ...thread, remote: false, ephemeral: true }));
  const normalizedRemoteRows = remoteRows.map((thread) => ({
    ...thread,
    remote: true,
    ephemeral: false
  }));
  await resolvePendingSideChatTarget(openSideChats);
  knownSideChatIds = new Set(sideChats.map((thread) => thread.id));
  for (const thread of sideChats) {
    if (sideChatLifecycles.get(thread.id)?.status === "closed") sideChatParentById.delete(thread.id);
  }
  const selection = selectTopThreadRows(localRows, normalizedRemoteRows, openSideChats, pinnedIds);
  const { byId } = selection;
  mostRecentThreadId = selection.mostRecentId;
  const [queueWindows] = await Promise.all([
    queueWindowsPromise,
    refreshRemoteLifecyclesFromLogs()
  ]);
  const localIds = new Set(localRows.map((thread) => thread.id));
  const candidateRows = [
    ...localRows,
    ...normalizedRemoteRows.filter((thread) => !localIds.has(thread.id)),
    ...openSideChats
  ];
  const identityCandidates = [...candidateRows];
  if (primaryThreadRow?.id
      && !identityCandidates.some((thread) => thread.id === primaryThreadRow.id)) {
    identityCandidates.push(primaryThreadRow);
  }
  const pinnedIdSet = new Set(pinnedIds);
  const currentCandidates = annotateKnownTitleAmbiguity(
    candidateRows.map((thread) => ({
      ...thread,
      pinned: pinnedIdSet.has(thread.id)
    })),
    identityCandidates
  );
  const currentThread = await verifiedCurrentCodexThread(queueWindows, currentCandidates);
  if (currentThread && unreadCompletionByThreadId.has(currentThread.id)) {
    // `codex-current-thread` can describe Codex's internal selection while the
    // app is behind another window. Only a strict frontmost match proves the
    // user has actually viewed the completed task.
    const completionWasViewed = await threadIsFocused(currentThread);
    if (completionWasViewed) acknowledgeCompletion(currentThread.id, { render: false });
  }
  if (currentThread && currentThread.id !== primaryThreadId) {
    rememberVerifiedThread(currentThread, {
      promote: false
    });
  }
  const rankedThreadIds = selection.selected.map((thread) => thread.id);
  const selected = annotateKnownTitleAmbiguity(
    // Hydrate all eight ranked rows plus an independently tracked current row.
    // The old current-first slice displaced Top Task 8 and made Top Task 1 a
    // duplicate of Current Task whenever the active task was not rank 1.
    primaryFirstThreadRows(selection.selected, currentCandidates, THREAD_COUNT + 1),
    identityCandidates
  );
  await Promise.all([
    refreshVisibleRemoteComposerState(selected, queueWindows),
    refreshFocusedGoalState(currentThread?.remote ? currentThread : null)
  ]);

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
  const queuedThreads = applyQueueState(hydratedThreads, queueWindows);
  const goalThreads = attachGoalsToThreads(queuedThreads, goalSnapshot);
  // Refresh the cached current row from the same lifecycle/queue/goal snapshot
  // while returning the ranked list without promotion.
  primaryFirstThreadRows(goalThreads, goalThreads, THREAD_COUNT + 1);
  const goalById = new Map(goalThreads.map((thread) => [thread.id, thread]));
  return {
    threads: rankedThreadIds.map((id) => goalById.get(id)).filter(Boolean),
    currentThread: primaryThreadId ? goalById.get(primaryThreadId) ?? null : null
  };
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

function startCompletionEffects(threadId, nowMs = Date.now(), endedAtMs = nowMs) {
  markUnreadCompletion(threadId, endedAtMs, nowMs);
  completionPulseStartedAt.set(threadId, nowMs);
  globalCompletionStartedAtMs = nowMs;
  globalCompletionThreadId = threadId;
  globalCompletionWasRendered = false;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = true;
}

function clearCompletionEffect(threadId) {
  completionPulseStartedAt.delete(threadId);
}

function cancelCompletionEffects(threadId) {
  clearCompletionEffect(threadId);
  if (globalCompletionThreadId !== threadId) return;
  globalCompletionStartedAtMs = null;
  globalCompletionThreadId = null;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = false;
  // Keep globalCompletionWasRendered intact so the animation timer sends one
  // clean, overlay-free frame if a pulse had already reached the device.
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
    const thread = slot === undefined ? null : threadForSlot(slot);
    if (thread?.id !== targetThreadId) continue;
    const svg = threadSvg(thread, slot);
    contextImages.set(context, svg);
    sendImage(context, composedContextSvg(context, svg, nowMs));
  }
}

function renderAnimatedThreadContexts(nowMs = Date.now()) {
  const unreadFrameDue = nowMs - lastUnreadCompletionFrameAtMs
    >= UNREAD_COMPLETION_FRAME_INTERVAL_MS;
  const unreadRenderGroup = unreadCompletionRenderGroup;
  let hasVisibleUnreadCompletion = false;
  let threadContextIndex = 0;
  for (const [context, action] of contexts) {
    const slot = THREAD_SLOT_BY_ACTION.get(action);
    const thread = slot === undefined ? null : threadForSlot(slot);
    if (slot === undefined) continue;
    const completionStartedAtMs = thread?.id ? completionPulseStartedAt.get(thread.id) : null;
    const completionAnimating = Number.isFinite(completionStartedAtMs)
      && nowMs - completionStartedAtMs < THREAD_COMPLETION_PULSE_DURATION_MS;
    const unreadAnimating = thread?.status === "completed"
      && unreadCompletionByThreadId.has(thread.id);
    if (unreadAnimating) hasVisibleUnreadCompletion = true;
    const renderUnreadFrame = unreadAnimating
      && unreadFrameDue
      && threadContextIndex % UNREAD_COMPLETION_GROUP_COUNT === unreadRenderGroup;
    if (
      (thread?.status === "working" && String(thread.reasoningEffort ?? "").toLowerCase() === "ultra")
      || completionAnimating
      || renderUnreadFrame
    ) {
      setImage(context, threadSvg(thread, slot));
    } else if (Number.isFinite(completionStartedAtMs)) {
      clearCompletionEffect(thread.id);
      setImage(context, threadSvg(thread, slot));
    }
    threadContextIndex += 1;
  }
  if (unreadFrameDue && hasVisibleUnreadCompletion) {
    lastUnreadCompletionFrameAtMs = nowMs;
    unreadCompletionRenderGroup = (unreadCompletionRenderGroup + 1)
      % UNREAD_COMPLETION_GROUP_COUNT;
  }
}

function trackCompletionTransitions(previousThreads, nextThreads, nowMs = Date.now()) {
  const previousById = new Map(previousThreads.filter(Boolean).map((thread) => [thread.id, thread]));
  if (!hasLoadedThreadState) {
    for (const thread of nextThreads) {
      const queueCount = Math.max(0, Number.parseInt(thread?.queueCount, 10) || 0);
      reconcileUnreadCompletion(thread);
      if (thread?.id && queueCount > 0) completionQueueBarrierMsByThreadId.set(thread.id, nowMs);
      if (thread?.status === "completed" && Number.isFinite(thread.endedAtMs)) {
        const completedDuringStartup = thread.endedAtMs >= pluginStartedAtMs - COMPLETION_STARTUP_GRACE_MS
          && thread.endedAtMs <= nowMs + APP_SERVER_START_TOLERANCE_MS;
        const markerFollowsTurnStart = !Number.isFinite(thread.startedAtMs)
          || thread.endedAtMs > thread.startedAtMs;
        // A terminal row with queued follow-ups is an intermediate handoff, not
        // a finished task. Remember its marker so it cannot pulse later when
        // that queue is edited or dequeued.
        if (completedDuringStartup && markerFollowsTurnStart && queueCount === 0) {
          pendingCompletionByThreadId.set(thread.id, {
            startedAtMs: Number.isFinite(thread.startedAtMs) ? thread.startedAtMs : null,
            endedAtMs: thread.endedAtMs,
            firstObservedAtMs: nowMs
          });
        }
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
    reconcileUnreadCompletion(thread);
    const previous = previousById.get(thread.id);
    const previousQueueCount = Math.max(0, Number.parseInt(previous?.queueCount, 10) || 0);
    const nextQueueCount = Math.max(0, Number.parseInt(thread.queueCount, 10) || 0);
    const queueChanged = Boolean(previous) && previousQueueCount !== nextQueueCount;
    if (queueChanged || nextQueueCount > 0) {
      completionQueueBarrierMsByThreadId.set(thread.id, nowMs);
      pendingCompletionByThreadId.delete(thread.id);
      clearUnreadCompletion(thread.id);
      cancelCompletionEffects(thread.id);
    }

    if (thread.status !== "completed") {
      pendingCompletionByThreadId.delete(thread.id);
      cancelCompletionEffects(thread.id);
      continue;
    }

    const knownEndMs = observedCompletionEndMs.get(thread.id);
    const queueBarrierMs = completionQueueBarrierMsByThreadId.get(thread.id);
    const pendingCompletion = pendingCompletionByThreadId.get(thread.id);
    const normalizedStartedAtMs = Number.isFinite(thread.startedAtMs) ? thread.startedAtMs : null;
    const markerFollowsTurnStart = Number.isFinite(thread.endedAtMs)
      && (!Number.isFinite(thread.startedAtMs) || thread.endedAtMs > thread.startedAtMs);
    const samePendingCompletion = pendingCompletion
      && pendingCompletion.endedAtMs === thread.endedAtMs
      && pendingCompletion.startedAtMs === normalizedStartedAtMs
      && nowMs > pendingCompletion.firstObservedAtMs;
    const queueIsSettledAndEmpty = nextQueueCount === 0
      && (!previous || previousQueueCount === 0)
      && !queueChanged;
    if (samePendingCompletion && queueIsSettledAndEmpty) {
      pendingCompletionByThreadId.delete(thread.id);
      startCompletionEffects(thread.id, nowMs, thread.endedAtMs);
      continue;
    }
    if (pendingCompletion) pendingCompletionByThreadId.delete(thread.id);

    const turnAdvanced = Boolean(previous)
      && Number.isFinite(thread.startedAtMs)
      && (
        !Number.isFinite(previous.startedAtMs)
        || thread.startedAtMs > previous.startedAtMs
      );
    const markerClearsQueueBarrier = !Number.isFinite(queueBarrierMs)
      || thread.endedAtMs > queueBarrierMs
      // A whole final queued turn can start and finish between refreshes. Its
      // advanced start identifies it as newer than the queue handoff even
      // though the end timestamp necessarily precedes this observation.
      || (queueChanged && turnAdvanced);
    const hasNewEndMarker = markerFollowsTurnStart
      && thread.endedAtMs >= unseenCompletionFloorMs
      && thread.endedAtMs <= nowMs + APP_SERVER_START_TOLERANCE_MS
      && (!Number.isFinite(knownEndMs) || thread.endedAtMs > knownEndMs)
      && markerClearsQueueBarrier;
    const queueCanStageCompletion = nextQueueCount === 0
      && (!queueChanged || turnAdvanced);
    // Queue count is presentation state only. Editing, deleting, or consuming
    // a queued prompt must never become completion evidence. A fresh terminal
    // marker is staged for one coherent refresh before any green frame is sent;
    // a queued continuation therefore has time to replace the stale old-turn
    // terminal row, while a collapsed final queued turn is retained by its
    // advanced start timestamp.
    if (hasNewEndMarker && queueCanStageCompletion) {
      pendingCompletionByThreadId.set(thread.id, {
        startedAtMs: normalizedStartedAtMs,
        endedAtMs: thread.endedAtMs,
        firstObservedAtMs: nowMs
      });
    }
    if (Number.isFinite(thread.endedAtMs)
        && (!Number.isFinite(knownEndMs) || thread.endedAtMs > knownEndMs)) {
      observedCompletionEndMs.set(thread.id, thread.endedAtMs);
    }
  }

  for (const threadId of completionPulseStartedAt.keys()) {
    if (!visibleIds.has(threadId)) clearCompletionEffect(threadId);
  }
  for (const threadId of pendingCompletionByThreadId.keys()) {
    if (!visibleIds.has(threadId)) pendingCompletionByThreadId.delete(threadId);
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
        const snapshot = await readTopThreadsWithRetries(reader, retryDelays);
        const threads = Array.isArray(snapshot) ? snapshot : snapshot?.threads;
        if (!Array.isArray(threads)) throw new Error("Codex task snapshot was malformed");
        consecutiveThreadRefreshFailures = 0;
        threadRefreshUnavailable = false;
        pulse = !pulse;
        const previousVisibleThreads = combinedVisibleThreads();
        const nextThreadSlots = Array.from(
          { length: THREAD_COUNT },
          (_, index) => threads[index] ?? null
        );
        if (!Array.isArray(snapshot) && snapshot?.currentThread?.id) {
          primaryThreadRow = {
            ...(primaryThreadRow?.id === snapshot.currentThread.id ? primaryThreadRow : {}),
            ...snapshot.currentThread
          };
        }
        const nextCurrentThread = currentThreadForDisplay(nextThreadSlots, primaryThreadRow);
        trackCompletionTransitions(
          previousVisibleThreads,
          combinedVisibleThreads(nextCurrentThread, nextThreadSlots)
        );
        threadSlots = nextThreadSlots;
        renderThreadContexts();
        if (fastModeState.threadId !== primaryThreadId) {
          fastModeRevision += 1;
          fastModeState = fastModeStateFromThread(nextCurrentThread ?? primaryThreadRow);
          renderStaticContexts();
          void refreshFastMode();
        }
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

async function performRemoteNavigation(thread, slot, options = {}) {
  const signal = options.signal ?? null;
  const startedAtMs = Date.now();
  const fingerprints = [...titleFingerprints(thread.title)];
  const strictIdentity = Boolean(thread.titleAmbiguous || thread.requiresStrictIdentity);
  const directCommand = remoteThreadKeyBridgeCommand(thread, "codex-open-thread");
  const searchCommand = remoteThreadKeyBridgeCommand(thread, "codex-search-thread");
  const directArgs = strictIdentity ? [thread.id] : [thread.id, ...fingerprints];
  const openApp = options.openApp
    ?? (() => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], {
      timeout: 5000,
      signal
    }));
  const directOpen = options.directOpen
    ?? (() => execFileAsync(KEY_BRIDGE, [directCommand, ...directArgs], {
      timeout: 4000,
      maxBuffer: 64 * 1024,
      signal
    }));
  const searchOpen = options.searchOpen
    ?? (() => runKeyBridgeWithInput(
      searchCommand,
      directArgs,
      thread.title,
      { timeoutMs: 6000, signal }
    ));
  const waitFrontmost = options.waitFrontmost
    ?? (() => execFileAsync(KEY_BRIDGE, ["codex-wait-frontmost"], {
      timeout: 3000,
      maxBuffer: 4096,
      signal
    }));
  const sleep = options.sleep ?? sleepWithSignal;
  const waitFocused = options.waitFocused
    ?? ((focusedOptions = {}) => waitForThreadFocused(thread, focusedOptions));

  runtimeTrace("remote-navigation", { slot: slot + 1, remote: true, phase: "start" });
  await openApp();
  throwIfAborted(signal);
  // `open -b` returns when LaunchServices has accepted the request, not when
  // Codex is actually frontmost. Wait on observable app state once so a cold
  // launch cannot burn both sidebar attempts and the search fallback before
  // the window is ready. AbortSignal still terminates the native poll when a
  // newer task selection supersedes this one.
  await waitFrontmost();
  throwIfAborted(signal);

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(REMOTE_APP_ACTIVATION_RETRY_MS, signal);
    try {
      const directResult = await directOpen();
      throwIfAborted(signal);
      const directOutput = String(directResult?.stdout ?? "");
      const directIdentity = directOutput.includes("strategy=uuid")
        ? "uuid"
        : directOutput.includes("strategy=title")
          ? "title"
          : "unknown";
      const ready = await waitFocused({
        signal,
        delays: REMOTE_DIRECT_READY_POLL_DELAYS_MS
      });
      if (ready) {
        runtimeTrace("remote-navigation", {
          slot: slot + 1,
          remote: true,
          strategy: strictIdentity ? "sidebar-strict" : "sidebar",
          result: "ready",
          reason: directIdentity,
          elapsedMs: Date.now() - startedAtMs
        });
        return true;
      }
      lastError = new Error("remote thread did not become focused after sidebar activation");
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (keyBridgeExitCode(error) === 3) throw error;
      lastError = error;
    }
  }

  runtimeTrace("remote-navigation", {
    slot: slot + 1,
    remote: true,
    strategy: strictIdentity ? "search-strict" : "search",
    phase: "start"
  });
  try {
    await searchOpen();
    throwIfAborted(signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    lastError = error;
    throw lastError;
  }
  let searchReady = await waitFocused({ signal, delays: REMOTE_READY_POLL_DELAYS_MS });
  if (!searchReady) {
    // The unified search itself already waited for and activated one exact
    // result. Revalidate once after the final navigation frame instead of
    // opening a second palette and risking a duplicate search interaction.
    await sleep(REMOTE_APP_ACTIVATION_RETRY_MS, signal);
    searchReady = await waitFocused({
      signal,
      delays: REMOTE_DIRECT_READY_POLL_DELAYS_MS
    });
  }
  if (!searchReady) {
    throw new Error("remote thread search closed before the target became focused", { cause: lastError });
  }
  runtimeTrace("remote-navigation", {
    slot: slot + 1,
    remote: true,
    strategy: strictIdentity ? "search-strict" : "search",
    result: "ready",
    elapsedMs: Date.now() - startedAtMs
  });
  return true;
}

async function performDeepLinkNavigation(thread, slot, options = {}) {
  const signal = options.signal ?? null;
  const startedAtMs = Date.now();
  const openUrl = options.openUrl
    ?? (() => execFileAsync("/usr/bin/open", [`codex://threads/${thread.id}`], {
      timeout: 5000,
      signal
    }));
  const waitFrontmost = options.waitFrontmost
    ?? (() => execFileAsync(KEY_BRIDGE, ["codex-wait-frontmost"], {
      timeout: 3000,
      maxBuffer: 4096,
      signal
    }));
  const waitFocused = options.waitFocused
    ?? ((focusedOptions = {}) => waitForThreadFocused(thread, focusedOptions));
  const sleep = options.sleep ?? sleepWithSignal;
  let lastError = null;

  runtimeTrace("thread-navigation", {
    slot: slot + 1,
    remote: false,
    strategy: "deep-link",
    phase: "start"
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(REMOTE_APP_ACTIVATION_RETRY_MS, signal);
    try {
      await openUrl();
      throwIfAborted(signal);
      await waitFrontmost();
      throwIfAborted(signal);
      if (await waitFocused({
        signal,
        delays: REMOTE_DIRECT_READY_POLL_DELAYS_MS
      })) {
        runtimeTrace("thread-navigation", {
          slot: slot + 1,
          remote: false,
          strategy: "deep-link",
          result: "ready",
          elapsedMs: Date.now() - startedAtMs
        });
        return true;
      }
      lastError = new Error("thread deep link did not become focused");
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }

  // A successful `open` only confirms LaunchServices accepted the URL. Give
  // the second attempt one final identity probe without dispatching a third
  // navigation request.
  await sleep(REMOTE_APP_ACTIVATION_RETRY_MS, signal);
  if (await waitFocused({ signal, delays: REMOTE_READY_POLL_DELAYS_MS })) {
    runtimeTrace("thread-navigation", {
      slot: slot + 1,
      remote: false,
      strategy: "deep-link-revalidate",
      result: "ready",
      elapsedMs: Date.now() - startedAtMs
    });
    return true;
  }
  throw new Error("thread deep link could not be verified", { cause: lastError });
}

function navigateDeepLinkThread(thread, slot, options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => navigateDeepLinkThread(thread, slot, options));
  }
  activeComposerCreation?.controller.abort();
  if (activeDeepLinkNavigation?.threadId === thread.id
      && !activeDeepLinkNavigation.controller.signal.aborted) {
    return activeDeepLinkNavigation.promise;
  }
  activeRemoteNavigation?.controller.abort();
  if (activeDeepLinkNavigation) activeDeepLinkNavigation.controller.abort();
  const controller = new AbortController();
  const navigation = {
    threadId: thread.id,
    controller,
    promise: null
  };
  navigation.promise = performDeepLinkNavigation(thread, slot, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    if (activeDeepLinkNavigation === navigation) activeDeepLinkNavigation = null;
  });
  activeDeepLinkNavigation = navigation;
  return navigation.promise;
}

function navigateRemoteThread(thread, slot, options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => navigateRemoteThread(thread, slot, options));
  }
  activeComposerCreation?.controller.abort();
  activeDeepLinkNavigation?.controller.abort();
  if (activeRemoteNavigation?.threadId === thread.id
      && !activeRemoteNavigation.controller.signal.aborted) {
    runtimeTrace("remote-navigation", {
      slot: slot + 1,
      remote: true,
      phase: "coalesce",
      coalesced: true
    });
    return activeRemoteNavigation.promise;
  }
  if (activeRemoteNavigation) {
    activeRemoteNavigation.controller.abort();
    runtimeTrace("remote-navigation", {
      slot: slot + 1,
      remote: true,
      phase: "supersede"
    });
  }
  const controller = new AbortController();
  const navigation = {
    threadId: thread.id,
    controller,
    promise: null
  };
  navigation.promise = performRemoteNavigation(thread, slot, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    if (activeRemoteNavigation === navigation) activeRemoteNavigation = null;
  });
  activeRemoteNavigation = navigation;
  return navigation.promise;
}

async function openThread(context, slot, options = {}) {
  const thread = options.thread ?? threadForSlot(slot);
  const feedback = options.feedback ?? showFeedback;
  if (!thread?.id) {
    feedback(context, "error", "작업 없음");
    return false;
  }
  if (thread.ephemeral) {
    return openListedSideChat(context, thread, options);
  }
  if (thread.remote && !accessibilityTrustedSync()) {
    feedback(context, "error", "손쉬운 사용", 2200);
    return false;
  }
  pendingSideChatTarget = null;
  feedback(context, "loading", "여는 중");
  const remoteNavigation = options.navigateRemote ?? navigateRemoteThread;
  const deepLinkNavigation = options.navigateDeepLink ?? navigateDeepLinkThread;
  const remember = options.rememberThread ?? rememberVerifiedThread;
  const acknowledge = options.acknowledgeCompletion ?? acknowledgeCompletion;
  const scheduleRefresh = options.scheduleRefresh
    ?? (() => setTimeout(() => void refreshThreads(), 1000));
  try {
    if (thread.remote) {
      await remoteNavigation(thread, slot);
      acknowledge(thread.id, { render: false });
      remember(thread);
      feedback(context, "success", "원격 전환");
      scheduleRefresh();
      return true;
    }
    await deepLinkNavigation(thread, slot);
    acknowledge(thread.id, { render: false });
    remember(thread);
    feedback(context, "success", "전환 완료");
    scheduleRefresh();
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clearFeedback(context);
      runtimeTrace("remote-navigation", {
        slot: slot + 1,
        remote: Boolean(thread.remote),
        result: "cancelled"
      });
      return false;
    }
    const exitCode = keyBridgeExitCode(error);
    const label = thread.remote
      ? exitCode === 3 || thread.titleAmbiguous ? "제목 중복" : "원격 확인"
      : "열기 실패";
    feedback(context, "error", label, thread.remote ? 1800 : undefined);
    console.error(`Could not open Codex ${thread.remote ? "remote " : ""}thread: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

async function openListedSideChat(context, thread, options = {}) {
  const feedback = options.feedback ?? showFeedback;
  const clear = options.clearFeedback ?? clearFeedback;
  const navigate = options.navigateDeepLink ?? navigateDeepLinkThread;
  const remember = options.rememberThread ?? rememberVerifiedThread;
  const acknowledge = options.acknowledgeCompletion ?? acknowledgeCompletion;
  const scheduleRefresh = options.scheduleRefresh
    ?? (() => setTimeout(() => void refreshThreads(), 1000));
  pendingSideChatTarget = null;
  feedback(context, "loading", "사이드챗 열기");
  try {
    // A listed side chat already has a live conversation id. Replaying the
    // Option+Command+S creation shortcut here opens a new side chat instead of
    // focusing the listed one. The normal Codex thread deep link also accepts
    // these ephemeral ids while their app-server session is alive.
    const slot = Math.max(0, threadSlots.findIndex((candidate) => candidate?.id === thread.id));
    await navigate(thread, slot);
    acknowledge(thread.id, { render: false });
    remember(thread);
    feedback(context, "success", "사이드챗 전환");
    scheduleRefresh();
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clear(context);
      runtimeTrace("thread-navigation", {
        slot: Math.max(0, threadSlots.findIndex((candidate) => candidate?.id === thread.id)) + 1,
        remote: false,
        result: "cancelled"
      });
      return false;
    }
    feedback(context, "error", "열기 실패");
    console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

function beginComposerCreation(kind, operation) {
  activeRemoteNavigation?.controller.abort();
  activeDeepLinkNavigation?.controller.abort();
  activeComposerCreation?.controller.abort();
  const controller = new AbortController();
  const creation = {
    kind,
    controller,
    promise: null
  };
  creation.promise = Promise.resolve()
    .then(() => operation(controller.signal))
    .finally(() => {
      if (activeComposerCreation === creation) activeComposerCreation = null;
    });
  activeComposerCreation = creation;
  return creation.promise;
}

async function openNewThread(context, options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => openNewThread(context, options));
  }
  const openApp = options.openApp
    ?? ((signal) => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], {
      timeout: 5000,
      signal
    }));
  const sleep = options.sleep ?? sleepWithSignal;
  const bridge = options.bridge ?? ((command, bridgeContext) => runKeyBridgeSync(command, bridgeContext));
  return beginComposerCreation("new-thread", async (signal) => {
    try {
      pendingSideChatTarget = null;
      lastOpenedThreadId = null;
      lastOpenedThreadAtMs = null;
      await openApp(signal);
      throwIfAborted(signal);
      await sleep(350, signal);
      throwIfAborted(signal);
      if (!bridge("new-thread", context)) return false;
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        clearFeedback(context);
        return false;
      }
      showFeedback(context, "error", "열기 실패");
      console.error(`Could not open a new Codex thread: ${error?.message ?? "unknown error"}`);
      return false;
    }
  });
}

async function openSideChat(context, options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => openSideChat(context, options));
  }
  const openApp = options.openApp
    ?? ((signal) => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], {
      timeout: 5000,
      signal
    }));
  const sleep = options.sleep ?? sleepWithSignal;
  const bridge = options.bridge ?? ((command, bridgeContext) => runKeyBridgeSync(command, bridgeContext));
  const scheduleRefreshes = options.scheduleRefreshes ?? scheduleSideChatTargetRefreshes;
  return beginComposerCreation("side-chat", async (signal) => {
    try {
      pendingSideChatTarget = null;
      const requestedAtMs = options.nowMs ?? Date.now();
      lastOpenedThreadId = null;
      lastOpenedThreadAtMs = null;
      await openApp(signal);
      throwIfAborted(signal);
      await sleep(350, signal);
      throwIfAborted(signal);
      if (!bridge("side-chat", context)) return false;
      pendingSideChatTarget = { requestedAtMs, knownIds: new Set(knownSideChatIds) };
      scheduleRefreshes(requestedAtMs);
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        clearFeedback(context);
        return false;
      }
      showFeedback(context, "error", "열기 실패");
      console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
      return false;
    }
  });
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
    // Prime the only synchronous permission check before the first hardware
    // press. This keeps first-use remote switching and push-to-talk responsive.
    primeAccessibilityTrust();
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
        if (message.action === ACTIONS.fastMode) void refreshFastMode({ quiet: true });
      }
    } else if (message.event === "willDisappear") {
      // A task-key hold owns both the voice release and its media lease. Let
      // that press state perform one gated teardown; calling the generic media
      // cleanup afterwards could otherwise bypass a failed voice-up.
      if (threadPressByContext.get(message.context)?.voiceStarted) {
        cancelThreadPress(message.context, true);
      } else {
        endVoiceHoldSync(message.context, false);
        cancelThreadPress(message.context, false);
      }
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
      } else if (action === ACTIONS.fastMode) {
        void toggleFastMode(message.context);
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
  unreadCompletionByThreadId.clear();
  completionQueueBarrierMsByThreadId.clear();
  pendingCompletionByThreadId.clear();
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceStateByContext.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  sendLongPressArmedContexts.clear();
  globalCompletionStartedAtMs = null;
  globalCompletionThreadId = null;
  globalCompletionWasRendered = false;
  globalCompletionRenderGroup = 0;
  globalCompletionInitialFanoutPending = false;
  unreadCompletionRenderGroup = 0;
  lastUnreadCompletionFrameAtMs = 0;
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
    queueCount: hasCompleted ? 0 : queueCount,
    goal: hasCompleted
      ? {
        threadId: DEMO_WORKING_ID,
        goalId: "demo-goal",
        status: "complete",
        timeUsedSeconds: 37 * 60 + 15,
        updatedAtMs: completionStartMs,
        source: "demo"
      }
      : {
        threadId: DEMO_WORKING_ID,
        goalId: "demo-goal",
        status: "active",
        timeUsedSeconds: 36 * 60 + 40,
        updatedAtMs: DEMO_EPOCH_MS - 32_000,
        source: "demo"
      }
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
    fastModeSvg({
      threadId: DEMO_WORKING_ID,
      enabled: true,
      available: true,
      failed: false
    }, DEMO_WORKING_ID),
    voiceSvg("idle", nowMs),
    pageNavigationSvg(ACTIONS.pagePrevious)
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

function renderCompletedTaskKey(outputPath, mode = "dark") {
  appearanceMode = mode;
  THEME = mode === "dark" ? DARK_THEME : LIGHT_THEME;
  fixedRenderTimeMs = DEMO_EPOCH_MS;
  resetDemoEffects();
  const completedThread = {
    id: DEMO_COMPLETED_ID,
    title: "문서 이미지",
    pinned: false,
    status: "completed",
    startedAtMs: DEMO_EPOCH_MS - 12 * 60_000 - 17_000,
    endedAtMs: DEMO_EPOCH_MS - 10 * 60_000,
    activity: { kind: "complete", label: "작업 완료" },
    reasoningEffort: "high",
    // Exercise the deliberate completed-card exception: the turn used Fast,
    // but the rendered terminal card reserves the header for its check mark.
    serviceTier: "priority",
    queueCount: 0
  };
  const resolvedOutput = path.resolve(outputPath);
  fsSync.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fsSync.writeFileSync(resolvedOutput, `${threadSvg(completedThread, 0)}\n`);
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
  if (elapsedMs >= 650 && elapsedMs < 1_400) {
    state = "preparing";
    accent = THEME.blue;
    result = "TARGET READYING · 전환 준비";
  } else if (elapsedMs >= 1_400 && elapsedMs < 2_650) {
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

function verifyCompletionTransitionPolicy(nowMs) {
  const threadId = "00000000-0000-4000-8000-000000000030";
  const oldStartedAtMs = nowMs - 30_000;
  const oldEndedAtMs = nowMs - 1_000;
  const newStartedAtMs = nowMs + 100;
  const thread = (status, queueCount, startedAtMs, endedAtMs = null) => ({
    id: threadId,
    title: "완료 판정 검증",
    remote: true,
    status,
    startedAtMs,
    endedAtMs,
    queueCount
  });
  const resetTracker = (loaded = true) => {
    resetDemoEffects();
    observedCompletionEndMs.clear();
    hasLoadedThreadState = loaded;
    lastThreadTransitionScanAtMs = nowMs - 3_000;
  };
  const noCompletionEffect = () => !completionPulseStartedAt.has(threadId)
    && !unreadCompletionByThreadId.has(threadId)
    && globalCompletionStartedAtMs === null
    && globalCompletionThreadId === null;

  resetTracker();
  trackCompletionTransitions(
    [thread("working", 3, oldStartedAtMs)],
    [thread("working", 2, oldStartedAtMs)],
    nowMs
  );
  const queueEditIgnored = noCompletionEffect();

  resetTracker();
  const queuedWorking = thread("working", 1, oldStartedAtMs);
  const oldTurnTerminalDuringDequeue = thread("completed", 0, oldStartedAtMs, oldEndedAtMs);
  const queuedTurnWorking = thread("working", 0, newStartedAtMs);
  trackCompletionTransitions([queuedWorking], [oldTurnTerminalDuringDequeue], nowMs);
  const oldTerminalAtHandoffIgnored = noCompletionEffect();
  trackCompletionTransitions(
    [oldTurnTerminalDuringDequeue],
    [queuedTurnWorking],
    nowMs + 200
  );
  const remoteQueueHandoffIgnored = oldTerminalAtHandoffIgnored && noCompletionEffect();

  resetTracker();
  const unobservedQueueTerminal = thread("completed", 0, oldStartedAtMs, oldEndedAtMs);
  trackCompletionTransitions(
    [thread("working", 0, oldStartedAtMs)],
    [unobservedQueueTerminal],
    nowMs
  );
  const ambiguousTerminalWasOnlyStaged = noCompletionEffect()
    && pendingCompletionByThreadId.get(threadId)?.endedAtMs === oldEndedAtMs;
  trackCompletionTransitions(
    [unobservedQueueTerminal],
    [queuedTurnWorking],
    nowMs + 200
  );
  const lateQueueHandoffNeverRendered = ambiguousTerminalWasOnlyStaged
    && noCompletionEffect()
    && !pendingCompletionByThreadId.has(threadId);

  resetTracker();
  const delayedTurnStartedAtMs = nowMs - 5_000;
  const delayedOldEndedAtMs = nowMs - 1_000;
  const delayedQueuedWorking = thread("working", 1, delayedTurnStartedAtMs);
  const delayedDequeuedWorking = thread("working", 0, delayedTurnStartedAtMs);
  trackCompletionTransitions(
    [delayedQueuedWorking],
    [delayedDequeuedWorking],
    nowMs
  );
  const delayedOldTerminal = thread("completed", 0, delayedTurnStartedAtMs, delayedOldEndedAtMs);
  trackCompletionTransitions(
    [delayedDequeuedWorking],
    [delayedOldTerminal],
    nowMs + 3_000
  );
  const delayedOldMarkerIgnored = noCompletionEffect();

  resetTracker(false);
  const startupTestNowMs = pluginStartedAtMs + 1_000;
  const startupEndedAtMs = pluginStartedAtMs + 500;
  const startupQueuedTerminal = thread(
    "completed",
    1,
    pluginStartedAtMs - 1_000,
    startupEndedAtMs
  );
  trackCompletionTransitions([], [startupQueuedTerminal], startupTestNowMs);
  const startupQueuedTerminalIgnored = noCompletionEffect()
    && observedCompletionEndMs.get(threadId) === startupEndedAtMs;

  resetTracker();
  const finalQueuedTurnStartedAtMs = nowMs + 500;
  const finalQueuedTurnWorking = thread("working", 0, finalQueuedTurnStartedAtMs);
  trackCompletionTransitions(
    [queuedWorking],
    [finalQueuedTurnWorking],
    nowMs + 600
  );
  const finalQueuedTurnTerminal = thread(
    "completed",
    0,
    finalQueuedTurnStartedAtMs,
    nowMs + 5_000
  );
  trackCompletionTransitions(
    [finalQueuedTurnWorking],
    [finalQueuedTurnTerminal],
    nowMs + 5_100
  );
  const queuedFinalCompletionStaged = noCompletionEffect()
    && pendingCompletionByThreadId.get(threadId)?.endedAtMs === nowMs + 5_000;
  trackCompletionTransitions(
    [finalQueuedTurnTerminal],
    [finalQueuedTurnTerminal],
    nowMs + 5_200
  );
  const queuedFinalCompletionPulsed = queuedFinalCompletionStaged
    && completionPulseStartedAt.get(threadId) === nowMs + 5_200
    && globalCompletionStartedAtMs === nowMs + 5_200;

  resetTracker();
  const collapsedFinalStartedAtMs = nowMs + 500;
  const collapsedFinalEndedAtMs = nowMs + 2_500;
  const collapsedFinalTerminal = thread(
    "completed",
    0,
    collapsedFinalStartedAtMs,
    collapsedFinalEndedAtMs
  );
  trackCompletionTransitions(
    [queuedWorking],
    [collapsedFinalTerminal],
    nowMs + 2_600
  );
  const collapsedQueuedFinalStaged = noCompletionEffect()
    && pendingCompletionByThreadId.get(threadId)?.endedAtMs === collapsedFinalEndedAtMs;
  trackCompletionTransitions(
    [collapsedFinalTerminal],
    [collapsedFinalTerminal],
    nowMs + 2_800
  );
  const collapsedQueuedFinalPulsed = collapsedQueuedFinalStaged
    && completionPulseStartedAt.get(threadId) === nowMs + 2_800
    && globalCompletionStartedAtMs === nowMs + 2_800;

  resetTracker();
  const unknownStartQueuedWorking = thread("working", 1, null);
  trackCompletionTransitions(
    [unknownStartQueuedWorking],
    [collapsedFinalTerminal],
    nowMs + 2_600
  );
  const unknownStartCollapsedFinalStaged = noCompletionEffect()
    && pendingCompletionByThreadId.get(threadId)?.endedAtMs === collapsedFinalEndedAtMs;
  trackCompletionTransitions(
    [collapsedFinalTerminal],
    [collapsedFinalTerminal],
    nowMs + 2_800
  );
  const unknownStartCollapsedFinalPulsed = unknownStartCollapsedFinalStaged
    && completionPulseStartedAt.get(threadId) === nowMs + 2_800
    && globalCompletionStartedAtMs === nowMs + 2_800;

  resetTracker();
  const finalWorking = thread("working", 0, oldStartedAtMs);
  const finalTerminal = thread("completed", 0, oldStartedAtMs, nowMs);
  trackCompletionTransitions([finalWorking], [finalTerminal], nowMs + 100);
  const confirmedFinalCompletionStaged = noCompletionEffect()
    && pendingCompletionByThreadId.get(threadId)?.endedAtMs === nowMs;
  trackCompletionTransitions([finalTerminal], [finalTerminal], nowMs + 1_000);
  const firstPulseStartedAtMs = completionPulseStartedAt.get(threadId);
  const confirmedFinalCompletionPulsed = confirmedFinalCompletionStaged
    && firstPulseStartedAtMs === nowMs + 1_000
    && globalCompletionStartedAtMs === nowMs + 1_000
    && globalCompletionThreadId === threadId;
  const confirmedFinalCompletionUnread = unreadCompletionByThreadId.get(threadId)?.endedAtMs === nowMs;
  trackCompletionTransitions([finalTerminal], [finalTerminal], nowMs + 1_500);
  const identicalTerminalDidNotRetrigger = completionPulseStartedAt.get(threadId) === firstPulseStartedAtMs
    && globalCompletionStartedAtMs === firstPulseStartedAtMs;
  const persistentEffect = visibleCompletionPulseState(
    finalTerminal,
    firstPulseStartedAtMs + THREAD_COMPLETION_PULSE_DURATION_MS + 700
  );
  const unreadCompletionPersistsAfterInitialPulse = persistentEffect?.persistent === true
    && persistentEffect?.unread === true
    && persistentEffect.strength >= 0.3;
  acknowledgeCompletion(threadId, { persist: false, render: false });
  const acknowledgementClearsUnreadCompletion = !unreadCompletionByThreadId.has(threadId)
    && visibleCompletionPulseState(
      finalTerminal,
      firstPulseStartedAtMs + THREAD_COMPLETION_PULSE_DURATION_MS + 700
    ) === null;

  const passed = queueEditIgnored
    && remoteQueueHandoffIgnored
    && lateQueueHandoffNeverRendered
    && delayedOldMarkerIgnored
    && startupQueuedTerminalIgnored
    && queuedFinalCompletionPulsed
    && collapsedQueuedFinalPulsed
    && unknownStartCollapsedFinalPulsed
    && confirmedFinalCompletionPulsed
    && confirmedFinalCompletionUnread
    && identicalTerminalDidNotRetrigger
    && unreadCompletionPersistsAfterInitialPulse
    && acknowledgementClearsUnreadCompletion;
  resetTracker(false);
  return {
    passed,
    queueEditIgnored,
    oldTerminalAtHandoffIgnored,
    remoteQueueHandoffIgnored,
    ambiguousTerminalWasOnlyStaged,
    lateQueueHandoffNeverRendered,
    delayedOldMarkerIgnored,
    startupQueuedTerminalIgnored,
    queuedFinalCompletionStaged,
    queuedFinalCompletionPulsed,
    collapsedQueuedFinalStaged,
    collapsedQueuedFinalPulsed,
    unknownStartCollapsedFinalStaged,
    unknownStartCollapsedFinalPulsed,
    confirmedFinalCompletionStaged,
    confirmedFinalCompletionPulsed,
    confirmedFinalCompletionUnread,
    identicalTerminalDidNotRetrigger,
    unreadCompletionPersistsAfterInitialPulse,
    acknowledgementClearsUnreadCompletion
  };
}

function verifyCompletionFanout() {
  const nowMs = DEMO_EPOCH_MS + 10_000;
  const targetId = DEMO_COMPLETED_ID;
  const transitionPolicy = verifyCompletionTransitionPolicy(nowMs);
  const actions = [
    ACTIONS.weekly,
    ACTIONS.thread1,
    ACTIONS.topThread1,
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
  startCompletionEffects(targetId, nowMs);
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
  const targetTaskContextCount = 2;
  const passed = imageMessages.length === actions.length
    && allContextsSentOnce
    && globalChromeCount === actions.length - targetTaskContextCount
    && globalCompletionInitialFanoutPending === false
    && transitionPolicy.passed;
  console.log(JSON.stringify({
    passed,
    visibleContexts: actions.length,
    firstFrameImages: imageMessages.length,
    nonTargetGlobalChrome: globalChromeCount,
    transitionPolicy
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

  const rankedThreads = Array.from({ length: THREAD_COUNT }, (_, index) => ({
    ...stableThread,
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    title: `순위 작업 ${index + 1}`
  }));
  const offListCurrent = {
    ...stableThread,
    id: "00000000-0000-4000-8000-000000000099",
    title: "순위 밖 현재 작업"
  };
  primaryThreadId = offListCurrent.id;
  primaryThreadRow = offListCurrent;
  fastModeState = {
    threadId: offListCurrent.id,
    enabled: null,
    available: null,
    failed: false
  };
  hasLoadedThreadState = true;
  consecutiveThreadRefreshFailures = 0;
  threadRefreshUnavailable = false;
  const rankedSnapshotLoaded = await refreshThreads(null, {
    reader: async () => ({
      threads: rankedThreads,
      currentThread: offListCurrent
    }),
    retryDelays: []
  });
  const rankedListKeepsAllEight = rankedSnapshotLoaded
    && threadSlots.map((thread) => thread?.id).join(",")
      === rankedThreads.map((thread) => thread.id).join(",")
    && threadForAction(ACTIONS.thread1)?.id === offListCurrent.id
    && threadForAction(ACTIONS.topThread1)?.id === rankedThreads[0].id
    && threadForAction(ACTIONS.thread8)?.id === rankedThreads[7].id;

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
    && rankedListKeepsAllEight
    && sideChatCachePreserved
    && persistentSideChatReentryBlocked;
  console.log(JSON.stringify({
    passed,
    retryAttempts,
    keptLastGoodList,
    oneOffStartupHidden,
    rankedListKeepsAllEight,
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

  const sameTitlePeerId = "00000000-0000-4000-8000-000000000022";
  const sameTitle = "동일 제목 음성 대상";
  const [sameTitleTarget, sameTitlePeer] = annotateKnownTitleAmbiguity([
    { id: targetThreadId, title: sameTitle, remote: true },
    { id: sameTitlePeerId, title: sameTitle, remote: true }
  ], [
    { id: targetThreadId, title: sameTitle, remote: true },
    { id: sameTitlePeerId, title: sameTitle, remote: true }
  ]);
  threadSlots = [sameTitleTarget, sameTitlePeer, ...Array(THREAD_COUNT - 2).fill(null)];
  const identityProbeCalls = [];
  const identityProbe = async (command, args) => {
    identityProbeCalls.push({ command, args: [...args] });
    if (command === "codex-focused-thread-strict"
        && args.length === 1 && args[0] === targetThreadId) return { stdout: "match=uuid" };
    const error = new Error("simulated different focused UUID");
    error.exitCode = 1;
    throw error;
  };
  const sameTitleTargetFocused = await voiceTargetIsFocused(targetThreadId, {
    probe: identityProbe
  });
  const sameTitlePeerRejected = !(await voiceTargetIsFocused(sameTitlePeerId, {
    probe: identityProbe
  }));
  const sameTitleVoiceGuardUsesUuid = sameTitleTargetFocused
    && sameTitlePeerRejected
    && identityProbeCalls.length === 2
    && identityProbeCalls.every(({ command, args }) => command === "codex-focused-thread-strict"
      && args.length === 1)
    && identityProbeCalls[0].args[0] === targetThreadId
    && identityProbeCalls[1].args[0] === sameTitlePeerId;

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
    targetFocused: async () => true,
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

  voiceStateByContext.set(context, "submitting");
  voiceTargetThreadByContext.set(context, targetThreadId);
  voiceSessionIdByContext.set(context, sessionId);
  let fallbackFocusChecks = 0;
  const fallbackGuardCommands = [];
  await submitCompletedVoiceTranscription(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    openApp: async () => {},
    sleep: async () => {},
    targetFocused: async () => {
      fallbackFocusChecks += 1;
      return fallbackFocusChecks === 1;
    },
    bridge(command) {
      fallbackGuardCommands.push(command);
      return true;
    },
    waitForDraftReset: async () => false,
    scheduleRefresh: () => {}
  });
  const fallbackRechecksTarget = fallbackFocusChecks === 2
    && fallbackGuardCommands.join(",") === "codex-submit-composer"
    && voiceStateByContext.get(context) === "error";

  const staleCommands = [];
  voiceStateByContext.set(context, "submitting");
  voiceSessionIdByContext.set(context, ++nextVoiceSessionId);
  await submitCompletedVoiceTranscription(context, targetThreadId, {
    ...tracker,
    lastObserved: transcript
  }, {
    openApp: async () => {},
    sleep: async () => {},
    targetFocused: async () => true,
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
    targetFocused: async () => true,
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
    voiceReleasePendingContexts.clear();
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
      && resumeCount === 2;
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

  const clearVoiceGateTestState = () => {
    cancelVoiceReleaseRetry();
    for (const heldContext of voiceStartVerificationTimers.keys()) {
      clearVoiceStartVerification(heldContext);
    }
    voiceHeldContexts.clear();
    voiceReleasePendingContexts.clear();
    voiceTranscriptionByContext.clear();
    voiceStateByContext.clear();
    voiceStateResetAtMs.clear();
    voiceTargetThreadByContext.clear();
    voiceSessionIdByContext.clear();
    voiceMediaPauseOwners.clear();
    voiceMediaPaused = true;
    voiceReleaseProbeOnly = false;
  };
  const makeQueuedScheduler = (queue) => (callback) => {
    const token = { callback, cancelled: false };
    queue.push(token);
    return token;
  };
  const clearQueuedSchedule = (token) => { token.cancelled = true; };

  const failedReleaseContext = "voice-release-failure-context";
  contexts.set(failedReleaseContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(failedReleaseContext);
  voiceMediaPauseOwners.add(failedReleaseContext);
  voiceTranscriptionByContext.set(failedReleaseContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const failedReleaseCommands = [];
  const failedReleaseSchedules = [];
  let failedReleaseAttempts = 0;
  let failedReleaseResumeCount = 0;
  const failedReleaseOptions = {
    releaseVoice: () => {
      failedReleaseCommands.push("voice-up");
      failedReleaseAttempts += 1;
      return failedReleaseAttempts > 1 ? "inactive" : "unconfirmed-no-action";
    },
    stateReader: () => baseline,
    resumeMedia: (releasedContext) => {
      failedReleaseResumeCount += 1;
      voiceMediaPauseOwners.delete(releasedContext);
      if (voiceMediaPauseOwners.size === 0) voiceMediaPaused = false;
    },
    retryDelays: [0, 0],
    retrySchedule: makeQueuedScheduler(failedReleaseSchedules),
    retryClearSchedule: clearQueuedSchedule
  };
  const firstReleaseFailed = !endVoiceHoldSync(
    failedReleaseContext,
    true,
    failedReleaseOptions
  );
  let lifecycleBypassResumeCount = 0;
  const lifecyclePressState = {
    mediaPauseStarted: true,
    mediaPauseReleased: false,
    resumeMedia: () => { lifecycleBypassResumeCount += 1; }
  };
  releaseThreadMediaPause(lifecyclePressState, failedReleaseContext);
  const failedReleaseRetainsMedia = failedReleaseResumeCount === 0
    && firstReleaseFailed
    && failedReleaseSchedules.length === 1
    && voiceReleasePendingContexts.has(failedReleaseContext)
    && voiceMediaPauseOwners.has(failedReleaseContext)
    && voiceMediaPaused
    && !voiceHeldContexts.has(failedReleaseContext)
    && voiceTranscriptionByContext.has(failedReleaseContext)
    && voiceStateByContext.get(failedReleaseContext) === "error";
  const willDisappearCannotBypassReleaseGate = lifecycleBypassResumeCount === 0
    && !lifecyclePressState.mediaPauseReleased
    && voiceMediaPauseOwners.has(failedReleaseContext);
  const releaseRetrySucceeded = endVoiceHoldSync(
    failedReleaseContext,
    true,
    failedReleaseOptions
  );
  const retriedTracker = voiceTranscriptionByContext.get(failedReleaseContext);
  const failedReleaseCanBeRetried = releaseRetrySucceeded
    && failedReleaseCommands.join(",") === "voice-up,voice-up"
    && failedReleaseResumeCount === 1
    && !voiceReleasePendingContexts.has(failedReleaseContext)
    && !voiceMediaPauseOwners.has(failedReleaseContext)
    && !voiceMediaPaused
    && Number.isFinite(retriedTracker?.releasedAtMs)
    && voiceStateByContext.get(failedReleaseContext) === "transcribing";
  await failedReleaseSchedules[0].callback();
  const staleAutomaticRetryCancelled = failedReleaseSchedules[0].cancelled
    && failedReleaseCommands.length === 2;
  contexts.delete(failedReleaseContext);

  const automaticContext = "voice-auto-release-context";
  contexts.set(automaticContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(automaticContext);
  voiceMediaPauseOwners.add(automaticContext);
  voiceTranscriptionByContext.set(automaticContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const automaticSchedules = [];
  const automaticProbeOnly = [];
  let automaticResumeCount = 0;
  const automaticReleaseStarted = !endVoiceHoldSync(automaticContext, true, {
    releaseVoice: (_releaseContext, { probeOnly }) => {
      automaticProbeOnly.push(probeOnly);
      return probeOnly ? "inactive" : "unconfirmed-after-stop-action";
    },
    stateReader: () => baseline,
    resumeMedia: (releasedContext) => {
      automaticResumeCount += 1;
      voiceMediaPauseOwners.delete(releasedContext);
      voiceMediaPaused = voiceMediaPauseOwners.size > 0;
    },
    retryDelays: [0, 0],
    retrySchedule: makeQueuedScheduler(automaticSchedules),
    retryClearSchedule: clearQueuedSchedule
  });
  await automaticSchedules[0]?.callback();
  const automaticTracker = voiceTranscriptionByContext.get(automaticContext);
  const automaticReleaseRetryCompletes = automaticReleaseStarted
    && automaticProbeOnly.join(",") === "false,true"
    && automaticResumeCount === 1
    && !voiceReleasePendingContexts.has(automaticContext)
    && Number.isFinite(automaticTracker?.releasedAtMs)
    && voiceStateByContext.get(automaticContext) === "transcribing";
  const stopActionRetryUsesProbeOnly = automaticProbeOnly.length === 2
    && automaticProbeOnly[0] === false
    && automaticProbeOnly[1] === true;
  contexts.delete(automaticContext);

  const deferredDisappearContext = "voice-deferred-disappear-context";
  contexts.set(deferredDisappearContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(deferredDisappearContext);
  voiceMediaPauseOwners.add(deferredDisappearContext);
  voiceTranscriptionByContext.set(deferredDisappearContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  voiceSessionIdByContext.set(
    deferredDisappearContext,
    voiceTranscriptionByContext.get(deferredDisappearContext).sessionId
  );
  voiceTargetThreadByContext.set(deferredDisappearContext, targetThreadId);
  voiceStateByContext.set(deferredDisappearContext, "recording");
  const deferredDisappearSchedules = [];
  const deferredDisappearProbeOnly = [];
  let signalDeferredRetryStarted;
  const deferredRetryStarted = new Promise((resolve) => {
    signalDeferredRetryStarted = resolve;
  });
  let resolveDeferredRetryOutcome;
  const deferredRetryOutcome = new Promise((resolve) => {
    resolveDeferredRetryOutcome = resolve;
  });
  let deferredDisappearResumeCount = 0;
  const deferredDisappearOptions = {
    releaseVoice: (_releaseContext, { probeOnly }) => {
      deferredDisappearProbeOnly.push(probeOnly);
      if (!probeOnly) return "unconfirmed-after-stop-action";
      signalDeferredRetryStarted();
      return deferredRetryOutcome;
    },
    stateReader: () => baseline,
    resumeMedia: (releasedContext) => {
      deferredDisappearResumeCount += 1;
      voiceMediaPauseOwners.delete(releasedContext);
      voiceMediaPaused = voiceMediaPauseOwners.size > 0;
    },
    retryDelays: [0],
    retrySchedule: makeQueuedScheduler(deferredDisappearSchedules),
    retryClearSchedule: clearQueuedSchedule
  };
  const deferredInitialReleaseFailed = !endVoiceHoldSync(
    deferredDisappearContext,
    true,
    deferredDisappearOptions
  );
  const deferredRetryRun = deferredDisappearSchedules[0]?.callback();
  await deferredRetryStarted;
  const callsBeforeOverlappingRelease = deferredDisappearProbeOnly.length;
  const overlappingReleaseStayedSingleFlight = !endVoiceHoldSync(
    deferredDisappearContext,
    false,
    deferredDisappearOptions
  ) && deferredDisappearProbeOnly.length === callsBeforeOverlappingRelease;
  // Mirror willDisappear cleanup while the native probe is still unresolved.
  cancelVoiceTranscription(deferredDisappearContext);
  voiceStateByContext.delete(deferredDisappearContext);
  voiceSessionIdByContext.delete(deferredDisappearContext);
  contexts.delete(deferredDisappearContext);
  resolveDeferredRetryOutcome("inactive");
  await deferredRetryRun;
  const asyncReleaseRetryIsSingleFlight = deferredInitialReleaseFailed
    && overlappingReleaseStayedSingleFlight
    && deferredDisappearProbeOnly.join(",") === "false,true"
    && voiceReleaseAttemptInFlight === null;
  const disappearedContextIsNotRecreated = deferredDisappearResumeCount === 1
    && !voiceHeldContexts.has(deferredDisappearContext)
    && !voiceReleasePendingContexts.has(deferredDisappearContext)
    && !voiceMediaPauseOwners.has(deferredDisappearContext)
    && !voiceMediaPaused
    && !voiceTranscriptionByContext.has(deferredDisappearContext)
    && !voiceStateByContext.has(deferredDisappearContext)
    && !voiceStateResetAtMs.has(deferredDisappearContext)
    && !voiceTargetThreadByContext.has(deferredDisappearContext)
    && !voiceSessionIdByContext.has(deferredDisappearContext);

  const uncertainReleaseContext = "voice-uncertain-release-context";
  contexts.set(uncertainReleaseContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(uncertainReleaseContext);
  voiceMediaPauseOwners.add(uncertainReleaseContext);
  voiceTranscriptionByContext.set(uncertainReleaseContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const uncertainReleaseSchedules = [];
  const uncertainReleaseProbeOnly = [];
  endVoiceHoldSync(uncertainReleaseContext, false, {
    releaseVoice: (_releaseContext, { probeOnly }) => {
      uncertainReleaseProbeOnly.push(probeOnly);
      return probeOnly ? "inactive" : "unknown-possible-action";
    },
    resumeMedia: (releasedContext) => {
      voiceMediaPauseOwners.delete(releasedContext);
      voiceMediaPaused = voiceMediaPauseOwners.size > 0;
    },
    retryDelays: [0],
    retrySchedule: makeQueuedScheduler(uncertainReleaseSchedules),
    retryClearSchedule: clearQueuedSchedule
  });
  await uncertainReleaseSchedules[0]?.callback();
  const uncertainReleaseRetryUsesProbeOnly = uncertainReleaseProbeOnly.join(",") === "false,true"
    && !voiceReleasePendingContexts.has(uncertainReleaseContext)
    && !voiceMediaPauseOwners.has(uncertainReleaseContext)
    && !voiceMediaPaused;
  contexts.delete(uncertainReleaseContext);

  const reportedUnknownContext = "voice-reported-unknown-context";
  contexts.set(reportedUnknownContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(reportedUnknownContext);
  voiceMediaPauseOwners.add(reportedUnknownContext);
  voiceTranscriptionByContext.set(reportedUnknownContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const reportedUnknownSchedules = [];
  const reportedUnknownProbeOnly = [];
  endVoiceHoldSync(reportedUnknownContext, false, {
    releaseVoice: (_releaseContext, { probeOnly }) => {
      reportedUnknownProbeOnly.push(probeOnly);
      return reportedUnknownProbeOnly.length === 1 ? "unknown" : "inactive";
    },
    resumeMedia: (releasedContext) => {
      voiceMediaPauseOwners.delete(releasedContext);
      voiceMediaPaused = voiceMediaPauseOwners.size > 0;
    },
    retryDelays: [0],
    retrySchedule: makeQueuedScheduler(reportedUnknownSchedules),
    retryClearSchedule: clearQueuedSchedule
  });
  await reportedUnknownSchedules[0]?.callback();
  const reportedUnknownCanRetryVoiceUp = reportedUnknownProbeOnly.join(",") === "false,false"
    && !voiceReleasePendingContexts.has(reportedUnknownContext)
    && !voiceMediaPauseOwners.has(reportedUnknownContext)
    && !voiceMediaPaused;
  contexts.delete(reportedUnknownContext);

  const boundedContext = "voice-bounded-release-context";
  contexts.set(boundedContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(boundedContext);
  voiceMediaPauseOwners.add(boundedContext);
  voiceTranscriptionByContext.set(boundedContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const boundedSchedules = [];
  let boundedReleaseAttempts = 0;
  endVoiceHoldSync(boundedContext, true, {
    releaseVoice: () => {
      boundedReleaseAttempts += 1;
      return "unconfirmed-no-action";
    },
    stateReader: () => baseline,
    resumeMedia: () => {},
    retryDelays: [0, 0],
    retrySchedule: makeQueuedScheduler(boundedSchedules),
    retryClearSchedule: clearQueuedSchedule
  });
  for (let index = 0; index < boundedSchedules.length; index += 1) {
    await boundedSchedules[index].callback();
  }
  const automaticReleaseRetryIsBounded = boundedReleaseAttempts === 3
    && boundedSchedules.length === 2
    && voiceReleaseRetryState === null
    && voiceReleasePendingContexts.has(boundedContext)
    && voiceMediaPauseOwners.has(boundedContext);
  contexts.delete(boundedContext);

  clearVoiceGateTestState();
  voiceHeldContexts.add(context);
  voiceMediaPauseOwners.add(context);
  const failedSupersedeSessionId = ++nextVoiceSessionId;
  voiceTranscriptionByContext.set(context, {
    ...tracker,
    sessionId: failedSupersedeSessionId
  });
  voiceSessionIdByContext.set(context, failedSupersedeSessionId);
  const failedSupersedeCommands = [];
  const failedSupersedeOptions = {
    autoSubmit: true,
    composerAlreadyFocused: true,
    bridge(command) {
      if (command !== "voice-up") failedSupersedeCommands.push(command);
      return true;
    },
    releaseVoice: () => {
      failedSupersedeCommands.push("voice-up");
      return "unconfirmed-no-action";
    },
    stateReader: () => baseline,
    pauseMedia: (pauseContext) => { voiceMediaPauseOwners.add(pauseContext); },
    resumeMedia: (resumeContext) => { voiceMediaPauseOwners.delete(resumeContext); },
    retryDelays: []
  };
  const blockedNewHold = !beginVoiceHoldSync(otherContext, {
    ...failedSupersedeOptions,
    targetThreadId: otherTargetThreadId
  });
  const failedSupersedeBlocksNewVoice = blockedNewHold
    && failedSupersedeCommands.join(",") === "voice-up"
    && voiceReleasePendingContexts.has(context)
    && voiceMediaPauseOwners.has(context)
    && !voiceMediaPauseOwners.has(otherContext)
    && voiceSessionIdByContext.has(context)
    && !voiceSessionIdByContext.has(otherContext);

  const unknownStartContext = "voice-start-unknown-context";
  contexts.set(unknownStartContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(unknownStartContext);
  voiceMediaPauseOwners.add(unknownStartContext);
  voiceTranscriptionByContext.set(unknownStartContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  const unknownVerificationSchedules = [];
  let unknownStartReleaseCalls = 0;
  verifyVoiceStarted(unknownStartContext, {
    audioInputState: () => "unknown",
    releaseVoice: () => {
      unknownStartReleaseCalls += 1;
      return "inactive";
    },
    unknownRetryDelays: [0],
    verificationSchedule: makeQueuedScheduler(unknownVerificationSchedules),
    reportError: () => {}
  });
  await unknownVerificationSchedules[0]?.callback();
  const persistentUnknownStartKeepsHold = unknownVerificationSchedules.length === 1
    && unknownStartReleaseCalls === 0
    && voiceHeldContexts.has(unknownStartContext)
    && !voiceReleasePendingContexts.has(unknownStartContext)
    && voiceMediaPauseOwners.has(unknownStartContext)
    && voiceTranscriptionByContext.has(unknownStartContext);
  contexts.delete(unknownStartContext);

  const startFailureContext = "voice-start-failure-context";
  contexts.set(startFailureContext, ACTIONS.voice);
  clearVoiceGateTestState();
  voiceHeldContexts.add(startFailureContext);
  voiceMediaPauseOwners.add(startFailureContext);
  voiceTranscriptionByContext.set(startFailureContext, {
    ...tracker,
    sessionId: ++nextVoiceSessionId
  });
  let startFailureResumeCount = 0;
  verifyVoiceStarted(startFailureContext, {
    audioInputState: () => "inactive",
    releaseVoice: () => "unconfirmed-no-action",
    resumeMedia: () => { startFailureResumeCount += 1; },
    retryDelays: [],
    reportError: () => {}
  });
  const failedStartReleaseRetainsMedia = startFailureResumeCount === 0
    && voiceReleasePendingContexts.has(startFailureContext)
    && voiceMediaPauseOwners.has(startFailureContext)
    && voiceMediaPaused
    && !voiceHeldContexts.has(startFailureContext)
    && voiceStateByContext.get(startFailureContext) === "error";
  contexts.delete(startFailureContext);

  const shutdownContext = "voice-shutdown-context";
  clearVoiceGateTestState();
  voiceReleasePendingContexts.add(shutdownContext);
  voiceMediaPauseOwners.add(shutdownContext);
  shutdownCleanupStarted = false;
  shutdownCleanupResult = true;
  let shutdownReleaseCalls = 0;
  const failedShutdownCommands = [];
  const shutdownFailure = !releaseVoiceKeysSync({
    releaseVoice: () => {
      shutdownReleaseCalls += 1;
      return "unconfirmed-no-action";
    },
    bridge(command) {
      failedShutdownCommands.push(command);
      return true;
    }
  });
  const secondShutdownResult = releaseVoiceKeysSync({
    releaseVoice: () => {
      shutdownReleaseCalls += 1;
      return "inactive";
    },
    bridge(command) {
      failedShutdownCommands.push(`second-${command}`);
      return true;
    }
  });
  const shutdownFailureKeepsMediaPaused = shutdownFailure
    && !secondShutdownResult
    && shutdownReleaseCalls === 1
    && failedShutdownCommands.join(",") === "release"
    && voiceReleasePendingContexts.has(shutdownContext)
    && voiceMediaPauseOwners.has(shutdownContext)
    && voiceMediaPaused;
  const shutdownCleanupIsIdempotent = shutdownReleaseCalls === 1
    && !failedShutdownCommands.some((command) => command.startsWith("second-"));

  shutdownCleanupStarted = false;
  shutdownCleanupResult = true;
  voiceReleaseProbeOnly = false;
  const successfulShutdownCommands = [];
  const shutdownSucceeded = releaseVoiceKeysSync({
    releaseVoice: () => "inactive",
    bridge(command) {
      successfulShutdownCommands.push(command);
      return true;
    }
  });
  const shutdownSuccessRestoresMedia = shutdownSucceeded
    && successfulShutdownCommands.join(",") === "media-play-pause"
    && !voiceReleasePendingContexts.has(shutdownContext)
    && voiceMediaPauseOwners.size === 0
    && !voiceMediaPaused;

  const passed = Boolean(baseline && transcript && buttonFocusFallback)
    && ignoredFocusTypeChange
    && detectedStableTranscript
    && rejectedUnchangedDraft
    && acceptedStableReset
    && retriedUnconfirmedSubmit
    && successRequiresConfirmation
    && fallbackRechecksTarget
    && sameTitleVoiceGuardUsesUuid
    && staleSubmissionIgnored
    && crossContextSubmissionIgnored
    && overlappingOldThenNewRelease
    && overlappingNewThenOldRelease
    && failedReleaseRetainsMedia
    && willDisappearCannotBypassReleaseGate
    && failedReleaseCanBeRetried
    && staleAutomaticRetryCancelled
    && automaticReleaseRetryCompletes
    && automaticReleaseRetryIsBounded
    && stopActionRetryUsesProbeOnly
    && asyncReleaseRetryIsSingleFlight
    && disappearedContextIsNotRecreated
    && uncertainReleaseRetryUsesProbeOnly
    && reportedUnknownCanRetryVoiceUp
    && failedSupersedeBlocksNewVoice
    && persistentUnknownStartKeepsHold
    && failedStartReleaseRetainsMedia
    && shutdownFailureKeepsMediaPaused
    && shutdownCleanupIsIdempotent
    && shutdownSuccessRestoresMedia;
  console.log(JSON.stringify({
    passed,
    ignoredFocusTypeChange,
    detectedStableTranscript,
    rejectedUnchangedDraft,
    acceptedStableReset,
    retriedUnconfirmedSubmit,
    successRequiresConfirmation,
    fallbackRechecksTarget,
    sameTitleVoiceGuardUsesUuid,
    staleSubmissionIgnored,
    crossContextSubmissionIgnored,
    overlappingOldThenNewRelease,
    overlappingNewThenOldRelease,
    failedReleaseRetainsMedia,
    willDisappearCannotBypassReleaseGate,
    failedReleaseCanBeRetried,
    staleAutomaticRetryCancelled,
    automaticReleaseRetryCompletes,
    automaticReleaseRetryIsBounded,
    stopActionRetryUsesProbeOnly,
    asyncReleaseRetryIsSingleFlight,
    disappearedContextIsNotRecreated,
    uncertainReleaseRetryUsesProbeOnly,
    reportedUnknownCanRetryVoiceUp,
    failedSupersedeBlocksNewVoice,
    persistentUnknownStartKeepsHold,
    failedStartReleaseRetainsMedia,
    shutdownFailureKeepsMediaPaused,
    shutdownCleanupIsIdempotent,
    shutdownSuccessRestoresMedia
  }));
  if (!passed) process.exitCode = 1;
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  threadSlots = Array(THREAD_COUNT).fill(null);
  socket = null;
}

async function verifyInteractionPolicy() {
  const fastStatuses = ["working", "stopped", "idle", "error"];
  const activity = { kind: "think", label: "생각 중" };
  const fastBadgeNonCompletedStates = fastStatuses.every((status) => threadHeader(
    THEME.green,
    status,
    "대기",
    activity,
    status === "working",
    "xhigh",
    "priority",
    null
  ).includes('data-mode="fast"'));
  const completedHidesFastBadge = !threadHeader(
    THEME.green,
    "completed",
    "완료",
    { kind: "complete", label: "작업 완료" },
    false,
    "xhigh",
    "priority",
    { strength: 0 }
  ).includes('data-mode="fast"');
  const standardHasNoFastBadge = [...fastStatuses, "completed"].every((status) => !threadHeader(
    THEME.green,
    status,
    status === "completed" ? "완료" : "대기",
    activity,
    status === "working",
    "xhigh",
    "default",
    status === "completed" ? { strength: 0 } : null
  ).includes('data-mode="fast"'));

  const goalThreadBase = {
    id: "00000000-0000-4000-8000-000000000020",
    title: "목표 표시 확인",
    remote: true,
    queueCount: 0,
    startedAtMs: 120_000,
    endedAtMs: 130_000
  };
  const activeGoalMarkup = threadSvg({
    ...goalThreadBase,
    status: "working",
    goal: { status: "active", timeUsedSeconds: 125, updatedAtMs: Date.now() }
  }, 0);
  const blockedGoalMarkup = threadSvg({
    ...goalThreadBase,
    status: "stopped",
    goal: { status: "blocked", timeUsedSeconds: 125, updatedAtMs: 100_000 }
  }, 0);
  const completedGoalMarkup = threadSvg({
    ...goalThreadBase,
    status: "completed",
    goal: { status: "complete", timeUsedSeconds: 125, updatedAtMs: 100_000 }
  }, 0);
  const activeGoalUsesOfficialBadge = activeGoalMarkup.includes('data-goal="active"')
    && activeGoalMarkup.includes('d="M12 13V2l8 4-8 4"');
  const blockedGoalBadgeAndTimeFreeze = blockedGoalMarkup.includes('data-goal="blocked"')
    && blockedGoalMarkup.includes(">02:05</text>");
  const completedGoalHidesBadgeButKeepsTotal = !completedGoalMarkup.includes("data-goal=")
    && completedGoalMarkup.includes(">02:05</text>");
  const completedGoalLifetimeFollowsTurn = !goalPredatesWorkingTurn(
    { status: "complete", updatedAtMs: 120_000 },
    { status: "working", startedAtMs: 90_000 }
  ) && goalPredatesWorkingTurn(
    { status: "complete", updatedAtMs: 120_000 },
    { status: "working", startedAtMs: 130_000 }
  );

  const goalProbeThread = {
    id: "00000000-0000-4000-8000-000000000021",
    title: "원격 목표 감지",
    remote: true
  };
  goalProbe = { threadId: null, checkedAtMs: 0, absentCount: 0 };
  observedGoalByThreadId.delete(goalProbeThread.id);
  confirmedGoalAbsentByThreadId.delete(goalProbeThread.id);
  const detectedRemoteGoal = await refreshFocusedGoalState(goalProbeThread, 10_000, {
    probe: async () => ({ stdout: "state=active elapsed=42 visited=80" })
  });
  const retainedUnknownGoalTime = await refreshFocusedGoalState(goalProbeThread, 13_000, {
    probe: async () => ({ stdout: "state=active elapsed=unknown visited=80" })
  });
  const explicitNoGoalProbe = async () => {
    const error = new Error("simulated complete no-goal scan");
    error.exitCode = 2;
    error.stdout = "state=none elapsed=0 visited=80";
    throw error;
  };
  const firstMissingGoal = await refreshFocusedGoalState(goalProbeThread, 16_000, {
    probe: explicitNoGoalProbe
  });
  const secondMissingGoal = await refreshFocusedGoalState(goalProbeThread, 19_000, {
    probe: explicitNoGoalProbe
  });
  const remoteGoalProbeNeedsStableAbsence = detectedRemoteGoal?.status === "active"
    && retainedUnknownGoalTime?.timeUsedSeconds === 45
    && firstMissingGoal?.status === "active"
    && secondMissingGoal === null
    && confirmedGoalAbsentByThreadId.has(goalProbeThread.id);
  const unknownNewGoalAfterComplete = mergeObservedGoal({
    threadId: goalProbeThread.id,
    goalId: "finished-goal",
    status: "complete",
    timeUsedSeconds: 9_000,
    updatedAtMs: 20_000,
    source: "accessibility"
  }, {
    threadId: goalProbeThread.id,
    goalId: null,
    status: "active",
    timeUsedSeconds: null,
    updatedAtMs: 21_000,
    source: "accessibility",
    timeUnknown: true
  }, 21_000);
  const unknownNewGoalDoesNotInheritCompletedTime = unknownNewGoalAfterComplete.goalId === null
    && unknownNewGoalAfterComplete.timeUsedSeconds === null;
  const expiredGoalThreadId = "00000000-0000-4000-8000-000000000022";
  observedGoalByThreadId.set(expiredGoalThreadId, {
    threadId: expiredGoalThreadId,
    status: "active",
    timeUsedSeconds: 5,
    updatedAtMs: 1
  });
  pruneExpiredRemoteGoals(REMOTE_GOAL_CACHE_MAX_AGE_MS + 2);
  const expiredRemoteGoalCacheIsPruned = !observedGoalByThreadId.has(expiredGoalThreadId)
    && confirmedGoalAbsentByThreadId.has(expiredGoalThreadId);

  const remoteThread = {
    id: "00000000-0000-4000-8000-000000000030",
    title: "원격 전환 확인",
    remote: true,
    status: "working"
  };
  const sameTitleRemotePeer = {
    id: "00000000-0000-4000-8000-000000000031",
    title: remoteThread.title,
    remote: true,
    status: "working"
  };
  const [ambiguousRemote, ambiguousRemotePeer] = annotateKnownTitleAmbiguity([
    remoteThread,
    sameTitleRemotePeer
  ], [
    remoteThread,
    sameTitleRemotePeer
  ]);
  const [uniqueRemote] = annotateKnownTitleAmbiguity([remoteThread], [remoteThread]);
  const knownTitleAmbiguityDetected = ambiguousRemote.titleAmbiguous === true
    && uniqueRemote.titleAmbiguous === false;
  const ambiguousTitleUsesStrictIdentity = remoteThreadKeyBridgeCommand(
    ambiguousRemote,
    "codex-open-thread"
  ) === "codex-open-thread-strict"
    && remoteThreadKeyBridgeCommand(uniqueRemote, "codex-open-thread") === "codex-open-thread";
  threadSlots = [ambiguousRemote, ambiguousRemotePeer, ...Array(THREAD_COUNT - 2).fill(null)];
  const focusedIdentityCalls = [];
  const focusedIdentityProbe = async (command, args) => {
    focusedIdentityCalls.push({ command, args: [...args] });
    if (command === "codex-focused-thread-strict"
        && args.length === 1 && args[0] === ambiguousRemote.id) return { stdout: "match=uuid" };
    const error = new Error("simulated different focused UUID");
    error.exitCode = 1;
    throw error;
  };
  const ambiguousVoiceTargetFocused = await voiceTargetIsFocused(ambiguousRemote.id, {
    probe: focusedIdentityProbe
  });
  const ambiguousVoicePeerRejected = !(await voiceTargetIsFocused(ambiguousRemotePeer.id, {
    probe: focusedIdentityProbe
  }));
  const sameTitleVoiceTargetIsIdentitySafe = ambiguousVoiceTargetFocused
    && ambiguousVoicePeerRejected
    && focusedIdentityCalls.length === 2
    && focusedIdentityCalls.every(({ command, args }) => command === "codex-focused-thread-strict"
      && args.length === 1)
    && focusedIdentityCalls[0].args[0] === ambiguousRemote.id
    && focusedIdentityCalls[1].args[0] === ambiguousRemotePeer.id;
  const manuallyActiveThread = {
    id: "00000000-0000-4000-8000-000000000032",
    title: "Codex 앱에서 직접 선택한 작업",
    remote: false,
    status: "idle"
  };
  primaryThreadId = remoteThread.id;
  primaryThreadRow = remoteThread;
  const currentIdentityCalls = [];
  const currentIdentityProbe = async (command, args) => {
    currentIdentityCalls.push({ command, args: [...args] });
    if (command === "codex-current-thread" && args[0] === manuallyActiveThread.id) {
      return { stdout: "match=title" };
    }
    const error = new Error("simulated different active Codex task");
    error.exitCode = 1;
    throw error;
  };
  const manuallySelectedCurrent = await verifiedCurrentCodexThread([
    {
      focused: true,
      headers: new Set(titleFingerprints(manuallyActiveThread.title)),
      buttons: new Map()
    }
  ], [remoteThread, manuallyActiveThread], {
    probe: currentIdentityProbe
  });
  if (manuallySelectedCurrent) {
    rememberVerifiedThread(manuallySelectedCurrent, {
      promote: false,
      refreshFastMode: false
    });
  }
  const manualCodexSelectionOverridesStreamDeckHistory = manuallySelectedCurrent?.id === manuallyActiveThread.id
    && primaryThreadId === manuallyActiveThread.id
    && primaryThreadRow?.id === manuallyActiveThread.id
    && currentIdentityCalls.length === 1
    && currentIdentityCalls[0].command === "codex-current-thread"
    && currentIdentityCalls[0].args[0] === manuallyActiveThread.id;
  const composerTurnStartedAtMs = 180_000;
  remoteLifecycleCache.set(remoteThread.id, {
    status: "working",
    startedAtMs: composerTurnStartedAtMs,
    endedAtMs: null,
    latestTurnId: "00000000-0000-7000-8000-000000000032"
  });
  const focusedRemoteForSpeed = {
    ...remoteThread,
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    serviceTier: null
  };
  threadSlots = [focusedRemoteForSpeed, ...Array(THREAD_COUNT - 1).fill(null)];
  primaryThreadId = focusedRemoteForSpeed.id;
  primaryThreadRow = focusedRemoteForSpeed;
  const remoteFastApplied = applyFocusedRemoteComposerState(
    focusedRemoteForSpeed,
    { enabled: true, available: true },
    composerTurnStartedAtMs + 500
  );
  const remoteFastCardShowsBolt = threadSlots[0]?.serviceTier === "priority"
    && threadSvg(threadSlots[0], 0).includes('data-mode="fast"');
  const remoteStandardApplied = applyFocusedRemoteComposerState(
    threadSlots[0],
    { enabled: false, available: true },
    composerTurnStartedAtMs + 700
  );
  const remoteStandardCardClearsBolt = threadSlots[0]?.serviceTier === "default"
    && !threadSvg(threadSlots[0], 0).includes('data-mode="fast"');
  const focusedRemoteSpeedUpdatesImmediately = remoteFastApplied
    && remoteFastCardShowsBolt
    && remoteStandardApplied
    && remoteStandardCardClearsBolt;
  remoteComposerStateByThreadId.delete(remoteThread.id);
  remoteLifecycleCache.delete(remoteThread.id);
  let directAttempts = 0;
  let searchAttempts = 0;
  const activationOrder = [];
  await performRemoteNavigation(remoteThread, 2, {
    openApp: async () => { activationOrder.push("open"); },
    waitFrontmost: async () => { activationOrder.push("frontmost"); },
    sleep: async () => {},
    focused: async () => false,
    directOpen: async () => {
      activationOrder.push("direct");
      directAttempts += 1;
      const error = new Error("simulated sidebar miss");
      error.exitCode = 1;
      throw error;
    },
    searchOpen: async () => {
      activationOrder.push("search");
      searchAttempts += 1;
    },
    waitFocused: async () => true
  });
  const fallbackSearchRunsOnce = directAttempts === 2 && searchAttempts === 1;
  const activationWaitRunsOnceBeforeNavigation = activationOrder.join(",")
    === "open,frontmost,direct,direct,search";

  let delayedDirectAttempts = 0;
  let delayedDirectFocusChecks = 0;
  let delayedDirectSearches = 0;
  await performRemoteNavigation(remoteThread, 2, {
    openApp: async () => {},
    waitFrontmost: async () => {},
    sleep: async () => {},
    directOpen: async () => { delayedDirectAttempts += 1; },
    searchOpen: async () => { delayedDirectSearches += 1; },
    waitFocused: async () => {
      delayedDirectFocusChecks += 1;
      return delayedDirectFocusChecks >= 2;
    }
  });
  const successfulButUnreadyDirectRetries = delayedDirectAttempts === 2
    && delayedDirectFocusChecks === 2
    && delayedDirectSearches === 0;

  let postSearchDirectAttempts = 0;
  let postSearchAttempts = 0;
  let postSearchFocusChecks = 0;
  await performRemoteNavigation(remoteThread, 2, {
    openApp: async () => {},
    waitFrontmost: async () => {},
    sleep: async () => {},
    directOpen: async () => {
      postSearchDirectAttempts += 1;
      const error = new Error("simulated sidebar miss");
      error.exitCode = 1;
      throw error;
    },
    searchOpen: async () => { postSearchAttempts += 1; },
    waitFocused: async () => {
      postSearchFocusChecks += 1;
      return postSearchFocusChecks >= 2;
    }
  });
  const unifiedSearchRevalidatesWithoutDuplicate = postSearchDirectAttempts === 2
    && postSearchAttempts === 1
    && postSearchFocusChecks === 2;

  const localThreadA = {
    id: "00000000-0000-4000-8000-000000000040",
    title: "로컬 현재 작업",
    status: "idle",
    recency_at: 100
  };
  const localThreadB = {
    id: "00000000-0000-4000-8000-000000000041",
    title: "로컬 전환 작업",
    status: "idle",
    recency_at: 90
  };
  const localThreadC = {
    id: "00000000-0000-4000-8000-000000000042",
    title: "로컬 최근 작업",
    status: "idle",
    recency_at: 200
  };
  let localOpenAttempts = 0;
  let localFrontmostChecks = 0;
  let localFocusChecks = 0;
  await performDeepLinkNavigation(localThreadB, 1, {
    openUrl: async () => { localOpenAttempts += 1; },
    waitFrontmost: async () => { localFrontmostChecks += 1; },
    waitFocused: async () => {
      localFocusChecks += 1;
      return localFocusChecks >= 2;
    },
    sleep: async () => {}
  });
  const firstClickLocalRetries = localOpenAttempts === 2
    && localFrontmostChecks === 2
    && localFocusChecks === 2;

  activeRemoteNavigation = null;
  let resolveOpenApp;
  const openAppGate = new Promise((resolve) => { resolveOpenApp = resolve; });
  let openAppAttempts = 0;
  const coalesceOptions = {
    openApp: async () => {
      openAppAttempts += 1;
      await openAppGate;
    },
    waitFrontmost: async () => {},
    sleep: async () => {},
    directOpen: async () => {},
    waitFocused: async () => true
  };
  const firstNavigation = navigateRemoteThread(remoteThread, 2, coalesceOptions);
  const secondNavigation = navigateRemoteThread(remoteThread, 2, coalesceOptions);
  const sameTargetSharesNavigation = firstNavigation === secondNavigation && openAppAttempts === 1;
  resolveOpenApp();
  await Promise.all([firstNavigation, secondNavigation]);
  const navigationLeaseCleared = activeRemoteNavigation === null;

  socket = { readyState: WebSocket.OPEN, send() {} };
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  contextFeedback.clear();
  threadPressByContext.clear();
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  const currentSlotContext = "interaction-current-slot";
  contexts.set(currentSlotContext, ACTIONS.thread2);
  threadSlots = [localThreadA, localThreadB, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];
  primaryThreadId = localThreadC.id;
  primaryThreadRow = localThreadC;
  const independentCurrentAndRankedActions = threadForAction(ACTIONS.thread1)?.id === localThreadC.id
    && threadForAction(ACTIONS.topThread1)?.id === localThreadA.id
    && threadForAction(ACTIONS.thread2)?.id === localThreadB.id;
  primaryThreadId = localThreadA.id;
  primaryThreadRow = localThreadA;
  markUnreadCompletion(localThreadB.id, DEMO_EPOCH_MS, DEMO_EPOCH_MS, { persist: false });
  const originalConsoleError = console.error;
  console.error = () => {};
  const failedLocalNavigation = await openThread(currentSlotContext, 1, {
    navigateDeepLink: async () => { throw new Error("simulated navigation failure"); },
    scheduleRefresh: () => {},
    feedback: () => {},
    rememberThread: (thread) => rememberVerifiedThread(thread, { refreshFastMode: false })
  });
  console.error = originalConsoleError;
  const failedNavigationKeepsCurrentSlot = !failedLocalNavigation
    && primaryThreadId === localThreadA.id
    && threadSlots[0]?.id === localThreadA.id;
  const failedNavigationKeepsUnreadCompletion = unreadCompletionByThreadId.has(localThreadB.id);
  const successfulLocalNavigation = await openThread(currentSlotContext, 1, {
    navigateDeepLink: async () => true,
    scheduleRefresh: () => {},
    feedback: () => {},
    rememberThread: (thread) => rememberVerifiedThread(thread, { refreshFastMode: false })
  });
  const verifiedNavigationUpdatesCurrentOnly = successfulLocalNavigation
    && primaryThreadId === localThreadB.id
    && primaryThreadRow?.id === localThreadB.id
    && threadSlots[0]?.id === localThreadA.id
    && threadSlots[1]?.id === localThreadB.id
    && threadSlots.filter((thread) => thread?.id === localThreadB.id).length === 1;
  const successfulNavigationAcknowledgesCompletion = !unreadCompletionByThreadId.has(localThreadB.id);
  const refreshedCurrentRows = primaryFirstThreadRows(
    [localThreadC, localThreadA],
    [localThreadC, localThreadA]
  );
  const refreshPreservesCurrentSlot = refreshedCurrentRows[0]?.id === localThreadB.id
    && refreshedCurrentRows.filter((thread) => thread?.id === localThreadB.id).length === 1;
  primaryThreadId = remoteThread.id;
  primaryThreadRow = remoteThread;
  const currentRemoteRows = primaryFirstThreadRows(
    [localThreadC, localThreadA],
    [remoteThread, localThreadC, localThreadA]
  );
  const currentUnpinnedRemoteIsSlotOneException = currentRemoteRows[0]?.id === remoteThread.id
    && currentRemoteRows.filter((thread) => thread?.id === remoteThread.id).length === 1;
  const stalePrimary = {
    ...remoteThread,
    title: "동일 제목 원격 작업",
    remote: true,
    ephemeral: false
  };
  const sameTitleFreshRemote = {
    ...remoteThread,
    id: "00000000-0000-4000-8000-000000000043",
    title: stalePrimary.title,
    remote: true,
    ephemeral: false
  };
  primaryThreadId = stalePrimary.id;
  primaryThreadRow = stalePrimary;
  const retainedStaleRows = primaryFirstThreadRows(
    [sameTitleFreshRemote],
    [sameTitleFreshRemote]
  );
  const annotatedRetainedRows = annotateKnownTitleAmbiguity(
    retainedStaleRows,
    [stalePrimary, sameTitleFreshRemote]
  );
  const staleCurrentRequiresStrictIdentity = retainedStaleRows[0]?.requiresStrictIdentity === true
    && remoteThreadKeyBridgeCommand(retainedStaleRows[0], "codex-open-thread")
      === "codex-open-thread-strict"
    && annotatedRetainedRows[1]?.titleAmbiguous === true;
  primaryThreadId = localThreadB.id;
  primaryThreadRow = { ...localThreadB, remote: true, ephemeral: true };
  const normalizedCurrentRows = primaryFirstThreadRows(
    [{ ...localThreadB, remote: false, ephemeral: false }],
    [{ ...localThreadB, remote: false, ephemeral: false }]
  );
  const freshSourceFlagsReplaceCachedFlags = normalizedCurrentRows[0]?.remote === false
    && normalizedCurrentRows[0]?.ephemeral === false;
  const sideChatFeedbackKinds = [];
  let sideChatClearCount = 0;
  const cancelledSideChat = await openListedSideChat(
    "interaction-cancelled-side-chat",
    { ...localThreadC, ephemeral: true },
    {
      navigateDeepLink: async () => { throw abortedOperationError(); },
      feedback: (_context, kind) => { sideChatFeedbackKinds.push(kind); },
      clearFeedback: () => { sideChatClearCount += 1; },
      scheduleRefresh: () => {}
    }
  );
  const cancelledSideChatIsQuiet = !cancelledSideChat
    && sideChatClearCount === 1
    && sideChatFeedbackKinds.join(",") === "loading";
  primaryThreadId = localThreadB.id;
  primaryThreadRow = localThreadB;
  threadSlots = [localThreadB, localThreadA, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];

  const pressContext = "interaction-remote-hold";
  contexts.set(pressContext, ACTIONS.thread1);
  threadSlots = [remoteThread, ...Array(THREAD_COUNT - 1).fill(null)];
  let resolveFirstOpen;
  const firstOpenGate = new Promise((resolve) => { resolveFirstOpen = resolve; });
  let firstHoldCallback = null;
  let voiceStarts = 0;
  let mediaResumes = 0;
  beginThreadPress(pressContext, 0, {
    openThread: () => firstOpenGate,
    schedule: (callback) => {
      firstHoldCallback = callback;
      return null;
    },
    sleep: async () => {},
    focusComposer: async () => true,
    pauseMedia: async () => true,
    resumeMedia: async () => {
      mediaResumes += 1;
      return true;
    },
    beginVoice: () => {
      voiceStarts += 1;
      return true;
    }
  });
  const firstHoldRun = firstHoldCallback();
  await Promise.resolve();
  endThreadPress(pressContext);
  beginThreadPress(pressContext, 0, {
    openThread: async () => true,
    schedule: () => null,
    sleep: async () => {},
    focusComposer: async () => true,
    pauseMedia: async () => true,
    resumeMedia: async () => true,
    beginVoice: () => true
  });
  const replacementPress = threadPressByContext.get(pressContext);
  resolveFirstOpen(true);
  await firstHoldRun;
  await Promise.resolve();
  const staleHoldCannotDeleteNextPress = replacementPress != null
    && threadPressByContext.get(pressContext) === replacementPress
    && voiceStarts === 0
    && mediaResumes === 1;
  cancelThreadPress(pressContext, false);

  const baselineContext = "interaction-missing-composer";
  contexts.set(baselineContext, ACTIONS.voice);
  const baselineCommands = [];
  let baselineMediaResumes = 0;
  const missingBaselineRejected = !beginVoiceHoldSync(baselineContext, {
    targetThreadId: remoteThread.id,
    autoSubmit: true,
    requireBaseline: true,
    composerAlreadyFocused: true,
    stateReader: () => null,
    bridge(command) {
      baselineCommands.push(command);
      return true;
    },
    pauseMedia: () => {},
    resumeMedia: () => { baselineMediaResumes += 1; }
  })
    && !baselineCommands.includes("voice-down")
    && baselineMediaResumes === 1
    && !voiceHeldContexts.has(baselineContext);

  voiceMediaPauseOwners.clear();
  voiceMediaPaused = false;
  voiceMediaTransitionTail = Promise.resolve();
  voiceMediaResumeReassertPending = false;
  const mediaCommands = [];
  const mediaBridge = async (command) => {
    mediaCommands.push(command);
    return true;
  };
  await pauseMediaForVoice("media-owner-a", { bridge: mediaBridge });
  await pauseMediaForVoice("media-owner-b", { bridge: mediaBridge });
  const immediateResumeOptions = {
    bridge: mediaBridge,
    sleep: async () => {},
    debounceMs: 0
  };
  const firstOwnerKeptPaused = !(await resumeMediaAfterVoice(
    "media-owner-a",
    immediateResumeOptions
  ));
  const finalOwnerResumed = await resumeMediaAfterVoice("media-owner-b", immediateResumeOptions);
  const mediaPauseLeaseIsBalanced = firstOwnerKeptPaused
    && finalOwnerResumed
    && mediaCommands.join(",") === "media-pause-if-playing,media-play-pause"
    && voiceMediaPauseOwners.size === 0
    && !voiceMediaPaused;

  const alreadyPausedCommands = [];
  const alreadyPausedStart = await pauseMediaForVoice("already-paused-owner", {
    bridge: async (command) => {
      alreadyPausedCommands.push(command);
      return false;
    }
  });
  const alreadyPausedRelease = await resumeMediaAfterVoice("already-paused-owner", {
    bridge: async (command) => {
      alreadyPausedCommands.push(command);
      return true;
    },
    sleep: async () => {},
    debounceMs: 0
  });
  const alreadyPausedMediaIsNeverToggled = !alreadyPausedStart
    && !alreadyPausedRelease
    && alreadyPausedCommands.join(",") === "media-pause-if-playing"
    && !voiceMediaPauseOwners.has("already-paused-owner")
    && !voiceMediaPaused;

  voiceMediaPaused = true;
  addVoiceMediaPauseOwner("coalesced-owner-a");
  addVoiceMediaPauseOwner("coalesced-owner-b");
  let coalescedResumeSleeps = 0;
  const coalescedResumeCommands = [];
  const coalescedResumeOptions = {
    bridge: async (command) => {
      coalescedResumeCommands.push(command);
      return true;
    },
    sleep: async () => { coalescedResumeSleeps += 1; },
    debounceMs: 120
  };
  const firstCoalescedResume = resumeMediaAfterVoice(
    "coalesced-owner-a",
    coalescedResumeOptions
  );
  const secondCoalescedResume = resumeMediaAfterVoice(
    "coalesced-owner-b",
    coalescedResumeOptions
  );
  await Promise.all([firstCoalescedResume, secondCoalescedResume]);
  const multiOwnerResumeDebouncesOnce = coalescedResumeSleeps === 1
    && coalescedResumeCommands.join(",") === "media-play-pause"
    && !voiceMediaPaused;

  voiceMediaPaused = true;
  voiceMediaPauseOwners.add("failed-resume-owner");
  const failedResume = await resumeMediaAfterVoice("failed-resume-owner", {
    bridge: async () => false,
    sleep: async () => {},
    debounceMs: 0
  });
  const failedResumeRetainsState = !failedResume && voiceMediaPaused;
  await resumeMediaAfterVoice(null, {
    bridge: async () => true,
    sleep: async () => {},
    debounceMs: 0
  });

  voiceMediaPaused = true;
  addVoiceMediaPauseOwner("race-owner-a");
  const mediaRaceCommands = [];
  let resolveResumeDebounce;
  let signalResumeDebounce;
  const resumeDebounceGate = new Promise((resolve) => { resolveResumeDebounce = resolve; });
  const resumeDebounceStarted = new Promise((resolve) => { signalResumeDebounce = resolve; });
  const mediaRaceBridge = async (command) => {
    mediaRaceCommands.push(command);
    return true;
  };
  const racingResume = resumeMediaAfterVoice("race-owner-a", {
    bridge: mediaRaceBridge,
    debounceMs: 120,
    sleep: async () => {
      signalResumeDebounce();
      await resumeDebounceGate;
    }
  });
  await resumeDebounceStarted;
  const racingPause = pauseMediaForVoice("race-owner-b", {
    bridge: mediaRaceBridge,
    sleep: async () => {}
  });
  resolveResumeDebounce();
  await Promise.all([racingResume, racingPause]);
  const concurrentResumeBeforeDispatchIsCoalesced = voiceMediaPaused
    && voiceMediaPauseOwners.has("race-owner-b")
    && mediaRaceCommands.length === 0;
  await resumeMediaAfterVoice("race-owner-b", {
    bridge: mediaRaceBridge,
    sleep: async () => {},
    debounceMs: 0
  });

  voiceMediaPaused = true;
  addVoiceMediaPauseOwner("post-dispatch-owner-a");
  const postDispatchCommands = [];
  let signalResumeDispatched;
  let resolveResumeDispatched;
  const resumeWasDispatched = new Promise((resolve) => { signalResumeDispatched = resolve; });
  const resumeDispatchGate = new Promise((resolve) => { resolveResumeDispatched = resolve; });
  let reassertAttempts = 0;
  const postDispatchBridge = async (command) => {
    postDispatchCommands.push(command);
    if (command === "media-play-pause") {
      signalResumeDispatched();
      await resumeDispatchGate;
      return true;
    }
    reassertAttempts += 1;
    return reassertAttempts >= 2;
  };
  const postDispatchResume = resumeMediaAfterVoice("post-dispatch-owner-a", {
    bridge: postDispatchBridge,
    sleep: async () => {},
    debounceMs: 0
  });
  await resumeWasDispatched;
  const postDispatchPause = pauseMediaForVoice("post-dispatch-owner-b", {
    bridge: postDispatchBridge,
    sleep: async () => {}
  });
  resolveResumeDispatched();
  await Promise.all([postDispatchResume, postDispatchPause]);
  const postDispatchResumeRaceReassertsPause = voiceMediaPaused
    && voiceMediaPauseOwners.has("post-dispatch-owner-b")
    && !voiceMediaResumeReassertPending
    && postDispatchCommands.join(",") === [
      "media-play-pause",
      "media-pause-if-playing",
      "media-pause-if-playing"
    ].join(",");
  await resumeMediaAfterVoice("post-dispatch-owner-b", {
    bridge: async () => true,
    sleep: async () => {},
    debounceMs: 0
  });

  const guardContext = "interaction-target-guard";
  const guardSessionId = ++nextVoiceSessionId;
  contexts.set(guardContext, ACTIONS.thread1);
  voiceStateByContext.set(guardContext, "submitting");
  voiceTargetThreadByContext.set(guardContext, remoteThread.id);
  voiceSessionIdByContext.set(guardContext, guardSessionId);
  const guardedCommands = [];
  await submitCompletedVoiceTranscription(guardContext, remoteThread.id, {
    baseline: parseTextInputState("focused-text-state", "0\t0000000000000000"),
    lastObserved: parseTextInputState("focused-text-state", "9\t1111111111111111"),
    sessionId: guardSessionId
  }, {
    openApp: async () => {},
    sleep: async () => {},
    targetFocused: async () => false,
    bridge(command) {
      guardedCommands.push(command);
      return true;
    }
  });
  const wrongTargetCannotSubmit = guardedCommands.length === 0
    && voiceStateByContext.get(guardContext) === "error";

  const offStateError = new Error("fast mode is off");
  offStateError.exitCode = 1;
  offStateError.stdout = "state=off available=1 source=composer\n";
  const parsedOffState = await queryFastModeState({
    stateProbe: async () => { throw offStateError; }
  });
  const offExitIsConfirmedState = parsedOffState.enabled === false
    && parsedOffState.available === true;
  const passiveComposerState = await queryFastModeState({
    stateProbe: async () => ({
      stdout: "reasoning=max service_tier=unknown available=1 reasoning_available=1 service_tier_available=0 confidence=0 visited=812\n"
    })
  });
  const passiveComposerReadDoesNotClaimSpeed = passiveComposerState.enabled === null
    && passiveComposerState.available === null
    && passiveComposerState.reasoningEffort === "max";

  const fastContext = "interaction-fast-mode";
  contexts.set(fastContext, ACTIONS.fastMode);
  primaryThreadId = localThreadB.id;
  primaryThreadRow = localThreadB;
  threadSlots = [localThreadB, localThreadA, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];
  fastModeState = {
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    failed: false
  };
  const metadataFastState = fastModeStateFromThread({
    ...localThreadB,
    reasoningEffort: "max",
    serviceTier: "priority"
  });
  const taskMetadataRestoresFastWithoutMenu = metadataFastState.threadId === localThreadB.id
    && metadataFastState.enabled === true
    && metadataFastState.available === true
    && metadataFastState.reasoningEffort === "max";
  const fastOnVisual = fastModeSvg({
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    failed: false
  }, localThreadB.id);
  const fastOffVisual = fastModeSvg({
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    failed: false
  }, localThreadB.id);
  const fastUnavailableVisual = fastModeSvg({
    threadId: localThreadB.id,
    enabled: null,
    available: false,
    failed: false
  }, localThreadB.id);
  const fastFailedVisual = fastModeSvg({
    threadId: localThreadB.id,
    enabled: null,
    available: null,
    failed: true
  }, localThreadB.id);
  const fastModeVisualsAreIconFirst = fastOnVisual.includes('data-fast-state="on"')
    && fastOffVisual.includes('data-fast-state="off"')
    && !fastOnVisual.includes("FAST ON")
    && !fastOffVisual.includes("FAST OFF")
    && !fastOnVisual.includes("<text")
    && !fastOffVisual.includes("<text")
    && fastUnavailableVisual.includes("사용 불가")
    && fastFailedVisual.includes("상태 오류")
    && fastOnVisual.includes('M83 15L42 80H66L56 130L105 59H80Z');
  let resolveFastNavigation;
  const fastNavigationGate = new Promise((resolve) => { resolveFastNavigation = resolve; });
  activeDeepLinkNavigation = {
    threadId: localThreadB.id,
    controller: new AbortController(),
    promise: fastNavigationGate
  };
  let fastSetAttempts = 0;
  let fastStateProbeAttempts = 0;
  let fastSetTargetCorrect = true;
  const fastOptions = {
    feedback: () => {},
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stateProbe: async () => {
      fastStateProbeAttempts += 1;
      return {
        stdout: fastStateProbeAttempts === 1
          ? "state=off available=1 source=composer\n"
          : "state=on available=1 source=composer\n"
      };
    },
    setMode: async (enabled) => {
      fastSetAttempts += 1;
      fastSetTargetCorrect = fastSetTargetCorrect && enabled === true;
    }
  };
  const firstFastToggle = toggleFastMode(fastContext, fastOptions);
  const secondFastToggle = toggleFastMode(fastContext, fastOptions);
  await Promise.resolve();
  const fastToggleWaitedForNavigation = fastSetAttempts === 0;
  resolveFastNavigation(true);
  const [firstFastResult, secondFastResult] = await Promise.all([
    firstFastToggle,
    secondFastToggle
  ]);
  activeDeepLinkNavigation = null;
  const fastToggleIsCoalescedAndConfirmed = firstFastToggle === secondFastToggle
    && firstFastResult
    && secondFastResult
    && fastSetAttempts === 1
    && fastStateProbeAttempts === 2
    && fastSetTargetCorrect
    && fastModeState.threadId === localThreadB.id
    && fastModeState.enabled === true
    && fastModeSvg().includes('data-fast-state="on"');

  let timeoutRecoveryStateProbes = 0;
  const fastTimeoutAfterApplyRecovers = await toggleFastMode(fastContext, {
    feedback: () => {},
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stateProbe: async () => {
      timeoutRecoveryStateProbes += 1;
      return {
        stdout: timeoutRecoveryStateProbes === 1
          ? "state=on available=1 source=composer\n"
          : "state=off available=1 source=composer\n"
      };
    },
    setMode: async (enabled) => {
      if (enabled !== false) throw new Error("unexpected recovery target");
      const error = new Error("simulated timeout after AXPress");
      error.code = "ETIMEDOUT";
      throw error;
    }
  });
  const fastSetTimeoutIsReconciled = fastTimeoutAfterApplyRecovers
    && timeoutRecoveryStateProbes === 2
    && fastModeState.threadId === localThreadB.id
    && fastModeState.enabled === false;

  let singleShotFastToggleCalls = 0;
  const singleShotFastToggleResult = await toggleFastMode(fastContext, {
    feedback: () => {},
    focusProbe: async () => ({ stdout: "match=uuid" }),
    toggleMode: async () => {
      singleShotFastToggleCalls += 1;
      return {
        stdout: "requested=on state=on available=1 changed=1 verified=1 reasoning=max service_tier=priority\n"
      };
    }
  });
  const singleShotFastToggleUsesOneNativeAction = singleShotFastToggleResult
    && singleShotFastToggleCalls === 1
    && fastModeState.threadId === localThreadB.id
    && fastModeState.enabled === true
    && fastModeState.available === true;

  let resolveStaleFastRefresh;
  const staleFastRefreshState = new Promise((resolve) => { resolveStaleFastRefresh = resolve; });
  const staleFastRefresh = refreshFastMode({
    threadId: localThreadB.id,
    quiet: true,
    stateProbe: async () => staleFastRefreshState
  });
  await Promise.resolve();
  fastModeRevision += 1;
  fastModeState = {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    failed: false
  };
  resolveStaleFastRefresh({ stdout: "state=off available=1 source=composer\n" });
  await staleFastRefresh;
  const staleFastRefreshCannotOverwriteToggle = fastModeState.enabled === true;
  await refreshFastMode({
    threadId: localThreadB.id,
    quiet: true,
    stateProbe: async () => ({ stdout: "state=unknown available=0 source=composer\n" })
  });
  const passiveUnknownFastRefreshPreservesConfirmedState = fastModeState.enabled === true
    && fastModeState.available === true;
  await refreshFastMode({
    threadId: localThreadB.id,
    quiet: true,
    stateProbe: async () => ({ stdout: "state=off available=1 source=composer\n" })
  });
  const fastRefreshRecoversWithoutPageReentry = passiveUnknownFastRefreshPreservesConfirmedState
    && fastModeState.enabled === false
    && fastModeState.available === true;

  activeDeepLinkNavigation = null;
  let resolveFastLease;
  const fastLeaseGate = new Promise((resolve) => { resolveFastLease = resolve; });
  activeFastModeUpdate = fastLeaseGate;
  let navigationAfterFastAttempts = 0;
  const navigationAfterFast = navigateDeepLinkThread(localThreadA, 0, {
    openUrl: async () => { navigationAfterFastAttempts += 1; },
    waitFrontmost: async () => {},
    waitFocused: async () => true,
    sleep: async () => {}
  });
  await Promise.resolve();
  const navigationWaitedForFastToggleBeforeRelease = navigationAfterFastAttempts === 0;
  activeFastModeUpdate = null;
  resolveFastLease(true);
  await navigationAfterFast;
  const navigationWaitsForFastToggle = navigationWaitedForFastToggleBeforeRelease
    && navigationAfterFastAttempts === 1;
  activeDeepLinkNavigation = null;

  let resolveNewThreadLease;
  const newThreadLease = new Promise((resolve) => { resolveNewThreadLease = resolve; });
  activeFastModeUpdate = newThreadLease;
  let newThreadMutations = 0;
  const deferredNewThread = openNewThread("interaction-new-thread-after-fast", {
    openApp: async () => { newThreadMutations += 1; },
    sleep: async () => {},
    bridge: () => {
      newThreadMutations += 1;
      return true;
    }
  });
  await Promise.resolve();
  const newThreadWaited = newThreadMutations === 0;
  activeFastModeUpdate = null;
  resolveNewThreadLease(true);
  const newThreadOpened = await deferredNewThread;

  let resolveSideChatLease;
  const sideChatLease = new Promise((resolve) => { resolveSideChatLease = resolve; });
  activeFastModeUpdate = sideChatLease;
  let sideChatMutations = 0;
  const deferredSideChat = openSideChat("interaction-side-chat-after-fast", {
    nowMs: 1234,
    openApp: async () => { sideChatMutations += 1; },
    sleep: async () => {},
    bridge: () => {
      sideChatMutations += 1;
      return true;
    },
    scheduleRefreshes: () => { sideChatMutations += 1; }
  });
  await Promise.resolve();
  const sideChatWaited = sideChatMutations === 0;
  activeFastModeUpdate = null;
  resolveSideChatLease(true);
  const sideChatOpened = await deferredSideChat;
  const composerCreatingActionsWaitForFastToggle = newThreadWaited
    && newThreadOpened
    && newThreadMutations === 2
    && sideChatWaited
    && sideChatOpened
    && sideChatMutations === 3;
  pendingSideChatTarget = null;

  primaryThreadId = localThreadB.id;
  primaryThreadRow = localThreadB;
  threadSlots = [localThreadB, localThreadA, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];
  fastModeState = {
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    failed: false
  };
  let releaseCreationSleep;
  let creationSleepStarted;
  const creationSleepGate = new Promise((resolve) => { releaseCreationSleep = resolve; });
  const creationReachedSleep = new Promise((resolve) => { creationSleepStarted = resolve; });
  const creationThenFastOrder = [];
  const creationBeforeFast = openNewThread("interaction-creation-before-fast", {
    openApp: async () => { creationThenFastOrder.push("open"); },
    sleep: async () => {
      creationSleepStarted();
      await creationSleepGate;
    },
    bridge: () => {
      creationThenFastOrder.push("create");
      return true;
    }
  });
  await creationReachedSleep;
  let reverseFastProbeCount = 0;
  const fastAfterCreation = toggleFastMode(fastContext, {
    feedback: () => {},
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stateProbe: async () => {
      reverseFastProbeCount += 1;
      return {
        stdout: reverseFastProbeCount === 1
          ? "state=off available=1 source=composer\n"
          : "state=on available=1 source=composer\n"
      };
    },
    setMode: async () => { creationThenFastOrder.push("fast"); }
  });
  await Promise.resolve();
  const fastWaitedForEarlierCreation = !creationThenFastOrder.includes("fast");
  releaseCreationSleep();
  await Promise.all([creationBeforeFast, fastAfterCreation]);
  const creationAndFastLeaseIsBidirectional = fastWaitedForEarlierCreation
    && creationThenFastOrder.join(",") === "open,create,fast";

  let releaseSupersededCreation;
  let supersededCreationStarted;
  const supersededCreationGate = new Promise((resolve) => { releaseSupersededCreation = resolve; });
  const supersededCreationReady = new Promise((resolve) => { supersededCreationStarted = resolve; });
  let supersededCreationBridges = 0;
  const supersededCreation = openSideChat("interaction-creation-superseded", {
    openApp: async () => {},
    sleep: async () => {
      supersededCreationStarted();
      await supersededCreationGate;
    },
    bridge: () => {
      supersededCreationBridges += 1;
      return true;
    },
    scheduleRefreshes: () => {}
  });
  await supersededCreationReady;
  let supersedingNavigationAttempts = 0;
  const supersedingNavigation = navigateDeepLinkThread(localThreadA, 0, {
    openUrl: async () => { supersedingNavigationAttempts += 1; },
    waitFrontmost: async () => {},
    waitFocused: async () => true,
    sleep: async () => {}
  });
  await supersedingNavigation;
  releaseSupersededCreation();
  const supersededCreationResult = await supersededCreation;
  const navigationSupersedesPendingCreation = !supersededCreationResult
    && supersededCreationBridges === 0
    && supersedingNavigationAttempts === 1;

  let releaseSupersededNavigation;
  let supersededNavigationStarted;
  const supersededNavigationGate = new Promise((resolve) => { releaseSupersededNavigation = resolve; });
  const supersededNavigationReady = new Promise((resolve) => { supersededNavigationStarted = resolve; });
  let supersededNavigationFocusChecks = 0;
  const supersededNavigation = navigateDeepLinkThread(localThreadC, 2, {
    openUrl: async () => {
      supersededNavigationStarted();
      await supersededNavigationGate;
    },
    waitFrontmost: async () => {},
    waitFocused: async () => {
      supersededNavigationFocusChecks += 1;
      return true;
    },
    sleep: async () => {}
  });
  await supersededNavigationReady;
  let supersedingCreationBridges = 0;
  const supersedingCreation = openNewThread("interaction-navigation-superseded", {
    openApp: async () => {},
    sleep: async () => {},
    bridge: () => {
      supersedingCreationBridges += 1;
      return true;
    }
  });
  await supersedingCreation;
  releaseSupersededNavigation();
  const supersededNavigationWasAborted = await supersededNavigation
    .then(() => false, (error) => isAbortError(error));
  const creationSupersedesPendingNavigation = supersededNavigationWasAborted
    && supersededNavigationFocusChecks === 0
    && supersedingCreationBridges === 1;

  let releaseCancelledSameTarget;
  let cancelledSameTargetStarted;
  const cancelledSameTargetGate = new Promise((resolve) => { releaseCancelledSameTarget = resolve; });
  const cancelledSameTargetReady = new Promise((resolve) => { cancelledSameTargetStarted = resolve; });
  const cancelledSameTargetNavigation = navigateDeepLinkThread(localThreadA, 0, {
    openUrl: async () => {
      cancelledSameTargetStarted();
      await cancelledSameTargetGate;
    },
    waitFrontmost: async () => {},
    waitFocused: async () => true,
    sleep: async () => {}
  });
  const cancelledSameTargetOutcome = cancelledSameTargetNavigation
    .then(() => false, (error) => isAbortError(error));
  await cancelledSameTargetReady;
  let releaseInterleavedCreation;
  let interleavedCreationStarted;
  const interleavedCreationGate = new Promise((resolve) => { releaseInterleavedCreation = resolve; });
  const interleavedCreationReady = new Promise((resolve) => { interleavedCreationStarted = resolve; });
  const interleavedCreation = openNewThread("interaction-same-target-interleave", {
    openApp: async () => {},
    sleep: async () => {
      interleavedCreationStarted();
      await interleavedCreationGate;
    },
    bridge: () => true
  });
  await interleavedCreationReady;
  let sameTargetRetryAttempts = 0;
  const sameTargetRetry = navigateDeepLinkThread(localThreadA, 0, {
    openUrl: async () => { sameTargetRetryAttempts += 1; },
    waitFrontmost: async () => {},
    waitFocused: async () => true,
    sleep: async () => {}
  });
  const sameTargetRetryStartedFresh = sameTargetRetry !== cancelledSameTargetNavigation;
  const sameTargetRetryResult = await sameTargetRetry;
  releaseCancelledSameTarget();
  releaseInterleavedCreation();
  const cancelledSameTargetWasAborted = await cancelledSameTargetOutcome;
  const interleavedCreationResult = await interleavedCreation;
  const cancelledSameTargetDoesNotSwallowRetry = sameTargetRetryStartedFresh
    && sameTargetRetryResult
    && sameTargetRetryAttempts === 1
    && cancelledSameTargetWasAborted
    && !interleavedCreationResult;

  const passed = fastBadgeNonCompletedStates
    && completedHidesFastBadge
    && standardHasNoFastBadge
    && activeGoalUsesOfficialBadge
    && blockedGoalBadgeAndTimeFreeze
    && completedGoalHidesBadgeButKeepsTotal
    && completedGoalLifetimeFollowsTurn
    && remoteGoalProbeNeedsStableAbsence
    && unknownNewGoalDoesNotInheritCompletedTime
    && expiredRemoteGoalCacheIsPruned
    && knownTitleAmbiguityDetected
    && ambiguousTitleUsesStrictIdentity
    && sameTitleVoiceTargetIsIdentitySafe
    && manualCodexSelectionOverridesStreamDeckHistory
    && focusedRemoteSpeedUpdatesImmediately
    && fallbackSearchRunsOnce
    && activationWaitRunsOnceBeforeNavigation
    && successfulButUnreadyDirectRetries
    && unifiedSearchRevalidatesWithoutDuplicate
    && firstClickLocalRetries
    && sameTargetSharesNavigation
    && navigationLeaseCleared
    && independentCurrentAndRankedActions
    && failedNavigationKeepsCurrentSlot
    && failedNavigationKeepsUnreadCompletion
    && verifiedNavigationUpdatesCurrentOnly
    && successfulNavigationAcknowledgesCompletion
    && refreshPreservesCurrentSlot
    && currentUnpinnedRemoteIsSlotOneException
    && staleCurrentRequiresStrictIdentity
    && freshSourceFlagsReplaceCachedFlags
    && cancelledSideChatIsQuiet
    && staleHoldCannotDeleteNextPress
    && missingBaselineRejected
    && mediaPauseLeaseIsBalanced
    && alreadyPausedMediaIsNeverToggled
    && multiOwnerResumeDebouncesOnce
    && failedResumeRetainsState
    && concurrentResumeBeforeDispatchIsCoalesced
    && postDispatchResumeRaceReassertsPause
    && wrongTargetCannotSubmit
    && offExitIsConfirmedState
    && passiveComposerReadDoesNotClaimSpeed
    && taskMetadataRestoresFastWithoutMenu
    && fastModeVisualsAreIconFirst
    && fastToggleWaitedForNavigation
    && fastToggleIsCoalescedAndConfirmed
    && fastSetTimeoutIsReconciled
    && singleShotFastToggleUsesOneNativeAction
    && staleFastRefreshCannotOverwriteToggle
    && fastRefreshRecoversWithoutPageReentry
    && navigationWaitsForFastToggle
    && composerCreatingActionsWaitForFastToggle
    && creationAndFastLeaseIsBidirectional
    && navigationSupersedesPendingCreation
    && creationSupersedesPendingNavigation
    && cancelledSameTargetDoesNotSwallowRetry;
  console.log(JSON.stringify({
    passed,
    fastBadgeNonCompletedStates,
    completedHidesFastBadge,
    standardHasNoFastBadge,
    activeGoalUsesOfficialBadge,
    blockedGoalBadgeAndTimeFreeze,
    completedGoalHidesBadgeButKeepsTotal,
    completedGoalLifetimeFollowsTurn,
    remoteGoalProbeNeedsStableAbsence,
    unknownNewGoalDoesNotInheritCompletedTime,
    expiredRemoteGoalCacheIsPruned,
    knownTitleAmbiguityDetected,
    ambiguousTitleUsesStrictIdentity,
    sameTitleVoiceTargetIsIdentitySafe,
    manualCodexSelectionOverridesStreamDeckHistory,
    focusedRemoteSpeedUpdatesImmediately,
    fallbackSearchRunsOnce,
    activationWaitRunsOnceBeforeNavigation,
    successfulButUnreadyDirectRetries,
    unifiedSearchRevalidatesWithoutDuplicate,
    firstClickLocalRetries,
    sameTargetSharesNavigation,
    navigationLeaseCleared,
    independentCurrentAndRankedActions,
    failedNavigationKeepsCurrentSlot,
    failedNavigationKeepsUnreadCompletion,
    verifiedNavigationUpdatesCurrentOnly,
    successfulNavigationAcknowledgesCompletion,
    refreshPreservesCurrentSlot,
    currentUnpinnedRemoteIsSlotOneException,
    staleCurrentRequiresStrictIdentity,
    freshSourceFlagsReplaceCachedFlags,
    cancelledSideChatIsQuiet,
    staleHoldCannotDeleteNextPress,
    missingBaselineRejected,
    mediaPauseLeaseIsBalanced,
    alreadyPausedMediaIsNeverToggled,
    multiOwnerResumeDebouncesOnce,
    failedResumeRetainsState,
    concurrentResumeBeforeDispatchIsCoalesced,
    postDispatchResumeRaceReassertsPause,
    wrongTargetCannotSubmit,
    offExitIsConfirmedState,
    passiveComposerReadDoesNotClaimSpeed,
    taskMetadataRestoresFastWithoutMenu,
    fastModeVisualsAreIconFirst,
    fastToggleWaitedForNavigation,
    fastToggleIsCoalescedAndConfirmed,
    fastSetTimeoutIsReconciled,
    singleShotFastToggleUsesOneNativeAction,
    staleFastRefreshCannotOverwriteToggle,
    passiveUnknownFastRefreshPreservesConfirmedState,
    fastRefreshRecoversWithoutPageReentry,
    navigationWaitsForFastToggle,
    composerCreatingActionsWaitForFastToggle,
    creationAndFastLeaseIsBidirectional,
    navigationSupersedesPendingCreation,
    creationSupersedesPendingNavigation,
    cancelledSameTargetDoesNotSwallowRetry
  }));
  if (!passed) process.exitCode = 1;

  activeRemoteNavigation?.controller.abort();
  activeRemoteNavigation = null;
  activeDeepLinkNavigation?.controller.abort();
  activeDeepLinkNavigation = null;
  activeComposerCreation?.controller.abort();
  activeComposerCreation = null;
  activeFastModeRefresh = null;
  activeFastModeUpdate = null;
  threadPressByContext.clear();
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  voiceMediaPauseOwners.clear();
  voiceMediaPaused = false;
  voiceMediaTransitionTail = Promise.resolve();
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  contextFeedback.clear();
  observedGoalByThreadId.clear();
  displayedGoalByThreadId.clear();
  goalTerminalCutoffByThreadId.clear();
  confirmedGoalAbsentByThreadId.clear();
  goalProbe = { threadId: null, checkedAtMs: 0, absentCount: 0 };
  remoteComposerStateByThreadId.clear();
  remoteComposerProbe = { threadId: null, turnKey: null };
  threadSlots = Array(THREAD_COUNT).fill(null);
  primaryThreadId = null;
  primaryThreadRow = null;
  fastModeState = {
    threadId: null,
    enabled: null,
    available: null,
    failed: false
  };
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
  if (keyBridgePermissionContractMode) {
    fsSync.accessSync(KEY_BRIDGE, fsSync.constants.X_OK);
    console.log(JSON.stringify({ passed: true, keybridgeExecutable: true }));
  } else if (completionContractMode) {
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
  } else if (interactionContractMode) {
    verifyInteractionPolicy().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } else if (demoOutput || demoLightOutput || completedKeyOutput || demoAnimationDirectory || gestureAnimationDirectory) {
    if (gestureAnimationDirectory) renderGestureAnimations(gestureAnimationDirectory, "dark");
    else if (demoAnimationDirectory) renderDemoAnimation(demoAnimationDirectory, "dark");
    else if (completedKeyOutput) renderCompletedTaskKey(completedKeyOutput, "dark");
    else renderDemo(demoOutput || demoLightOutput, demoLightOutput ? "light" : "dark");
  } else if (snapshotMode) {
    readTopThreads()
      .then((snapshot) => {
        const threads = Array.isArray(snapshot) ? snapshot : snapshot.threads;
        console.log(JSON.stringify(threads.map(({ id, title, pinned, ephemeral, remote, status, startedAtMs, endedAtMs, activity, reasoningEffort, serviceTier, queueCount, goal }) => ({
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
          timing: timingLabel({ status, startedAtMs, endedAtMs, goal }),
          goal: goal ? {
            status: goal.status,
            unfinished: goalIsUnfinished(goal)
          } : null
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
  const renderingOnly = Boolean(
    demoOutput
    || demoLightOutput
    || completedKeyOutput
    || demoAnimationDirectory
    || gestureAnimationDirectory
  );
  if (!renderingOnly) ensureKeyBridgeExecutable(KEY_BRIDGE);
  installShutdownHandlers();
  runSelectedMode();
}

if (require.main === module) main();

module.exports = { main, shouldProbeRemoteComposerState };
