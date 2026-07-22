"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { execFile, execFileSync, spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const {
  activityLabel,
  feedbackLabel,
  localizeText,
  setLanguage,
  t
} = require("./i18n");
const {
  parseRegistrationInfo,
  runtimeCapabilities,
  runtimeLanguage
} = require("./runtime-info");

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
const {
  parseCodexQueueWindows,
  queueBadgeLabel,
  queueCountForWindow,
  queueCountsByThreadForWindow,
  queueTitleFingerprints
} = require("./queue-state");
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
const { prepareKeyBridgeExecutable } = require("./keybridge-permissions");
const {
  REASONING_EFFORT_ORDER,
  loadReasoningOptionCatalog,
  normalizeReasoningEfforts
} = require("./reasoning-options");
const {
  bridgeFailureStaysLocal,
  parsePermissionHealth,
  permissionIssueForHealth,
  permissionIssueLabel
} = require("./permission-health");
const { resolveProfilePageTarget } = require("./profile-navigation");
const {
  CodexControlPlane,
  definiteMicroFallback,
  verifyAfterMicroDelivery
} = require("./control-plane");
const { CodexMicroBootstrap } = require("./micro-bootstrap");
const { CodexMicroBridge, confirmedMicroThreadSnapshot } = require("./micro-cdp");
const {
  framePolicyForDevice,
  normalizeDeviceInfo,
  registrationDevices
} = require("./device-frame-policy");
const { createImageDeliveryQueue } = require("./image-delivery");
const {
  applySideChatLogLine,
  createSideChatDiscoveryState,
  openDiscoveredSideChats
} = require("./side-chat-state");
const {
  ACTIONS,
  APP_SERVER_SESSION_CACHE_MS,
  APP_SERVER_START_TOLERANCE_MS,
  COMPLETION_OBSERVATION_OVERLAP_MS,
  COMPLETION_STARTUP_GRACE_MS,
  CURRENT_THREAD_SLOT,
  DESKTOP_LOG_PATH_CACHE_MS,
  DISTRIBUTED_PROFILE_NAME,
  FAST_MODE_LONG_PRESS_MS,
  GLOBAL_COMPLETION_FRAME_INTERVAL_MS,
  GLOBAL_COMPLETION_GROUP_COUNT,
  GLOBAL_COMPLETION_PULSE_DURATION_MS,
  MEDIA_COMMAND_BY_ACTION,
  PAGE_DIRECTION_BY_ACTION,
  QUEUE_ZERO_CONFIRM_MS,
  SEND_LONG_PRESS_MS,
  SIDE_CHAT_COMPOSER_READY_DELAYS_MS,
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
  UNREAD_COMPLETION_DISMISS_FADE_MS,
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
const PERMISSION_HEALTH_CACHE_MS = 15_000;
const PERMISSION_MONITOR_INTERVAL_MS = 30_000;
const PERMISSION_REQUEST_COOLDOWN_MS = 10 * 60_000;
const PERMISSION_RECHECK_DELAYS_MS = [1_200, 5_000, 15_000];
const OPERATION_FAILURE_WINDOW_MS = 30_000;
const OPERATION_FAILURE_THRESHOLD = 2;
const CURRENT_THREAD_SYNC_INTERVAL_MS = 750;
const CURRENT_THREAD_SYNC_CACHE_MS = 250;
const REASONING_INPUT_SETTLE_MS = 1_100;
const MICRO_REASONING_INPUT_SETTLE_MS = 90;
const REASONING_PROGRESS_TRANSITION_MS = 320;
const REASONING_PARTICLE_ACCELERATION_MS = 420;
const REASONING_PARTICLE_DECELERATION_MS = 520;
const MICRO_TASK_SWITCH_VERIFY_DELAYS_MS = [45, 80, 140, 220, 320, 480];
const SQLITE = "/usr/bin/sqlite3";
const USER_HOME = os.homedir();
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(USER_HOME, ".codex"));
const CODEX_CONFIG = path.resolve(
  process.env.THREADDECK_CODEX_CONFIG || path.join(CODEX_HOME, "config.toml")
);
const CODEX_MODELS_CACHE = path.resolve(
  process.env.THREADDECK_CODEX_MODELS_CACHE || path.join(CODEX_HOME, "models_cache.json")
);
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
const PACKAGED_KEY_BRIDGE = path.join(__dirname, "keybridge");
let KEY_BRIDGE = PACKAGED_KEY_BRIDGE;
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
  "held",
  "accessibility",
  "postEvent",
  "codexAccess",
  "issue"
]);
const CURRENT_THREAD_AWARE_ACTIONS = new Set([
  ACTIONS.thread1,
  ACTIONS.sideChat,
  ACTIONS.voice,
  ACTIONS.send,
  ACTIONS.fastMode,
  ACTIONS.reasoning
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
const registrationInfo = parseRegistrationInfo(argument("-info"));
const runtime = runtimeCapabilities(registrationInfo);
const language = setLanguage(runtimeLanguage(
  registrationInfo,
  argument("--language") || process.env.THREADDECK_LANGUAGE
));
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
// A manual escape hatch keeps every control usable with manifest artwork if a
// future Stream Deck release regresses dynamic-image handling. Normal runtime
// delivery stays enabled and is bounded by the coalescing queue below.
const liveImageDeliveryEnabled = process.env.THREADDECK_SAFE_DISPLAY !== "1";

const contexts = new Map();
const contextDeviceIds = new Map();
const frameDeviceInfoById = new Map(
  registrationDevices(registrationInfo).map((device) => [device.id, device])
);
const contextImages = new Map();
const contextSentImages = new Map();
const contextFeedback = new Map();
const permissionAlertedContexts = new Set();
const microBridgeAlertedContexts = new Set();
const operationFailureByCapability = new Map();
const statusCache = new Map();
const completionPulseStartedAt = new Map();
const unreadCompletionByThreadId = new Map();
const completionDismissFadeByThreadId = new Map();
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
const voiceBackendByContext = new Map();
const voiceStartVerificationTimers = new Map();
const sendPressStartedAt = new Map();
const sendLongPressTimers = new Map();
const sendLongPressArmedContexts = new Set();
const activeSendDispatchByContext = new Map();
const fastModePressStartedAt = new Map();
const fastModeLongPressTimers = new Map();
const fastModeLongPressArmedContexts = new Set();
const fastModeLongPressUpdates = new Map();
const reasoningBusyContexts = new Set();
const reasoningDirectionByThreadId = new Map();
const reasoningAvailableEffortsByThreadId = new Map();
const reasoningPowerSelectionsByThreadId = new Map();
const reasoningVisualOverrideByThreadId = new Map();
const reasoningProgressTransitionByKey = new Map();
const reasoningParticleMotionByKey = new Map();
const reasoningPendingCountByThreadId = new Map();
const reasoningPendingCountByContext = new Map();
const reasoningInputBatchByKey = new Map();
// Codex stores the user's globally visible effort list in config.toml. Load it
// once at plugin startup (and again only after a Codex app-server restart),
// then let an exact picker scan refine the subset for a particular task/model.
let reasoningGlobalOptionCatalog = { model: null, efforts: [], source: "none" };
let activeReasoningOptionCatalogRefresh = null;
let reasoningCatalogAppServerStartedAtMs = null;
const threadPressByContext = new Map();
const currentVoicePressByContext = new Map();
let socket = null;

function updateFrameDeviceInfo(deviceId, deviceInfo) {
  const normalized = normalizeDeviceInfo(deviceId, deviceInfo);
  if (!normalized.id) return null;
  frameDeviceInfoById.set(normalized.id, normalized);
  return normalized;
}

function framePolicyForContext(context) {
  const deviceId = contextDeviceIds.get(context) ?? "unknown-device";
  return framePolicyForDevice(frameDeviceInfoById.get(deviceId), { deviceId });
}

const imageDeliveryQueue = createImageDeliveryQueue({
  deliver: (context, svg) => sendImageImmediately(context, svg),
  isOpen: () => socket?.readyState === WebSocket.OPEN,
  bufferedAmount: () => Number(socket?.bufferedAmount) || 0,
  // Each connected device has an independent lane. Neo uses the measured
  // ceiling from the physical stress test; unmeasured devices start from a
  // conservative type/size policy and slow further under socket pressure.
  resolvePolicy: (context) => framePolicyForContext(context),
  minContextIntervalMs: 100,
  minGlobalIntervalMs: 34,
  maxBufferedBytes: 16 * 1024,
  backpressureRetryMs: 50,
  maxSlowdownMultiplier: 4,
  recoveryMs: 3_000,
  onAdaptiveChange: ({ reason, slowdownMultiplier }) => {
    runtimeTrace("image-delivery-adaptive", {
      phase: reason,
      result: `x${slowdownMultiplier.toFixed(2)}`
    });
  }
});
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
// Blank New Task and Side Chat composers exist before Codex publishes a
// durable conversation UUID. Keep the visible composer as Current Task until
// Codex assigns that UUID or the user explicitly opens another task.
let activeComposerFocusLease = null;
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
let activeCurrentThreadSync = null;
let activeMicroReadOnlyRefresh = null;
let currentThreadIdentityCandidates = [];
let lastCurrentThreadSyncAtMs = 0;
let fastModeRevision = 0;

function provisionalComposerId(kind, requestedAtMs) {
  const prefix = kind === "new-thread" ? "new-thread-pending" : "side-chat-pending";
  return `${prefix}:${Math.max(0, Math.trunc(requestedAtMs))}`;
}

function isProvisionalSideChatThread(thread) {
  return Boolean(thread?.provisionalSideChat);
}

function isProvisionalNewThread(thread) {
  return Boolean(thread?.provisionalNewThread);
}

function isProvisionalComposerThread(thread) {
  return isProvisionalSideChatThread(thread) || isProvisionalNewThread(thread);
}

function activeComposerFocusThread(candidates = []) {
  const lease = activeComposerFocusLease;
  if (!lease) return null;
  if (lease.targetThreadId) {
    const fresh = candidates.find((thread) => thread?.id === lease.targetThreadId);
    return {
      ...(lease.thread ?? {}),
      ...(fresh ?? {}),
      id: lease.targetThreadId,
      parentId: fresh?.parentId ?? lease.thread?.parentId ?? lease.parentId ?? null,
      remote: false,
      ephemeral: lease.kind === "side-chat",
      provisionalSideChat: false,
      provisionalNewThread: false,
      requiresStrictIdentity: Boolean(
        fresh?.requiresStrictIdentity ?? lease.thread?.requiresStrictIdentity
      )
    };
  }
  return lease.thread ?? null;
}

function activeSideChatFocusThread(candidates = []) {
  return activeComposerFocusLease?.kind === "side-chat"
    ? activeComposerFocusThread(candidates)
    : null;
}

function activeNewThreadFocusThread(candidates = []) {
  return activeComposerFocusLease?.kind === "new-thread"
    ? activeComposerFocusThread(candidates)
    : null;
}

function currentControlThreadId() {
  return activeComposerFocusThread()?.id ?? primaryThreadId;
}

function storeComposerFocusLease(lease, options = {}) {
  const previousControlId = currentControlThreadId();
  activeComposerFocusLease = lease;
  const thread = activeComposerFocusThread();
  const nextControlId = thread?.id ?? null;
  if (nextControlId !== previousControlId || fastModeState.threadId !== nextControlId) {
    fastModeRevision += 1;
    fastModeState = {
      ...fastModeStateFromThread(thread, fastModeState),
      threadId: nextControlId,
      failed: false
    };
  }
  if (options.render !== false) {
    renderThreadContexts();
    renderStaticContexts();
  }
  return thread;
}

function activateSideChatFocusLease(options = {}) {
  const requestedAtMs = Number.isFinite(options.requestedAtMs)
    ? options.requestedAtMs
    : Date.now();
  const targetThreadId = options.thread?.id ?? options.targetThreadId ?? null;
  const parent = options.parentThread
    ?? currentThreadIdentityCandidates.find((thread) => thread?.id === options.parentId)
    ?? (primaryThreadRow?.id === options.parentId ? primaryThreadRow : null)
    ?? primaryThreadRow
    ?? null;
  const provisional = {
    ...(parent ?? {}),
    id: provisionalComposerId("side-chat", requestedAtMs),
    title: t("activity.sideChat"),
    parentId: options.parentId ?? parent?.id ?? null,
    remote: false,
    ephemeral: true,
    provisionalSideChat: true,
    requiresStrictIdentity: true,
    pinned: false,
    status: "idle",
    activity: { kind: "command", label: t("activity.sideChat") },
    startedAtMs: requestedAtMs,
    endedAtMs: null
  };
  const thread = targetThreadId
    ? {
      ...provisional,
      ...(options.thread ?? {}),
      id: targetThreadId,
      provisionalSideChat: false
    }
    : provisional;
  return storeComposerFocusLease({
    kind: "side-chat",
    requestedAtMs,
    parentId: thread.parentId ?? options.parentId ?? null,
    targetThreadId,
    thread
  }, options);
}

function activateNewThreadFocusLease(options = {}) {
  const requestedAtMs = Number.isFinite(options.requestedAtMs)
    ? options.requestedAtMs
    : Date.now();
  const targetThreadId = options.thread?.id ?? options.targetThreadId ?? null;
  const source = options.sourceThread
    ?? currentThreadIdentityCandidates.find((thread) => thread?.id === options.sourceThreadId)
    ?? (primaryThreadRow?.id === options.sourceThreadId ? primaryThreadRow : null)
    ?? primaryThreadRow
    ?? null;
  const provisional = {
    ...(source ?? {}),
    id: provisionalComposerId("new-thread", requestedAtMs),
    title: t("activity.newTask"),
    parentId: null,
    remote: false,
    ephemeral: false,
    provisionalSideChat: false,
    provisionalNewThread: true,
    requiresStrictIdentity: true,
    pinned: false,
    status: "idle",
    activity: { kind: "command", label: t("activity.newTask") },
    startedAtMs: requestedAtMs,
    endedAtMs: null,
    cwd: options.projectContext?.cwd ?? source?.cwd ?? ""
  };
  const thread = targetThreadId
    ? {
      ...provisional,
      ...(options.thread ?? {}),
      id: targetThreadId,
      provisionalNewThread: false
    }
    : provisional;
  return storeComposerFocusLease({
    kind: "new-thread",
    requestedAtMs,
    sourceThreadId: options.sourceThreadId ?? source?.id ?? null,
    projectContext: options.projectContext ?? null,
    knownIds: options.knownIds instanceof Set ? new Set(options.knownIds) : new Set(),
    targetThreadId,
    thread
  }, options);
}

function promoteSideChatFocusLease(thread, options = {}) {
  if (!thread?.id || activeComposerFocusLease?.kind !== "side-chat") return false;
  const requestedAtMs = activeComposerFocusLease.requestedAtMs;
  const parentId = thread.parentId
    ?? activeComposerFocusLease.parentId
    ?? sideChatParentById.get(thread.id)
    ?? null;
  activateSideChatFocusLease({
    requestedAtMs,
    parentId,
    targetThreadId: thread.id,
    thread,
    render: options.render
  });
  return true;
}

function promoteNewThreadFocusLease(thread, options = {}) {
  const lease = activeComposerFocusLease;
  if (!thread?.id || lease?.kind !== "new-thread") return false;
  activateNewThreadFocusLease({
    requestedAtMs: lease.requestedAtMs,
    sourceThreadId: lease.sourceThreadId,
    sourceThread: lease.thread,
    projectContext: lease.projectContext,
    knownIds: lease.knownIds,
    targetThreadId: thread.id,
    thread,
    render: options.render
  });
  return true;
}

function clearComposerFocusLease(options = {}) {
  const previous = activeComposerFocusLease;
  if (!previous) return false;
  activeComposerFocusLease = null;
  const previousControlId = previous.targetThreadId ?? previous.thread?.id ?? null;
  if (fastModeState.threadId === previousControlId) {
    fastModeRevision += 1;
    fastModeState = fastModeStateFromThread(primaryThreadRow, fastModeState);
  }
  if (options.render !== false) {
    renderThreadContexts();
    renderStaticContexts();
  }
  return true;
}

function revokeComposerFocusForRendererCurrent(currentId, options = {}) {
  const lease = activeComposerFocusLease;
  if (!lease || !currentId) return false;
  const expectedId = lease.targetThreadId
    ?? (lease.kind === "side-chat" ? lease.parentId : lease.sourceThreadId)
    ?? null;
  // Before Codex assigns the new composer UUID, its source task remains the
  // only stable renderer identity. Preserve that short provisional phase, but
  // once a target exists any different renderer task is an explicit selection
  // and must win immediately.
  if (currentId === expectedId && options.force !== true) return false;
  if (lease.kind === "side-chat") pendingSideChatTarget = null;
  if (activeComposerCreation?.kind === lease.kind) {
    activeComposerCreation.markComposerReady?.(null);
    activeComposerCreation.controller?.abort();
  }
  clearComposerFocusLease({ render: false });
  if (options.render !== false) {
    renderThreadContexts();
    renderStaticContexts();
  }
  runtimeTrace("composer-focus", {
    kind: lease.kind,
    result: "manual-override",
    provisional: !lease.targetThreadId
  });
  return true;
}

function currentThreadForDisplay(rankedThreads = threadSlots, currentRow = primaryThreadRow) {
  const leasedComposer = activeComposerFocusThread([
    ...rankedThreads,
    currentRow,
    ...currentThreadIdentityCandidates
  ].filter(Boolean));
  if (leasedComposer) return leasedComposer;
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
  model: null,
  enabled: null,
  available: null,
  failed: false
};
let appServerSessionCache = { checkedAtMs: 0, startedAtMs: null };
let desktopLogPathCache = { checkedAtMs: 0, path: null, paths: [] };
let permissionHealthCache = { checkedAtMs: 0, health: null };
let permissionIssue = null;
let microBridgeIssue = null;
let microBootstrapStatus = { state: "idle", detail: null, atMs: null };
let lastPermissionRequestAtMs = 0;
let activePermissionRefresh = null;
let codexAccessFailureCount = 0;
let lastCodexAccessFailureAtMs = 0;
let runtimeTraceTail = Promise.resolve();
let pinnedIdsCache = [];
let remoteThreadRowsCache = [];
let sideChatRowsCache = [];
let sideChatDiscoveryState = createSideChatDiscoveryState();

const codexMicroBridge = new CodexMicroBridge({
  log: (message) => {
    runtimeTrace("control-plane", { strategy: "micro", result: "connected" });
    if (process.env.THREADDECK_MICRO_DEBUG === "1") console.log(message);
  }
});
const codexControlPlane = new CodexControlPlane({
  micro: codexMicroBridge,
  log: (message) => {
    runtimeTrace("control-plane", {
      strategy: "micro",
      result: message.includes("legacy") ? "fallback" : "failed"
    });
    if (process.env.THREADDECK_MICRO_DEBUG === "1") console.warn(message);
  }
});
const codexMicroBootstrap = new CodexMicroBootstrap({
  onStatus: (status) => handleMicroBootstrapStatus(status)
});

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
const sideChatTitleById = new Map();
const sideChatLifecycleCache = new Map();
const closedSideChatAtMs = new Map();
const sideChatCloseLogOffsets = new Map();
const sideChatDiscoveryLogCursors = new Map();
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

function sendImageImmediately(context, svg) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (contextSentImages.get(context) === svg) return false;
  if (runtimeTraceEnabled) {
    if (!liveImageDeliveryEnabled) return false;
  }
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  send({ event: "setImage", context, payload: { target: 0, image } });
  contextSentImages.set(context, svg);
  return true;
}

function sendImage(context, svg) {
  // Snapshot/contract modes use a synchronous fake socket and need exact
  // deterministic frames. Only a live Stream Deck connection is throttled.
  if (!runtimeTraceEnabled) return sendImageImmediately(context, svg);
  if (!liveImageDeliveryEnabled) return false;
  // Always replace a queued frame, even when the newest desired frame equals
  // the last one already displayed. Otherwise an older pending animation
  // frame could be delivered after the visual state has returned to rest.
  return imageDeliveryQueue.enqueue(context, svg);
}

function feedbackOverlaySvg(svg, feedback) {
  const accent = feedback.kind === "error" ? THEME.red : feedback.kind === "success" ? THEME.green : THEME.blue;
  const label = compactLine(feedbackLabel(feedback.label), 6.2);
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

function permissionIssueOverlaySvg(svg, issue) {
  const label = compactLine(permissionIssueLabel(issue), 6.2);
  const labelWidth = Math.max(1, titleVisualWidth(label));
  const labelFontSize = Math.max(12.5, Math.min(15.5, 76 / labelWidth)).toFixed(1);
  const overlay = `
  <rect x="5.2" y="5.2" width="133.6" height="133.6" rx="15.4" fill="none" stroke="${THEME.red}" stroke-width="3.2" stroke-opacity=".92"/>
  <rect x="15" y="105" width="114" height="28" rx="10" fill="${THEME.raised}" stroke="${THEME.red}" stroke-width="1.4"/>
  <path d="M28 123L34 112L40 123Z" fill="none" stroke="${THEME.red}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M34 116V119" stroke="${THEME.red}" stroke-width="2" stroke-linecap="round"/>
  <circle cx="34" cy="121.5" r="1" fill="${THEME.red}"/>
  <text x="84" y="125" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${labelFontSize}" font-weight="650" text-anchor="middle">${escapeXml(label)}</text>`;
  return svg.replace("</svg>", `${overlay}\n</svg>`);
}

function microBridgeIssueLabel(issue) {
  if (issue === "restart-needed") return t("micro.restartCodex");
  if (issue === "connecting") return t("micro.connecting");
  return t("micro.checkBridge");
}

function microBridgeIssueOverlaySvg(svg, issue) {
  const accent = issue === "connecting" ? THEME.blue : THEME.amber;
  const label = compactLine(microBridgeIssueLabel(issue), 6.2);
  const labelWidth = Math.max(1, titleVisualWidth(label));
  const labelFontSize = Math.max(12.5, Math.min(15.5, 78 / labelWidth)).toFixed(1);
  const overlay = `
  <rect x="5.2" y="5.2" width="133.6" height="133.6" rx="15.4" fill="none" stroke="${accent}" stroke-width="2.5" stroke-opacity=".86"/>
  <rect x="15" y="109" width="114" height="25" rx="9.5" fill="${THEME.raised}" stroke="${accent}" stroke-width="1.2"/>
  <circle cx="29" cy="121.5" r="3.1" fill="${accent}"/>
  <text x="80" y="127" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${labelFontSize}" font-weight="650" text-anchor="middle">${escapeXml(label)}</text>`;
  return svg.replace("</svg>", `${overlay}\n</svg>`);
}

function isMicroControlAction(action) {
  return action === ACTIONS.reasoning || action === ACTIONS.fastMode;
}

function setImage(context, svg) {
  contextImages.set(context, svg);
  sendImage(context, composedContextSvg(context, svg));
}

function showFeedback(context, kind, label, durationMs) {
  const token = ++feedbackSerial;
  const feedback = { kind, label: feedbackLabel(label), token };
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
  return activityLabel(activity);
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

function normalizedReasoningModel(value) {
  const model = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9._-]*$/.test(model) ? model : null;
}

function reasoningSelectionProgress(model, effort) {
  // Codex's compact axis begins at Terra Light, immediately before Sol Light.
  // Both report the same effort token (`low`), so model identity is required
  // to keep the physical key at the true first position.
  if (normalizedReasoningModel(model)?.includes("terra")
      && normalizedReasoningEffort(effort) === "low") return 0;
  return reasoningEffortProgress(effort);
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

function reasoningTransitionKey(scope, threadId) {
  return threadId ? `${scope}:${threadId}` : null;
}

function reasoningTransitionProgressAt(transition, nowMs = renderTimeMs()) {
  if (!transition) return 0;
  const elapsedMs = Math.max(0, nowMs - transition.startedAtMs);
  if (elapsedMs >= REASONING_PROGRESS_TRANSITION_MS) return transition.to;
  const progress = smootherStep01(elapsedMs / REASONING_PROGRESS_TRANSITION_MS);
  return transition.from + (transition.to - transition.from) * progress;
}

function animatedReasoningProgress(
  scope,
  threadId,
  effort,
  model = null,
  nowMs = renderTimeMs()
) {
  const target = reasoningSelectionProgress(model, effort);
  const key = reasoningTransitionKey(scope, threadId);
  if (!key) return target;
  const previous = reasoningProgressTransitionByKey.get(key);
  if (!previous) {
    reasoningProgressTransitionByKey.set(key, {
      from: target,
      to: target,
      startedAtMs: nowMs
    });
    return target;
  }
  if (Math.abs(previous.to - target) > 0.0001) {
    const from = reasoningTransitionProgressAt(previous, nowMs);
    const transition = { from, to: target, startedAtMs: nowMs };
    reasoningProgressTransitionByKey.set(key, transition);
    return from;
  }
  return reasoningTransitionProgressAt(previous, nowMs);
}

function reasoningProgressTransitionActive(scope, threadId, nowMs = renderTimeMs()) {
  const transition = reasoningProgressTransitionByKey.get(
    reasoningTransitionKey(scope, threadId)
  );
  return Boolean(transition)
    && Math.abs(transition.from - transition.to) > 0.0001
    && nowMs - transition.startedAtMs < REASONING_PROGRESS_TRANSITION_MS;
}

function reasoningParticleMotionKey(scope, threadId) {
  return threadId ? `${scope}:${threadId}` : null;
}

function reasoningParticleSpeedAt(motion, nowMs) {
  if (!motion) return 0;
  const durationMs = motion.toSpeed > motion.fromSpeed
    ? REASONING_PARTICLE_ACCELERATION_MS
    : REASONING_PARTICLE_DECELERATION_MS;
  const elapsedMs = Math.max(0, nowMs - motion.startedAtMs);
  if (elapsedMs >= durationMs) return motion.toSpeed;
  const progress = smootherStep01(elapsedMs / durationMs);
  return motion.fromSpeed + (motion.toSpeed - motion.fromSpeed) * progress;
}

function animatedReasoningParticleMotion(scope, threadId, fast, nowMs = renderTimeMs()) {
  const targetSpeed = fast ? 1 : 0;
  const key = reasoningParticleMotionKey(scope, threadId);
  if (!key) return { phase: (nowMs % 820) / 820, speed: targetSpeed };

  let motion = reasoningParticleMotionByKey.get(key);
  if (!motion || nowMs < motion.lastAtMs) {
    motion = {
      phase: 0,
      speed: targetSpeed,
      fromSpeed: targetSpeed,
      toSpeed: targetSpeed,
      startedAtMs: nowMs,
      lastAtMs: nowMs
    };
    reasoningParticleMotionByKey.set(key, motion);
    return { phase: motion.phase, speed: motion.speed };
  }

  const previousSpeed = reasoningParticleSpeedAt(motion, motion.lastAtMs);
  let currentSpeed = reasoningParticleSpeedAt(motion, nowMs);
  const elapsedSinceFrameMs = Math.max(0, Math.min(120, nowMs - motion.lastAtMs));
  motion.phase = (motion.phase
    + elapsedSinceFrameMs / 820 * ((previousSpeed + currentSpeed) / 2)) % 1;
  motion.lastAtMs = nowMs;
  motion.speed = currentSpeed;

  if (motion.toSpeed !== targetSpeed) {
    motion.fromSpeed = currentSpeed;
    motion.toSpeed = targetSpeed;
    motion.startedAtMs = nowMs;
    motion.speed = currentSpeed;
  } else {
    const durationMs = targetSpeed > motion.fromSpeed
      ? REASONING_PARTICLE_ACCELERATION_MS
      : REASONING_PARTICLE_DECELERATION_MS;
    if (nowMs - motion.startedAtMs >= durationMs) {
      currentSpeed = targetSpeed;
      motion.speed = targetSpeed;
      motion.fromSpeed = targetSpeed;
    }
  }
  reasoningParticleMotionByKey.set(key, motion);
  return { phase: motion.phase, speed: currentSpeed };
}

function reasoningParticleTransitionActive(scope, threadId, nowMs = renderTimeMs()) {
  const motion = reasoningParticleMotionByKey.get(
    reasoningParticleMotionKey(scope, threadId)
  );
  if (!motion) return false;
  const durationMs = motion.toSpeed > motion.fromSpeed
    ? REASONING_PARTICLE_ACCELERATION_MS
    : REASONING_PARTICLE_DECELERATION_MS;
  return Math.abs(motion.toSpeed - reasoningParticleSpeedAt(motion, nowMs)) > 0.002
    && nowMs - motion.startedAtMs < durationMs;
}

function flowingReasoningSlider(accent, label, fast, layout = {}) {
  const trackX = layout.trackX ?? 9;
  const trackY = layout.trackY ?? 8;
  const trackWidth = layout.trackWidth ?? 126;
  const trackHeight = layout.trackHeight ?? 28;
  const trackFill = layout.trackFill ?? THEME.sliderTrack;
  const trackStroke = layout.trackStroke ?? "none";
  const trackStrokeWidth = layout.trackStrokeWidth ?? 0;
  const showLabel = layout.showLabel !== false;
  const idSuffix = String(layout.idSuffix ?? "");
  const fillClipId = `reasoningFillClip${idSuffix}`;
  const fillId = `reasoningFill${idSuffix}`;
  const bloomId = `reasoningBloom${idSuffix}`;
  const trackRadius = trackHeight / 2;
  const trackCenterY = trackY + trackHeight / 2;
  const effortProgress = Number.isFinite(layout.progressOverride)
    ? Math.max(0, Math.min(1, layout.progressOverride))
    : reasoningEffortProgress(label?.effort);
  const appearance = reasoningEffortAppearance(label?.effort);
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
  const particleScope = layout.particleScope ?? "slider";
  const particleThreadId = layout.particleThreadId ?? layout.idSuffix ?? particleScope;
  const particleState = animatedReasoningParticleMotion(
    particleScope,
    particleThreadId,
    fast,
    nowMs
  );
  const particleSpeed = particleState.speed;
  const particleMotion = particleSpeed > 0.002
    ? fast ? particleSpeed >= 0.998 ? "flow" : "accelerating" : "decelerating"
    : appearance.ultra ? "jitter" : "none";
  const particlePhase = particleState.phase;
  const jitterPhase = (nowMs % 1400) / 1400;
  const particleCount = 10;
  const particles = particleMotion === "none" || particleFlowWidth < 1 ? "" : Array.from({ length: particleCount }, (_, index) => {
    const random = (channel) => seededParticleUnit(index, channel);
    const loopAngle = particlePhase * Math.PI * 2;
    const jitterAngle = jitterPhase * Math.PI * 2;
    let position;
    let x;
    let y;
    let radius;
    let baseOpacity;
    if (particleSpeed > 0.002) {
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
      // Standard-speed Ultra mirrors Codex's compact slider: particles keep
      // their own place and only tremble and shimmer. Fast mode is the sole
      // state that communicates forward motion across the track.
      position = (random(0) - particlePhase + 1) % 1;
      const xJitterFrequency = 2 + Math.floor(random(1) * 3);
      const yJitterFrequency = 2 + Math.floor(random(2) * 4);
      x = trackX + particlePadding + position * particleFlowWidth
        + Math.sin(jitterAngle * xJitterFrequency + random(3) * Math.PI * 2) * (0.16 + random(4) * 0.3);
      y = trackCenterY + (random(5) - 0.5) * 10.5
        + Math.sin(jitterAngle * yJitterFrequency + random(6) * Math.PI * 2) * (0.28 + random(7) * 0.54);
      radius = 0.9 + random(8) * 0.42;
      const shimmer = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(
        jitterAngle * (1 + Math.floor(random(1) * 2)) + random(9) * Math.PI * 2
      ));
      baseOpacity = (0.56 + random(9) * 0.26) * shimmer;
    }
    const visibility = appearance.ultra ? 1 : smootherStep01(particleSpeed);
    const opacity = Math.max(0, Math.min(
      0.94,
      baseOpacity * edgeFade(position, particleSpeed > 0.002 ? 0.12 : 0.08) * visibility
    ));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="#FFFFFF" opacity="${opacity.toFixed(2)}"/>`;
  }).join("");
  const particleLayer = particles
    ? `<g data-reasoning-particles="${particleMotion}" data-reasoning-particle-speed="${particleSpeed.toFixed(3)}">${particles}</g>`
    : "";
  const modeIconPath = "M21 14L17.2 20.3H21L19.8 27L26 19H22.3L24.3 14Z";
  const restModeIcon = showLabel && fast ? `<path data-mode="fast" d="${modeIconPath}" fill="${THEME.text}" fill-opacity=".88"/>` : "";
  const filledModeIcon = showLabel && fast ? `<path data-mode="fast" d="${modeIconPath}" fill="#FFFFFF" fill-opacity=".92"/>` : "";
  const textX = fast ? 30 : 16;
  const labelText = String(label?.text ?? "");
  const fontSize = labelText.length >= 8 ? 14.8 : 16;
  const ambientGlow = appearance.ultra
    ? `<rect x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}" fill="url(#${bloomId})" opacity="${ambienceOpacity.toFixed(3)}"/>`
    : "";

  return `
  <defs>
    <clipPath id="${fillClipId}"><rect x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}"/></clipPath>
    <linearGradient id="${fillId}" x1="${trackX}" y1="0" x2="${trackX + trackWidth}" y2="0" gradientUnits="userSpaceOnUse">
      ${appearance.gradientStops}
    </linearGradient>
    ${appearance.ultra ? `<linearGradient id="${bloomId}" x1="${trackX}" y1="0" x2="${trackX + trackWidth}" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF" stop-opacity=".02"/><stop offset=".5" stop-color="#FFD7FF" stop-opacity=".62"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".02"/>
    </linearGradient>` : ""}
  </defs>
  <rect x="${trackX}" y="${trackY}" width="${trackWidth}" height="${trackHeight}" rx="${trackRadius}" fill="${trackFill}" stroke="${trackStroke}" stroke-width="${trackStrokeWidth}"/>
  <g clip-path="url(#${fillClipId})">
    <rect data-reasoning-progress="${effortProgress.toFixed(3)}" x="${trackX}" y="${trackY}" width="${fillWidth.toFixed(1)}" height="${trackHeight}" rx="${trackRadius}" fill="url(#${fillId})"/>
    ${ambientGlow}
    ${particleLayer}
  </g>
  ${restModeIcon}
  ${showLabel ? `<text x="${textX}" y="27" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" text-anchor="start" clip-path="url(#headerClip)">${escapeXml(labelText)}</text>` : ""}
  <g clip-path="url(#${fillClipId})">
    ${filledModeIcon}
    ${showLabel ? `<text x="${textX}" y="27" fill="#FFFFFF" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" text-anchor="start" clip-path="url(#headerClip)">${escapeXml(labelText)}</text>` : ""}
  </g>`;
}

function smootherStep01(value) {
  const x = Math.max(0, Math.min(1, Number(value) || 0));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function completionPulseState(threadId, nowMs = renderTimeMs()) {
  const startedAtMs = completionPulseStartedAt.get(threadId);
  if (!Number.isFinite(startedAtMs)) return null;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  if (elapsedMs >= THREAD_COMPLETION_PULSE_DURATION_MS) return null;
  const progress = elapsedMs / THREAD_COMPLETION_PULSE_DURATION_MS;
  // Three deliberate breaths keep the completed task unmistakable. A short
  // quintic attack and release remove the hard first/last-frame jump, while a
  // small floor prevents the troughs from reading as dropped frames.
  const wave = 0.5 + 0.5 * Math.cos(progress * Math.PI * 6);
  const attack = 0.14 + 0.86 * smootherStep01(elapsedMs / 180);
  const release = smootherStep01((1 - progress) / 0.14);
  const envelope = 0.78 + 0.22 * (1 - progress);
  const strength = attack * (0.16 + 0.84 * wave) * release * envelope;
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
  // Ease into the persistent task-only breath as the initial animation ends,
  // then keep a visible green floor between peaks to mean "not viewed".
  const attack = smootherStep01(elapsedMs / 320);
  const strength = attack * (0.22 + 0.5 * breath);
  return {
    elapsedMs,
    progress: phase,
    strength,
    persistent: true,
    unread: true
  };
}

function completionDismissFadeState(threadId, nowMs = renderTimeMs()) {
  const fade = completionDismissFadeByThreadId.get(threadId);
  if (!fade) return null;
  const elapsedMs = Math.max(0, nowMs - fade.startedAtMs);
  if (elapsedMs >= UNREAD_COMPLETION_DISMISS_FADE_MS) return null;
  const progress = elapsedMs / UNREAD_COMPLETION_DISMISS_FADE_MS;
  // Preserve the exact brightness visible when the completion is acknowledged,
  // then ease both opacity and stroke width to rest without a one-frame cut.
  const release = 1 - smootherStep01(progress);
  return {
    elapsedMs,
    progress,
    strength: fade.initialStrength * release,
    dismissal: true
  };
}

function visibleCompletionPulseState(thread, nowMs = renderTimeMs()) {
  if (!thread?.id || thread.status !== "completed") return null;
  return completionPulseState(thread.id, nowMs)
    ?? unreadCompletionPulseState(thread.id, nowMs)
    ?? completionDismissFadeState(thread.id, nowMs);
}

function globalCompletionPulseState(nowMs = renderTimeMs()) {
  if (!Number.isFinite(globalCompletionStartedAtMs)) return null;
  const elapsedMs = Math.max(0, nowMs - globalCompletionStartedAtMs);
  if (elapsedMs >= GLOBAL_COMPLETION_PULSE_DURATION_MS) return null;
  const progress = elapsedMs / GLOBAL_COMPLETION_PULSE_DURATION_MS;
  // Two coordinated breaths acknowledge the completion across every key.
  // Quintic attack/release keeps opacity and stroke width velocity continuous.
  const breath = 0.5 + 0.5 * Math.cos(progress * Math.PI * 4);
  const attack = 0.18 + 0.82 * smootherStep01(elapsedMs / 160);
  const release = smootherStep01((1 - progress) / 0.2);
  const envelope = 0.82 + 0.18 * (1 - progress);
  const strength = attack * (0.22 + 0.78 * breath) * release * envelope;
  return { elapsedMs, progress, strength };
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
  if (permissionIssue) rendered = permissionIssueOverlaySvg(rendered, permissionIssue);
  else if (microBridgeIssue && isMicroControlAction(contexts.get(context))) {
    rendered = microBridgeIssueOverlaySvg(rendered, microBridgeIssue);
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

function threadHeader(accent, status, statusLabel, activity, pulsing = false, reasoningEffort = null, serviceTier = null, completionEffect = null, threadId = null) {
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
  const label = compactLine(status === "working" ? activityLabel : localizeText(statusLabel), fast ? 5.7 : 6.8);
  if (status === "working") {
    return flowingReasoningSlider(accent, { text: label, effort: reasoningEffort }, fast, {
      progressOverride: animatedReasoningProgress("thread", threadId, reasoningEffort),
      particleScope: "thread",
      particleThreadId: threadId,
      idSuffix: threadId ? `Thread${String(threadId).replace(/[^A-Za-z0-9]/g, "")}` : "Thread"
    });
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
    ? t("voice.recording")
    : state === "preparing"
      ? t("voice.preparing")
      : state === "transcribing"
        ? t("voice.transcribing")
        : state === "submitting"
          ? t("voice.submitting")
          : state === "sent"
            ? t("voice.sent")
            : state === "complete"
              ? t("voice.complete")
              : t("voice.error");
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
  if (sendPressStartedAt.has(context) || activeSendDispatchByContext.has(context)) return;
  sendPressStartedAt.set(context, Date.now());
  const timer = setTimeout(() => {
    if (!sendPressStartedAt.has(context) || contexts.get(context) !== ACTIONS.send) return;
    sendLongPressArmedContexts.add(context);
    setImage(context, sendSvg(true));
  }, SEND_LONG_PRESS_MS);
  sendLongPressTimers.set(context, timer);
}

function endSendPress(context, options = {}) {
  const startedAtMs = sendPressStartedAt.get(context);
  if (!Number.isFinite(startedAtMs)) return Promise.resolve(false);
  const longPress = Date.now() - startedAtMs >= SEND_LONG_PRESS_MS;
  cancelSendPress(context, true);
  const synchronizeCurrent = options.synchronizeCurrent ?? synchronizeCurrentCodexThread;
  const focusComposer = options.focusComposer
    ?? (() => focusCurrentComposer(context));
  const sendCommand = options.sendCommand
    ?? ((command) => runKeyBridgeAwaited(command, context));
  const productionControl = !options.sendCommand && !options.focusComposer;
  const dispatch = (async () => {
    const pendingFastModeUpdate = options.fastModeUpdate ?? activeFastModeUpdate;
    if (pendingFastModeUpdate) await pendingFastModeUpdate.catch(() => false);
    const pendingNavigation = options.navigationPromise ?? currentNavigationPromise();
    if (pendingNavigation) {
      try {
        await pendingNavigation;
      } catch {
        showFeedback(context, "error", "전환 확인", 1600);
        return false;
      }
    }
    const currentThread = await synchronizeCurrent({
      force: true,
      quiet: true,
      refreshFastMode: false
    });
    if (contexts.get(context) !== ACTIONS.send) return false;
    if (productionControl) {
      const command = longPress ? "send-command" : "send";
      const result = await codexControlPlane.execute("submit", {
        micro: longPress ? null : (micro) => micro.submit(),
        legacy: async () => {
          if (!await focusComposer()) return false;
          if (currentThread?.id
              && !await currentControlThreadIsFocused(currentThread, {
                probe: options.focusProbe
              })) return false;
          return sendCommand(command);
        }
      }, { quiet: true });
      runtimeTrace("control-plane", {
        strategy: result.backend,
        result: result.ok ? "success" : "failed"
      });
      if (!result.ok) showFeedback(context, "error", "전송 확인", 1600);
      return result.ok;
    }
    if (!await focusComposer()) {
      showFeedback(context, "error", "입력창 확인", 1600);
      return false;
    }
    if (currentThread?.id
        && !await currentControlThreadIsFocused(currentThread, { probe: options.focusProbe })) {
      showFeedback(context, "error", "작업 확인", 1600);
      return false;
    }
    return sendCommand(longPress ? "send-command" : "send");
  })().finally(() => {
    if (activeSendDispatchByContext.get(context) === dispatch) {
      activeSendDispatchByContext.delete(context);
    }
  });
  activeSendDispatchByContext.set(context, dispatch);
  return dispatch;
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
  if (releaseVoice && state.voiceStarted) void Promise.resolve(state.endVoice(context, false));
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

  const productionControl = !options.openThread
    && !options.focusComposer
    && !options.beginVoice;
  const microStatus = options.microStatus
    ?? (productionControl ? microControlThreadStatus : null);
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
    microTargetVerified: false,
    activateApp: options.activateApp
      ?? (productionControl
        ? (() => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], { timeout: 5000 }))
        : (async () => true)),
    pauseMedia: options.pauseMedia ?? pauseMediaForVoice,
    resumeMedia: options.resumeMedia ?? resumeMediaAfterVoice,
    beginVoice: options.beginVoice ?? beginVoiceHold,
    endVoice: options.endVoice ?? endVoiceHold,
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
    if (initialDelayMs > 0) await state.sleep(initialDelayMs);
    if (threadPressByContext.get(context) !== state || !state.held) return false;
    if (microStatus) {
      try {
        const status = await microStatus(thread, { useMicro: true });
        if (threadPressByContext.get(context) !== state || !state.held) return false;
        if (status?.available) {
          state.microTargetVerified = status.matches === true;
          return state.microTargetVerified;
        }
      } catch (error) {
        runtimeTrace("micro-control-target", {
          result: "unavailable",
          reason: error?.code ?? "status-error"
        });
      }
    }
    const retryDelaysMs = [0, 90, 160, 280];
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
    if (!composerFocused) {
      if (threadPressByContext.get(context) === state) threadPressByContext.delete(context);
      releaseThreadMediaPause(state, context);
      setVoiceVisualState(context, "error");
      runtimeTrace("thread-hold", {
        slot: slot + 1,
        phase: "target",
        result: "unconfirmed",
        held: true
      });
      return;
    }
    clearFeedback(context);
    const voiceStarted = await Promise.resolve(state.beginVoice(context, {
      targetThreadId: state.threadId,
      autoSubmit: true,
      requireBaseline: true,
      composerAlreadyFocused: composerFocused,
      allowComposerRefocus: !state.microTargetVerified,
      pauseMedia: () => state.mediaPausePromise
    }));
    if (threadPressByContext.get(context) !== state || !state.held) {
      if (voiceStarted) await Promise.resolve(state.endVoice(context, false));
      releaseThreadMediaPause(state, context);
      return;
    }
    state.voiceStarted = voiceStarted;
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
  const shortTap = !state.armed && !state.voiceStarted;
  if (shortTap) {
    void Promise.resolve(state.openPromise).then(async (opened) => {
      if (!opened) return false;
      await state.activateApp();
      runtimeTrace("thread-navigation", {
        slot: state.slot + 1,
        strategy: "activate-after-micro",
        result: "frontmost"
      });
      return true;
    }).catch((error) => {
      runtimeTrace("thread-navigation", {
        slot: state.slot + 1,
        strategy: "activate-after-micro",
        result: "failed",
        reason: error?.code ?? "activation-error"
      });
    });
  }
  if (state.voiceStarted) void Promise.resolve(state.endVoice(context, true));
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

function fastModeSvg(
  state = fastModeState,
  activeThreadId = primaryThreadId,
  longPressArmed = false
) {
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
    ? t("fast.unavailable")
    : failed
      ? t("fast.error")
      : confirmed
        ? ""
        : t("fast.unknown");
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
  const chrome = longPressArmed
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.blue}" fill-opacity=".08" stroke="${THEME.blue}" stroke-opacity=".9" stroke-width="3"/>`
    : "";
  return shell(accent, `
    <g data-fast-state="${status}">${bolt}</g>
    ${warningText}`, "", chrome);
}

// AppKit measurements for the same bold system-font labels rendered on the
// physical key. These deliberately use the full typographic advance rather
// than the generic title-width heuristic so the separate Fast overlay never
// touches a wide glyph such as M, even after low-resolution rasterization.
const REASONING_CONTROL_LABEL_METRICS = Object.freeze({
  "TERRA LIGHT": Object.freeze({ fontSize: 16, width: 105.1 }),
  LIGHT: Object.freeze({ fontSize: 23, width: 67.4 }),
  MEDIUM: Object.freeze({ fontSize: 23, width: 93.0 }),
  HIGH: Object.freeze({ fontSize: 23, width: 57.5 }),
  XHIGH: Object.freeze({ fontSize: 23, width: 73.4 }),
  MAX: Object.freeze({ fontSize: 23, width: 52.1 }),
  ULTRA: Object.freeze({ fontSize: 23, width: 72.7 }),
  EFFORT: Object.freeze({ fontSize: 23, width: 82.0 })
});

// Material Symbols Rounded `bolt`, weight 600, fill 1 (Apache-2.0).
// Its rounded, full-height silhouette stays balanced at Neo key resolution.
// Keep the source path intact and map it through one ordinary SVG transform:
// Stream Deck's hardware renderer can omit a nested <svg> even though desktop
// preview renderers display it. See NOTICE.md and the packaged license text.
const REASONING_FAST_BOLT_PATH = "M343.04-338.52H232.61q-31.91 0-47.09-28.28-15.17-28.29 3.35-55.07l327.26-471.26q11.7-16.26 30.24-22.33 18.54-6.06 37.24 1.07 18.7 7.13 28.67 24.11 9.98 16.97 7.42 36.8l-33.7 272h142.57q33.91 0 48.08 30.35 14.18 30.35-7.91 56.56L410.91-63.82q-12.69 15.26-30.95 19.26-18.26 4-36.09-3.57-17.83-7.56-27.18-24.32-9.34-16.77-6.78-36.03l33.13-230.04Z";
const REASONING_FAST_GLYPH_WIDTH = 12;
const REASONING_FAST_GLYPH_SCALE = 0.02;
const REASONING_FAST_GLYPH_SOURCE_LEFT = 180;
const REASONING_FAST_GLYPH_TRANSLATE_Y = 58.6;

function reasoningControlSvg(
  state = fastModeState,
  activeThreadId = primaryThreadId,
  direction = reasoningDirectionByThreadId.get(activeThreadId) ?? "up",
  busy = false
) {
  const effort = state?.threadId === activeThreadId
    ? normalizedReasoningEffort(state?.reasoningEffort)
    : null;
  const model = state?.threadId === activeThreadId
    ? normalizedReasoningModel(state?.model)
    : null;
  const terraLight = model?.includes("terra") && effort === "low";
  const fast = state?.threadId === activeThreadId && state?.enabled === true;
  const status = effort ?? "unknown";
  const accent = effort === "ultra"
    ? appearanceMode === "light" ? "#7040C7" : "#B15CE8"
    : effort ? THEME.blue : THEME.amber;
  const levelLabel = terraLight ? "TERRA LIGHT" : ({
    none: "LIGHT",
    minimal: "LIGHT",
    low: "LIGHT",
    medium: "MEDIUM",
    high: "HIGH",
    xhigh: "XHIGH",
    max: "MAX",
    ultra: "ULTRA"
  }[effort] ?? "EFFORT");
  const labelMetrics = REASONING_CONTROL_LABEL_METRICS[levelLabel]
    ?? REASONING_CONTROL_LABEL_METRICS.EFFORT;
  const levelFontSizePx = labelMetrics.fontSize;
  const speedGlyphWidth = REASONING_FAST_GLYPH_WIDTH;
  const speedGlyphGap = 7;
  const levelLabelWidth = labelMetrics.width;
  const speedGlyphX = Math.max(
    2,
    72 - levelLabelWidth / 2 - speedGlyphGap - speedGlyphWidth
  );
  const slider = flowingReasoningSlider(
    accent,
    { effort },
    fast,
    {
      trackX: 16,
      trackY: 79,
      trackWidth: 114,
      trackHeight: 24,
      trackFill: THEME.raised,
      trackStroke: THEME.borderStrong,
      trackStrokeWidth: 1,
      showLabel: false,
      idSuffix: "Control",
      particleScope: "control",
      particleThreadId: activeThreadId,
      progressOverride: animatedReasoningProgress(
        "control",
        activeThreadId,
        effort,
        model
      )
    }
  );
  const speedGlyphTransformX = speedGlyphX
    - REASONING_FAST_GLYPH_SOURCE_LEFT * REASONING_FAST_GLYPH_SCALE;
  const speedGlyph = fast
    ? `<g data-reasoning-fast-overlay="label-left" data-reasoning-fast="on" data-reasoning-fast-left="${speedGlyphX.toFixed(1)}" transform="translate(${speedGlyphTransformX.toFixed(1)} ${REASONING_FAST_GLYPH_TRANSLATE_Y}) scale(${REASONING_FAST_GLYPH_SCALE})" pointer-events="none"><path d="${REASONING_FAST_BOLT_PATH}" fill="${accent}"/></g>`
    : "";
  const chrome = busy
    ? `<rect x="5.5" y="5.5" width="133" height="133" rx="15" fill="${THEME.blue}" fill-opacity=".05" stroke="${THEME.blue}" stroke-opacity=".78" stroke-width="2.6"/>`
    : "";
  return shell(accent, `
    <g data-reasoning-state="${status}" data-reasoning-direction="${direction !== "down" ? "up" : "down"}" data-fast-state="${fast ? "on" : "off"}">
      <g data-reasoning-label-layer="center"><text data-reasoning-label="${status}" x="72" y="58" fill="${THEME.text}" font-family="${FONT_STACK}" font-size="${levelFontSizePx}" font-weight="760" text-anchor="middle">${levelLabel}</text></g>
      ${speedGlyph}
      ${slider}
    </g>`, "", chrome);
}

function cancelFastModePress(context, restoreImage = false) {
  const timer = fastModeLongPressTimers.get(context);
  if (timer) clearTimeout(timer);
  fastModeLongPressTimers.delete(context);
  fastModePressStartedAt.delete(context);
  fastModeLongPressArmedContexts.delete(context);
  if (restoreImage) {
    const action = contexts.get(context);
    if (action === ACTIONS.fastMode) setImage(context, fastModeSvg());
    else if (action === ACTIONS.reasoning) {
      const svg = staticActionSvg(action, context);
      if (svg) setImage(context, svg);
    }
  }
}

function triggerReasoningFastModeHold(context, options = {}) {
  if (!fastModePressStartedAt.has(context)
      || contexts.get(context) !== ACTIONS.reasoning) return Promise.resolve(false);
  const existing = fastModeLongPressUpdates.get(context);
  if (fastModeLongPressArmedContexts.has(context)) {
    return existing ?? Promise.resolve(true);
  }
  fastModeLongPressArmedContexts.add(context);
  const svg = staticActionSvg(ACTIONS.reasoning, context);
  if (svg) setImage(context, svg);

  // Once the physical hold crosses its threshold, it is unambiguously a Fast
  // gesture. Start the verified toggle now instead of adding key-up latency.
  // key-up only clears the press bookkeeping and returns this same operation.
  const update = afterFastModeUpdate(
    () => toggleFastMode(context, options.fastMode ?? options)
  );
  fastModeLongPressUpdates.set(context, update);
  update.then(
    () => {
      if (fastModeLongPressUpdates.get(context) === update) {
        fastModeLongPressUpdates.delete(context);
      }
    },
    () => {
      if (fastModeLongPressUpdates.get(context) === update) {
        fastModeLongPressUpdates.delete(context);
      }
    }
  );
  return update;
}

function beginFastModePress(context, options = {}) {
  const action = contexts.get(context);
  if (fastModePressStartedAt.has(context)
      || (activeFastModeUpdate && action !== ACTIONS.reasoning)) return;
  fastModePressStartedAt.set(context, Date.now());
  const timer = setTimeout(() => {
    if (!fastModePressStartedAt.has(context)
        || ![ACTIONS.fastMode, ACTIONS.reasoning].includes(contexts.get(context))) return;
    const action = contexts.get(context);
    if (action === ACTIONS.reasoning) {
      void triggerReasoningFastModeHold(context, options);
    } else {
      fastModeLongPressArmedContexts.add(context);
      setImage(context, fastModeSvg(fastModeState, currentControlThreadId(), true));
    }
  }, FAST_MODE_LONG_PRESS_MS);
  fastModeLongPressTimers.set(context, timer);
}

function endFastModePress(context, options = {}) {
  const startedAtMs = fastModePressStartedAt.get(context);
  if (!Number.isFinite(startedAtMs)) return Promise.resolve(false);
  cancelFastModePress(context, true);
  return toggleFastMode(context, options);
}

function endReasoningControlPress(context, options = {}) {
  const startedAtMs = fastModePressStartedAt.get(context);
  if (!Number.isFinite(startedAtMs)) return Promise.resolve(false);
  const triggeredAtThreshold = fastModeLongPressArmedContexts.has(context);
  const thresholdUpdate = fastModeLongPressUpdates.get(context);
  const longPress = triggeredAtThreshold
    || Date.now() - startedAtMs >= FAST_MODE_LONG_PRESS_MS;
  // A short tap is immediately replaced by its optimistic effort frame, so
  // avoid sending an unnecessary old-state frame first. Long press still
  // clears its armed border while waiting to toggle Fast mode.
  cancelFastModePress(context, longPress && !triggeredAtThreshold);
  if (triggeredAtThreshold) {
    return thresholdUpdate ?? Promise.resolve(true);
  }
  return longPress
    // Event-loop starvation can deliver key-up before the matured timer. Keep
    // a release-time fallback, but the normal path starts exactly at 0.6 s.
    ? afterFastModeUpdate(() => toggleFastMode(context, options.fastMode ?? options))
    : stepReasoningEffort(context, options.reasoning ?? options);
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
  const controlThreadId = currentControlThreadId();
  if (action === ACTIONS.newThread) return newThreadSvg();
  if (action === ACTIONS.voice) {
    const state = context
      ? voiceHeldContexts.has(context) ? "recording" : voiceStateByContext.get(context) ?? "idle"
      : "idle";
    return voiceSvg(state);
  }
  if (action === ACTIONS.send) return sendSvg(context ? sendLongPressArmedContexts.has(context) : false);
  if (action === ACTIONS.appSwitch) return appSwitchSvg();
  if (action === ACTIONS.fastMode) {
    return fastModeSvg(
      fastModeState,
      controlThreadId,
      context ? fastModeLongPressArmedContexts.has(context) : false
    );
  }
  if (action === ACTIONS.reasoning) {
    const visual = reasoningVisualOverrideByThreadId.get(controlThreadId);
    const displayState = visual
      ? {
        ...fastModeState,
        threadId: controlThreadId,
        model: visual.model ?? fastModeState.model,
        reasoningEffort: visual.effort,
        failed: false
      }
      : fastModeState;
    return reasoningControlSvg(
      displayState,
      controlThreadId,
      visual?.direction ?? reasoningDirectionByThreadId.get(controlThreadId) ?? "up",
      context ? reasoningBusyContexts.has(context) : false
    );
  }
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

function sendContextResult(context, event) {
  if (context && contexts.has(context)) send({ event, context });
}

function renderPermissionIssueContexts() {
  for (const [context] of contexts) {
    const svg = contextImages.get(context);
    if (svg) sendImage(context, composedContextSvg(context, svg));
  }
}

function renderMicroBridgeIssueContexts() {
  for (const [context, action] of contexts) {
    if (!isMicroControlAction(action)) continue;
    const svg = contextImages.get(context);
    if (svg) sendImage(context, composedContextSvg(context, svg));
  }
}

function alertMicroBridgeContext(context) {
  if (!context
      || !isMicroControlAction(contexts.get(context))
      || microBridgeAlertedContexts.has(context)) return;
  microBridgeAlertedContexts.add(context);
  sendContextResult(context, "showAlert");
}

function setMicroBridgeIssue(nextIssue) {
  if (microBridgeIssue === nextIssue) return false;
  const previousIssue = microBridgeIssue;
  microBridgeIssue = nextIssue;
  microBridgeAlertedContexts.clear();
  renderMicroBridgeIssueContexts();
  for (const [context, action] of contexts) {
    if (!isMicroControlAction(action)) continue;
    if (["restart-needed", "error"].includes(nextIssue)) alertMicroBridgeContext(context);
    else if (previousIssue && !nextIssue) sendContextResult(context, "showOk");
  }
  return true;
}

function handleMicroBootstrapStatus(status) {
  microBootstrapStatus = status ?? { state: "error", detail: "unknown", atMs: Date.now() };
  runtimeTrace("micro-bootstrap", {
    phase: microBootstrapStatus.state,
    reason: String(microBootstrapStatus.detail ?? "").slice(0, 48)
  });
  if (microBootstrapStatus.state === "connected") {
    setMicroBridgeIssue(null);
    codexMicroBridge.disconnect();
    void refreshMicroReadOnly({ force: true, quiet: true });
    return;
  }
  if (microBootstrapStatus.state === "restart-needed") {
    setMicroBridgeIssue("restart-needed");
    return;
  }
  if (microBootstrapStatus.state === "recovering"
      || (microBootstrapStatus.state === "waiting"
        && ["confirm-unbridged", "recovery-startup"].includes(microBootstrapStatus.detail))) {
    setMicroBridgeIssue("connecting");
    return;
  }
  if (microBootstrapStatus.state === "error") {
    setMicroBridgeIssue("error");
    return;
  }
  setMicroBridgeIssue(null);
}

function alertPermissionContext(context) {
  if (!context || permissionAlertedContexts.has(context)) return;
  permissionAlertedContexts.add(context);
  sendContextResult(context, "showAlert");
}

function setPermissionIssue(nextIssue, context = null) {
  if (permissionIssue === nextIssue) {
    if (nextIssue) alertPermissionContext(context);
    return false;
  }
  const previousIssue = permissionIssue;
  permissionIssue = nextIssue;
  permissionAlertedContexts.clear();
  renderPermissionIssueContexts();
  for (const [visibleContext] of contexts) {
    if (nextIssue) alertPermissionContext(visibleContext);
    else if (previousIssue) sendContextResult(visibleContext, "showOk");
  }
  return true;
}

function permissionHealthFromResult(result) {
  return parsePermissionHealth(result?.stdout ?? result ?? "");
}

function legacyPermissionHealthSync() {
  let accessibility = false;
  let postEvent = false;
  try {
    execFileSync(KEY_BRIDGE, ["accessibility-preflight"], { stdio: "ignore", timeout: 800 });
    accessibility = true;
  } catch {
    accessibility = false;
  }
  try {
    execFileSync(KEY_BRIDGE, ["preflight"], { stdio: "ignore", timeout: 800 });
    postEvent = true;
  } catch {
    postEvent = false;
  }
  return {
    accessibility,
    postEvent,
    codexRunning: null,
    codexAccess: null,
    axError: null
  };
}

function permissionHealthSync(nowMs = Date.now(), force = false) {
  if (!force
      && permissionHealthCache.health
      && nowMs - permissionHealthCache.checkedAtMs < PERMISSION_HEALTH_CACHE_MS) {
    return permissionHealthCache.health;
  }
  let health = null;
  try {
    health = parsePermissionHealth(execFileSync(KEY_BRIDGE, ["permission-health"], {
      encoding: "utf8",
      timeout: 1200,
      maxBuffer: 4096
    }));
  } catch (error) {
    health = parsePermissionHealth(error?.stdout);
  }
  health ??= legacyPermissionHealthSync();
  permissionHealthCache = { checkedAtMs: nowMs, health };
  return health;
}

function commandPermissionRequirements(command) {
  if (command.includes("selftest")) {
    return { accessibility: false, postEvent: false, codex: false };
  }
  const codexCommand = command.startsWith("codex-") && command !== "codex-wait-frontmost";
  const reasoningCommand = command.startsWith("reasoning-effort-");
  const accessibility = command.startsWith("fast-mode-")
    || reasoningCommand
    || codexCommand
    || [
      "focused-text-state",
      "editable-text-state",
      "focused-element-info",
      "editable-element-info",
      "selected-element-info",
      "media-pause-if-playing",
      "media-resume-paused",
      "media-playback-state",
      "media-playback-debug",
      "media-accessibility-state",
      "media-active-debug"
    ].includes(command);
  const postEvent = command.startsWith("fast-mode-")
    || reasoningCommand
    || command.startsWith("codex-open-thread")
    || command.startsWith("codex-open-side-chat")
    || command.startsWith("codex-find-thread")
    || command.startsWith("codex-search-thread")
    || [
      "voice-down",
      "send",
      "send-command",
      "app-switch",
      "new-thread",
      "side-chat",
      "selftest",
      "voice-event-selftest",
      "media-previous",
      "media-rewind",
      "media-pause-if-playing",
      "media-resume-paused",
      "media-play-pause",
      "media-forward",
      "media-mute",
      "media-volume-down",
      "media-volume-up",
      "media-next"
    ].includes(command);
  return {
    accessibility,
    postEvent,
    codex: (accessibility && codexCommand)
      || command.startsWith("fast-mode-")
      || reasoningCommand
  };
}

function commandPermissionIssue(command, health) {
  const requirements = commandPermissionRequirements(command);
  if (requirements.accessibility && health?.accessibility === false) return "accessibility";
  if (requirements.postEvent && health?.postEvent === false) return "post-event";
  if (requirements.codex
      && health?.codexRunning === true
      && health?.codexAccess === false) return "codex-access";
  return null;
}

function requestSystemPermissions(context = null, nowMs = Date.now()) {
  if (nowMs - lastPermissionRequestAtMs < PERMISSION_REQUEST_COOLDOWN_MS) {
    if (permissionIssue) alertPermissionContext(context);
    return false;
  }
  lastPermissionRequestAtMs = nowMs;
  execFile(KEY_BRIDGE, ["permission-request"], {
    timeout: 5000,
    maxBuffer: 4096
  }, (error, stdout) => {
    const health = parsePermissionHealth(stdout ?? error?.stdout);
    if (health) permissionHealthCache = { checkedAtMs: Date.now(), health };
  });
  for (const delayMs of PERMISSION_RECHECK_DELAYS_MS) {
    setTimeout(() => void refreshPermissionHealth({ force: true }), delayMs);
  }
  return true;
}

function refreshPermissionHealth(options = {}) {
  if (activePermissionRefresh && !options.force) return activePermissionRefresh;
  const refresh = (async () => {
    let health = null;
    try {
      const result = await execFileAsync(KEY_BRIDGE, ["permission-health"], {
        timeout: 1500,
        maxBuffer: 4096
      });
      health = permissionHealthFromResult(result);
    } catch (error) {
      health = parsePermissionHealth(error?.stdout);
    }
    if (!health) health = permissionHealthSync(Date.now(), true);
    permissionHealthCache = { checkedAtMs: Date.now(), health };

    let issue = permissionIssueForHealth(health);
    if (!issue && health?.codexRunning === true && health?.codexAccess === false) {
      const nowMs = Date.now();
      if (nowMs - lastCodexAccessFailureAtMs > OPERATION_FAILURE_WINDOW_MS) {
        codexAccessFailureCount = 0;
      }
      lastCodexAccessFailureAtMs = nowMs;
      codexAccessFailureCount += 1;
      if (codexAccessFailureCount >= OPERATION_FAILURE_THRESHOLD) issue = "codex-access";
    } else if (!issue) {
      codexAccessFailureCount = 0;
      lastCodexAccessFailureAtMs = 0;
    }

    runtimeTrace("permission-health", {
      accessibility: health?.accessibility,
      postEvent: health?.postEvent,
      codexAccess: health?.codexAccess,
      issue: issue ?? "none"
    });
    if (issue) {
      setPermissionIssue(issue, options.context ?? null);
      if (options.promptIfMissing && ["accessibility", "post-event"].includes(issue)) {
        requestSystemPermissions(options.context ?? null);
      }
    } else if (["accessibility", "post-event", "codex-access"].includes(permissionIssue)) {
      setPermissionIssue(null);
    }
    return health;
  })().finally(() => {
    if (activePermissionRefresh === refresh) activePermissionRefresh = null;
  });
  activePermissionRefresh = refresh;
  return refresh;
}

function ensureCommandPermissions(command, context = null, quiet = false) {
  const health = permissionHealthSync(Date.now(), Boolean(permissionIssue));
  const issue = commandPermissionIssue(command, health);
  if (!issue) return true;
  setPermissionIssue(issue, context);
  requestSystemPermissions(context);
  if (!quiet && context) showFeedback(context, "error", "권한 요청", 2400);
  console.error(`Key bridge ${command} is blocked by ${issue}`);
  return false;
}

function bridgeCapability(command) {
  if (command.startsWith("codex-")
      || command.startsWith("fast-mode-")
      || command.startsWith("reasoning-effort-")) return "codex";
  if (command.startsWith("media-") || command.startsWith("audio-")) return "media";
  return "input";
}

function noteBridgeSuccess(command, quiet = false) {
  const capability = bridgeCapability(command);
  if (quiet && permissionIssue !== `${capability}-operation`) return;
  operationFailureByCapability.delete(capability);
  if (permissionIssue === `${capability}-operation`) setPermissionIssue(null);
  if (["accessibility", "post-event", "codex-access"].includes(permissionIssue)) {
    void refreshPermissionHealth({ force: true });
  }
}

function noteBridgeFailure(command, error, context = null, quiet = false) {
  const exitCode = keyBridgeExitCode(error);
  const health = permissionHealthSync(Date.now(), true);
  let issue = commandPermissionIssue(command, health) ?? permissionIssueForHealth(health);
  if (!issue && [77, 79].includes(exitCode)) issue = "accessibility";
  if (!issue && exitCode === 78) issue = "post-event";
  if (issue) {
    setPermissionIssue(issue, context);
    requestSystemPermissions(context);
    if (!quiet && context) showFeedback(context, "error", "권한 요청", 2400);
    return true;
  }
  if (bridgeFailureStaysLocal(command)) {
    runtimeTrace("bridge-health", {
      result: "failed",
      reason: command.slice(0, 48),
      issue: "local-control"
    });
    return false;
  }
  const capability = bridgeCapability(command);
  const mediaHealthFailure = capability === "media" && exitCode !== 2;
  if ((quiet && !mediaHealthFailure) || isAbortError(error)) return false;
  const nowMs = Date.now();
  const prior = operationFailureByCapability.get(capability);
  const count = prior && nowMs - prior.lastAtMs <= OPERATION_FAILURE_WINDOW_MS
    ? prior.count + 1
    : 1;
  operationFailureByCapability.set(capability, { count, lastAtMs: nowMs });
  const threshold = capability === "media" ? 1 : OPERATION_FAILURE_THRESHOLD;
  if (count >= threshold) {
    setPermissionIssue(`${capability}-operation`, context);
  }
  runtimeTrace("bridge-health", {
    result: "failed",
    reason: command.slice(0, 48),
    issue: count >= threshold ? `${capability}-operation` : "transient"
  });
  return false;
}

function runKeyBridge(command, context = null) {
  if (!ensureCommandPermissions(command, context)) return false;
  execFile(KEY_BRIDGE, [command], { timeout: 2000 }, (error) => {
    if (!error) {
      noteBridgeSuccess(command);
      return;
    }
    const permissionFailure = noteBridgeFailure(command, error, context);
    if (context && !permissionFailure) showFeedback(context, "error", "키 입력 실패");
    console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
  });
  return true;
}

async function runKeyBridgeAwaited(command, context = null, options = {}) {
  const quiet = Boolean(options.quiet);
  if (!ensureCommandPermissions(command, context, quiet)) return false;
  try {
    await execFileAsync(KEY_BRIDGE, [command], {
      timeout: command.startsWith("codex-") ? 2500 : 1000,
      maxBuffer: 64 * 1024
    });
    noteBridgeSuccess(command, quiet);
    return true;
  } catch (error) {
    const permissionFailure = noteBridgeFailure(command, error, context, quiet);
    if (!quiet) {
      if (context && !permissionFailure) showFeedback(context, "error", "키 입력 실패");
      console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
    }
    return false;
  }
}

function runKeyBridgeSync(command, context = null, options = {}) {
  const quiet = Boolean(options.quiet);
  const releasesHeldKeys = command === "voice-up" || command === "release";
  if (!releasesHeldKeys && !ensureCommandPermissions(command, context, quiet)) return false;
  try {
    execFileSync(KEY_BRIDGE, [command], {
      stdio: "ignore",
      timeout: command === "voice-up" || command.startsWith("codex-") ? 2500 : 1000
    });
    noteBridgeSuccess(command, quiet);
    return true;
  } catch (error) {
    const permissionFailure = noteBridgeFailure(command, error, context, quiet);
    if (!quiet) {
      if (context && !permissionFailure) showFeedback(context, "error", "키 입력 실패");
      console.error(`Key bridge ${command} failed: ${error?.message ?? "unknown error"}`);
    }
    return false;
  }
}

function primeAccessibilityTrust() {
  void refreshPermissionHealth({ force: true, promptIfMissing: true });
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

function bindPendingVoiceContextsToThread(
  threadId,
  nowMs = Date.now(),
  provisionalSideChatRequestedAtMs = null
) {
  if (!threadId) return;
  lastOpenedThreadId = threadId;
  lastOpenedThreadAtMs = nowMs;
  for (const [context, transcription] of voiceTranscriptionByContext) {
    if (contexts.get(context) !== ACTIONS.voice || voiceTargetThreadByContext.has(context)) continue;
    if (Number.isFinite(provisionalSideChatRequestedAtMs)
        && transcription?.provisionalSideChatRequestedAtMs
          !== provisionalSideChatRequestedAtMs) continue;
    if (transcription) {
      transcription.targetThreadId = threadId;
      delete transcription.provisionalSideChatRequestedAtMs;
    }
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
  const { requestedAtMs, knownIds, parentId, targetThreadId: resolvedThreadId } = pendingSideChatTarget;
  if (resolvedThreadId) return resolvedThreadId;
  const listedCandidate = sideChats
    .filter((thread) => !knownIds.has(thread.id)
      && Number.isFinite(thread.createdAtMs)
      && thread.createdAtMs + APP_SERVER_START_TOLERANCE_MS >= requestedAtMs)
    .sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a))[0];
  const targetThreadId = listedCandidate?.id
    ?? await readPendingSideChatIdFromDesktopLog(requestedAtMs, knownIds);
  if (targetThreadId) {
    // Keep the creation lease alive after discovery. Current-task controls
    // may already be pressed while Codex is animating the Side Chat panel;
    // only the focused-identity confirmation below is allowed to release
    // them into the shared composer.
    pendingSideChatTarget = {
      ...pendingSideChatTarget,
      targetThreadId
    };
    if (parentId) sideChatParentById.set(targetThreadId, parentId);
    promoteSideChatFocusLease(
      listedCandidate ?? {
        id: targetThreadId,
        title: t("activity.sideChat"),
        parentId,
        remote: false,
        ephemeral: true,
        requiresStrictIdentity: true
      },
      { render: true }
    );
    bindPendingVoiceContextsToThread(targetThreadId, nowMs, requestedAtMs);
    return targetThreadId;
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

async function waitForPendingSideChatComposerReady(requestedAtMs, options = {}) {
  const signal = options.signal ?? null;
  const sleep = options.sleep ?? sleepWithSignal;
  const focusComposer = options.focusComposer
    ?? (() => runKeyBridgeAwaited("codex-focus-side-chat-composer", null, { quiet: true }));

  for (const delayMs of SIDE_CHAT_COMPOSER_READY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs, signal);
    throwIfAborted(signal);
    if (pendingSideChatTarget?.requestedAtMs !== requestedAtMs) return null;
    if (await focusComposer()) {
      return {
        requestedAtMs,
        targetThreadId: pendingSideChatTarget?.targetThreadId ?? null
      };
    }
  }
  return null;
}

async function waitForPendingSideChatFocus(requestedAtMs, options = {}) {
  const signal = options.signal ?? null;
  const sleep = options.sleep ?? sleepWithSignal;
  const refresh = options.refresh ?? (() => refreshThreads());
  const focusProbe = options.focusProbe;
  const remember = options.rememberThread ?? rememberVerifiedThread;
  const pollAtMs = [...new Set([
    ...SIDE_CHAT_TARGET_REFRESH_DELAYS_MS,
    SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS
  ])].sort((left, right) => left - right);
  let elapsedMs = 0;

  for (const targetElapsedMs of pollAtMs) {
    const delayMs = Math.max(0, targetElapsedMs - elapsedMs);
    if (delayMs > 0) await sleep(delayMs, signal);
    elapsedMs = targetElapsedMs;
    throwIfAborted(signal);
    await refresh();
    throwIfAborted(signal);

    const pending = pendingSideChatTarget;
    if (!pending || pending.requestedAtMs !== requestedAtMs) break;
    if (!pending.targetThreadId) continue;
    const thread = currentThreadIdentityCandidates
      .find((candidate) => candidate?.id === pending.targetThreadId)
      ?? combinedVisibleThreads()
        .find((candidate) => candidate?.id === pending.targetThreadId)
      ?? {
        id: pending.targetThreadId,
        title: "",
        remote: false,
        ephemeral: true,
        requiresStrictIdentity: true
      };
    if (!await threadIsFocused(thread, { probe: focusProbe, signal })) continue;

    promoteSideChatFocusLease(thread, { render: false });
    remember(thread, {
      recordOpenedHint: true,
      refreshFastMode: false
    });
    pendingSideChatTarget = null;
    return thread;
  }

  if (pendingSideChatTarget?.requestedAtMs === requestedAtMs) {
    pendingSideChatTarget = null;
  }
  throw new Error("new Side Chat did not become the focused Codex task");
}

function resolveVoiceTargetThreadId(nowMs = Date.now()) {
  const leasedComposer = activeComposerFocusThread(currentThreadIdentityCandidates);
  if (leasedComposer) {
    return isProvisionalComposerThread(leasedComposer) ? null : leasedComposer.id;
  }
  if (pendingSideChatTarget) {
    if (nowMs - pendingSideChatTarget.requestedAtMs < SIDE_CHAT_TARGET_DISCOVERY_TIMEOUT_MS) return null;
    pendingSideChatTarget = null;
  }
  const visibleIds = new Set(combinedVisibleThreads().map((thread) => thread.id));
  // The dedicated microphone belongs to the Dashboard's Current Task. A
  // manually selected Codex task must outrank older Stream Deck navigation
  // hints and recency ordering, otherwise the transcript lands in the visible
  // composer while the recording overlay names a different task.
  if (primaryThreadId && visibleIds.has(primaryThreadId)) return primaryThreadId;
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
  if (!options.probe && options.useMicro !== false) {
    const snapshot = await codexControlPlane.refreshReadOnly({ quiet: true });
    const activeThreadId = microSnapshotActiveThreadId(snapshot);
    if (activeThreadId) return activeThreadId === targetThreadId;
  }
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
  const submit = options.submit
    ?? (options.bridge
      ? async () => bridge("codex-submit-composer", null, { quiet: true })
      : async () => {
        const result = await codexControlPlane.execute("submit", {
          micro: (micro) => micro.submit(),
          legacy: () => bridge("codex-submit-composer", null, { quiet: true })
        }, { quiet: true });
        return result.ok;
      });
  const waitForDraftReset = options.waitForDraftReset ?? waitForVoiceDraftReset;
  const scheduleRefresh = options.scheduleRefresh ?? (() => setTimeout(() => void refreshThreads(), 500));
  const targetFocused = options.targetFocused ?? voiceTargetIsFocused;
  const productionControl = !options.openApp
    && !options.bridge
    && !options.submit
    && !options.targetFocused;
  const microStatus = options.microStatus
    ?? (productionControl ? microControlThreadStatus : null);
  const requireTargetFocus = async (phase) => {
    if (await targetFocused(targetThreadId)) return true;
    failVoiceTranscription(context);
    runtimeTrace("voice-submit", { phase, result: "not-focused" });
    return false;
  };
  try {
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;
    let microTargetVerified = false;
    if (microStatus) {
      const targetThread = combinedVisibleThreads().find(
        (candidate) => candidate?.id === targetThreadId
      ) ?? { id: targetThreadId };
      try {
        const status = await microStatus(targetThread, { useMicro: true });
        if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;
        if (status?.available) {
          if (!status.matches) {
            failVoiceTranscription(context);
            runtimeTrace("voice-submit", { phase: "micro-target-check", result: "mismatch" });
            return;
          }
          microTargetVerified = true;
        }
      } catch (error) {
        runtimeTrace("micro-control-target", {
          result: "unavailable",
          reason: error?.code ?? "status-error"
        });
      }
    }
    if (!microTargetVerified) {
      await openApp();
      await sleep(140);
    }
    if (!voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) return;
    if (!microTargetVerified && !await requireTargetFocus("target-check")) return;

    const clickedSubmit = await submit();
    let confirmed = clickedSubmit
      && await waitForDraftReset(context, targetThreadId, tracker, options);
    const allowKeyboardFallback = options.allowKeyboardFallback ?? !microTargetVerified;
    if (!confirmed
        && allowKeyboardFallback
        && voiceSubmissionStillCurrent(context, targetThreadId, tracker.sessionId)) {
      // The explicit button is preferred, but Codex can rebuild the composer
      // between transcription and submission. Refocus the draft and retry with
      // Return, then verify the draft actually cleared before showing success.
      // Recheck immediately before that fallback so a task switch during the
      // first confirmation wait can never submit into the new task.
      if (!await requireTargetFocus("fallback-target-check")) return;
      if (!bridge("codex-focus-composer", null, { quiet: true })) {
        failVoiceTranscription(context);
        runtimeTrace("voice-submit", { phase: "fallback-focus", result: "failed" });
        return;
      }
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
      const resumed = Boolean(await bridge("media-resume-paused", null, { quiet: true }));
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

function cancelCurrentVoicePress(context, releaseStarted = true) {
  const state = currentVoicePressByContext.get(context);
  if (!state) return false;
  state.held = false;
  currentVoicePressByContext.delete(context);
  if (releaseStarted && state.voiceStarted) void endVoiceHold(context);
  else if (!state.voiceStarted && voiceStateByContext.get(context) === "preparing") {
    setVoiceVisualState(context, "idle");
  }
  return true;
}

function beginCurrentVoicePress(context, options = {}) {
  if (currentVoicePressByContext.has(context) || voiceHeldContexts.has(context)) return false;
  const state = {
    held: true,
    voiceStarted: false,
    promise: null
  };
  currentVoicePressByContext.set(context, state);
  setVoiceVisualState(context, "preparing");
  const synchronizeCurrent = options.synchronizeCurrent ?? synchronizeCurrentCodexThread;
  const focusComposer = options.focusComposer
    ?? (() => focusCurrentComposer(context));
  const focusSideChatComposer = options.focusSideChatComposer
    ?? (() => runKeyBridgeAwaited(
      "codex-focus-side-chat-composer",
      context,
      { quiet: true }
    ));
  const candidateSideChatCreation = options.sideChatCreation === undefined
    ? activeComposerCreation
    : options.sideChatCreation;
  const sideChatCreation = candidateSideChatCreation?.kind === "side-chat"
      && candidateSideChatCreation?.composerReadyPromise
    ? candidateSideChatCreation
    : null;
  const beginVoice = options.beginVoice ?? beginVoiceHold;
  const productionControl = !options.synchronizeCurrent
    && !options.focusComposer
    && !options.focusSideChatComposer
    && !options.beginVoice;
  const microStatus = options.microStatus
    ?? (productionControl ? microControlThreadStatus : null);
  state.promise = (async () => {
    const pendingFastModeUpdate = options.fastModeUpdate ?? activeFastModeUpdate;
    if (pendingFastModeUpdate) await pendingFastModeUpdate.catch(() => false);

    // A brand-new Side Chat does not have a conversation UUID immediately.
    // The dedicated microphone can still target its verified right-side
    // composer without guessing an existing task. The provisional timestamp
    // is handed to the real UUID as soon as Codex publishes it.
    if (sideChatCreation) {
      const composerReady = await sideChatCreation.composerReadyPromise;
      if (!composerReady) {
        if (state.held && currentVoicePressByContext.get(context) === state) {
          setVoiceVisualState(context, "error");
        }
        return false;
      }
      if (!state.held
          || currentVoicePressByContext.get(context) !== state
          || contexts.get(context) !== ACTIONS.voice) return false;
      const pending = pendingSideChatTarget?.requestedAtMs === composerReady.requestedAtMs
        ? pendingSideChatTarget
        : null;
      const targetThreadId = sideChatCreation.targetThreadId
        ?? pending?.targetThreadId
        ?? "";
      let composerFocused = await focusSideChatComposer();
      const focusedThread = sideChatCreation.focusedThread;
      if (!composerFocused && targetThreadId && focusedThread?.id === targetThreadId) {
        composerFocused = await focusComposer()
          && await threadIsFocused(focusedThread, { probe: options.focusProbe });
      }
      if (!composerFocused) {
        setVoiceVisualState(context, "error");
        return false;
      }
      if (!state.held || currentVoicePressByContext.get(context) !== state) return false;
      const voiceStarted = await Promise.resolve(beginVoice(context, {
        targetThreadId,
        provisionalSideChatRequestedAtMs: targetThreadId
          ? null
          : composerReady.requestedAtMs,
        composerAlreadyFocused: true
      }));
      if (!state.held || currentVoicePressByContext.get(context) !== state) {
        if (voiceStarted) await Promise.resolve(endVoiceHold(context, false));
        return false;
      }
      state.voiceStarted = voiceStarted;
      return state.voiceStarted;
    }

    const pendingNavigation = options.navigationPromise ?? currentNavigationPromise();
    if (pendingNavigation) {
      try {
        await pendingNavigation;
      } catch {
        setVoiceVisualState(context, "error");
        return false;
      }
    }
    const currentThread = await synchronizeCurrent({
      force: true,
      quiet: true,
      refreshFastMode: false
    });
    if (!state.held
        || currentVoicePressByContext.get(context) !== state
        || contexts.get(context) !== ACTIONS.voice) return false;
    const provisionalCurrent = isProvisionalComposerThread(currentThread)
      && threadBelongsToActiveComposerFocus(currentThread);
    let microTargetVerified = false;
    if (microStatus && currentThread?.id && !provisionalCurrent) {
      try {
        const status = await microStatus(currentThread, { useMicro: true });
        if (!state.held || currentVoicePressByContext.get(context) !== state) return false;
        if (status?.available) {
          if (!status.matches) {
            setVoiceVisualState(context, "error");
            return false;
          }
          microTargetVerified = true;
        }
      } catch (error) {
        runtimeTrace("micro-control-target", {
          result: "unavailable",
          reason: error?.code ?? "status-error"
        });
      }
    }
    if (!microTargetVerified) {
      if (!await focusComposer()) {
        setVoiceVisualState(context, "error");
        return false;
      }
      if (currentThread?.id
          && !await currentControlThreadIsFocused(currentThread, { probe: options.focusProbe })) {
        setVoiceVisualState(context, "error");
        return false;
      }
    }
    if (!state.held || currentVoicePressByContext.get(context) !== state) return false;
    const voiceStarted = await Promise.resolve(beginVoice(context, {
      targetThreadId: provisionalCurrent ? "" : currentThread?.id ?? "",
      composerAlreadyFocused: true,
      allowComposerRefocus: !microTargetVerified
    }));
    if (!state.held || currentVoicePressByContext.get(context) !== state) {
      if (voiceStarted) await Promise.resolve(endVoiceHold(context, false));
      return false;
    }
    state.voiceStarted = voiceStarted;
    return state.voiceStarted;
  })().catch((error) => {
    if (!isAbortError(error)) {
      console.error(`Could not prepare Codex voice input: ${error?.message ?? "unknown error"}`);
      setVoiceVisualState(context, "error");
    }
    return false;
  }).finally(() => {
    if (!state.voiceStarted && currentVoicePressByContext.get(context) === state) {
      currentVoicePressByContext.delete(context);
    }
  });
  return true;
}

function endCurrentVoicePress(context, options = {}) {
  const state = currentVoicePressByContext.get(context);
  if (!state) return endVoiceHold(context, true, options);
  state.held = false;
  currentVoicePressByContext.delete(context);
  if (state.voiceStarted) return endVoiceHold(context, true, options);
  if (voiceStateByContext.get(context) === "preparing") setVoiceVisualState(context, "idle");
  return true;
}

async function beginVoiceHold(context, options = {}) {
  // Contract tests and explicit adapters retain the original synchronous
  // path. Production uses the control plane so the renderer-native PTT event
  // can replace keyboard modifiers without changing the transcription state
  // machine around it.
  if (options.bridge || options.forceLegacy) return beginVoiceHoldSync(context, options);
  if (voiceHeldContexts.has(context)) return true;
  const previousContexts = [...new Set([
    ...voiceHeldContexts,
    ...voiceReleasePendingContexts
  ])];
  if (previousContexts.length > 0) {
    const released = await endVoiceHold(previousContexts.at(-1), false, {
      resumeMedia: options.resumeMedia
    });
    if (!released) {
      setVoiceVisualState(context, "error");
      return false;
    }
  }

  const stateReader = options.stateReader ?? textInputStateSync;
  const pauseMedia = options.pauseMedia ?? pauseMediaForVoice;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  void pauseMedia(context);
  cancelVoiceTranscription(context);
  voiceStateByContext.delete(context);
  const sessionId = claimVoiceSession(context);
  const targetThreadId = options.targetThreadId ?? resolveVoiceTargetThreadId();
  if (targetThreadId) voiceTargetThreadByContext.set(context, targetThreadId);
  if (!options.composerAlreadyFocused) {
    const focused = await focusCurrentComposer(context);
    if (!focused) {
      void resumeMedia(context);
      failVoiceTranscription(context);
      return false;
    }
  }
  let baseline = stateReader();
  if (!baseline
      && options.composerAlreadyFocused
      && options.allowComposerRefocus !== false
      && !Number.isFinite(options.provisionalSideChatRequestedAtMs)) {
    await focusCurrentComposer(context);
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
    provisionalSideChatRequestedAtMs:
      Number.isFinite(options.provisionalSideChatRequestedAtMs)
        ? options.provisionalSideChatRequestedAtMs
        : null,
    sessionId
  });

  const result = await codexControlPlane.execute("push-to-talk-start", {
    micro: (micro) => micro.setPushToTalk(true),
    legacy: () => runKeyBridgeSync("voice-down", context)
  }, { quiet: true });
  if (!result.ok) {
    if (result.backend === "micro" && result.ambiguous) {
      voiceBackendByContext.set(context, "micro");
      voiceHeldContexts.add(context);
      await endVoiceHold(context, false, { resumeMedia });
    } else {
      void resumeMedia(context);
    }
    failVoiceTranscription(context);
    return false;
  }
  voiceBackendByContext.set(context, result.backend);
  voiceHeldContexts.add(context);
  runtimeTrace("voice-hold", {
    phase: "recording",
    strategy: result.backend,
    result: "started"
  });
  setVoiceVisualState(context, "recording");
  clearVoiceStartVerification(context);
  // The renderer host-message path is an acknowledged native start. The
  // legacy shortcut still needs Core Audio verification because its physical
  // key sequence can be rejected independently by macOS permissions.
  if (result.backend === "legacy") {
    voiceStartVerificationTimers.set(
      context,
      setTimeout(() => verifyVoiceStarted(context), VOICE_START_VERIFY_MS)
    );
  }
  return true;
}

function beginVoiceHoldSync(context, options = {}) {
  if (voiceHeldContexts.has(context)) return true;
  const bridge = options.bridge ?? runKeyBridgeSync;
  const stateReader = options.stateReader ?? textInputStateSync;
  const pauseMedia = options.pauseMedia ?? pauseMediaForVoice;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  const composerFocusCommand = options.composerFocusCommand
    ?? (activeComposerFocusLease?.kind === "side-chat"
      ? "codex-focus-side-chat-composer"
      : "codex-focus-composer");
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
    bridge(composerFocusCommand, null, { quiet: true });
  }
  let baseline = stateReader();
  if (!baseline
      && options.composerAlreadyFocused
      && !Number.isFinite(options.provisionalSideChatRequestedAtMs)) {
    // The prepared focus can become stale if Codex replaces the composer DOM
    // during the final navigation frame. Retry only in that exceptional case.
    bridge(composerFocusCommand, null, { quiet: true });
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
    provisionalSideChatRequestedAtMs:
      Number.isFinite(options.provisionalSideChatRequestedAtMs)
        ? options.provisionalSideChatRequestedAtMs
        : null,
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

async function endVoiceHold(context, trackTranscription = true, options = {}) {
  const releaseContexts = [...new Set([
    ...voiceHeldContexts,
    ...voiceReleasePendingContexts
  ])];
  const usesMicro = releaseContexts.some(
    (releaseContext) => voiceBackendByContext.get(releaseContext) === "micro"
  );
  if (!usesMicro || options.bridge || options.releaseVoice) {
    const released = endVoiceHoldSync(context, trackTranscription, options);
    if (released) {
      for (const releaseContext of releaseContexts) voiceBackendByContext.delete(releaseContext);
    }
    return released;
  }
  clearVoiceStartVerification(context);
  if (releaseContexts.length === 0) return true;
  const stateReader = options.stateReader ?? textInputStateSync;
  const resumeMedia = options.resumeMedia ?? resumeMediaAfterVoice;
  const result = await codexControlPlane.execute("push-to-talk-stop", {
    micro: (micro) => micro.setPushToTalk(false),
    legacy: () => nativeVoiceReleaseOutcomeAsync()
  }, { quiet: true });
  const outcome = result.ok
    ? result.backend === "micro" ? "inactive" : normalizeVoiceReleaseOutcome(result.value)
    : result.ambiguous ? "unknown-possible-action" : "unconfirmed-no-action";
  const released = applyVoiceReleaseOutcome(context, releaseContexts, outcome, {
    resumeMedia,
    scheduleRetry: false
  });
  if (!released) return false;
  for (const releaseContext of releaseContexts) voiceBackendByContext.delete(releaseContext);
  return finalizeVoiceRelease(context, releaseContexts, trackTranscription, stateReader);
}

function releaseVoiceKeysSync(rawOptions = {}) {
  if (shutdownCleanupStarted) return shutdownCleanupResult;
  shutdownCleanupStarted = true;
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const bridge = options.bridge ?? runKeyBridgeSync;
  cancelVoiceReleaseRetry();
  for (const state of currentVoicePressByContext.values()) state.held = false;
  currentVoicePressByContext.clear();
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
  voiceBackendByContext.clear();
  for (const timer of voiceStartVerificationTimers.values()) clearTimeout(timer);
  voiceStartVerificationTimers.clear();
  for (const state of threadPressByContext.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  threadPressByContext.clear();
  for (const timer of fastModeLongPressTimers.values()) clearTimeout(timer);
  fastModeLongPressTimers.clear();
  fastModePressStartedAt.clear();
  fastModeLongPressArmedContexts.clear();
  fastModeLongPressUpdates.clear();
  cancelReasoningInputBatches();
  reasoningBusyContexts.clear();
  reasoningAvailableEffortsByThreadId.clear();
  reasoningPowerSelectionsByThreadId.clear();
  reasoningVisualOverrideByThreadId.clear();
  reasoningProgressTransitionByKey.clear();
  reasoningParticleMotionByKey.clear();
  reasoningPendingCountByThreadId.clear();
  reasoningPendingCountByContext.clear();
  if (released && voiceMediaPaused && bridge("media-resume-paused", null, { quiet: true })) {
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
    for (const fingerprint of queueTitleFingerprints(thread)) {
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

function currentThreadCandidatesForSync() {
  const byId = new Map();
  for (const thread of [...currentThreadIdentityCandidates, ...combinedVisibleThreads()]) {
    if (!thread?.id) continue;
    const previous = byId.get(thread.id);
    byId.set(thread.id, previous ? { ...previous, ...thread } : thread);
  }
  return [...byId.values()];
}

function dashboardCurrentActionsVisible() {
  return [...contexts.values()].some((action) => CURRENT_THREAD_AWARE_ACTIONS.has(action));
}

function composerStateNeedsRefreshForThread(threadId, state = fastModeState) {
  return !threadId
    || state?.threadId !== threadId
    || state?.failed === true
    || typeof state?.enabled !== "boolean"
    || !normalizedReasoningEffort(state?.reasoningEffort);
}

function microSnapshotActiveThreadId(snapshot) {
  if (snapshot?.focusedComposerKind === "main") {
    const sideChatCreationInFlight = activeComposerCreation?.kind === "side-chat"
      && activeComposerCreation.controller?.signal?.aborted !== true;
    if (!sideChatCreationInFlight) {
      return snapshot?.activeThreadKey ?? snapshot?.activeSideChatThreadId ?? null;
    }
  }
  if (snapshot?.focusedComposerKind === "side-chat") {
    return snapshot?.activeSideChatThreadId ?? snapshot?.activeThreadKey ?? null;
  }
  return snapshot?.activeSideChatThreadId ?? snapshot?.activeThreadKey ?? null;
}

function genericSideChatTitle(value) {
  return /^(?:side\s*chat|sidechat|사이드\s*챗|사이드챗)(?:\s+\d+)?$/i
    .test(String(value ?? "").trim());
}

function rememberMicroSideChatTitles(sideChats) {
  for (const sideChat of Array.isArray(sideChats) ? sideChats : []) {
    const id = sideChat?.id;
    const title = typeof sideChat?.title === "string" ? sideChat.title.trim() : "";
    if (!id || !title) continue;
    const previous = sideChatTitleById.get(id);
    if (!previous || genericSideChatTitle(previous)) sideChatTitleById.set(id, title);
    const canonicalTitle = sideChatTitleById.get(id);
    const cached = sideChatRowsCache.find((thread) => thread?.id === id);
    if (cached && canonicalTitle) {
      cached.title = canonicalTitle;
      cached.fallbackTitle = false;
      cached.queueTitles = [...new Set([
        canonicalTitle,
        ...(Array.isArray(cached.queueTitles) ? cached.queueTitles : [])
      ])];
    }
  }
}

async function refreshMicroSideChatTitleCache() {
  // Establish the current app-server session boundary first. A new session
  // intentionally clears every old Side Chat cache, including titles.
  await readAppServerSessionStartMs();
  const snapshot = await codexControlPlane.refreshReadOnly({ quiet: true });
  rememberMicroSideChatTitles(snapshot?.sideChats);
  return snapshot;
}

function applyMicroReadOnlySnapshot(snapshot, options = {}) {
  rememberMicroSideChatTitles(snapshot?.sideChats);
  const activeSideChatThreadId = snapshot?.activeSideChatThreadId ?? null;
  const activeThreadKey = microSnapshotActiveThreadId(snapshot);
  if (!activeThreadKey) return null;
  const candidates = options.candidates ?? currentThreadCandidatesForSync();
  const leasedSideChat = activeComposerFocusLease?.kind === "side-chat"
    ? activeComposerFocusThread(candidates)
    : null;
  const current = candidates.find((thread) => thread?.id === activeThreadKey)
    ?? combinedVisibleThreads().find((thread) => thread?.id === activeThreadKey)
    ?? (activeSideChatThreadId && leasedSideChat
      ? {
        ...leasedSideChat,
        id: activeSideChatThreadId,
        parentId: leasedSideChat.parentId ?? activeComposerFocusLease?.parentId ?? null,
        remote: false,
        ephemeral: true,
        provisionalSideChat: false,
        requiresStrictIdentity: true
      }
      : null)
    ?? null;
  if (!current?.id) return null;

  const leasedComposer = activeComposerFocusThread(candidates);
  const mainComposerOverridesSideChat = snapshot?.focusedComposerKind === "main"
    && activeComposerFocusLease?.kind === "side-chat"
    && !(activeComposerCreation?.kind === "side-chat"
      && activeComposerCreation.controller?.signal?.aborted !== true);
  if (leasedComposer && (leasedComposer.id !== current.id || mainComposerOverridesSideChat)) {
    // The renderer reports the composer that actually owns keyboard input.
    // A manual in-app task change therefore revokes an older provisional or
    // discovered Side Chat lease without waiting for an Accessibility poll.
    revokeComposerFocusForRendererCurrent(current.id, {
      render: false,
      force: mainComposerOverridesSideChat
    });
  }
  if (current.ephemeral) {
    if (activeComposerFocusLease?.kind === "side-chat") {
      promoteSideChatFocusLease(current, { render: false });
      if (pendingSideChatTarget
          && !pendingSideChatTarget.targetThreadId
          && Number.isFinite(activeComposerFocusLease.requestedAtMs)) {
        pendingSideChatTarget = {
          ...pendingSideChatTarget,
          targetThreadId: current.id
        };
        if (current.parentId) sideChatParentById.set(current.id, current.parentId);
        bindPendingVoiceContextsToThread(
          current.id,
          options.nowMs ?? Date.now(),
          activeComposerFocusLease.requestedAtMs
        );
      }
    }
    else {
      activateSideChatFocusLease({
        requestedAtMs: current.createdAtMs ?? Date.now(),
        parentId: current.parentId ?? sideChatParentById.get(current.id) ?? null,
        targetThreadId: current.id,
        thread: current,
        render: false
      });
    }
  }

  const changed = primaryThreadId !== current.id;
  rememberVerifiedThread(current, {
    nowMs: options.nowMs ?? Date.now(),
    promote: options.promote !== false && (changed || options.promoteConfirmed === true),
    recordOpenedHint: false,
    refreshFastMode: false
  });
  const effort = normalizedReasoningEffort(snapshot.reasoningEffort);
  const model = normalizedReasoningModel(snapshot.model);
  rememberReasoningPowerSelections(current.id, snapshot.powerSelections);
  const fastEnabled = typeof snapshot.fastEnabled === "boolean"
    ? snapshot.fastEnabled
    : null;
  if ((effort || fastEnabled !== null) && currentControlThreadId() === current.id) {
    fastModeState = {
      ...fastModeStateFromThread(current, fastModeState),
      threadId: current.id,
      model: model ?? (fastModeState.threadId === current.id ? fastModeState.model : null),
      enabled: fastEnabled ?? fastModeState.enabled,
      available: fastEnabled === null ? fastModeState.available : true,
      reasoningEffort: effort ?? fastModeState.reasoningEffort,
      failed: false
    };
    applyFocusedComposerState(current, fastModeState);
    renderFastModeContexts();
  }
  runtimeTrace("current-thread-sync", {
    strategy: "micro",
    result: changed ? "changed" : "confirmed"
  });
  return current;
}

function refreshMicroReadOnly(options = {}) {
  if (activeMicroReadOnlyRefresh && options.force !== true) return activeMicroReadOnlyRefresh;
  const refresh = codexControlPlane.refreshReadOnly({
    force: options.force,
    quiet: options.quiet !== false
  }).then((snapshot) => (
    snapshot ? applyMicroReadOnlySnapshot(snapshot, options) : null
  )).catch(() => null).finally(() => {
    if (activeMicroReadOnlyRefresh === refresh) activeMicroReadOnlyRefresh = null;
  });
  activeMicroReadOnlyRefresh = refresh;
  return refresh;
}

async function microControlThreadStatus(thread, options = {}) {
  if (!thread?.id || options.useMicro === false) {
    return { available: false, matches: false, snapshot: null };
  }
  const refresh = options.refresh
    ?? (() => codexControlPlane.refreshReadOnly({ force: true, quiet: true }));
  const snapshot = await refresh();
  const activeThreadId = microSnapshotActiveThreadId(snapshot);
  if (!activeThreadId) {
    return { available: false, matches: false, snapshot: null };
  }
  if (options.apply !== false) {
    applyMicroReadOnlySnapshot(snapshot, {
      candidates: options.candidates,
      promote: false
    });
  }
  const matches = activeThreadId === thread.id;
  runtimeTrace("micro-control-target", {
    result: matches ? "confirmed" : "mismatch"
  });
  return { available: true, matches, snapshot };
}

async function synchronizeCurrentCodexThread(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const shouldUseMicro = options.microRefresh !== false
    && !options.readWindows
    && !options.probe;
  // A Side Chat lives in the right-hand composer of its parent task. Codex's
  // generic current-thread accessibility header can still report the parent,
  // so never let that legacy observation revoke the explicit Side Chat lease.
  // The renderer Micro snapshot is different: it identifies the composer
  // that actually owns input, and therefore outranks an older lease after a
  // direct in-app task click.
  const leasedComposer = activeComposerFocusThread(currentThreadCandidatesForSync());
  if (leasedComposer && !shouldUseMicro) {
    lastCurrentThreadSyncAtMs = nowMs;
    if (!isProvisionalComposerThread(leasedComposer)
        && primaryThreadId !== leasedComposer.id) {
      rememberVerifiedThread(leasedComposer, {
        nowMs,
        promote: options.promote !== false,
        recordOpenedHint: false,
        refreshFastMode: false
      });
    }
    return leasedComposer;
  }
  if (!options.force
      && nowMs - lastCurrentThreadSyncAtMs < CURRENT_THREAD_SYNC_CACHE_MS) {
    return currentThreadForDisplay();
  }
  if (activeCurrentThreadSync) return activeCurrentThreadSync;

  const candidates = options.candidates ?? currentThreadCandidatesForSync();
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const readWindows = options.readWindows ?? readCodexQueueWindows;
  const sync = (async () => {
    try {
      if (shouldUseMicro) {
        const microCurrent = await refreshMicroReadOnly({
          candidates,
          nowMs,
          promote: options.promote,
          promoteConfirmed: options.promoteConfirmed,
          quiet: true
        });
        if (microCurrent?.id) {
          lastCurrentThreadSyncAtMs = Date.now();
          const retainedLease = activeComposerFocusThread(candidates);
          if (retainedLease && isProvisionalComposerThread(retainedLease)) {
            return retainedLease;
          }
          return microCurrent;
        }
      }
      const fallbackLease = activeComposerFocusThread(candidates);
      if (fallbackLease) {
        lastCurrentThreadSyncAtMs = Date.now();
        if (!isProvisionalComposerThread(fallbackLease)
            && primaryThreadId !== fallbackLease.id) {
          rememberVerifiedThread(fallbackLease, {
            nowMs,
            promote: options.promote !== false,
            recordOpenedHint: false,
            refreshFastMode: false
          });
        }
        return fallbackLease;
      }
      const windows = await readWindows(options);
      const current = await verifiedCurrentCodexThread(windows, candidates, {
        signal: options.signal,
        probe: options.probe
      });
      lastCurrentThreadSyncAtMs = Date.now();
      if (!current?.id) return null;

      const hydrated = combinedVisibleThreads()
        .find((thread) => thread?.id === current.id);
      const resolved = hydrated ? { ...current, ...hydrated } : current;
      const changed = primaryThreadId !== resolved.id;
      // Stream Deck can become frontmost before Codex during app startup. In
      // that order the first composer probe is intentionally rejected, but a
      // later active-window sync may still resolve the same task identity.
      // Retry the task-scoped controls until both speed and effort have one
      // trustworthy value instead of leaving their keys in an error state
      // merely because the task UUID itself did not change.
      const composerStateNeedsRefresh = composerStateNeedsRefreshForThread(resolved.id);
      rememberVerifiedThread(resolved, {
        nowMs,
        promote: options.promote !== false && (changed || options.promoteConfirmed === true),
        recordOpenedHint: false,
        refreshFastMode: options.refreshFastMode ?? (changed || composerStateNeedsRefresh),
        refreshFastModeAction: options.refreshFastModeAction
      });
      if (unreadCompletionByThreadId.has(resolved.id)
          && await threadIsFocused(resolved, { probe: options.focusProbe })) {
        acknowledgeCompletion(resolved.id);
      }
      if (changed) runtimeTrace("current-thread-sync", { result: "changed" });
      return resolved;
    } catch (error) {
      lastCurrentThreadSyncAtMs = Date.now();
      if (!isAbortError(error) && !options.quiet) {
        console.error(`Could not synchronize Codex current task: ${error?.message ?? "unknown error"}`);
      }
      return null;
    }
  })().finally(() => {
    if (activeCurrentThreadSync === sync) activeCurrentThreadSync = null;
  });
  activeCurrentThreadSync = sync;
  return sync;
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

function threadBelongsToActiveSideChatFocus(thread) {
  if (activeComposerFocusLease?.kind !== "side-chat" || !thread?.id) return false;
  const active = activeSideChatFocusThread([thread]);
  return active?.id === thread.id;
}

function threadBelongsToActiveComposerFocus(thread) {
  if (!activeComposerFocusLease || !thread?.id) return false;
  return activeComposerFocusThread([thread])?.id === thread.id;
}

async function focusCurrentComposer(context = null, options = {}) {
  const command = activeComposerFocusLease?.kind === "side-chat"
    ? "codex-focus-side-chat-composer"
    : options.restore
      ? "codex-restore-composer"
      : "codex-focus-composer";
  const focus = options.focus
    ?? ((targetCommand) => runKeyBridgeAwaited(targetCommand, context, { quiet: true }));
  return focus(command);
}

async function focusAdvancedReasoningComposer(context = null, options = {}) {
  const openApp = options.openApp
    ?? (() => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], {
      timeout: 5000
    }));
  const waitFrontmost = options.waitFrontmost
    ?? (() => execFileAsync(KEY_BRIDGE, ["codex-wait-frontmost"], {
      timeout: 3000,
      maxBuffer: 4096
    }));
  const focusComposer = options.focusComposer
    ?? (() => focusCurrentComposer(context));
  // Max and Ultra are absent from Codex Micro's compact power axis on some
  // models. Their exact fallback must operate Codex's visible Advanced list,
  // whose AX controls deliberately reject presses while another app is
  // frontmost. Activate Codex only for that Advanced-only path; ordinary
  // Effort and Fast controls remain renderer-native and stay off-screen.
  await openApp();
  await waitFrontmost();
  return focusComposer();
}

async function currentControlThreadIsFocused(thread, options = {}) {
  if (isProvisionalComposerThread(thread)
      && threadBelongsToActiveComposerFocus(thread)) return true;
  return threadIsFocused(thread, options);
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
  const composerFocusedMatch = text.match(
    /(?:^|\s)composer_focused=([01])(?:\s|$)/i
  )?.[1] ?? null;
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
    reasoningEffort: composerState.reasoningEffort,
    composerFocused: composerFocusedMatch === "1"
      ? true
      : composerFocusedMatch === "0"
        ? false
        : null
  };
}

function normalizeReasoningEffortOptions(values) {
  return normalizeReasoningEfforts(
    Array.isArray(values) ? values : String(values ?? "").split(",")
  );
}

function reasoningEffortOptionsForThread(threadId) {
  const exact = threadId
    ? reasoningAvailableEffortsByThreadId.get(threadId) ?? []
    : [];
  if (exact.length >= 2) return exact;
  return reasoningGlobalOptionCatalog.efforts.length >= 2
    ? reasoningGlobalOptionCatalog.efforts
    : [];
}

function normalizeReasoningPowerSelections(values) {
  const seen = new Set();
  const selections = [];
  for (const value of Array.isArray(values) ? values : []) {
    const model = normalizedReasoningModel(value?.model);
    const reasoningEffort = normalizedReasoningEffort(value?.reasoningEffort);
    if (!model || !reasoningEffort) continue;
    const id = typeof value?.id === "string" && value.id.trim()
      ? value.id.trim().toLowerCase()
      : `${model}:${reasoningEffort}`;
    if (seen.has(id)) continue;
    seen.add(id);
    selections.push({ id, model, effort: reasoningEffort, compact: true });
  }
  return selections;
}

function rememberReasoningPowerSelections(threadId, values) {
  if (!threadId) return [];
  const selections = normalizeReasoningPowerSelections(values);
  if (selections.length >= 2) {
    reasoningPowerSelectionsByThreadId.set(threadId, selections);
    return selections;
  }
  reasoningPowerSelectionsByThreadId.delete(threadId);
  return [];
}

function reasoningPowerSelectionsForThread(threadId) {
  return threadId ? reasoningPowerSelectionsByThreadId.get(threadId) ?? [] : [];
}

function reasoningSelectionOptionsForThread(threadId) {
  const compact = reasoningPowerSelectionsForThread(threadId);
  if (compact.length < 2) return [];
  const modelCounts = new Map();
  for (const selection of compact) {
    modelCounts.set(selection.model, (modelCounts.get(selection.model) ?? 0) + 1);
  }
  const configuredModel = normalizedReasoningModel(reasoningGlobalOptionCatalog.model);
  const primaryModel = configuredModel && modelCounts.has(configuredModel)
    ? configuredModel
    : [...modelCounts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  if (!primaryModel) return compact;

  const primaryEfforts = normalizeReasoningEffortOptions([
    ...reasoningEffortOptionsForThread(threadId),
    ...reasoningGlobalOptionCatalog.efforts,
    ...compact.filter((selection) => selection.model === primaryModel)
      .map((selection) => selection.effort)
  ]);
  const expanded = [];
  let insertedPrimary = false;
  for (const selection of compact) {
    if (selection.model !== primaryModel) {
      expanded.push(selection);
      continue;
    }
    if (insertedPrimary) continue;
    insertedPrimary = true;
    for (const effort of primaryEfforts) {
      const compactMatch = compact.find((candidate) => (
        candidate.model === primaryModel && candidate.effort === effort
      ));
      expanded.push(compactMatch ?? {
        id: `${primaryModel}:${effort}`,
        model: primaryModel,
        effort,
        compact: false
      });
    }
  }
  return expanded;
}

function reasoningSelectionIndex(options, model, effort) {
  const normalizedModel = normalizedReasoningModel(model);
  const normalizedEffort = normalizedReasoningEffort(effort);
  return options.findIndex((selection) => (
    selection.model === normalizedModel && selection.effort === normalizedEffort
  ));
}

function refreshReasoningOptionCatalog(options = {}) {
  if (activeReasoningOptionCatalogRefresh && options.force !== true) {
    return activeReasoningOptionCatalogRefresh;
  }
  const refresh = loadReasoningOptionCatalog(CODEX_CONFIG, CODEX_MODELS_CACHE)
    .then((catalog) => {
      const previous = reasoningGlobalOptionCatalog;
      reasoningGlobalOptionCatalog = {
        model: catalog?.model ?? null,
        efforts: normalizeReasoningEffortOptions(catalog?.efforts),
        source: catalog?.source ?? "none"
      };
      const changed = previous.model !== reasoningGlobalOptionCatalog.model
        || previous.source !== reasoningGlobalOptionCatalog.source
        || previous.efforts.join(",") !== reasoningGlobalOptionCatalog.efforts.join(",");
      if (changed) {
        // A Codex/model restart can change which levels are exposed. Exact
        // task scans from the old process are no longer authoritative.
        reasoningAvailableEffortsByThreadId.clear();
        reasoningPowerSelectionsByThreadId.clear();
        reasoningDirectionByThreadId.clear();
      }
      return reasoningGlobalOptionCatalog;
    })
    .catch(() => reasoningGlobalOptionCatalog)
    .finally(() => {
      if (activeReasoningOptionCatalogRefresh === refresh) {
        activeReasoningOptionCatalogRefresh = null;
      }
    });
  activeReasoningOptionCatalogRefresh = refresh;
  return refresh;
}

function parseReasoningEffortOptions(output) {
  const text = String(output ?? "");
  const encoded = text.match(/(?:^|\s)options=([^\s]+)(?:\s|$)/i)?.[1] ?? "";
  if (!encoded || encoded.toLowerCase() === "unknown") return [];
  const options = normalizeReasoningEffortOptions(encoded);
  return options.length >= 2 ? options : [];
}

function rememberReasoningEffortOptions(threadId, values) {
  if (!threadId) return [];
  const options = normalizeReasoningEffortOptions(values);
  if (options.length >= 2) {
    reasoningAvailableEffortsByThreadId.set(threadId, options);
    return options;
  }
  reasoningAvailableEffortsByThreadId.delete(threadId);
  return [];
}

function parseReasoningStepState(output) {
  const text = String(output ?? "");
  const composer = parseFastModeState(text);
  if (!composer) return null;
  const flag = (name) => {
    const match = text.match(new RegExp(`(?:^|\\s)${name}=([01])(?:\\s|$)`, "i"));
    return match ? match[1] === "1" : null;
  };
  const direction = text.match(/(?:^|\s)direction=(up|down)(?:\s|$)/i)?.[1]?.toLowerCase() ?? null;
  return {
    ...composer,
    availableEfforts: parseReasoningEffortOptions(text),
    direction,
    changed: flag("changed"),
    verified: flag("verified"),
    atMinimum: flag("at_min"),
    atMaximum: flag("at_max")
  };
}

function nextReasoningDirection(threadId, state = fastModeState) {
  const effort = state?.threadId === threadId
    ? normalizedReasoningEffort(state?.reasoningEffort)
    : null;
  const available = reasoningEffortOptionsForThread(threadId);
  const selections = reasoningSelectionOptionsForThread(threadId);
  const selectionIndex = state?.threadId === threadId
    ? reasoningSelectionIndex(selections, state?.model, effort)
    : -1;
  if (selectionIndex === 0) return "up";
  if (selectionIndex === selections.length - 1 && selectionIndex >= 0) return "down";
  if (available.length >= 2 && effort === available[0]) return "up";
  if (available.length >= 2 && effort === available.at(-1)) return "down";
  const cached = reasoningDirectionByThreadId.get(threadId);
  if (cached === "up" || cached === "down") return cached;
  // If neither Codex's global setting nor an exact task scan is available,
  // only Ultra is a trustworthy universal upper endpoint. The first native
  // transaction will scan the real picker and seed the per-task cache.
  return effort === "ultra" ? "down" : "up";
}

function optimisticReasoningStep(
  threadId,
  direction,
  state = fastModeState,
  availableEfforts = reasoningEffortOptionsForThread(threadId)
) {
  if (!threadId || state?.threadId !== threadId) return null;
  const current = normalizedReasoningEffort(state?.reasoningEffort);
  const selections = reasoningSelectionOptionsForThread(threadId);
  const selectionIndex = reasoningSelectionIndex(
    selections,
    state?.model,
    current
  );
  if (selections.length >= 2 && selectionIndex >= 0) {
    let nextDirection = direction === "down" ? "down" : "up";
    if (nextDirection === "up" && selectionIndex === selections.length - 1) {
      nextDirection = "down";
    } else if (nextDirection === "down" && selectionIndex === 0) {
      nextDirection = "up";
    }
    const nextIndex = selectionIndex + (nextDirection === "down" ? -1 : 1);
    const next = selections[nextIndex];
    return {
      model: next.model,
      effort: next.effort,
      direction: nextIndex === selections.length - 1
        ? "down"
        : nextIndex === 0
          ? "up"
          : nextDirection
    };
  }
  const options = normalizeReasoningEffortOptions(availableEfforts);
  const index = options.indexOf(current);
  if (options.length < 2 || index < 0) return null;
  let nextDirection = direction === "down" ? "down" : "up";
  if (nextDirection === "up" && index === options.length - 1) nextDirection = "down";
  else if (nextDirection === "down" && index === 0) nextDirection = "up";
  const nextIndex = index + (nextDirection === "down" ? -1 : 1);
  const effort = options[nextIndex];
  return {
    effort,
    direction: nextIndex === options.length - 1
      ? "down"
      : nextIndex === 0
        ? "up"
        : nextDirection
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
  const fallbackModel = fallback?.threadId === threadId
    ? normalizedReasoningModel(fallback?.model)
    : null;
  const nextReasoning = normalizedReasoningEffort(thread?.nextReasoningEffort);
  const activeReasoning = normalizedReasoningEffort(thread?.reasoningEffort);
  const nextServiceTier = normalizedServiceTier(thread?.nextServiceTier);
  const activeServiceTier = normalizedServiceTier(thread?.serviceTier);
  const hasNextSettingsSnapshot = Number.isFinite(thread?.nextSettingsAtMs);
  const activeMetadataEnabled = activeServiceTier
    ? isFastServiceTier(activeServiceTier)
    : null;
  const nextMetadataEnabled = hasNextSettingsSnapshot && nextServiceTier
    ? isFastServiceTier(nextServiceTier)
    : null;
  // A verified composer/Micro observation owns the live next-turn control for
  // the same task. The three-second task scan can briefly replay an older
  // next_settings row after a native toggle; letting that row win made the
  // Fast bolt disappear until the next renderer poll. Metadata remains the
  // startup/task-switch seed when no same-task observation exists.
  const enabled = fallbackMatches
    ? fallback.enabled
    : typeof nextMetadataEnabled === "boolean"
      ? nextMetadataEnabled
      : activeMetadataEnabled;
  return {
    threadId,
    model: fallbackModel,
    enabled,
    available: typeof enabled === "boolean"
      ? fallbackMatches
        ? fallback.available ?? true
        : true
      : null,
    reasoningEffort: fallbackReasoning
      ?? (hasNextSettingsSnapshot ? nextReasoning : null)
      ?? activeReasoning,
    failed: false
  };
}

function mergeFastModeObservation(thread, observed, previous = fastModeState) {
  const threadId = thread?.id ?? previous?.threadId ?? null;
  const previousModel = previous?.threadId === threadId
    ? normalizedReasoningModel(previous?.model)
    : null;
  if (typeof observed?.enabled === "boolean") {
    return {
      threadId,
      ...observed,
      model: normalizedReasoningModel(observed?.model)
        ?? previousModel,
      available: observed.available ?? true
    };
  }
  const fallback = fastModeStateFromThread(thread, previous);
  return {
    threadId,
    model: normalizedReasoningModel(observed?.model) ?? fallback.model,
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
    if (action === ACTIONS.fastMode || action === ACTIONS.reasoning) {
      const svg = staticActionSvg(action, context);
      if (svg) setImage(context, svg);
    }
  }
}

function refreshFastMode(options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => refreshFastMode(options));
  }
  const threadId = options.threadId ?? currentControlThreadId();
  if (!threadId) {
    fastModeRevision += 1;
    fastModeState = {
      threadId: null,
      model: null,
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
      if (currentControlThreadId() !== threadId || fastModeRevision !== revision) return false;
      const thread = combinedVisibleThreads().find((candidate) => candidate.id === threadId)
        ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null);
      let microObserved = null;
      if (!options.stateProbe && options.useMicro !== false) {
        const snapshot = await codexControlPlane.refreshReadOnly({ quiet: true });
        const provisionalCurrent = isProvisionalComposerThread(thread)
          && threadBelongsToActiveComposerFocus(thread);
        if (snapshot
            && (microSnapshotActiveThreadId(snapshot) === threadId || provisionalCurrent)
            && (typeof snapshot.fastEnabled === "boolean"
              || normalizedReasoningEffort(snapshot.reasoningEffort))) {
          microObserved = {
            model: normalizedReasoningModel(snapshot.model),
            enabled: snapshot.fastEnabled,
            available: typeof snapshot.fastEnabled === "boolean" ? true : null,
            reasoningEffort: normalizedReasoningEffort(snapshot.reasoningEffort),
            composerFocused: true
          };
          applyMicroReadOnlySnapshot(snapshot, { promote: false });
        }
      }
      // The native speed control is scoped to the focused composer and carries
      // no task id of its own. Never bind another window's mode to the cached
      // Current Task. Contract tests inject a state probe and exercise
      // the cache logic independently of the native identity guard.
      if (!options.stateProbe && !microObserved) {
        if (activeComposerFocusLease && !await focusCurrentComposer(null)) {
          throw new Error("Codex composer was not focused");
        }
        if (!thread || !await currentControlThreadIsFocused(thread)) {
          throw new Error("Codex current task was not focused");
        }
      }
      const observed = microObserved ?? await queryFastModeState(options);
      if (currentControlThreadId() !== threadId || fastModeRevision !== revision) return false;
      const state = mergeFastModeObservation(thread, observed, fastModeState);
      if (options.preserveConfirmedOnUnavailable
          && (!state.available || typeof state.enabled !== "boolean")
          && fastModeState.threadId === threadId
          && typeof fastModeState.enabled === "boolean") return false;
      fastModeState = { threadId, ...state, failed: false };
      applyFocusedComposerState(thread, state);
      renderFastModeContexts();
      return typeof state.enabled === "boolean";
    } catch (error) {
      if (currentControlThreadId() !== threadId || fastModeRevision !== revision) return false;
      if (options.preserveConfirmedOnUnavailable
          && fastModeState.threadId === threadId
          && typeof fastModeState.enabled === "boolean") return false;
      fastModeState = {
        threadId,
        model: null,
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
    if (results.some((result) => result.status === "fulfilled" && result.value === true)) return true;
    throw results.at(-1)?.reason ?? new Error("task navigation did not complete");
  });
}

function afterFastModeUpdate(startNavigation) {
  const update = activeFastModeUpdate;
  if (!update) return startNavigation();
  // Fast mode is scoped to the focused composer, while the native AX action
  // deliberately accepts no task id. Keep task navigation behind the active
  // toggle so a later button press cannot move focus between its verification
  // and AXPress and accidentally change the next task instead. An Effort tap
  // can replace the active control promise with a successor while this wait is
  // in flight. Drain that successor too; otherwise toggleFastMode() would see
  // it as active, return the Effort promise, and silently swallow the held Fast
  // gesture without ever dispatching FAST.
  return update.catch(() => false).then(() => {
    const successor = activeFastModeUpdate;
    if (successor && successor !== update) {
      return afterFastModeUpdate(startNavigation);
    }
    return startNavigation();
  });
}

function toggleFastMode(context, options = {}) {
  if (activeFastModeUpdate) return activeFastModeUpdate;
  fastModeRevision += 1;
  const feedback = options.feedback ?? showFeedback;
  const update = (async () => {
    const productionNativeAction = !options.toggleMode && !options.stateProbe && !options.setMode;
    const synchronizeCurrent = options.synchronizeCurrent
      ?? (productionNativeAction
        ? synchronizeCurrentCodexThread
        : async () => currentThreadForDisplay());
    feedback(context, "loading", "FAST 확인");
    const pendingNavigation = options.navigationPromise ?? currentNavigationPromise();
    if (pendingNavigation) {
      try {
        await pendingNavigation;
      } catch {
        feedback(context, "error", "전환 확인", 1600);
        return false;
      }
    }
    const synchronizedThread = await synchronizeCurrent({
      force: productionNativeAction,
      quiet: true,
      refreshFastMode: false
    });
    if (!synchronizedThread?.id) {
      feedback(context, "error", "작업 확인", 1600);
      return false;
    }
    const pendingRefresh = activeFastModeRefresh?.promise;
    if (pendingRefresh) {
      try {
        await pendingRefresh;
      } catch {
        // Its revision was invalidated above; the fresh probe below remains
        // authoritative even if the old read failed while being drained.
      }
    }
    const threadId = synchronizedThread.id;
    const thread = combinedVisibleThreads().find((candidate) => candidate?.id === threadId)
      ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null);
    if (productionNativeAction && options.useMicro !== false) {
      const microResult = await codexControlPlane.execute("fast-mode-toggle", {
        micro: async (bridge) => {
          const previousEnabled = fastModeState.threadId === threadId
            && typeof fastModeState.enabled === "boolean"
            ? fastModeState.enabled
            : null;
          await bridge.toggleFast();
          return verifyAfterMicroDelivery(async () => {
            await sleepWithSignal(120);
            const snapshot = await bridge.refreshReadOnly();
            if (!isProvisionalComposerThread(thread)
                && microSnapshotActiveThreadId(snapshot) !== threadId) {
              throw new Error("Fast mode changed outside the verified current task");
            }
            return {
              snapshot,
              enabled: typeof snapshot.fastEnabled === "boolean"
                ? snapshot.fastEnabled
                : previousEnabled === null ? null : !previousEnabled
            };
          }, "Fast mode verification");
        }
      }, { quiet: true });
      if (microResult.backend === "micro") {
        if (!microResult.ok) {
          feedback(context, "error", "변경 확인", 1600);
          return false;
        }
        const observed = microResult.value ?? {};
        const snapshot = observed.snapshot ?? null;
        const enabled = observed.enabled;
        fastModeState = {
          ...fastModeStateFromThread(thread, fastModeState),
          threadId,
          model: normalizedReasoningModel(snapshot?.model)
            ?? fastModeState.model,
          enabled,
          available: typeof enabled === "boolean" ? true : null,
          reasoningEffort: normalizedReasoningEffort(snapshot?.reasoningEffort)
            ?? fastModeState.reasoningEffort,
          composerFocused: true,
          failed: typeof enabled !== "boolean"
        };
        if (snapshot) applyMicroReadOnlySnapshot(snapshot, { promote: false });
        applyFocusedComposerState(thread, fastModeState);
        renderFastModeContexts();
        clearFeedback(context);
        runtimeTrace("control-plane", {
          strategy: "micro",
          result: typeof enabled === "boolean" ? "success" : "unverified"
        });
        return typeof enabled === "boolean";
      }
      if (microResult.ambiguous) {
        feedback(context, "error", "변경 확인", 1600);
        return false;
      }
    }
    if (productionNativeAction && !ensureCommandPermissions("fast-mode-toggle", context)) return false;
    const focusTargetComposer = options.focusTargetComposer
      ?? (() => focusCurrentComposer(context));
    if (productionNativeAction
        && activeComposerFocusLease
        && !await focusTargetComposer()) {
      feedback(context, "error", "입력창 확인", 1600);
      return false;
    }
    if (!thread || !await currentControlThreadIsFocused(thread, { probe: options.focusProbe })) {
      feedback(context, "error", "작업 확인", 1600);
      return false;
    }

    // Production uses one native transaction: it opens the composer menu
    // once, reads the live state, selects its exact inverse, and returns the
    // applied state. The injected stateProbe/setMode pair remains available
    // for deterministic legacy contract tests.
    const usesNativeToggle = !options.toggleMode && !options.stateProbe && !options.setMode;
    const toggleMode = options.toggleMode
      ?? (usesNativeToggle
        ? () => execFileAsync(KEY_BRIDGE, ["fast-mode-toggle"], {
          timeout: 5000,
          maxBuffer: 4096
        })
        : null);
    const focusComposer = options.focusComposer
      ?? (usesNativeToggle
        ? () => focusCurrentComposer(null, { restore: true })
        : null);
    if (toggleMode) {
      try {
        const result = await toggleMode();
        const confirmed = parseFastModeState(result?.stdout ?? result ?? "");
        if (currentControlThreadId() !== threadId
            || !confirmed?.available
            || typeof confirmed.enabled !== "boolean") {
          throw new Error("Codex fast mode toggle result was not confirmed");
        }
        fastModeState = {
          threadId,
          model: fastModeState.threadId === threadId ? fastModeState.model : null,
          ...confirmed,
          failed: false
        };
        applyFocusedComposerState(thread, confirmed);
        renderFastModeContexts();
        // New native helpers restore focus inside the same transaction. Keep
        // this fallback for a transient Chromium focus failure and for users
        // whose plugin JavaScript is briefly ahead of the bundled helper.
        if (confirmed.composerFocused !== true
            && focusComposer
            && !await focusComposer()) {
          feedback(context, "error", "입력창 확인", 1600);
          console.error("Codex Fast mode changed, but composer focus was not restored");
          return false;
        }
        if (confirmed.composerFocused !== true && focusComposer) {
          fastModeState = { ...fastModeState, composerFocused: true };
        }
        noteBridgeSuccess("fast-mode-toggle");
        // The verified icon itself is the success acknowledgement. Keep text
        // overlays for actionable failures instead of restating on/off.
        clearFeedback(context);
        return true;
      } catch (error) {
        if (focusComposer) await focusComposer();
        if (currentControlThreadId() === threadId) {
          fastModeState = {
            threadId,
            enabled: null,
            available: null,
            failed: true
          };
          renderFastModeContexts();
        }
        const permissionFailure = noteBridgeFailure("fast-mode-toggle", error, context);
        if (!permissionFailure) feedback(context, "error", "변경 실패", 1600);
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
      if (currentControlThreadId() === threadId) {
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
      if (currentControlThreadId() !== threadId
          || confirmed.enabled !== targetEnabled
          || !confirmed.available) {
        throw new Error("Codex fast mode target was not confirmed");
      }
      fastModeState = {
        threadId,
        model: fastModeState.threadId === threadId ? fastModeState.model : null,
        ...confirmed,
        failed: false
      };
      applyFocusedComposerState(thread, confirmed);
      renderFastModeContexts();
      noteBridgeSuccess("fast-mode-set");
      clearFeedback(context);
      return true;
    } catch (confirmationError) {
      const error = setError ?? confirmationError;
      if (currentControlThreadId() === threadId) {
        fastModeState = {
          threadId,
          enabled: null,
          available: null,
          failed: true
        };
        renderFastModeContexts();
      }
      const permissionFailure = noteBridgeFailure("fast-mode-set", error, context);
      if (!permissionFailure) feedback(context, "error", "변경 실패", 1600);
      console.error(`Could not change Codex fast mode: ${error?.message ?? "unknown error"}`);
      return false;
    }
  })().finally(() => {
    if (activeFastModeUpdate === update) activeFastModeUpdate = null;
  });
  activeFastModeUpdate = update;
  return update;
}

function performReasoningEffortChange(context, options = {}) {
  const productionNativeAction = !options.stepEffort;
  const bridgeCapability = "reasoning-effort-step";
  const synchronizeCurrent = options.synchronizeCurrent
    ?? (productionNativeAction
      ? synchronizeCurrentCodexThread
      : async () => currentThreadForDisplay());
  const focusComposer = options.focusComposer
    ?? (productionNativeAction
      ? () => focusCurrentComposer(null, { restore: true })
      : null);
  const initialThreadId = Object.hasOwn(options, "queuedThreadId")
    ? options.queuedThreadId
    : currentControlThreadId();
  const initialDirection = options.direction ?? nextReasoningDirection(initialThreadId);
  const update = (async () => {
    reasoningBusyContexts.add(context);
    renderFastModeContexts();
    try {
      const pendingNavigation = options.navigationPromise ?? currentNavigationPromise();
      if (pendingNavigation) await pendingNavigation;
      const synchronizedThread = await synchronizeCurrent({
        force: productionNativeAction,
        quiet: true,
        refreshFastMode: false
      });
      if (!synchronizedThread?.id) throw new Error("Codex current task was not found");
      if (initialThreadId && synchronizedThread.id !== initialThreadId) {
        throw new Error("Codex current task changed while effort input was queued");
      }
      const pendingRefresh = activeFastModeRefresh?.promise;
      if (pendingRefresh) await pendingRefresh.catch(() => false);
      const threadId = synchronizedThread.id;
      const thread = combinedVisibleThreads().find((candidate) => candidate?.id === threadId)
        ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null);
      const direction = options.direction ?? (threadId === initialThreadId
        ? initialDirection
        : nextReasoningDirection(threadId));
      const tapCount = Math.max(1, Math.min(64, Math.trunc(options.tapCount ?? 1)));
      const expectedEffort = normalizedReasoningEffort(
        reasoningVisualOverrideByThreadId.get(threadId)?.effort
      );
      const expectedModel = normalizedReasoningModel(
        reasoningVisualOverrideByThreadId.get(threadId)?.model
      );
      const currentEffort = fastModeState.threadId === threadId
        ? normalizedReasoningEffort(fastModeState.reasoningEffort)
        : normalizedReasoningEffort(thread?.nextReasoningEffort)
          ?? normalizedReasoningEffort(thread?.reasoningEffort);
      const currentModel = fastModeState.threadId === threadId
        ? normalizedReasoningModel(fastModeState.model)
        : null;
      const executionPlan = productionNativeAction
        ? reasoningSelectionExecutionPlan(
          currentModel,
          currentEffort,
          expectedModel,
          expectedEffort,
          threadId,
          direction,
          tapCount
        )
        : {
          mode: "step",
          direction,
          count: tapCount,
          targetEffort: expectedEffort
        };
      const plannedDirection = executionPlan.direction ?? direction;
      const plannedTapCount = executionPlan.count ?? tapCount;
      const needsAdvancedFallback = ["exact", "power-exact"].includes(
        executionPlan.mode
      );
      if (productionNativeAction && executionPlan.mode === "unavailable") {
        throw new Error("Requested Codex model and effort combination is unavailable");
      }
      if (productionNativeAction && executionPlan.mode === "none") {
        applyFocusedComposerState(thread, fastModeState);
        clearFeedback(context);
        runtimeTrace("control-plane", {
          strategy: "reasoning-noop",
          result: "already-target"
        });
        return true;
      }
      let microNeedsExactCorrection = false;
      if (productionNativeAction
          && options.useMicro !== false
          && ["power", "power-exact"].includes(executionPlan.mode)) {
        const powerTarget = executionPlan.powerTarget;
        const powerResult = await codexControlPlane.execute("reasoning-power-select", {
          micro: async (bridge) => {
            const ultraConfirmation = powerTarget.effort === "ultra"
              ? bridge.confirmUltraFullAccess({ timeoutMs: 1800 })
              : null;
            await bridge.setPowerSelection(powerTarget.model, powerTarget.effort);
            if (ultraConfirmation) await ultraConfirmation;
            return verifyAfterMicroDelivery(async () => {
              await sleepWithSignal(160);
              const snapshot = await bridge.refreshReadOnly();
              if (!isProvisionalComposerThread(thread)
                  && microSnapshotActiveThreadId(snapshot) !== threadId) {
                throw new Error("Power selection changed outside the verified current task");
              }
              if (normalizedReasoningModel(snapshot.model) !== powerTarget.model
                  || normalizedReasoningEffort(snapshot.reasoningEffort)
                    !== powerTarget.effort) {
                throw new Error("Codex power selection did not reach its exact target");
              }
              return snapshot;
            }, "Power selection verification");
          }
        }, { quiet: true });
        if (powerResult.backend !== "micro" || !powerResult.ok) {
          showFeedback(context, "error", "변경 확인", 1600);
          return false;
        }
        const snapshot = powerResult.value;
        applyMicroReadOnlySnapshot(snapshot, { promote: false });
        if (executionPlan.mode === "power-exact") {
          microNeedsExactCorrection = true;
          runtimeTrace("control-plane", {
            strategy: "micro+advanced",
            result: "model-selected"
          });
        } else {
          const confirmedModel = normalizedReasoningModel(snapshot.model);
          const confirmedEffort = normalizedReasoningEffort(snapshot.reasoningEffort);
          const selections = reasoningSelectionOptionsForThread(threadId);
          const selectionIndex = reasoningSelectionIndex(
            selections,
            confirmedModel,
            confirmedEffort
          );
          fastModeState = {
            ...fastModeStateFromThread(thread, fastModeState),
            threadId,
            model: confirmedModel,
            enabled: typeof snapshot.fastEnabled === "boolean"
              ? snapshot.fastEnabled
              : fastModeState.enabled,
            available: typeof snapshot.fastEnabled === "boolean"
              ? true
              : fastModeState.available,
            reasoningEffort: confirmedEffort,
            composerFocused: true,
            failed: false
          };
          reasoningDirectionByThreadId.set(
            threadId,
            selectionIndex === selections.length - 1
              ? "down"
              : selectionIndex === 0
                ? "up"
                : plannedDirection
          );
          applyFocusedComposerState(thread, fastModeState);
          clearFeedback(context);
          runtimeTrace("control-plane", {
            strategy: "micro-power",
            result: "success"
          });
          return true;
        }
      }
      if (productionNativeAction
          && options.useMicro !== false
          && executionPlan.mode === "micro") {
        const microResult = await codexControlPlane.execute("reasoning-effort-step", {
          micro: async (bridge) => {
            await bridge.adjustReasoning(
              plannedDirection === "down" ? "decrease" : "increase",
              plannedTapCount,
              { confirmUltra: false }
            );
            return verifyAfterMicroDelivery(async () => {
              await sleepWithSignal(140);
              const snapshot = await bridge.refreshReadOnly();
              if (!isProvisionalComposerThread(thread)
                  && microSnapshotActiveThreadId(snapshot) !== threadId) {
                throw new Error("Effort changed outside the verified current task");
              }
              return snapshot;
            }, "Effort verification");
          }
        }, { quiet: true });
        if (microResult.backend === "micro") {
          if (!microResult.ok) {
            showFeedback(context, "error", "변경 확인", 1600);
            return false;
          }
          const snapshot = microResult.value;
          const visualEffort = normalizedReasoningEffort(
            reasoningVisualOverrideByThreadId.get(threadId)?.effort
          );
          const confirmedEffort = normalizedReasoningEffort(snapshot?.reasoningEffort)
            ?? visualEffort;
          if (!confirmedEffort) {
            showFeedback(context, "error", "변경 확인", 1600);
            return false;
          }
          if (expectedEffort && confirmedEffort !== expectedEffort) {
            // The physical Micro's compact encoder intentionally omits some
            // Advanced-only levels on certain models. Because the renderer
            // snapshot gives us the exact post-knob state, it is safe to
            // correct that verified mismatch once through Codex's complete
            // Advanced option list instead of replaying another encoder tick.
            microNeedsExactCorrection = true;
            applyMicroReadOnlySnapshot(snapshot, { promote: false });
            runtimeTrace("control-plane", {
              strategy: "micro+advanced",
              result: "target-skipped"
            });
          } else {
            const availableEfforts = reasoningEffortOptionsForThread(threadId);
            if (availableEfforts.length >= 2) {
              rememberReasoningEffortOptions(threadId, availableEfforts);
            }
            fastModeState = {
              ...fastModeStateFromThread(thread, fastModeState),
              threadId,
              model: normalizedReasoningModel(snapshot?.model)
                ?? fastModeState.model,
              enabled: typeof snapshot?.fastEnabled === "boolean"
                ? snapshot.fastEnabled
                : fastModeState.enabled,
              available: typeof snapshot?.fastEnabled === "boolean"
                ? true
                : fastModeState.available,
              reasoningEffort: confirmedEffort,
              composerFocused: true,
              failed: false
            };
            const effortIndex = availableEfforts.indexOf(confirmedEffort);
            const nextDirection = effortIndex === availableEfforts.length - 1
              ? "down"
              : effortIndex === 0
                ? "up"
                : plannedDirection;
            reasoningDirectionByThreadId.set(threadId, nextDirection);
            if (snapshot) applyMicroReadOnlySnapshot(snapshot, { promote: false });
            applyFocusedComposerState(thread, fastModeState);
            clearFeedback(context);
            runtimeTrace("control-plane", { strategy: "micro", result: "success" });
            return true;
          }
        }
        if (microResult.ambiguous) {
          showFeedback(context, "error", "변경 확인", 1600);
          return false;
        }
      }
      if (productionNativeAction
          && !ensureCommandPermissions(bridgeCapability, context)) return false;
      const exactTargetEffort = productionNativeAction
          && expectedEffort
          && (needsAdvancedFallback || microNeedsExactCorrection)
        ? expectedEffort
        : null;
      const focusTargetComposer = options.focusTargetComposer
        ?? (exactTargetEffort
          ? () => focusAdvancedReasoningComposer(context)
          : () => focusCurrentComposer(context));
      if (productionNativeAction && !await focusTargetComposer()) {
        throw new Error("Codex current composer was not focused");
      }
      if (!thread || !await currentControlThreadIsFocused(thread, { probe: options.focusProbe })) {
        throw new Error("Codex current task was not focused");
      }

      const stepEffort = options.stepEffort
        ?? ((stepDirection, count) => execFileAsync(
          KEY_BRIDGE,
          ["reasoning-effort-step", stepDirection, String(count)],
          { timeout: 6000, maxBuffer: 4096 }
        ));
      const setExactEffort = options.setExactEffort
        ?? ((effort) => execFileAsync(
          KEY_BRIDGE,
          ["reasoning-effort-set", effort],
          { timeout: 7000, maxBuffer: 4096 }
        ));
      // Ordinary levels use Codex's native Micro encoder. Max, Ultra, or a
      // verified encoder skip takes the exact Advanced route after the input
      // burst settles, scans this user's full list, and selects only the final
      // target once.
      const rendererUltraConfirmation = exactTargetEffort === "ultra"
          && productionNativeAction
        ? codexControlPlane.execute("reasoning-ultra-confirm", {
          micro: (bridge) => bridge.confirmUltraFullAccess({ timeoutMs: 1600 })
        }, { quiet: true }).catch(() => null)
        : null;
      let result = null;
      let actionError = null;
      try {
        result = exactTargetEffort
          ? await setExactEffort(exactTargetEffort)
          : await stepEffort(plannedDirection, plannedTapCount);
      } catch (error) {
        actionError = error;
      }
      let confirmed = parseReasoningStepState(result?.stdout ?? result ?? "");
      let rendererUltraSnapshot = null;
      const rendererUltraResult = rendererUltraConfirmation
        ? await rendererUltraConfirmation
        : null;
      const parsedConfirmedEffort = normalizedReasoningEffort(
        confirmed?.reasoningEffort
      );
      const nativeConfirmed = !actionError
        && confirmed?.verified === true
        && parsedConfirmedEffort === exactTargetEffort;
      if (rendererUltraResult && !nativeConfirmed) {
        if (rendererUltraResult.backend === "micro"
            && rendererUltraResult.ok
            && rendererUltraResult.value?.confirmed === true) {
          await sleepWithSignal(160);
          rendererUltraSnapshot = await codexControlPlane.refreshReadOnly({
            force: true,
            quiet: true
          });
          if (microSnapshotActiveThreadId(rendererUltraSnapshot) === threadId
              && normalizedReasoningEffort(rendererUltraSnapshot.reasoningEffort)
                === "ultra") {
            confirmed = {
              reasoningEffort: "ultra",
              availableEfforts: reasoningEffortOptionsForThread(threadId),
              verified: true,
              enabled: rendererUltraSnapshot.fastEnabled,
              available: typeof rendererUltraSnapshot.fastEnabled === "boolean"
                ? true
                : null,
              composerFocused: true,
              atMinimum: false,
              atMaximum: true,
              direction: "down"
            };
            actionError = null;
          }
        }
      }
      if (actionError) throw actionError;
      const confirmedEffort = normalizedReasoningEffort(confirmed?.reasoningEffort);
      const availableEfforts = normalizeReasoningEffortOptions(
        confirmed?.availableEfforts
      );
      if (currentControlThreadId() !== threadId
          || confirmed?.verified !== true
          || !confirmedEffort
          || availableEfforts.length < 2
          || !availableEfforts.includes(confirmedEffort)
          || (exactTargetEffort && confirmedEffort !== exactTargetEffort)) {
        throw new Error("Codex reasoning effort change was not confirmed");
      }
      rememberReasoningEffortOptions(threadId, availableEfforts);

      const merged = mergeFastModeObservation(thread, confirmed, fastModeState);
      fastModeState = {
        threadId,
        ...merged,
        model: expectedModel ?? merged.model ?? fastModeState.model,
        reasoningEffort: confirmedEffort,
        composerFocused: confirmed.composerFocused,
        failed: false
      };
      const nextDirection = confirmed.atMaximum === true
        ? "down"
        : confirmed.atMinimum === true
          ? "up"
          : confirmed.direction ?? plannedDirection;
      reasoningDirectionByThreadId.set(threadId, nextDirection);
      applyFocusedComposerState(thread, fastModeState);

      if (confirmed.composerFocused !== true
          && focusComposer
          && !await focusComposer()) {
        throw new Error("Codex composer focus was not restored");
      }
      if (confirmed.composerFocused !== true && focusComposer) {
        fastModeState = { ...fastModeState, composerFocused: true };
      }
      noteBridgeSuccess(bridgeCapability);
      clearFeedback(context);
      return true;
    } catch (error) {
      if (focusComposer) await focusComposer();
      const permissionFailure = noteBridgeFailure(
        bridgeCapability,
        error,
        context
      );
      if (!permissionFailure) showFeedback(context, "error", "변경 실패", 1600);
      console.error(`Could not set Codex reasoning effort: ${error?.message ?? "unknown error"}`);
      return false;
    }
  })();
  return update;
}

function incrementReasoningPending(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function reasoningInputBatchKey(context, threadId) {
  return threadId ? `thread:${threadId}` : `context:${context}`;
}

function resetReasoningInputSettleTimer(batch, delayMs) {
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    batch.timer = null;
    batch.release();
  }, Math.max(0, delayMs));
}

function reasoningEffortNeedsAdvancedFallback(value) {
  return ["max", "ultra"].includes(normalizedReasoningEffort(value));
}

function reasoningEffortExecutionPlan(
  currentValue,
  targetValue,
  availableEfforts,
  fallbackDirection = "up",
  fallbackCount = 1
) {
  const currentEffort = normalizedReasoningEffort(currentValue);
  const targetEffort = normalizedReasoningEffort(targetValue);
  const options = normalizeReasoningEffortOptions(availableEfforts);
  const fallback = {
    mode: targetEffort ? "exact" : "step",
    direction: fallbackDirection === "down" ? "down" : "up",
    count: Math.max(1, Math.min(64, Math.trunc(fallbackCount ?? 1))),
    targetEffort
  };
  if (!currentEffort || !targetEffort || options.length < 2) return fallback;
  if (currentEffort === targetEffort) {
    return { mode: "none", direction: fallback.direction, count: 0, targetEffort };
  }
  const currentIndex = options.indexOf(currentEffort);
  const targetIndex = options.indexOf(targetEffort);
  if (currentIndex < 0 || targetIndex < 0) return fallback;
  if (reasoningEffortNeedsAdvancedFallback(currentEffort)
      || reasoningEffortNeedsAdvancedFallback(targetEffort)) {
    return { ...fallback, mode: "exact" };
  }
  return {
    mode: "micro",
    direction: targetIndex < currentIndex ? "down" : "up",
    count: Math.abs(targetIndex - currentIndex),
    targetEffort
  };
}

function reasoningSelectionExecutionPlan(
  currentModelValue,
  currentEffortValue,
  targetModelValue,
  targetEffortValue,
  threadId,
  fallbackDirection = "up",
  fallbackCount = 1
) {
  const currentModel = normalizedReasoningModel(currentModelValue);
  const targetModel = normalizedReasoningModel(targetModelValue);
  const currentEffort = normalizedReasoningEffort(currentEffortValue);
  const targetEffort = normalizedReasoningEffort(targetEffortValue);
  if (!currentModel || !targetModel || currentModel === targetModel) {
    return reasoningEffortExecutionPlan(
      currentEffort,
      targetEffort,
      reasoningEffortOptionsForThread(threadId),
      fallbackDirection,
      fallbackCount
    );
  }
  if (currentEffort === targetEffort && currentModel === targetModel) {
    return {
      mode: "none",
      direction: fallbackDirection,
      count: 0,
      targetModel,
      targetEffort
    };
  }
  const selections = reasoningSelectionOptionsForThread(threadId);
  const target = selections.find((selection) => (
    selection.model === targetModel && selection.effort === targetEffort
  ));
  if (!target) {
    return {
      mode: "unavailable",
      direction: fallbackDirection,
      count: 0,
      targetModel,
      targetEffort
    };
  }
  if (target.compact) {
    return {
      mode: "power",
      direction: fallbackDirection,
      count: 1,
      targetModel,
      targetEffort,
      powerTarget: target
    };
  }
  const targetRank = REASONING_EFFORT_ORDER.indexOf(targetEffort);
  const compactTarget = selections
    .filter((selection) => selection.model === targetModel && selection.compact)
    .sort((left, right) => (
      Math.abs(REASONING_EFFORT_ORDER.indexOf(left.effort) - targetRank)
      - Math.abs(REASONING_EFFORT_ORDER.indexOf(right.effort) - targetRank)
    ))[0] ?? null;
  return compactTarget
    ? {
      mode: "power-exact",
      direction: fallbackDirection,
      count: 1,
      targetModel,
      targetEffort,
      powerTarget: compactTarget
    }
    : {
      mode: "unavailable",
      direction: fallbackDirection,
      count: 0,
      targetModel,
      targetEffort
    };
}

function reasoningInputSettleMs(
  options = {},
  targetEffort = null,
  advancedTouched = false
) {
  if (Number.isFinite(options.settleMs)) return options.settleMs;
  if (advancedTouched || reasoningEffortNeedsAdvancedFallback(targetEffort)) {
    return REASONING_INPUT_SETTLE_MS;
  }
  return codexControlPlane.health().connected
    ? MICRO_REASONING_INPUT_SETTLE_MS
    : REASONING_INPUT_SETTLE_MS;
}

function cancelReasoningInputBatches() {
  for (const batch of reasoningInputBatchByKey.values()) {
    batch.cancelled = true;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    batch.release();
  }
  reasoningInputBatchByKey.clear();
}

function stepReasoningEffort(context, options = {}) {
  fastModeRevision += 1;
  const pendingNavigation = options.navigationPromise ?? currentNavigationPromise();
  // A press made while Side Chat/task creation is still resolving belongs to
  // the destination that will be verified by the transaction, not the old
  // currently cached task. In that case defer both identity and optimism.
  const queuedThreadId = pendingNavigation ? null : currentControlThreadId();
  const visual = reasoningVisualOverrideByThreadId.get(queuedThreadId);
  const direction = options.direction
    ?? visual?.direction
    ?? nextReasoningDirection(queuedThreadId);
  let advancedTouched = reasoningEffortNeedsAdvancedFallback(
    visual?.effort ?? fastModeState.reasoningEffort
  );
  let optimistic = null;
  // Paint every tap immediately from the last requested position. The native
  // Codex picker is debounced separately, so a burst moves the hardware track
  // on every press but selects only the final stopped effort once.
  if (queuedThreadId) {
    const baseState = {
      ...fastModeState,
      threadId: queuedThreadId,
      model: visual?.model ?? fastModeState.model,
      reasoningEffort: visual?.effort ?? fastModeState.reasoningEffort
    };
    optimistic = optimisticReasoningStep(queuedThreadId, direction, baseState);
    if (optimistic) {
      reasoningVisualOverrideByThreadId.set(queuedThreadId, optimistic);
      reasoningDirectionByThreadId.set(queuedThreadId, optimistic.direction);
      advancedTouched ||= reasoningEffortNeedsAdvancedFallback(optimistic.effort);
    }
  }
  incrementReasoningPending(reasoningPendingCountByThreadId, queuedThreadId);
  incrementReasoningPending(reasoningPendingCountByContext, context);
  reasoningBusyContexts.add(context);
  renderFastModeContexts();

  const batchKey = reasoningInputBatchKey(context, queuedThreadId);
  const existingBatch = reasoningInputBatchByKey.get(batchKey);
  if (existingBatch && !existingBatch.dispatched) {
    existingBatch.tapCount += 1;
    existingBatch.contexts.add(context);
    existingBatch.options = { ...existingBatch.options, ...options };
    existingBatch.advancedTouched ||= advancedTouched;
    resetReasoningInputSettleTimer(
      existingBatch,
      reasoningInputSettleMs(
        options,
        optimistic?.effort ?? visual?.effort ?? fastModeState.reasoningEffort,
        existingBatch.advancedTouched
      )
    );
    return existingBatch.promise;
  }

  const blocker = activeFastModeUpdate;
  let release;
  const settled = new Promise((resolve) => {
    release = resolve;
  });
  const batch = {
    key: batchKey,
    context,
    contexts: new Set([
      ...(existingBatch?.contexts ?? []),
      context
    ]),
    queuedThreadId,
    startingDirection: direction,
    tapCount: 1,
    options: { ...options, navigationPromise: pendingNavigation },
    timer: null,
    cancelled: false,
    dispatched: false,
    advancedTouched,
    release,
    promise: null
  };
  let update;
  update = Promise.resolve(blocker)
    .catch(() => false)
    .then(() => settled)
    .then(() => {
      batch.dispatched = true;
      return batch.cancelled
        ? false
        : performReasoningEffortChange(context, {
          ...batch.options,
          queuedThreadId: batch.queuedThreadId,
          direction: batch.startingDirection,
          tapCount: batch.tapCount,
          advancedTouched: batch.advancedTouched,
          coalesced: true
        });
    })
    .finally(() => {
      if (batch.timer) clearTimeout(batch.timer);
      const isLatestBatch = reasoningInputBatchByKey.get(batch.key) === batch;
      if (isLatestBatch) {
        reasoningInputBatchByKey.delete(batch.key);
        if (batch.queuedThreadId) {
          reasoningPendingCountByThreadId.delete(batch.queuedThreadId);
          reasoningVisualOverrideByThreadId.delete(batch.queuedThreadId);
        }
        for (const batchContext of batch.contexts) {
          reasoningPendingCountByContext.delete(batchContext);
          reasoningBusyContexts.delete(batchContext);
        }
      }
      if (activeFastModeUpdate === update) activeFastModeUpdate = null;
      renderFastModeContexts();
    });
  batch.promise = update;
  reasoningInputBatchByKey.set(batch.key, batch);
  resetReasoningInputSettleTimer(
    batch,
    reasoningInputSettleMs(
      options,
      optimistic?.effort ?? visual?.effort ?? fastModeState.reasoningEffort,
      batch.advancedTouched
    )
  );
  activeFastModeUpdate = update;
  return update;
}

function applyQueueState(threads, windows, nowMs = Date.now()) {
  const observations = new Map();
  for (const window of windows) {
    const candidates = queueWindowThreadCandidates(window, threads);
    const positionedCounts = queueCountsByThreadForWindow(window, candidates);
    if (positionedCounts) {
      for (const thread of candidates) {
        if (!positionedCounts.has(thread.id)) continue;
        const count = positionedCounts.get(thread.id);
        const previous = observations.get(thread.id);
        observations.set(thread.id, {
          thread,
          count: Math.max(previous?.count ?? 0, count)
        });
      }
      continue;
    }
    // Never attach an aggregate window count to one arbitrarily selected task
    // when Codex is showing multiple conversation panes. A transiently
    // incomplete geometry read is safer to retry than to merge Side Chat rows
    // into the primary task badge.
    if (candidates.length !== 1) continue;
    const thread = candidates[0];
    if (!thread?.id) continue;
    const count = queueCountForWindow(window);
    const previous = observations.get(thread.id);
    observations.set(thread.id, {
      thread,
      count: Math.max(previous?.count ?? 0, count)
    });
  }

  const observedIds = new Set();
  for (const { thread, count } of observations.values()) {
    observedIds.add(thread.id);
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

function displayThreadTitle(thread) {
  if (thread?.titleKey) return t(thread.titleKey);
  return normalizeTitle(thread?.title);
}

function queueBadgeSvg(thread) {
  const label = queueBadgeLabel(thread?.queueCount);
  if (!label) return "";
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

function timingTextBaselineY(fontSize) {
  // Keep the optical center fixed inside the 31 px timing capsule. A fixed
  // baseline makes the compact goal+queue label sit too low as its font
  // shrinks, because a smaller font needs less baseline offset from center.
  const timingCapsuleCenterY = 117.5;
  return Number((timingCapsuleCenterY + fontSize * 0.38).toFixed(2));
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
  const timingBaselineY = timingTextBaselineY(timingFontSize);
  const completionStrength = completionEffect?.strength ?? 0;
  const completionChrome = completionEffect ? `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.green}" fill-opacity="${(0.32 * completionStrength).toFixed(3)}" stroke="${THEME.green}" stroke-opacity="${(0.78 * completionStrength).toFixed(3)}" stroke-width="${(1 + completionStrength * 1.2).toFixed(2)}"/>` : "";
  const completionText = completionEffect ? `
    <text data-thread-timing="completion" x="${timingX}" y="${timingBaselineY}" fill="${THEME.text}" fill-opacity="${(0.82 * completionStrength).toFixed(3)}" font-family="${FONT_STACK}" font-size="${timingFontSize}" font-weight="650" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>` : "";
  return `
    <rect x="13" y="102" width="118" height="31" rx="11" fill="${THEME.raised}"/>
    ${completionChrome}
    ${goalBadgeSvg(thread)}
    <text data-thread-timing="base" x="${timingX}" y="${timingBaselineY}" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="${timingFontSize}" font-weight="600" font-variant-numeric="tabular-nums" text-anchor="middle">${escapeXml(elapsedLabel)}</text>
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
  const [line1, line2] = wrapTitle(displayThreadTitle(thread), 5.05);
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
    threadHeader(style.accent, thread.status, style.label, activity, thread.status === "working", thread.reasoningEffort, thread.serviceTier, completionEffect, thread.id),
    completionPulseChrome(completionEffect));
  return applyVoiceTargetOverlay(rendered, thread.id);
}

function threadSvg(thread, slot) {
  if (!thread) {
    return shell(THEME.muted, `
      <circle cx="72" cy="69" r="19" fill="${THEME.raised}"/>
      <path d="M62 69H82M72 59V79" stroke="${THEME.muted}" stroke-width="2.5" stroke-linecap="round"/>
      <text x="72" y="114" fill="${THEME.textSecondary}" font-family="${FONT_STACK}" font-size="19.5" font-weight="600" text-anchor="middle">${escapeXml(t("thread.empty"))}</text>`,
      threadHeader(THEME.muted, "idle", t("status.idle"), { kind: "idle", code: "activity.waiting" }));
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
  const [line1, line2] = wrapTitle(displayThreadTitle(thread), thread.pinned ? 4.9 : 5.75);
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
    threadHeader(style.accent, thread.status, style.label, activity, thread.status === "working", thread.reasoningEffort, thread.serviceTier, completionEffect, thread.id),
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

function localProjectsFromState(state) {
  const projects = state?.["local-projects"];
  return projects && typeof projects === "object" && !Array.isArray(projects)
    ? projects
    : {};
}

function threadProjectAssignmentFromState(state, threadId) {
  const assignments = state?.["thread-project-assignments"];
  const assignment = threadId && assignments && typeof assignments === "object"
    ? assignments[threadId]
    : null;
  return assignment && typeof assignment === "object" ? assignment : null;
}

function pathBelongsToRoot(candidatePath, rootPath) {
  if (!candidatePath || !rootPath) return false;
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectForCwd(state, cwd) {
  if (!cwd) return null;
  for (const [projectId, project] of Object.entries(localProjectsFromState(state))) {
    const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
    if (roots.some((root) => pathBelongsToRoot(cwd, root))) {
      return { projectId, project, roots };
    }
  }
  return null;
}

function threadProjectContextFromState(thread, state) {
  const leasedNewThread = activeNewThreadFocusThread();
  if (isProvisionalNewThread(thread) && leasedNewThread) {
    return activeComposerFocusLease?.projectContext ?? {
      inProject: null,
      projectId: null,
      projectKind: null,
      cwd: thread?.cwd ?? "",
      rootPaths: []
    };
  }
  const anchorId = thread?.ephemeral
    ? thread.parentId ?? sideChatParentById.get(thread.id) ?? null
    : thread?.id ?? null;
  const assignment = threadProjectAssignmentFromState(state, anchorId);
  if (assignment?.projectId) {
    const project = localProjectsFromState(state)[assignment.projectId] ?? null;
    return {
      inProject: true,
      projectId: assignment.projectId,
      projectKind: assignment.projectKind ?? "local",
      cwd: assignment.cwd ?? thread?.cwd ?? project?.rootPaths?.[0] ?? "",
      rootPaths: Array.isArray(project?.rootPaths) ? [...project.rootPaths] : []
    };
  }
  const projectlessIds = Array.isArray(state?.["projectless-thread-ids"])
    ? state["projectless-thread-ids"]
    : [];
  if (anchorId && projectlessIds.includes(anchorId)) {
    return {
      inProject: false,
      projectId: null,
      projectKind: "projectless",
      cwd: thread?.cwd ?? "",
      rootPaths: []
    };
  }
  const cwdProject = projectForCwd(state, thread?.cwd);
  if (cwdProject) {
    return {
      inProject: true,
      projectId: cwdProject.projectId,
      projectKind: "local",
      cwd: thread.cwd,
      rootPaths: [...cwdProject.roots]
    };
  }
  return {
    inProject: null,
    projectId: null,
    projectKind: null,
    cwd: thread?.cwd ?? "",
    rootPaths: []
  };
}

function threadMatchesProjectContext(thread, state, projectContext) {
  if (!projectContext || projectContext.inProject === null) return true;
  const assignment = threadProjectAssignmentFromState(state, thread?.id);
  if (projectContext.inProject) {
    if (assignment?.projectId) return assignment.projectId === projectContext.projectId;
    return projectContext.rootPaths.some((root) => pathBelongsToRoot(thread?.cwd, root));
  }
  if (assignment?.projectId) return false;
  const projectlessIds = Array.isArray(state?.["projectless-thread-ids"])
    ? state["projectless-thread-ids"]
    : [];
  if (projectlessIds.includes(thread?.id)) return true;
  // An empty cwd while Codex is still writing global state is ambiguous. Keep
  // the placeholder instead of attaching it to a concurrently created project
  // task; the next refresh can promote it once either source becomes explicit.
  return Boolean(thread?.cwd) && !projectForCwd(state, thread.cwd);
}

async function resolvePendingNewThreadTarget(localRows, globalStatePromise) {
  const lease = activeComposerFocusLease;
  if (lease?.kind !== "new-thread" || lease.targetThreadId) return null;
  let state = null;
  try {
    state = await globalStatePromise;
  } catch {
    return null;
  }
  const minimumCreatedAtMs = lease.requestedAtMs - 5000;
  const candidates = localRows
    .filter((thread) => !lease.knownIds?.has(thread.id))
    .filter((thread) => {
      const createdAtMs = uuidV7TimestampMs(thread.id);
      return Number.isFinite(createdAtMs) && createdAtMs >= minimumCreatedAtMs;
    })
    .filter((thread) => threadMatchesProjectContext(thread, state, lease.projectContext))
    .sort((left, right) => uuidV7TimestampMs(right.id) - uuidV7TimestampMs(left.id));
  const thread = candidates[0] ?? null;
  if (!thread) return null;
  promoteNewThreadFocusLease(thread, { render: false });
  bindPendingVoiceContextsToThread(thread.id);
  runtimeTrace("new-thread-focus", {
    result: "promoted",
    scope: lease.projectContext?.inProject === true ? "project" : "standalone"
  });
  return thread;
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
    sideChatTitleById.clear();
    sideChatLifecycleCache.clear();
    closedSideChatAtMs.clear();
    sideChatCloseLogOffsets.clear();
    sideChatDiscoveryState = createSideChatDiscoveryState();
    sideChatDiscoveryLogCursors.clear();
  }
  if (Number.isFinite(startedAtMs)
      && startedAtMs !== reasoningCatalogAppServerStartedAtMs) {
    reasoningCatalogAppServerStartedAtMs = startedAtMs;
    void refreshReasoningOptionCatalog({ force: true });
  }
  appServerSessionCache = { checkedAtMs: nowMs, startedAtMs };
  return startedAtMs;
}

async function readEphemeralSideChats(
  persistentRowsOrIds,
  parentId,
  globalStatePromise = null,
  options = {}
) {
  const sessionStartedAtMs = await readAppServerSessionStartMs();
  if (!Number.isFinite(sessionStartedAtMs)) return [];
  const persistentIds = persistentRowsOrIds instanceof Set
    ? persistentRowsOrIds
    : new Set(persistentRowsOrIds.map((row) => row.id));
  const cachedById = new Map(sideChatRowsCache.map((thread) => [thread.id, thread]));
  let promptHistory = null;
  let promptHistoryAvailable = false;
  try {
    const state = await (globalStatePromise ?? readGlobalStateSnapshot());
    promptHistory = promptHistoryFromState(state);
    promptHistoryAvailable = Boolean(promptHistory);
  } catch {
    // Preserve the last valid prompt-history snapshot. Log discovery below is
    // independent and may still add or close Side Chats during a state rewrite.
  }

  let discoveredRows = [];
  if (options.discoverFromLogs !== false) {
    try {
      discoveredRows = await refreshDiscoveredSideChatsFromLogs(
        persistentIds,
        sessionStartedAtMs
      );
    } catch {
      discoveredRows = openDiscoveredSideChats(sideChatDiscoveryState, persistentIds);
    }
  }
  const discoveredById = new Map(discoveredRows.map((thread) => [thread.id, thread]));
  const sideChatsById = new Map();

  if (!promptHistoryAvailable) {
    for (const thread of sideChatRowsCache) {
      if (!persistentIds.has(thread.id) && !closedSideChatAtMs.has(thread.id)) {
        sideChatsById.set(thread.id, { ...thread });
      }
    }
  } else {
    for (const [id, prompts] of Object.entries(promptHistory)) {
      if (!UUID_PATTERN.test(id) || persistentIds.has(id) || !Array.isArray(prompts)) continue;
      const createdAtMs = uuidV7TimestampMs(id);
      if (!Number.isFinite(createdAtMs)
          || createdAtMs + APP_SERVER_START_TOLERANCE_MS < sessionStartedAtMs) continue;
      const firstPrompt = prompts.find((prompt) => typeof prompt === "string" && prompt.trim());
      const rendererTitle = sideChatTitleById.get(id) ?? null;
      const preferredTitle = rendererTitle ?? firstPrompt;
      if (!preferredTitle || isInternalThreadRecord({ title: preferredTitle })) continue;
      const rememberedParentId = discoveredById.get(id)?.parentId
        ?? sideChatParentById.get(id)
        ?? parentId
        ?? null;
      if (rememberedParentId) sideChatParentById.set(id, rememberedParentId);
      sideChatsById.set(id, {
        id,
        title: normalizeTitle(preferredTitle),
        queueTitles: [...new Set([rendererTitle, firstPrompt].filter(Boolean))],
        fallbackTitle: false,
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
  }

  for (const record of discoveredRows) {
    if (persistentIds.has(record.id) || closedSideChatAtMs.has(record.id)) continue;
    const current = sideChatsById.get(record.id) ?? cachedById.get(record.id) ?? null;
    const rememberedParentId = record.parentId
      ?? current?.parentId
      ?? sideChatParentById.get(record.id)
      ?? parentId
      ?? null;
    if (rememberedParentId) sideChatParentById.set(record.id, rememberedParentId);
    const createdAtMs = record.createdAtMs;
    const rendererTitle = sideChatTitleById.get(record.id) ?? null;
    sideChatsById.set(record.id, {
      id: record.id,
      title: rendererTitle ?? (current?.fallbackTitle === false ? current.title : ""),
      queueTitles: [...new Set([
        rendererTitle,
        ...(Array.isArray(current?.queueTitles) ? current.queueTitles : [])
      ].filter(Boolean))],
      fallbackTitle: !rendererTitle && current?.fallbackTitle !== false,
      cwd: "",
      rollout_path: null,
      recency_at: Math.floor(createdAtMs / 1000),
      updated_at: Math.floor(createdAtMs / 1000),
      createdAtMs,
      promptCount: current?.promptCount ?? 0,
      parentId: rememberedParentId,
      ephemeral: true,
      pinned: false
    });
  }

  const ordinalByParent = new Map();
  const sideChats = [...sideChatsById.values()]
    .filter((thread) => !persistentIds.has(thread.id) && !closedSideChatAtMs.has(thread.id))
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .map((thread) => {
      const group = thread.parentId ?? "unknown";
      const ordinal = (ordinalByParent.get(group) ?? 0) + 1;
      ordinalByParent.set(group, ordinal);
      return thread.fallbackTitle
        ? { ...thread, title: `${t("activity.sideChat")} ${ordinal}` }
        : thread;
    });

  const activeSideChatIds = new Set(sideChats.map((thread) => thread.id));
  for (const id of sideChatParentById.keys()) {
    if (!activeSideChatIds.has(id)) {
      sideChatParentById.delete(id);
      sideChatTitleById.delete(id);
    }
  }
  // Prompt history is persisted asynchronously and can briefly omit an
  // entry while Codex rewrites the state file. Keep lifecycle/close memory
  // for the lifetime of the app-server session so a closed side chat cannot
  // flash back into the list after one transient read.
  sideChatRowsCache = sideChats.sort((a, b) => threadRecencyMs(b) - threadRecencyMs(a));
  return [...sideChatRowsCache];
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

async function refreshDiscoveredSideChatsFromLogs(persistentIds, sessionStartedAtMs) {
  const filePaths = await readCurrentDesktopLogPaths();
  const files = [];
  for (const filePath of filePaths) {
    try {
      files.push({ filePath, stat: await fs.stat(filePath) });
    } catch {
      // A rotating log can disappear between discovery and inspection.
    }
  }
  files.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  const activePaths = new Set(files.map(({ filePath }) => filePath));

  for (const { filePath } of files) {
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      const stat = await handle.stat();
      const previous = sideChatDiscoveryLogCursors.get(filePath) ?? null;
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
        : Math.max(0, stat.size - SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES);
      if (start >= stat.size) {
        if (!continuing) {
          sideChatDiscoveryLogCursors.set(filePath, {
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
        applySideChatLogLine(sideChatDiscoveryState, line, {
          sessionStartedAtMs,
          sessionToleranceMs: APP_SERVER_START_TOLERANCE_MS
        });
      }
      sideChatDiscoveryLogCursors.set(filePath, {
        offset: start + bytesRead,
        fileIdentity: logFileIdentity(stat),
        boundaryBytes: nextLogBoundary(continuing ? previous.boundaryBytes : null, chunk),
        lineState
      });
    } finally {
      await handle?.close();
    }
  }

  for (const filePath of sideChatDiscoveryLogCursors.keys()) {
    if (!activePaths.has(filePath)) sideChatDiscoveryLogCursors.delete(filePath);
  }
  for (const [id, closedAtMs] of sideChatDiscoveryState.closedAtById) {
    closedSideChatAtMs.set(id, closedAtMs);
  }
  return openDiscoveredSideChats(sideChatDiscoveryState, persistentIds);
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
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : renderTimeMs();
  const visibleEffect = completionPulseState(threadId, nowMs)
    ?? unreadCompletionPulseState(threadId, nowMs);
  const hadTransientEffect = completionPulseStartedAt.has(threadId)
    || globalCompletionThreadId === threadId;
  const clearedUnread = clearUnreadCompletion(threadId, options);
  if (!clearedUnread && !hadTransientEffect) return false;
  if (options.fade !== false && visibleEffect?.strength >= 0.002) {
    completionDismissFadeByThreadId.set(threadId, {
      startedAtMs: nowMs,
      initialStrength: visibleEffect.strength
    });
  } else {
    completionDismissFadeByThreadId.delete(threadId);
  }
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

function applyFocusedComposerState(thread, state, nowMs = Date.now()) {
  if (!thread?.id) return false;
  const reasoningEffort = normalizedReasoningEffort(state?.reasoningEffort);
  const serviceTier = typeof state?.enabled === "boolean"
    ? state.enabled ? "priority" : "default"
    : null;
  if (!reasoningEffort && !serviceTier) return false;

  let changed = false;
  const refreshedThread = (candidate) => {
    const next = {
      ...candidate,
      nextReasoningEffort: reasoningEffort ?? candidate.nextReasoningEffort,
      nextServiceTier: serviceTier ?? candidate.nextServiceTier,
      nextSettingsAtMs: nowMs
    };
    changed ||= next.nextReasoningEffort !== candidate.nextReasoningEffort
      || next.nextServiceTier !== candidate.nextServiceTier;
    return next;
  };
  threadSlots = threadSlots.map((candidate) => (
    candidate?.id === thread.id ? refreshedThread(candidate) : candidate
  ));
  if (primaryThreadRow?.id === thread.id) {
    primaryThreadRow = refreshedThread(primaryThreadRow);
  }
  // These values describe the next run and are intentionally invisible on the
  // current turn card. The caller already repaints the dedicated controls.
  return changed;
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
    nextReasoningEffort: null,
    nextServiceTier: undefined,
    nextSettingsAtMs: null,
    turnId: null,
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
      if (foundStart) return {
        ...lifecycle,
        serviceTier: lifecycle.serviceTier ?? "default",
        nextReasoningEffort: lifecycle.nextReasoningEffort ?? lifecycle.reasoningEffort,
        nextServiceTier: lifecycle.nextServiceTier ?? lifecycle.serviceTier ?? "default",
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
      cursor = start;
      searched += length;
    }
    consumeLifecycleLines([carry], lifecycle);
    return {
      ...lifecycle,
      status: lifecycle.status ?? "idle",
      serviceTier: lifecycle.serviceTier ?? "default",
      nextReasoningEffort: lifecycle.nextReasoningEffort ?? lifecycle.reasoningEffort,
      nextServiceTier: lifecycle.nextServiceTier ?? lifecycle.serviceTier ?? "default",
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
    nextReasoningEffort: null,
    nextServiceTier: "default",
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
      nextReasoningEffort: null,
      nextServiceTier: "default",
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
  if (activeComposerFocusLease?.targetThreadId === thread.id) {
    activeComposerFocusLease = {
      ...activeComposerFocusLease,
      parentId: activeComposerFocusLease.kind === "side-chat"
        ? thread.parentId
          ?? activeComposerFocusLease.parentId
          ?? sideChatParentById.get(thread.id)
          ?? null
        : null,
      thread: {
        ...(activeComposerFocusLease.thread ?? {}),
        ...thread,
        provisionalSideChat: false,
        provisionalNewThread: false
      }
    };
  }
  const changed = primaryThreadId !== thread.id;
  primaryThreadId = thread.id;
  if (options.recordOpenedHint !== false) {
    lastOpenedThreadId = thread.id;
    lastOpenedThreadAtMs = options.nowMs ?? Date.now();
  }
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
  if (options.refreshFastMode !== false) {
    const refresh = options.refreshFastModeAction ?? refreshFastMode;
    void refresh();
  }
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
  const microSideChatTitlesPromise = refreshMicroSideChatTitleCache();
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
  await resolvePendingNewThreadTarget(localRows, globalStatePromise);
  await microSideChatTitlesPromise;
  const sideChats = await readEphemeralSideChats(
    persistentIds,
    primaryThreadId ?? localRows[0]?.id ?? null,
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
    if (sideChatLifecycles.get(thread.id)?.status !== "closed") continue;
    sideChatParentById.delete(thread.id);
    sideChatTitleById.delete(thread.id);
    if (activeComposerFocusLease?.kind === "side-chat"
        && activeComposerFocusLease.targetThreadId === thread.id) {
      clearComposerFocusLease({ render: false });
    }
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
  currentThreadIdentityCandidates = currentCandidates;
  const detectedCurrentThread = await verifiedCurrentCodexThread(queueWindows, currentCandidates);
  const leasedCurrentThread = activeComposerFocusThread(currentCandidates);
  const currentThread = leasedCurrentThread ?? detectedCurrentThread;
  lastCurrentThreadSyncAtMs = Date.now();
  if (currentThread
      && !isProvisionalComposerThread(currentThread)
      && unreadCompletionByThreadId.has(currentThread.id)) {
    // `codex-current-thread` can describe Codex's internal selection while the
    // app is behind another window. Only a strict frontmost match proves the
    // user has actually viewed the completed task.
    const completionWasViewed = await threadIsFocused(currentThread);
    if (completionWasViewed) acknowledgeCompletion(currentThread.id, { render: false });
  }
  if (currentThread
      && !isProvisionalComposerThread(currentThread)
      && currentThread.id !== primaryThreadId) {
    rememberVerifiedThread(currentThread, {
      promote: false,
      recordOpenedHint: false,
      // `currentThread` is still the lightweight identity row here. Wait for
      // lifecycle/queue hydration below before seeding the next-run controls;
      // otherwise startup can race an empty composer probe against the final
      // Effort/Fast snapshot and leave those keys unbound.
      refreshFastMode: false
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
        : parentLifecycle?.serviceTier ?? "default",
      nextReasoningEffort: lifecycle.nextReasoningEffort
        ?? parentLifecycle?.nextReasoningEffort
        ?? lifecycle.reasoningEffort
        ?? parentLifecycle?.reasoningEffort
        ?? "medium",
      nextServiceTier: lifecycle.nextServiceTier
        ?? parentLifecycle?.nextServiceTier
        ?? lifecycle.serviceTier
        ?? parentLifecycle?.serviceTier
        ?? "default",
      nextSettingsAtMs: lifecycle.nextSettingsAtMs
        ?? parentLifecycle?.nextSettingsAtMs
        ?? null
    };
  });
  const queuedThreads = applyQueueState(hydratedThreads, queueWindows);
  const goalThreads = attachGoalsToThreads(queuedThreads, goalSnapshot);
  // Refresh the cached current row from the same lifecycle/queue/goal snapshot
  // while returning the ranked list without promotion.
  primaryFirstThreadRows(goalThreads, goalThreads, THREAD_COUNT + 1);
  const goalById = new Map(goalThreads.map((thread) => [thread.id, thread]));
  const leasedHydratedThread = activeComposerFocusThread(goalThreads);
  return {
    threads: rankedThreadIds.map((id) => goalById.get(id)).filter(Boolean),
    currentThread: leasedHydratedThread
      ?? (primaryThreadId ? goalById.get(primaryThreadId) ?? null : null)
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
  completionDismissFadeByThreadId.delete(threadId);
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
    // Guarantee one acknowledgement frame on every visible plugin-owned key,
    // then update all keys together at a smooth, device-safe cadence. Keeping
    // one synchronized render group prevents adjacent keys from visibly
    // stepping through different phases of the same completion breath.
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

function threadReasoningTrackShouldAnimate(thread) {
  return thread?.status === "working"
    && (
      isFastServiceTier(thread.serviceTier)
      || normalizedReasoningEffort(thread.reasoningEffort) === "ultra"
      || reasoningProgressTransitionActive("thread", thread.id)
      || reasoningParticleTransitionActive("thread", thread.id)
    );
}

function reasoningControlShouldAnimate(
  state = fastModeState,
  activeThreadId = currentControlThreadId()
) {
  const visualEffort = reasoningVisualOverrideByThreadId.get(activeThreadId)?.effort;
  return Boolean(activeThreadId)
    && state?.threadId === activeThreadId
    && (
      state.enabled === true
      || normalizedReasoningEffort(visualEffort ?? state.reasoningEffort) === "ultra"
      || reasoningProgressTransitionActive("control", activeThreadId)
      || reasoningParticleTransitionActive("control", activeThreadId)
    );
}

function renderAnimatedThreadContexts(nowMs = Date.now()) {
  const unreadFrameDue = nowMs - lastUnreadCompletionFrameAtMs
    >= UNREAD_COMPLETION_FRAME_INTERVAL_MS;
  const unreadRenderGroup = unreadCompletionRenderGroup;
  let hasVisibleUnreadCompletion = false;
  let threadContextIndex = 0;
  const visibleThreadIds = new Set();
  const expiredDismissFadeThreadIds = new Set();
  for (const [context, action] of contexts) {
    const slot = THREAD_SLOT_BY_ACTION.get(action);
    const thread = slot === undefined ? null : threadForSlot(slot);
    if (slot === undefined) continue;
    if (thread?.id) visibleThreadIds.add(thread.id);
    const completionStartedAtMs = thread?.id ? completionPulseStartedAt.get(thread.id) : null;
    const completionAnimating = Number.isFinite(completionStartedAtMs)
      && nowMs - completionStartedAtMs < THREAD_COMPLETION_PULSE_DURATION_MS;
    const unreadAnimating = thread?.status === "completed"
      && unreadCompletionByThreadId.has(thread.id);
    const dismissFade = thread?.id ? completionDismissFadeByThreadId.get(thread.id) : null;
    const dismissAnimating = thread?.status === "completed"
      && Number.isFinite(dismissFade?.startedAtMs)
      && nowMs - dismissFade.startedAtMs < UNREAD_COMPLETION_DISMISS_FADE_MS;
    if (unreadAnimating) hasVisibleUnreadCompletion = true;
    const renderUnreadFrame = unreadAnimating
      && unreadFrameDue
      && threadContextIndex % UNREAD_COMPLETION_GROUP_COUNT === unreadRenderGroup;
    if (
      threadReasoningTrackShouldAnimate(thread)
      || completionAnimating
      || dismissAnimating
      || renderUnreadFrame
    ) {
      setImage(context, threadSvg(thread, slot));
    } else if (dismissFade) {
      expiredDismissFadeThreadIds.add(thread.id);
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
  for (const threadId of expiredDismissFadeThreadIds) {
    completionDismissFadeByThreadId.delete(threadId);
  }
  for (const [threadId, fade] of completionDismissFadeByThreadId) {
    if (visibleThreadIds.has(threadId)) continue;
    if (nowMs - fade.startedAtMs >= UNREAD_COMPLETION_DISMISS_FADE_MS) {
      completionDismissFadeByThreadId.delete(threadId);
    }
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
        const primaryThreadIdAtRefreshStart = primaryThreadId;
        const controlThreadIdAtRefreshStart = fastModeState.threadId;
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
        if (!Array.isArray(snapshot)
            && snapshot?.currentThread?.id
            && !isProvisionalComposerThread(snapshot.currentThread)) {
          // The returned current row is authoritative and fully hydrated. Do
          // not rely on a reader's incidental global mutation: custom readers,
          // a cold plugin process, and a fast willAppear sequence all need the
          // same explicit binding from Current Task to its dependent controls.
          rememberVerifiedThread(snapshot.currentThread, {
            promote: false,
            recordOpenedHint: false,
            refreshFastMode: false
          });
        }
        const nextCurrentThread = currentThreadForDisplay(nextThreadSlots, primaryThreadRow);
        trackCompletionTransitions(
          previousVisibleThreads,
          combinedVisibleThreads(nextCurrentThread, nextThreadSlots)
        );
        threadSlots = nextThreadSlots;
        renderThreadContexts();
        const composerThread = nextCurrentThread ?? primaryThreadRow;
        const snapshotComposerState = fastModeStateFromThread(
          composerThread,
          fastModeState
        );
        const composerStateChanged = snapshotComposerState.threadId !== fastModeState.threadId
          || snapshotComposerState.enabled !== fastModeState.enabled
          || snapshotComposerState.available !== fastModeState.available
          || snapshotComposerState.reasoningEffort !== fastModeState.reasoningEffort
          || snapshotComposerState.failed !== fastModeState.failed;
        const controlThreadId = currentControlThreadId();
        const composerInputIsIdle = !activeFastModeUpdate
          && !reasoningPendingCountByThreadId.has(controlThreadId);
        const currentControlBindingChanged = primaryThreadIdAtRefreshStart !== primaryThreadId
          || controlThreadIdAtRefreshStart !== fastModeState.threadId;
        if (composerInputIsIdle && composerStateChanged) {
          fastModeRevision += 1;
          fastModeState = snapshotComposerState;
        }
        if (composerInputIsIdle
            && (composerStateChanged || currentControlBindingChanged)) {
          // Effort/Fast may have appeared before the first thread refresh. A
          // binding change must repaint every current-task control even when
          // rememberVerifiedThread already seeded an identical state object.
          renderStaticContexts();
        }
        if (composerInputIsIdle
            && !isProvisionalComposerThread(composerThread)
            && composerStateNeedsRefreshForThread(controlThreadId, fastModeState)) {
          void refreshFastMode({ quiet: true, preserveConfirmedOnUnavailable: true });
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

function knownThreadById(threadId) {
  if (!threadId) return null;
  return currentThreadIdentityCandidates.find((thread) => thread?.id === threadId)
    ?? threadSlots.find((thread) => thread?.id === threadId)
    ?? (primaryThreadRow?.id === threadId ? primaryThreadRow : null)
    ?? sideChatRowsCache.find((thread) => thread?.id === threadId)
    ?? null;
}

async function performListedSideChatNavigation(thread, slot, options = {}) {
  const signal = options.signal ?? null;
  const focusSideChatComposer = options.focusSideChatComposer
    ?? (() => runKeyBridgeAwaited(
      "codex-focus-side-chat-composer",
      null,
      { quiet: true }
    ));
  const sideChatFocused = options.sideChatFocused
    ?? ((focusedOptions = {}) => threadIsFocused(thread, focusedOptions));
  // If the requested Side Chat is already paired with its parent, focusing its
  // right-hand composer is both faster and less disruptive than replaying any
  // navigation UI.
  if (await focusSideChatComposer()
      && await sideChatFocused({ signal, probe: options.focusProbe })) return true;

  // A Side Chat can already be mounted in Codex's tab strip even when another
  // browser-use or Side Chat tab is selected. Select that exact renderer tab
  // before replaying the parent deep link; reopening the parent can otherwise
  // tear down the tab strip just before the activation attempt.
  const activateMountedSideChat = options.activateMountedSideChat
    ?? (async () => {
      const openApp = options.openApp
        ?? (() => execFileAsync("/usr/bin/open", ["-b", "com.openai.codex"], {
          timeout: 5000,
          signal
        }));
      const waitFrontmost = options.waitFrontmost
        ?? (() => execFileAsync(KEY_BRIDGE, ["codex-wait-frontmost"], {
          timeout: 3000,
          maxBuffer: 4096,
          signal
        }));
      await openApp();
      throwIfAborted(signal);
      await waitFrontmost();
      throwIfAborted(signal);
      try {
        const result = await codexMicroBridge.focusSideChat(thread.id, {
          mountTimeoutMs: 180,
          selectionTimeoutMs: 650,
          restoreRetained: false
        });
        return {
          backend: "micro",
          identityVerified: result?.threadId === thread.id && result?.selected === true
        };
      } catch (error) {
        if (error?.delivery === "unknown") throw error;
        return null;
      }
    });
  try {
    const activation = await activateMountedSideChat();
    throwIfAborted(signal);
    if (activation?.identityVerified === true && await focusSideChatComposer()) return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    // An unconfirmed renderer click is still verified once through the visible
    // composer before any parent navigation is allowed to replace the view.
    if (await focusSideChatComposer()
        && await sideChatFocused({ signal, probe: options.focusProbe })) return true;
  }

  const parentId = thread.parentId ?? sideChatParentById.get(thread.id) ?? null;
  const parent = options.parentThread ?? knownThreadById(parentId);
  if (!parent?.id) throw new Error("Side Chat parent task was not found");
  const navigateParent = options.navigateParent
    ?? ((parentThread, parentSlot, navigationOptions) => parentThread.remote
      ? performRemoteNavigation(parentThread, parentSlot, navigationOptions)
      : performDeepLinkNavigation(parentThread, parentSlot, navigationOptions));
  await navigateParent(parent, slot, { ...options, signal });
  throwIfAborted(signal);

  const fingerprints = [...titleFingerprints(thread.title)];
  const activateSideChat = options.activateSideChat
    ?? (async () => {
      try {
        const result = await codexMicroBridge.focusSideChat(thread.id);
        codexControlPlane.noteMicroSuccess();
        return {
          backend: "micro",
          identityVerified: result?.threadId === thread.id && result?.selected === true
        };
      } catch (error) {
        codexControlPlane.noteMicroFailure(error);
        if (!definiteMicroFallback(error)) throw error;
      }
      try {
        await execFileAsync(
          KEY_BRIDGE,
          ["codex-open-side-chat", thread.id, ...fingerprints],
          { timeout: 3000, maxBuffer: 32 * 1024, signal }
        );
        return { backend: "legacy", identityVerified: false };
      } catch (error) {
        throw new Error("Side Chat tab activation failed", { cause: error });
      }
    });
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleepWithSignal(REMOTE_APP_ACTIVATION_RETRY_MS, signal);
    try {
      const activation = await activateSideChat();
      throwIfAborted(signal);
      if (!await focusSideChatComposer()) {
        throw new Error("Side Chat composer did not become visible");
      }
      if (activation?.identityVerified === true) return true;
      if (await sideChatFocused({ signal, probe: options.focusProbe })) return true;
      lastError = new Error("Side Chat tab did not become focused");
    } catch (error) {
      if (isAbortError(error) || keyBridgeExitCode(error) === 3) throw error;
      lastError = error;
    }
  }
  throw new Error("Side Chat could not be restored beside its parent", { cause: lastError });
}

function navigateListedSideChat(thread, slot, options = {}) {
  if (activeFastModeUpdate) {
    return afterFastModeUpdate(() => navigateListedSideChat(thread, slot, options));
  }
  activeComposerCreation?.controller.abort();
  if (activeDeepLinkNavigation?.threadId === thread.id
      && !activeDeepLinkNavigation.controller.signal.aborted) {
    return activeDeepLinkNavigation.promise;
  }
  activeRemoteNavigation?.controller.abort();
  activeDeepLinkNavigation?.controller.abort();
  const controller = new AbortController();
  const navigation = {
    threadId: thread.id,
    controller,
    promise: null
  };
  navigation.promise = performListedSideChatNavigation(thread, slot, {
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
  const permissionCommand = thread.remote ? "codex-open-thread" : "codex-current-thread";
  pendingSideChatTarget = null;
  feedback(context, "loading", "여는 중");
  const remoteNavigation = options.navigateRemote ?? navigateRemoteThread;
  const deepLinkNavigation = options.navigateDeepLink ?? navigateDeepLinkThread;
  const remember = options.rememberThread ?? rememberVerifiedThread;
  const acknowledge = options.acknowledgeCompletion ?? acknowledgeCompletion;
  const focusThreadComposer = options.focusThreadComposer
    ?? (() => focusCurrentComposer(context));
  const scheduleRefresh = options.scheduleRefresh
    ?? (() => setTimeout(() => void refreshThreads(), 1000));
  try {
    const productionNavigation = !options.navigateRemote && !options.navigateDeepLink;
    if (productionNavigation && options.useMicro !== false) {
      const microResult = await codexControlPlane.execute("task-switch", {
        micro: async (bridge, cachedSnapshot) => {
          await bridge.openThread(thread.id, { snapshot: cachedSnapshot ?? undefined });
          return verifyAfterMicroDelivery(async () => {
            let snapshot = null;
            for (const delayMs of MICRO_TASK_SWITCH_VERIFY_DELAYS_MS) {
              await sleepWithSignal(delayMs);
              snapshot = await bridge.refreshReadOnly();
              const confirmed = confirmedMicroThreadSnapshot(snapshot, thread.id);
              if (confirmed) return confirmed;
            }
            throw new Error("Codex Micro task switch was delivered but not confirmed");
          }, "task switch verification");
        }
      }, { quiet: true });
      if (microResult.backend === "micro") {
        if (!microResult.ok) {
          feedback(context, "error", "전환 확인", 1600);
          return false;
        }
        acknowledge(thread.id, { render: false });
        clearComposerFocusLease({ render: false });
        remember(thread, { refreshFastMode: false });
        applyMicroReadOnlySnapshot(microResult.value, { promote: true });
        feedback(context, "success", thread.remote ? "원격 전환" : "전환 완료");
        scheduleRefresh();
        runtimeTrace("thread-navigation", {
          slot: slot + 1,
          remote: Boolean(thread.remote),
          strategy: "micro",
          result: "success"
        });
        return true;
      }
      if (microResult.ambiguous) {
        feedback(context, "error", "전환 확인", 1600);
        return false;
      }
    }
    if (productionNavigation
        && !ensureCommandPermissions(permissionCommand, context)) return false;
    if (thread.remote) {
      await remoteNavigation(thread, slot);
      acknowledge(thread.id, { render: false });
      clearComposerFocusLease({ render: false });
      remember(thread);
      if (!await focusThreadComposer()) {
        throw new Error("Codex thread composer was not focused");
      }
      noteBridgeSuccess(permissionCommand);
      feedback(context, "success", "원격 전환");
      scheduleRefresh();
      return true;
    }
    await deepLinkNavigation(thread, slot);
    acknowledge(thread.id, { render: false });
    clearComposerFocusLease({ render: false });
    remember(thread);
    if (!await focusThreadComposer()) {
      throw new Error("Codex thread composer was not focused");
    }
    noteBridgeSuccess(permissionCommand);
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
    const permissionFailure = exitCode === 3 || thread.titleAmbiguous
      ? false
      : noteBridgeFailure(permissionCommand, error, context);
    const label = thread.remote
      ? exitCode === 3 || thread.titleAmbiguous ? "제목 중복" : "원격 확인"
      : "열기 실패";
    if (!permissionFailure) feedback(context, "error", label, thread.remote ? 1800 : undefined);
    console.error(`Could not open Codex ${thread.remote ? "remote " : ""}thread: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

async function openListedSideChat(context, thread, options = {}) {
  const feedback = options.feedback ?? showFeedback;
  const clear = options.clearFeedback ?? clearFeedback;
  const navigate = options.navigateSideChat
    ?? options.navigateDeepLink
    ?? navigateListedSideChat;
  const remember = options.rememberThread ?? rememberVerifiedThread;
  const acknowledge = options.acknowledgeCompletion ?? acknowledgeCompletion;
  const focusSideChatComposer = options.focusSideChatComposer
    ?? (() => focusCurrentComposer(context));
  const scheduleRefresh = options.scheduleRefresh
    ?? (() => setTimeout(() => void refreshThreads(), 1000));
  pendingSideChatTarget = null;
  feedback(context, "loading", "사이드챗 열기");
  try {
    // Never deep-link the ephemeral conversation itself: that replaces the
    // paired workspace with a Side-Chat-only view. Restore its parent task,
    // activate the exact upper-right tab, and focus that tab's composer.
    const slot = Math.max(0, threadSlots.findIndex((candidate) => candidate?.id === thread.id));
    await navigate(thread, slot);
    acknowledge(thread.id, { render: false });
    activateSideChatFocusLease({
      requestedAtMs: thread.createdAtMs ?? Date.now(),
      parentId: thread.parentId ?? sideChatParentById.get(thread.id) ?? null,
      targetThreadId: thread.id,
      thread,
      render: false
    });
    remember(thread);
    if (!await focusSideChatComposer()) {
      throw new Error("Side Chat composer was not focused");
    }
    noteBridgeSuccess("codex-open-side-chat");
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
    const permissionFailure = noteBridgeFailure("codex-open-side-chat", error, context);
    if (!permissionFailure) feedback(context, "error", "열기 실패");
    console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
    return false;
  }
}

function beginComposerCreation(kind, operation) {
  activeRemoteNavigation?.controller.abort();
  activeDeepLinkNavigation?.controller.abort();
  activeComposerCreation?.controller.abort();
  const controller = new AbortController();
  let resolveComposerReady;
  const composerReadyPromise = new Promise((resolve) => {
    resolveComposerReady = resolve;
  });
  const creation = {
    kind,
    controller,
    promise: null,
    composerReadyPromise,
    composerReadySettled: false,
    requestedAtMs: null,
    targetThreadId: null,
    focusedThread: null,
    markComposerReady(value) {
      if (creation.composerReadySettled) return false;
      creation.composerReadySettled = true;
      resolveComposerReady(value || null);
      return true;
    }
  };
  creation.promise = Promise.resolve()
    .then(() => operation(controller.signal, creation))
    .finally(() => {
      creation.markComposerReady(null);
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
  const synchronizeCurrent = options.synchronizeCurrent ?? synchronizeCurrentCodexThread;
  const readGlobalState = options.readGlobalState ?? readGlobalStateSnapshot;
  const readKnownThreadIds = options.readKnownThreadIds ?? readPersistentThreadIds;
  const scheduleRefreshes = options.scheduleRefreshes
    ?? ((requestedAtMs) => {
      for (const delayMs of SIDE_CHAT_TARGET_REFRESH_DELAYS_MS) {
        setTimeout(() => {
          if (activeComposerFocusLease?.kind !== "new-thread"
              || activeComposerFocusLease.requestedAtMs !== requestedAtMs
              || activeComposerFocusLease.targetThreadId) return;
          void refreshThreads();
        }, delayMs);
      }
    });
  const createNewTask = options.createNewTask
    ?? (async (projectContext) => {
      const fallbackCommand = projectContext?.inProject === false
        ? "new-thread"
        : "new-project-thread";
      if (options.bridge || projectContext?.inProject === false) {
        return bridge(fallbackCommand, context);
      }
      const result = await codexControlPlane.execute("new-task", {
        micro: (micro) => micro.newTask(),
        legacy: () => bridge(fallbackCommand, context)
      }, { quiet: true });
      runtimeTrace("control-plane", {
        strategy: result.backend,
        result: result.ok ? "success" : "failed"
      });
      return result.ok;
    });
  return beginComposerCreation("new-thread", async (signal, creation) => {
    try {
      pendingSideChatTarget = null;
      const requestedAtMs = options.nowMs ?? Date.now();
      creation.requestedAtMs = requestedAtMs;
      const currentThread = await synchronizeCurrent({
        force: true,
        quiet: true,
        signal,
        refreshFastMode: false
      });
      throwIfAborted(signal);
      let globalState = {};
      try {
        globalState = await readGlobalState();
      } catch {
        // The state file is atomically rewritten by Codex. An unknown scope
        // still uses the native context-aware New Chat command below.
      }
      const projectContext = options.projectContext
        ?? threadProjectContextFromState(currentThread, globalState);
      let knownIds = new Set();
      try {
        knownIds = await readKnownThreadIds();
      } catch {
        knownIds = new Set(currentThreadIdentityCandidates.map((thread) => thread?.id).filter(Boolean));
      }
      lastOpenedThreadId = null;
      lastOpenedThreadAtMs = null;
      await openApp(signal);
      throwIfAborted(signal);
      await sleep(350, signal);
      throwIfAborted(signal);
      if (!await createNewTask(projectContext)) return false;
      clearComposerFocusLease({ render: false });
      activateNewThreadFocusLease({
        requestedAtMs,
        sourceThreadId: currentThread?.id ?? primaryThreadId ?? null,
        sourceThread: currentThread,
        projectContext,
        knownIds
      });
      creation.markComposerReady({ requestedAtMs });
      scheduleRefreshes(requestedAtMs);
      runtimeTrace("new-thread-focus", {
        result: "provisional",
        scope: projectContext?.inProject === true
          ? "project"
          : projectContext?.inProject === false
            ? "standalone"
            : "native-context"
      });
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
  const createSideChat = options.createSideChat
    ?? (options.bridge
      ? async () => bridge("side-chat", context)
      : async () => {
        const result = await codexControlPlane.execute("side-chat", {
          micro: (micro) => micro.openSideChat(),
          legacy: () => bridge("side-chat", context)
        }, { quiet: true });
        runtimeTrace("control-plane", {
          strategy: result.backend,
          result: result.ok ? "success" : "failed"
        });
        return result.ok;
      });
  const scheduleRefreshes = options.scheduleRefreshes ?? scheduleSideChatTargetRefreshes;
  const feedback = options.feedback ?? showFeedback;
  const synchronizeCurrent = options.synchronizeCurrent ?? synchronizeCurrentCodexThread;
  const waitFocused = options.waitFocused ?? waitForPendingSideChatFocus;
  const waitComposerReady = options.waitComposerReady ?? waitForPendingSideChatComposerReady;
  const focusSideChatComposer = options.focusSideChatComposer
    ?? (() => runKeyBridgeAwaited(
      "codex-focus-side-chat-composer",
      context,
      { quiet: true }
    ));
  return beginComposerCreation("side-chat", async (signal, creation) => {
    let composerReadyFeedbackShown = false;
    try {
      pendingSideChatTarget = null;
      feedback(context, "loading", "사이드챗 전환");
      const requestedAtMs = options.nowMs ?? Date.now();
      creation.requestedAtMs = requestedAtMs;
      const currentThread = await synchronizeCurrent({
        force: true,
        quiet: true,
        signal,
        refreshFastMode: false
      });
      throwIfAborted(signal);
      lastOpenedThreadId = null;
      lastOpenedThreadAtMs = null;
      await openApp(signal);
      throwIfAborted(signal);
      await sleep(350, signal);
      throwIfAborted(signal);
      if (!await createSideChat()) return false;
      const parentId = currentThread?.ephemeral
        ? currentThread.parentId
          ?? (activeComposerFocusLease?.kind === "side-chat"
            ? activeComposerFocusLease.parentId
            : null)
          ?? null
        : currentThread?.id ?? primaryThreadId ?? null;
      pendingSideChatTarget = {
        requestedAtMs,
        knownIds: new Set(knownSideChatIds),
        parentId,
        targetThreadId: null
      };
      activateSideChatFocusLease({
        requestedAtMs,
        parentId,
        parentThread: currentThread?.ephemeral ? null : currentThread
      });
      scheduleRefreshes(requestedAtMs);
      void Promise.resolve(waitComposerReady(requestedAtMs, {
        signal,
        sleep,
        focusComposer: focusSideChatComposer
      })).then((ready) => {
        if (ready) {
          creation.markComposerReady(ready);
          composerReadyFeedbackShown = true;
          feedback(context, "success", "사이드챗 준비");
        }
      }).catch((error) => {
        if (!isAbortError(error)) {
          console.error(
            `Could not prepare provisional Side Chat composer: ${error?.message ?? "unknown error"}`
          );
        }
      });
      const focusedSideChat = await waitFocused(requestedAtMs, {
        signal,
        sleep,
        focusProbe: options.focusProbe
      });
      throwIfAborted(signal);
      if (!focusedSideChat?.id) throw new Error("new Side Chat focus was not confirmed");
      promoteSideChatFocusLease(focusedSideChat, { render: false });
      creation.targetThreadId = focusedSideChat.id;
      creation.focusedThread = focusedSideChat;
      bindPendingVoiceContextsToThread(focusedSideChat.id, Date.now(), requestedAtMs);
      creation.markComposerReady({
        requestedAtMs,
        targetThreadId: focusedSideChat.id
      });
      if (!composerReadyFeedbackShown) feedback(context, "success", "사이드챗 준비");
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        clearFeedback(context);
        return false;
      }
      feedback(context, "error", "전환 실패");
      console.error(`Could not open Codex side chat: ${error?.message ?? "unknown error"}`);
      return false;
    }
  });
}

function visibleActionsForDevice(device) {
  const actions = [];
  for (const [context, action] of contexts) {
    if (contextDeviceIds.get(context) === device) actions.push(action);
  }
  return actions;
}

function switchProfilePage(context, device, action, settings = {}) {
  if (!device) return false;
  const target = resolveProfilePageTarget(action, settings, visibleActionsForDevice(device));
  if (!target) {
    runtimeTrace("page-navigation", { phase: "resolve", result: "failed" });
    showFeedback(context, "error", t("feedback.stateCheck"));
    console.warn("Could not identify the visible ThreadDeck profile page; navigation was not sent.");
    return false;
  }

  const message = {
    event: "switchToProfile",
    // switchToProfile is a plugin-level command; Stream Deck rejects an
    // action-instance context here even though key events provide one.
    context: pluginUUID,
    device,
    payload: {
      profile: DISTRIBUTED_PROFILE_NAME,
      page: target.page
    }
  };
  send(message);
  runtimeTrace("page-navigation", {
    phase: action === ACTIONS.pagePrevious ? "previous" : "next",
    result: String(target.page)
  });
  return true;
}

function registerPlugin() {
  if (!port || !pluginUUID || !registerEvent) process.exit(1);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.addEventListener("open", () => {
    send({ event: registerEvent, uuid: pluginUUID });
    for (const device of frameDeviceInfoById.values()) {
      const policy = framePolicyForDevice(device, { deviceId: device.id });
      runtimeTrace("image-delivery-policy", {
        phase: "registered",
        result: `${policy.profile}:${policy.aggregateFps}`
      });
    }
    // The watcher never launches Codex and preserves the Codex generation that
    // was already open when ThreadDeck first gained this backend. A later
    // normal Codex launch can be recovered once with a loopback-only bridge.
    void codexMicroBootstrap.start();
    // Prime the only synchronous permission check before the first hardware
    // press. This keeps first-use remote switching and push-to-talk responsive.
    primeAccessibilityTrust();
    // Codex exposes the user's visible effort levels in its read-only desktop
    // configuration and model cache. Prime them before the first Effort tap so
    // every hardware press can paint its next level immediately.
    void refreshReasoningOptionCatalog();
    // Read-only renderer discovery never activates a Micro device or changes
    // Codex state. It lets the first current-task control use the exact active
    // conversation when Codex was launched with the optional loopback bridge.
    void refreshMicroReadOnly({ force: true, quiet: true });
    // CodexBar takes several seconds on a cold request. Prime the cache while
    // the current Stream Deck page is rendering so the usage page can appear
    // with a value immediately.
    void refreshUsage();
  });

  socket.addEventListener("close", () => {
    imageDeliveryQueue.clear();
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

    if (message.event === "deviceDidConnect" || message.event === "deviceDidChange") {
      const device = updateFrameDeviceInfo(message.device, message.deviceInfo);
      if (device) {
        imageDeliveryQueue.resetLane(device.id);
        const policy = framePolicyForDevice(device, { deviceId: device.id });
        runtimeTrace("image-delivery-policy", {
          phase: message.event === "deviceDidConnect" ? "connected" : "changed",
          result: `${policy.profile}:${policy.aggregateFps}`
        });
      }
    } else if (message.event === "deviceDidDisconnect") {
      const deviceId = String(message.device ?? "");
      if (deviceId) {
        frameDeviceInfoById.delete(deviceId);
        imageDeliveryQueue.resetLane(deviceId);
      }
      runtimeTrace("image-delivery-policy", { phase: "disconnected", result: "reset" });
    }

    if (["willAppear", "willDisappear", "keyDown", "keyUp"].includes(message.event)) {
      runtimeTrace("streamdeck-event", {
        phase: message.event,
        result: String(message.action ?? "unknown").split(".").pop()
      });
    }

    if (message.event === "willAppear" && Object.values(ACTIONS).includes(message.action)) {
      contexts.set(message.context, message.action);
      if (message.device) contextDeviceIds.set(message.context, message.device);
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
        if (message.action === ACTIONS.fastMode
            || message.action === ACTIONS.reasoning) {
          void refreshFastMode({ quiet: true });
        }
      }
      if (permissionIssue) alertPermissionContext(message.context);
      else if (microBridgeIssue && isMicroControlAction(message.action)) {
        alertMicroBridgeContext(message.context);
      }
    } else if (message.event === "willDisappear") {
      cancelCurrentVoicePress(message.context, false);
      // A task-key hold owns both the voice release and its media lease. Let
      // that press state perform one gated teardown; calling the generic media
      // cleanup afterwards could otherwise bypass a failed voice-up.
      if (threadPressByContext.get(message.context)?.voiceStarted) {
        cancelThreadPress(message.context, true);
      } else {
        void endVoiceHold(message.context, false);
        cancelThreadPress(message.context, false);
      }
      cancelVoiceTranscription(message.context);
      cancelSendPress(message.context);
      cancelFastModePress(message.context);
      reasoningBusyContexts.delete(message.context);
      voiceStateByContext.delete(message.context);
      voiceSessionIdByContext.delete(message.context);
      contexts.delete(message.context);
      contextDeviceIds.delete(message.context);
      contextImages.delete(message.context);
      contextSentImages.delete(message.context);
      imageDeliveryQueue.remove(message.context);
      contextFeedback.delete(message.context);
      permissionAlertedContexts.delete(message.context);
      microBridgeAlertedContexts.delete(message.context);
    } else if (message.event === "keyDown" && contexts.has(message.context)) {
      const action = contexts.get(message.context);
      if (action === ACTIONS.voice && !voiceHeldContexts.has(message.context)) {
        beginCurrentVoicePress(message.context);
      } else if (action === ACTIONS.send) {
        beginSendPress(message.context);
      } else if (action === ACTIONS.fastMode) {
        beginFastModePress(message.context);
      } else if (action === ACTIONS.reasoning) {
        beginFastModePress(message.context);
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
        endCurrentVoicePress(message.context);
      } else if (action === ACTIONS.send) {
        void endSendPress(message.context);
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
        void endFastModePress(message.context);
      } else if (action === ACTIONS.reasoning) {
        void endReasoningControlPress(message.context);
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
    if (!globalCompletionPulseState(nowMs)
        && [...contexts.values()].some((action) => action === ACTIONS.reasoning)
        && reasoningControlShouldAnimate()) {
      renderFastModeContexts();
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
    // The full three-second refresh also scans lifecycle, queue, goal, and
    // remote metadata. This lightweight observer only reconciles Codex's
    // active window so a manual in-app task switch reaches the Dashboard in
    // under a second and every current-task control shares that identity.
    if (!hasLoadedThreadState || !dashboardCurrentActionsVisible()) return;
    if (activeRemoteNavigation || activeDeepLinkNavigation || activeComposerCreation
        || activeFastModeUpdate || voiceHeldContexts.size > 0) return;
    void synchronizeCurrentCodexThread({
      quiet: true,
      refreshFastMode: false
    }).then((current) => {
      if (!current?.id || current.id !== currentControlThreadId()) return false;
      if (activeRemoteNavigation || activeDeepLinkNavigation || activeComposerCreation
          || activeFastModeUpdate || voiceHeldContexts.size > 0) return false;
      // The closed Codex composer exposes Effort without opening its picker.
      // Poll it only for the verified current task so direct in-app changes
      // reach the dedicated key quickly. This updates next-turn controls only;
      // the running task card remains bound to its immutable turn_context.
      return refreshFastMode({
        threadId: current.id,
        quiet: true,
        preserveConfirmedOnUnavailable: true
      });
    }).catch(() => false);
  }, CURRENT_THREAD_SYNC_INTERVAL_MS);

  setInterval(() => {
    // Keep the cached value warm on every ThreadDeck page, not only after the
    // usage key has appeared. This removes the multi-second page-switch wait.
    if (contexts.size > 0) void refreshUsage();
  }, 60_000);

  setInterval(() => {
    if (contexts.size > 0) void refreshAppearance();
  }, 2000);

  setInterval(() => {
    if (contexts.size > 0) {
      void refreshPermissionHealth({ promptIfMissing: true });
    }
  }, PERMISSION_MONITOR_INTERVAL_MS);

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
  completionDismissFadeByThreadId.clear();
  completionQueueBarrierMsByThreadId.clear();
  pendingCompletionByThreadId.clear();
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceStateByContext.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  voiceBackendByContext.clear();
  sendLongPressArmedContexts.clear();
  fastModeLongPressArmedContexts.clear();
  cancelReasoningInputBatches();
  reasoningBusyContexts.clear();
  reasoningAvailableEffortsByThreadId.clear();
  reasoningPowerSelectionsByThreadId.clear();
  reasoningVisualOverrideByThreadId.clear();
  reasoningProgressTransitionByKey.clear();
  reasoningParticleMotionByKey.clear();
  reasoningPendingCountByThreadId.clear();
  reasoningPendingCountByContext.clear();
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
  const keyRadius = 22;
  const width = margin * 2 + keySize * 4 + gap * 3;
  const height = margin * 2 + keySize * 2 + gap;
  const keyPositions = keySvgs.map((svg, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = margin + column * (keySize + gap);
    const y = margin + row * (keySize + gap);
    return { svg, index, x, y };
  });
  const clips = keyPositions.map(({ index, x, y }) => (
    `<clipPath id="demoKeyClip${index}"><rect x="${x}" y="${y}" width="${keySize}" height="${keySize}" rx="${keyRadius}"/></clipPath>`
  )).join("\n    ");
  const images = keyPositions.map(({ svg, index, x, y }) => {
    const data = Buffer.from(svg).toString("base64");
    return `<image x="${x}" y="${y}" width="${keySize}" height="${keySize}" clip-path="url(#demoKeyClip${index})" href="data:image/svg+xml;base64,${data}"/>`;
  }).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    ${clips}
  </defs>
  <rect width="${width}" height="${height}" rx="34" fill="#2F2F2F"/>
  ${images}
</svg>\n`;
}

function demoKeySvgs(nowMs, elapsedMs = 0, animated = false) {
  fixedRenderTimeMs = nowMs;
  const completionStartMs = DEMO_EPOCH_MS + 4_700;
  const hasCompleted = animated && elapsedMs >= 4_700;
  const queueCount = animated && elapsedMs >= 4_000 ? 2 : 3;
  const reasoningEffort = !animated || elapsedMs >= 1_800
    ? "ultra"
    : elapsedMs >= 1_200
      ? "max"
      : elapsedMs >= 600
        ? "high"
        : "medium";
  const fastEnabled = !animated || elapsedMs >= 2_700;
  const fastArmed = animated && elapsedMs >= 2_100 && elapsedMs < 2_700;
  const reasoningBusy = animated && (elapsedMs < 1_900 || fastArmed);
  let voiceState = "idle";
  if (animated && elapsedMs >= 3_000 && elapsedMs < 3_700) voiceState = "recording";
  else if (animated && elapsedMs >= 3_700 && elapsedMs < 4_100) voiceState = "transcribing";
  else if (animated && elapsedMs >= 4_100 && elapsedMs < 4_400) voiceState = "submitting";
  else if (animated && elapsedMs >= 4_400 && elapsedMs < 4_700) voiceState = "sent";

  if (hasCompleted) {
    completionPulseStartedAt.set(DEMO_WORKING_ID, completionStartMs);
    globalCompletionStartedAtMs = completionStartMs;
    globalCompletionThreadId = DEMO_WORKING_ID;
  }

  const workingThread = {
    id: DEMO_WORKING_ID,
    title: "Release",
    pinned: true,
    status: hasCompleted ? "completed" : "working",
    startedAtMs: DEMO_EPOCH_MS - 4 * 60_000 - 12_000,
    endedAtMs: hasCompleted ? completionStartMs : null,
    activity: hasCompleted
      ? { kind: "complete", label: "작업 완료" }
      : elapsedMs >= 2_550
        ? { kind: "inspect", label: "코드 검증" }
        : { kind: "edit", label: "코드 수정" },
    reasoningEffort,
    serviceTier: fastEnabled ? "priority" : "default",
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
    newThreadSvg(),
    sideChatSvg(),
    sendSvg(),
    workingThreadSvg,
    reasoningControlSvg({
      threadId: DEMO_WORKING_ID,
      enabled: fastEnabled,
      available: true,
      reasoningEffort,
      failed: false
    }, DEMO_WORKING_ID, reasoningEffort === "ultra" ? "down" : "up", reasoningBusy),
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
  resetDemoEffects();
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
    title: "Docs ready",
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
  const framesPerSecond = 20;
  const durationMs = 6_000;
  const frameCount = durationMs / 1000 * framesPerSecond;
  fsSync.mkdirSync(resolvedDirectory, { recursive: true });
  for (const entry of fsSync.readdirSync(resolvedDirectory)) {
    if (/^frame-\d{3}\.svg$/.test(entry)) fsSync.unlinkSync(path.join(resolvedDirectory, entry));
  }
  // Keep interpolation state across frames. Resetting it for every SVG made
  // both Effort tracks jump directly between levels in the documentation GIF,
  // even though physical keys use the eased runtime transition.
  resetDemoEffects();
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
  const radius = (size * 22 / 144).toFixed(1);
  return `<defs><clipPath id="documentationKeyClip"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}"/></clipPath></defs>
  <image x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#documentationKeyClip)" href="data:image/svg+xml;base64,${data}"/>`;
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
    title: "Release",
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
    `Hold ${holdSeconds} s`,
    "Speak",
    "Release",
    "Transcribe",
    "Submit",
    "Sent"
  ];
  let state = "idle";
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = OPEN TASK";
  if (elapsedMs >= 650 && elapsedMs < 1_400) {
    state = "preparing";
    accent = THEME.blue;
    result = "TARGET READYING";
  } else if (elapsedMs >= 1_400 && elapsedMs < 2_650) {
    state = "recording";
    activeStage = 1;
    accent = THEME.amber;
    result = "KEEP HOLDING";
  } else if (elapsedMs >= 2_650 && elapsedMs < 3_150) {
    state = "transcribing";
    activeStage = 2;
    accent = THEME.textSecondary;
    result = "RELEASED";
  } else if (elapsedMs >= 3_150 && elapsedMs < 3_950) {
    state = "transcribing";
    activeStage = 3;
    accent = THEME.textSecondary;
    result = "DRAFT STABILIZING";
  } else if (elapsedMs >= 3_950 && elapsedMs < 4_750) {
    state = "submitting";
    activeStage = 4;
    accent = THEME.blue;
    result = "AUTO SUBMIT";
  } else if (elapsedMs >= 4_750 && elapsedMs < 5_750) {
    state = "sent";
    activeStage = 5;
    accent = THEME.green;
    result = "SEND VERIFIED";
  }
  return gesturePreviewSvg({
    title: "Task key",
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
    "Press",
    "Speak while held",
    "Release",
    "Transcribe",
    "Draft ready"
  ];
  let state = "idle";
  let activeStage = 0;
  let accent = THEME.text;
  let result = "PRESS = RECORD";
  if (elapsedMs >= 800 && elapsedMs < 2_300) {
    state = "recording";
    activeStage = 1;
    accent = THEME.amber;
    result = "KEEP HOLDING";
  } else if (elapsedMs >= 2_300 && elapsedMs < 2_800) {
    state = "transcribing";
    activeStage = 2;
    accent = THEME.textSecondary;
    result = "RELEASED";
  } else if (elapsedMs >= 2_800 && elapsedMs < 3_800) {
    state = "transcribing";
    activeStage = 3;
    accent = THEME.textSecondary;
    result = "DRAFT ONLY — NOT SENT";
  } else if (elapsedMs >= 3_800 && elapsedMs < 4_900) {
    state = "complete";
    activeStage = 4;
    accent = THEME.green;
    result = "REVIEW IN COMPOSER";
  }
  return gesturePreviewSvg({
    title: "Microphone",
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
    "Tap and release",
    "Return",
    `Hold ${holdSeconds} s`,
    "Blue = armed",
    "Release to run"
  ];
  let armed = false;
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = RETURN";
  if (elapsedMs >= 650 && elapsedMs < 1_450) {
    activeStage = 1;
    accent = THEME.green;
    result = "KEYSTROKE: RETURN";
  } else if (elapsedMs >= 2_150 && elapsedMs < 2_750) {
    activeStage = 2;
    result = "KEEP HOLDING";
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
    title: "Send key",
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
    "Tap",
    "Open or bring forward",
    "Hold",
    "Quit action",
    "Release"
  ];
  let quitArmed = false;
  let activeStage = 0;
  let accent = THEME.text;
  let result = "TAP = OPEN / FRONT";
  if (elapsedMs >= 900 && elapsedMs < 1_700) {
    activeStage = 1;
    accent = THEME.green;
    result = "APP OPENED OR FOCUSED";
  } else if (elapsedMs >= 2_000 && elapsedMs < 3_100) {
    activeStage = 2;
    result = "KEEP HOLDING";
  } else if (elapsedMs >= 3_100 && elapsedMs < 4_150) {
    quitArmed = true;
    activeStage = 3;
    accent = THEME.red;
    result = "LONG PRESS = QUIT";
  } else if (elapsedMs >= 4_150 && elapsedMs < 4_800) {
    activeStage = 4;
    accent = THEME.red;
    result = "QUIT REQUESTED";
  }
  return gesturePreviewSvg({
    title: "App launcher",
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
    && !completionDismissFadeByThreadId.has(threadId)
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
  const acknowledgementAtMs = firstPulseStartedAtMs
    + THREAD_COMPLETION_PULSE_DURATION_MS + 700;
  acknowledgeCompletion(threadId, {
    persist: false,
    render: false,
    nowMs: acknowledgementAtMs
  });
  const dismissalStartEffect = visibleCompletionPulseState(finalTerminal, acknowledgementAtMs);
  const dismissalMidEffect = visibleCompletionPulseState(
    finalTerminal,
    acknowledgementAtMs + UNREAD_COMPLETION_DISMISS_FADE_MS / 2
  );
  const dismissalEndEffect = visibleCompletionPulseState(
    finalTerminal,
    acknowledgementAtMs + UNREAD_COMPLETION_DISMISS_FADE_MS
  );
  const acknowledgementClearsUnreadCompletion = !unreadCompletionByThreadId.has(threadId);
  const acknowledgementFadesUnreadCompletion = dismissalStartEffect?.dismissal === true
    && Math.abs(dismissalStartEffect.strength - persistentEffect.strength) < 0.001
    && dismissalMidEffect?.dismissal === true
    && dismissalMidEffect.strength > 0
    && dismissalMidEffect.strength < dismissalStartEffect.strength
    && dismissalEndEffect === null;

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
    && acknowledgementClearsUnreadCompletion
    && acknowledgementFadesUnreadCompletion;
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
    acknowledgementClearsUnreadCompletion,
    acknowledgementFadesUnreadCompletion
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
    ACTIONS.reasoning,
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
  const targetStart = completionPulseState(targetId, nowMs)?.strength ?? 0;
  const targetAttack = completionPulseState(targetId, nowMs + 180)?.strength ?? 0;
  const targetRelease = completionPulseState(
    targetId,
    nowMs + THREAD_COMPLETION_PULSE_DURATION_MS - 1
  )?.strength ?? 1;
  const globalStart = globalCompletionPulseState(nowMs)?.strength ?? 0;
  const globalAttack = globalCompletionPulseState(nowMs + 160)?.strength ?? 0;
  const globalRelease = globalCompletionPulseState(
    nowMs + GLOBAL_COMPLETION_PULSE_DURATION_MS - 1
  )?.strength ?? 1;
  const completionAnimationUsesHighRateSmoothCurve = GLOBAL_COMPLETION_FRAME_INTERVAL_MS <= 40
    && GLOBAL_COMPLETION_GROUP_COUNT === 1
    && UNREAD_COMPLETION_FRAME_INTERVAL_MS <= 33
    && UNREAD_COMPLETION_GROUP_COUNT === 1
    && targetStart > 0.05
    && targetAttack > targetStart
    && targetRelease < 0.01
    && globalStart > 0.05
    && globalAttack > globalStart
    && globalRelease < 0.01;
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
    && completionAnimationUsesHighRateSmoothCurve
    && transitionPolicy.passed;
  console.log(JSON.stringify({
    passed,
    visibleContexts: actions.length,
    firstFrameImages: imageMessages.length,
    nonTargetGlobalChrome: globalChromeCount,
    completionAnimationUsesHighRateSmoothCurve,
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

  const startupCurrentContext = "refresh-startup-current";
  const startupReasoningContext = "refresh-startup-reasoning";
  contexts.clear();
  contextImages.clear();
  contextSentImages.clear();
  contexts.set(startupCurrentContext, ACTIONS.thread1);
  contexts.set(startupReasoningContext, ACTIONS.reasoning);
  contexts.set("refresh-startup-voice", ACTIONS.voice);
  contexts.set("refresh-startup-send", ACTIONS.send);
  threadSlots = Array(THREAD_COUNT).fill(null);
  primaryThreadId = null;
  primaryThreadRow = null;
  fastModeState = {
    threadId: null,
    enabled: null,
    available: null,
    failed: false
  };
  hasLoadedThreadState = false;
  consecutiveThreadRefreshFailures = 0;
  threadRefreshUnavailable = false;
  const startupSnapshotLoaded = await refreshThreads(null, {
    reader: async () => ({
      threads: [stableThread],
      currentThread: stableThread
    }),
    retryDelays: []
  });
  const startupReasoningSvg = contextImages.get(startupReasoningContext) ?? "";
  const startupControlsBindToCurrentTask = startupSnapshotLoaded
    && primaryThreadId === stableThread.id
    && primaryThreadRow?.id === stableThread.id
    && fastModeState.threadId === stableThread.id
    && fastModeState.reasoningEffort === "medium"
    && fastModeState.enabled === false
    && startupReasoningSvg.includes('data-reasoning-state="medium"')
    && !startupReasoningSvg.includes('data-reasoning-state="unknown"')
    && resolveVoiceTargetThreadId() === stableThread.id
    && currentThreadForDisplay()?.id === stableThread.id;

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
      && !contextImages.get(context)?.includes(t("thread.stateUnavailable"));

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
  const savedSideChatTitles = new Map(sideChatTitleById);
  let sideChatCachePreserved = false;
  let persistentSideChatReentryBlocked = false;
  let sideChatRendererTitleWinsPromptHistory = false;
  try {
    const sessionStartedAtMs = sideChatCreatedAtMs - 1_000;
    appServerSessionCache = { checkedAtMs: Date.now(), startedAtMs: sessionStartedAtMs };
    sideChatSessionStartMs = sessionStartedAtMs;
    sideChatRowsCache = [];
    sideChatParentById.clear();
    sideChatTitleById.clear();
    sideChatTitleById.set(sideChatId, "최초 사이드챗 질문");
    const persistentRows = [stableThread];
    const first = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve(sideChatState),
      { discoverFromLogs: false }
    );
    const afterReadFailure = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.reject(new Error("simulated global-state rewrite")),
      { discoverFromLogs: false }
    );
    const afterSemanticFailure = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve({ "electron-persisted-atom-state": "{partial" }),
      { discoverFromLogs: false }
    );
    const afterValidEmptyState = await readEphemeralSideChats(
      persistentRows,
      stableThread.id,
      Promise.resolve({
        "electron-persisted-atom-state": { "prompt-history": {} }
      }),
      { discoverFromLogs: false }
    );
    const blockedPersistentId = await readEphemeralSideChats(
      new Set([stableThread.id, sideChatId]),
      stableThread.id,
      Promise.resolve(sideChatState),
      { discoverFromLogs: false }
    );
    sideChatCachePreserved = first[0]?.id === sideChatId
      && afterReadFailure[0]?.id === sideChatId
      && afterSemanticFailure[0]?.id === sideChatId
      && afterValidEmptyState.length === 0
      && sideChatRowsCache.length === 0;
    sideChatRendererTitleWinsPromptHistory = first[0]?.title === "최초 사이드챗 질문"
      && first[0]?.queueTitles?.includes("최초 사이드챗 질문")
      && first[0]?.queueTitles?.includes("임시 사이드 작업");
    persistentSideChatReentryBlocked = blockedPersistentId.length === 0;
  } finally {
    appServerSessionCache = savedAppServerSessionCache;
    sideChatSessionStartMs = savedSideChatSessionStartMs;
    sideChatRowsCache = savedSideChatRowsCache;
    sideChatParentById.clear();
    for (const [id, parentId] of savedSideChatParents) sideChatParentById.set(id, parentId);
    sideChatTitleById.clear();
    for (const [id, title] of savedSideChatTitles) sideChatTitleById.set(id, title);
  }

  const passed = recoveredInsideRefresh
    && startupControlsBindToCurrentTask
    && keptLastGoodList
    && oneOffStartupHidden
    && startupErrorStable
    && rankedListKeepsAllEight
    && sideChatCachePreserved
    && sideChatRendererTitleWinsPromptHistory
    && persistentSideChatReentryBlocked;
  console.log(JSON.stringify({
    passed,
    retryAttempts,
    startupControlsBindToCurrentTask,
    keptLastGoodList,
    oneOffStartupHidden,
    rankedListKeepsAllEight,
    sideChatCachePreserved,
    sideChatRendererTitleWinsPromptHistory,
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
  voiceBackendByContext.clear();
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
    && successfulShutdownCommands.join(",") === "media-resume-paused"
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
  activeComposerFocusLease = null;
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
  const compactGoalQueueBaselineY = timingTextBaselineY(16.5);
  const compactGoalQueueMarkup = threadTimingBarSvg({
    ...goalThreadBase,
    status: "working",
    queueCount: 3,
    goal: {
      status: "active",
      timeUsedSeconds: 37 * 60 + 15,
      updatedAtMs: renderTimeMs()
    }
  }, { strength: 0.5 });
  const compactGoalQueueTimingIsVerticallyCentered = compactGoalQueueBaselineY < 125.5
    && compactGoalQueueMarkup.includes(
      `data-thread-timing="base" x="58" y="${compactGoalQueueBaselineY}"`
    )
    && compactGoalQueueMarkup.includes(
      `data-thread-timing="completion" x="58" y="${compactGoalQueueBaselineY}"`
    );
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
  threadSlots = [remoteThread, manuallyActiveThread, ...Array(THREAD_COUNT - 2).fill(null)];
  primaryThreadId = remoteThread.id;
  primaryThreadRow = remoteThread;
  lastOpenedThreadId = remoteThread.id;
  lastOpenedThreadAtMs = Date.now();
  currentThreadIdentityCandidates = [remoteThread, manuallyActiveThread];
  activeCurrentThreadSync = null;
  lastCurrentThreadSyncAtMs = 0;
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
  const manuallySelectedCurrent = await synchronizeCurrentCodexThread({
    force: true,
    candidates: [remoteThread, manuallyActiveThread],
    readWindows: async () => [{
      focused: true,
      headers: new Set(titleFingerprints(manuallyActiveThread.title)),
      buttons: new Map()
    }],
    probe: currentIdentityProbe,
    promote: false,
    refreshFastMode: false
  });
  const manualCodexSelectionOverridesStreamDeckHistory = manuallySelectedCurrent?.id === manuallyActiveThread.id
    && primaryThreadId === manuallyActiveThread.id
    && primaryThreadRow?.id === manuallyActiveThread.id
    && lastOpenedThreadId === remoteThread.id
    && resolveVoiceTargetThreadId() === manuallyActiveThread.id
    && currentIdentityCalls.length === 1
    && currentIdentityCalls[0].command === "codex-current-thread"
    && currentIdentityCalls[0].args[0] === manuallyActiveThread.id;

  fastModeState = {
    threadId: manuallyActiveThread.id,
    enabled: null,
    available: null,
    reasoningEffort: null,
    failed: true
  };
  activeCurrentThreadSync = null;
  lastCurrentThreadSyncAtMs = 0;
  let sameTaskComposerRecoveryRefreshes = 0;
  const sameTaskComposerRecovery = await synchronizeCurrentCodexThread({
    force: true,
    candidates: [manuallyActiveThread],
    readWindows: async () => [{
      focused: true,
      headers: new Set(titleFingerprints(manuallyActiveThread.title)),
      buttons: new Map()
    }],
    probe: async (command, args) => {
      if (command === "codex-current-thread" && args[0] === manuallyActiveThread.id) {
        return { stdout: "match=uuid" };
      }
      const error = new Error("simulated different active Codex task");
      error.exitCode = 1;
      throw error;
    },
    promote: false,
    refreshFastModeAction: () => {
      sameTaskComposerRecoveryRefreshes += 1;
      return Promise.resolve(true);
    }
  });
  const sameTaskComposerStateRecoversWithoutIdentityChange = sameTaskComposerRecovery?.id
      === manuallyActiveThread.id
    && primaryThreadId === manuallyActiveThread.id
    && sameTaskComposerRecoveryRefreshes === 1;
  fastModeState = {
    threadId: manuallyActiveThread.id,
    enabled: false,
    available: true,
    reasoningEffort: "low",
    failed: false
  };

  const sendContext = "interaction-current-send";
  contexts.set(sendContext, ACTIONS.send);
  contextImages.set(sendContext, sendSvg(false));
  sendPressStartedAt.set(sendContext, Date.now());
  const sendControlOrder = [];
  const sendUsesCurrentTask = await endSendPress(sendContext, {
    synchronizeCurrent: async () => {
      sendControlOrder.push("sync");
      return manuallyActiveThread;
    },
    focusComposer: async () => {
      sendControlOrder.push("focus");
      return true;
    },
    focusProbe: async () => {
      sendControlOrder.push("verify");
      return { stdout: "match=uuid" };
    },
    sendCommand: async (command) => {
      sendControlOrder.push(command);
      return true;
    }
  });
  contexts.delete(sendContext);
  contextImages.delete(sendContext);

  const voiceContext = "interaction-current-voice";
  contexts.set(voiceContext, ACTIONS.voice);
  contextImages.set(voiceContext, voiceSvg("idle"));
  let voiceControlTargetId = null;
  const voicePressStarted = beginCurrentVoicePress(voiceContext, {
    synchronizeCurrent: async () => manuallyActiveThread,
    focusComposer: async () => true,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    beginVoice: (_context, voiceOptions) => {
      voiceControlTargetId = voiceOptions.targetThreadId;
      return true;
    }
  });
  const voicePressState = currentVoicePressByContext.get(voiceContext);
  const voicePrepared = await voicePressState?.promise;
  endCurrentVoicePress(voiceContext);
  cancelVoiceTranscription(voiceContext, true);
  contexts.delete(voiceContext);
  contextImages.delete(voiceContext);
  const dashboardControlsUseCurrentTask = sendUsesCurrentTask
    && sendControlOrder.join(",") === "sync,focus,verify,send"
    && voicePressStarted
    && voicePrepared
    && voiceControlTargetId === manuallyActiveThread.id;

  const backgroundVoiceContext = "interaction-background-micro-voice";
  contexts.set(backgroundVoiceContext, ACTIONS.voice);
  contextImages.set(backgroundVoiceContext, voiceSvg("idle"));
  let backgroundVoiceFocusCalls = 0;
  let backgroundVoiceOptions = null;
  const backgroundVoiceStarted = beginCurrentVoicePress(backgroundVoiceContext, {
    synchronizeCurrent: async () => manuallyActiveThread,
    microStatus: async () => ({ available: true, matches: true }),
    focusComposer: async () => {
      backgroundVoiceFocusCalls += 1;
      return false;
    },
    beginVoice: (_context, voiceOptions) => {
      backgroundVoiceOptions = voiceOptions;
      return true;
    }
  });
  const backgroundVoiceState = currentVoicePressByContext.get(backgroundVoiceContext);
  const backgroundVoicePrepared = await backgroundVoiceState?.promise;
  endCurrentVoicePress(backgroundVoiceContext, { resumeMedia: async () => true });
  cancelVoiceTranscription(backgroundVoiceContext, true);
  contexts.delete(backgroundVoiceContext);
  contextImages.delete(backgroundVoiceContext);
  const microVoiceDoesNotNeedForegroundFocus = backgroundVoiceStarted
    && backgroundVoicePrepared
    && backgroundVoiceFocusCalls === 0
    && backgroundVoiceOptions?.targetThreadId === manuallyActiveThread.id
    && backgroundVoiceOptions?.composerAlreadyFocused === true
    && backgroundVoiceOptions?.allowComposerRefocus === false;

  const mismatchedVoiceContext = "interaction-background-micro-mismatch";
  contexts.set(mismatchedVoiceContext, ACTIONS.voice);
  contextImages.set(mismatchedVoiceContext, voiceSvg("idle"));
  let mismatchedVoiceFocusCalls = 0;
  let mismatchedVoiceStarts = 0;
  beginCurrentVoicePress(mismatchedVoiceContext, {
    synchronizeCurrent: async () => manuallyActiveThread,
    microStatus: async () => ({ available: true, matches: false }),
    focusComposer: async () => {
      mismatchedVoiceFocusCalls += 1;
      return true;
    },
    beginVoice: () => {
      mismatchedVoiceStarts += 1;
      return true;
    }
  });
  const mismatchedVoiceState = currentVoicePressByContext.get(mismatchedVoiceContext);
  const mismatchedVoicePrepared = await mismatchedVoiceState?.promise;
  cancelCurrentVoicePress(mismatchedVoiceContext, false);
  contexts.delete(mismatchedVoiceContext);
  contextImages.delete(mismatchedVoiceContext);
  const microVoiceMismatchFailsClosed = !mismatchedVoicePrepared
    && mismatchedVoiceFocusCalls === 0
    && mismatchedVoiceStarts === 0;
  const focusedRemoteForComposer = {
    ...remoteThread,
    status: "working",
    reasoningEffort: "high",
    serviceTier: "priority",
    nextReasoningEffort: "high",
    nextServiceTier: "priority",
    threadRuntimeStatus: { type: "active", activeFlags: [] },
  };
  threadSlots = [focusedRemoteForComposer, ...Array(THREAD_COUNT - 1).fill(null)];
  primaryThreadId = focusedRemoteForComposer.id;
  primaryThreadRow = focusedRemoteForComposer;
  const previousTurnSnapshotTime = fixedRenderTimeMs;
  fixedRenderTimeMs = 180_500;
  const runningCardBeforeComposerChange = threadSvg(threadSlots[0], 0);
  const nextComposerApplied = applyFocusedComposerState(
    threadSlots[0],
    { enabled: false, available: true, reasoningEffort: "medium" },
    180_700
  );
  const runningCardAfterComposerChange = threadSvg(threadSlots[0], 0);
  fixedRenderTimeMs = previousTurnSnapshotTime;
  const composerChangesStayNextTurnOnly = nextComposerApplied
    && threadSlots[0]?.reasoningEffort === "high"
    && threadSlots[0]?.serviceTier === "priority"
    && threadSlots[0]?.nextReasoningEffort === "medium"
    && threadSlots[0]?.nextServiceTier === "default"
    && primaryThreadRow?.reasoningEffort === "high"
    && primaryThreadRow?.serviceTier === "priority"
    && primaryThreadRow?.nextReasoningEffort === "medium"
    && primaryThreadRow?.nextServiceTier === "default"
    && runningCardBeforeComposerChange === runningCardAfterComposerChange
    && runningCardAfterComposerChange.includes('data-mode="fast"');
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
  let successfulLocalComposerFocuses = 0;
  const successfulLocalNavigation = await openThread(currentSlotContext, 1, {
    navigateDeepLink: async () => true,
    focusThreadComposer: async () => {
      successfulLocalComposerFocuses += 1;
      return true;
    },
    scheduleRefresh: () => {},
    feedback: () => {},
    rememberThread: (thread) => rememberVerifiedThread(thread, { refreshFastMode: false })
  });
  const verifiedNavigationUpdatesCurrentOnly = successfulLocalNavigation
    && primaryThreadId === localThreadB.id
    && primaryThreadRow?.id === localThreadB.id
    && threadSlots[0]?.id === localThreadA.id
    && threadSlots[1]?.id === localThreadB.id
    && threadSlots.filter((thread) => thread?.id === localThreadB.id).length === 1
    && successfulLocalComposerFocuses === 1;
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

  const tapActivationContext = "interaction-thread-tap-activation";
  contexts.set(tapActivationContext, ACTIONS.thread1);
  let tapActivationCalls = 0;
  beginThreadPress(tapActivationContext, 0, {
    thread: remoteThread,
    openThread: async () => true,
    schedule: () => null,
    activateApp: async () => { tapActivationCalls += 1; },
    focusComposer: async () => true,
    beginVoice: async () => true
  });
  endThreadPress(tapActivationContext);
  await Promise.resolve();
  await Promise.resolve();
  contexts.delete(tapActivationContext);
  const shortTaskTapBringsCodexForward = tapActivationCalls === 1;

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
    && mediaCommands.join(",") === "media-pause-if-playing,media-resume-paused"
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
    && coalescedResumeCommands.join(",") === "media-resume-paused"
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
    if (command === "media-resume-paused") {
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
      "media-resume-paused",
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

  const backgroundSubmitContext = "interaction-background-micro-submit";
  const backgroundSubmitSessionId = ++nextVoiceSessionId;
  contexts.set(backgroundSubmitContext, ACTIONS.thread1);
  voiceStateByContext.set(backgroundSubmitContext, "submitting");
  voiceTargetThreadByContext.set(backgroundSubmitContext, remoteThread.id);
  voiceSessionIdByContext.set(backgroundSubmitContext, backgroundSubmitSessionId);
  let backgroundSubmitOpenCalls = 0;
  let backgroundSubmitFocusCalls = 0;
  let backgroundSubmitCalls = 0;
  await submitCompletedVoiceTranscription(backgroundSubmitContext, remoteThread.id, {
    baseline: parseTextInputState("focused-text-state", "0\t0000000000000000"),
    lastObserved: parseTextInputState("focused-text-state", "8\t2222222222222222"),
    sessionId: backgroundSubmitSessionId
  }, {
    microStatus: async () => ({ available: true, matches: true }),
    openApp: async () => { backgroundSubmitOpenCalls += 1; },
    targetFocused: async () => {
      backgroundSubmitFocusCalls += 1;
      return true;
    },
    submit: async () => {
      backgroundSubmitCalls += 1;
      return true;
    },
    waitForDraftReset: async () => true,
    scheduleRefresh: () => {}
  });
  const microSubmitDoesNotActivateCodex = backgroundSubmitOpenCalls === 0
    && backgroundSubmitFocusCalls === 0
    && backgroundSubmitCalls === 1
    && voiceStateByContext.get(backgroundSubmitContext) === "sent";
  contexts.delete(backgroundSubmitContext);
  voiceStateByContext.delete(backgroundSubmitContext);
  voiceTargetThreadByContext.delete(backgroundSubmitContext);
  voiceSessionIdByContext.delete(backgroundSubmitContext);

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
  const nextTurnMetadataState = fastModeStateFromThread({
    ...localThreadB,
    reasoningEffort: "high",
    serviceTier: "priority",
    nextReasoningEffort: "medium",
    nextServiceTier: "default",
    nextSettingsAtMs: 123_456
  }, {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "high",
    failed: false
  });
  const confirmedComposerStateSurvivesStaleMetadata = nextTurnMetadataState.threadId === localThreadB.id
    && nextTurnMetadataState.enabled === true
    && nextTurnMetadataState.available === true
    && nextTurnMetadataState.reasoningEffort === "high";
  const directComposerThread = {
    ...localThreadB,
    status: "working",
    reasoningEffort: "high",
    serviceTier: "priority",
    nextReasoningEffort: "high",
    nextServiceTier: "priority"
  };
  primaryThreadRow = directComposerThread;
  threadSlots = [directComposerThread, localThreadA, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];
  fastModeState = {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "high",
    failed: false
  };
  const previousDirectComposerTime = fixedRenderTimeMs;
  fixedRenderTimeMs = 222_000;
  const directComposerCardBefore = threadSvg(directComposerThread, 0);
  const directComposerRefresh = await refreshFastMode({
    threadId: localThreadB.id,
    quiet: true,
    stateProbe: async () => ({
      stdout: "state=off available=1 reasoning=medium service_tier=default reasoning_available=1 service_tier_available=1 composer_focused=1\n"
    })
  });
  const directComposerCardAfter = threadSvg(threadSlots[0], 0);
  const directComposerControl = reasoningControlSvg(fastModeState, localThreadB.id);
  fixedRenderTimeMs = previousDirectComposerTime;
  const directCodexComposerChangeRefreshesControlOnly = directComposerRefresh
    && fastModeState.threadId === localThreadB.id
    && fastModeState.enabled === false
    && fastModeState.reasoningEffort === "medium"
    && primaryThreadRow?.reasoningEffort === "high"
    && primaryThreadRow?.serviceTier === "priority"
    && primaryThreadRow?.nextReasoningEffort === "medium"
    && primaryThreadRow?.nextServiceTier === "default"
    && directComposerCardBefore === directComposerCardAfter
    && directComposerControl.includes('data-reasoning-state="medium"')
    && directComposerControl.includes('>MEDIUM</text>')
    && directComposerControl.includes('data-fast-state="off"');
  primaryThreadRow = localThreadB;
  threadSlots = [localThreadB, localThreadA, localThreadC, ...Array(THREAD_COUNT - 3).fill(null)];
  fastModeState = {
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    failed: false
  };
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
    && fastUnavailableVisual.includes(t("fast.unavailable"))
    && fastFailedVisual.includes(t("fast.error"))
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
  let fastCurrentSyncAttempts = 0;
  const fastOptions = {
    feedback: () => {},
    synchronizeCurrent: async () => {
      fastCurrentSyncAttempts += 1;
      return localThreadB;
    },
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
    && fastCurrentSyncAttempts === 1
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

  let fastComposerFocusRecoveries = 0;
  const fastComposerFocusRecoveryResult = await toggleFastMode(fastContext, {
    feedback: () => {},
    focusProbe: async () => ({ stdout: "match=uuid" }),
    toggleMode: async () => ({
      stdout: "requested=off state=off available=1 changed=1 verified=1 reasoning=max service_tier=default composer_focused=0\n"
    }),
    focusComposer: async () => {
      fastComposerFocusRecoveries += 1;
      return true;
    }
  });
  const fastToggleRestoresComposerAfterNativeFocusMiss = fastComposerFocusRecoveryResult
    && fastComposerFocusRecoveries === 1
    && fastModeState.threadId === localThreadB.id
    && fastModeState.enabled === false
    && fastModeState.composerFocused === true;

  const fastHoldContext = "interaction-fast-hold";
  contexts.set(fastHoldContext, ACTIONS.fastMode);
  let fastHoldToggleCalls = 0;
  const fastHoldOptions = {
    feedback: () => {},
    synchronizeCurrent: async () => localThreadB,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    toggleMode: async () => {
      fastHoldToggleCalls += 1;
      return {
        stdout: "requested=on state=on available=1 changed=1 verified=1 reasoning=max service_tier=priority composer_focused=1\n"
      };
    }
  };
  fastModePressStartedAt.set(fastHoldContext, Date.now());
  const fastShortPressResult = await endFastModePress(fastHoldContext, fastHoldOptions);
  fastModePressStartedAt.set(
    fastHoldContext,
    Date.now() - FAST_MODE_LONG_PRESS_MS - 1
  );
  const fastLongPressResult = await endFastModePress(fastHoldContext, fastHoldOptions);
  const fastModeWorksOnRelease = fastShortPressResult
    && fastLongPressResult
    && fastHoldToggleCalls === 2;

  const immediateReasoningHoldContext = "interaction-reasoning-fast-hold";
  contexts.set(immediateReasoningHoldContext, ACTIONS.reasoning);
  let immediateReasoningFastToggleCalls = 0;
  fastModePressStartedAt.set(immediateReasoningHoldContext, Date.now());
  const thresholdToggleResult = await triggerReasoningFastModeHold(
    immediateReasoningHoldContext,
    {
      feedback: () => {},
      synchronizeCurrent: async () => localThreadB,
      focusProbe: async () => ({ stdout: "match=uuid" }),
      toggleMode: async () => {
        immediateReasoningFastToggleCalls += 1;
        return {
          stdout: "requested=off state=off available=1 changed=1 verified=1 reasoning=max service_tier=default composer_focused=1\n"
        };
      }
    }
  );
  const callsBeforeReasoningKeyUp = immediateReasoningFastToggleCalls;
  const thresholdReleaseResult = await endReasoningControlPress(
    immediateReasoningHoldContext
  );
  const reasoningFastToggleStartsAtThreshold = thresholdToggleResult
    && thresholdReleaseResult
    && callsBeforeReasoningKeyUp === 1
    && immediateReasoningFastToggleCalls === 1;

  const queuedReasoningHoldContext = "interaction-reasoning-fast-queued";
  contexts.set(queuedReasoningHoldContext, ACTIONS.reasoning);
  let releaseBlockedControl;
  const blockedControlGate = new Promise((resolve) => {
    releaseBlockedControl = resolve;
  });
  let blockedControlUpdate;
  blockedControlUpdate = blockedControlGate.finally(() => {
    if (activeFastModeUpdate === blockedControlUpdate) activeFastModeUpdate = null;
  });
  activeFastModeUpdate = blockedControlUpdate;
  let queuedReasoningFastToggleCalls = 0;
  fastModePressStartedAt.set(queuedReasoningHoldContext, Date.now());
  const queuedThresholdToggle = triggerReasoningFastModeHold(
    queuedReasoningHoldContext,
    {
      feedback: () => {},
      synchronizeCurrent: async () => localThreadB,
      focusProbe: async () => ({ stdout: "match=uuid" }),
      toggleMode: async () => {
        queuedReasoningFastToggleCalls += 1;
        return {
          stdout: "requested=on state=on available=1 changed=1 verified=1 reasoning=max service_tier=priority composer_focused=1\n"
        };
      }
    }
  );
  // Model an Effort successor replacing the operation that the hold first
  // observed. The Fast gesture must follow both controls, not adopt the
  // successor's result as if the FAST event itself had run.
  let releaseSuccessorControl;
  const successorControlGate = new Promise((resolve) => {
    releaseSuccessorControl = resolve;
  });
  let successorControlUpdate;
  successorControlUpdate = successorControlGate.finally(() => {
    if (activeFastModeUpdate === successorControlUpdate) activeFastModeUpdate = null;
  });
  activeFastModeUpdate = successorControlUpdate;
  const queuedThresholdRelease = endReasoningControlPress(
    queuedReasoningHoldContext
  );
  releaseBlockedControl(true);
  await blockedControlUpdate;
  releaseSuccessorControl(true);
  const queuedReasoningHoldResults = await Promise.all([
    queuedThresholdToggle,
    queuedThresholdRelease,
    successorControlUpdate
  ]);
  const reasoningFastHoldSurvivesEffortSuccessor = queuedReasoningHoldResults.every(Boolean)
    && queuedReasoningFastToggleCalls === 1
    && fastModeState.enabled === true;

  const reasoningContext = "interaction-reasoning";
  contexts.set(reasoningContext, ACTIONS.reasoning);
  reasoningDirectionByThreadId.delete(localThreadB.id);
  reasoningAvailableEffortsByThreadId.set(
    localThreadB.id,
    [...REASONING_EFFORT_ORDER]
  );
  let requestedReasoningStep = null;
  const reasoningStepResult = await stepReasoningEffort(reasoningContext, {
    settleMs: 0,
    direction: "down",
    synchronizeCurrent: async () => localThreadB,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stepEffort: async (direction, count) => {
      requestedReasoningStep = `${direction}:${count}`;
      return {
        stdout: "previous=max reasoning=xhigh options=low,medium,high,xhigh,max,ultra steps=1 service_tier=priority available=1 changed=1 verified=1 direction=down at_min=0 at_max=0 composer_focused=1\n"
      };
    }
  });
  const minimumStep = parseReasoningStepState(
    "previous=medium reasoning=low options=low,medium,high,xhigh,ultra steps=1 service_tier=default available=1 changed=1 verified=1 direction=down at_min=1 at_max=0 composer_focused=1"
  );
  const maximumStep = parseReasoningStepState(
    "previous=max reasoning=ultra options=low,medium,high,xhigh,max,ultra steps=1 service_tier=priority available=1 changed=1 verified=1 direction=up at_min=0 at_max=1 composer_focused=1"
  );
  const reasoningPingPongStateIsVerified = reasoningStepResult
    && requestedReasoningStep === "down:1"
    && reasoningDirectionByThreadId.get(localThreadB.id) === "down"
    && fastModeState.reasoningEffort === "xhigh"
    && reasoningAvailableEffortsByThreadId.get(localThreadB.id)?.includes("max")
    && minimumStep?.atMinimum === true
    && maximumStep?.atMaximum === true;
  const optimisticReasoningMovesBeforeNativeConfirmation = (() => {
    const upward = optimisticReasoningStep(localThreadB.id, "up", {
      threadId: localThreadB.id,
      reasoningEffort: "medium"
    });
    const maxToUltra = optimisticReasoningStep(localThreadB.id, "up", {
      threadId: localThreadB.id,
      reasoningEffort: "max"
    });
    const downward = optimisticReasoningStep(localThreadB.id, "down", {
      threadId: localThreadB.id,
      reasoningEffort: "ultra"
    });
    return upward?.effort === "high"
      && upward.direction === "up"
      && maxToUltra?.effort === "ultra"
      && maxToUltra.direction === "down"
      && downward?.effort === "max"
      && downward.direction === "down";
  })();
  const userSpecificReasoningOptionsAreRespected = (() => {
    const withoutMax = ["low", "medium", "high", "xhigh", "ultra"];
    const parsed = parseReasoningStepState(
      "previous=xhigh reasoning=ultra options=ultra,low,high,medium,xhigh,maxish,xhigh steps=1 service_tier=default available=1 changed=1 verified=1 direction=up at_min=0 at_max=1 composer_focused=1"
    );
    rememberReasoningEffortOptions(localThreadB.id, withoutMax);
    const upward = optimisticReasoningStep(localThreadB.id, "up", {
      threadId: localThreadB.id,
      reasoningEffort: "xhigh"
    });
    const downward = optimisticReasoningStep(localThreadB.id, "down", {
      threadId: localThreadB.id,
      reasoningEffort: "ultra"
    });
    const limitedUpperBounce = optimisticReasoningStep(
      localThreadB.id,
      "up",
      { threadId: localThreadB.id, reasoningEffort: "xhigh" },
      ["medium", "high", "xhigh"]
    );
    const limitedLowerBounce = optimisticReasoningStep(
      localThreadB.id,
      "down",
      { threadId: localThreadB.id, reasoningEffort: "medium" },
      ["medium", "high", "xhigh"]
    );
    const coldThread = "00000000-0000-4000-8000-00000000c01d";
    return parsed?.availableEfforts?.join(",") === "low,medium,high,xhigh,ultra"
      && upward?.effort === "ultra"
      && upward.direction === "down"
      && downward?.effort === "xhigh"
      && limitedUpperBounce?.effort === "high"
      && limitedUpperBounce.direction === "down"
      && limitedLowerBounce?.effort === "high"
      && limitedLowerBounce.direction === "up"
      && !optimisticReasoningStep(coldThread, "up", {
        threadId: coldThread,
        reasoningEffort: "xhigh"
      });
  })();
  const terraLightPowerAxisIsConnected = (() => {
    const previousCatalog = reasoningGlobalOptionCatalog;
    const previousEfforts = reasoningAvailableEffortsByThreadId.get(localThreadB.id);
    const previousPowerSelections = reasoningPowerSelectionsByThreadId.get(localThreadB.id);
    reasoningGlobalOptionCatalog = {
      model: "gpt-5.6-sol",
      efforts: [...REASONING_EFFORT_ORDER],
      source: "contract"
    };
    reasoningAvailableEffortsByThreadId.set(
      localThreadB.id,
      [...REASONING_EFFORT_ORDER]
    );
    rememberReasoningPowerSelections(localThreadB.id, [
      { id: "gpt-5.6-terra:low", model: "gpt-5.6-terra", reasoningEffort: "low" },
      { id: "gpt-5.6-sol:low", model: "gpt-5.6-sol", reasoningEffort: "low" },
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { id: "gpt-5.6-sol:xhigh", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      { id: "gpt-5.6-sol:ultra", model: "gpt-5.6-sol", reasoningEffort: "ultra" }
    ]);
    const selections = reasoningSelectionOptionsForThread(localThreadB.id);
    const downFromSolLight = optimisticReasoningStep(localThreadB.id, "down", {
      threadId: localThreadB.id,
      model: "gpt-5.6-sol",
      reasoningEffort: "low"
    });
    const upFromTerraLight = optimisticReasoningStep(localThreadB.id, "up", {
      threadId: localThreadB.id,
      model: "gpt-5.6-terra",
      reasoningEffort: "low"
    });
    const terraPlan = reasoningSelectionExecutionPlan(
      "gpt-5.6-sol",
      "low",
      "gpt-5.6-terra",
      "low",
      localThreadB.id,
      "down",
      1
    );
    const maxPlan = reasoningSelectionExecutionPlan(
      "gpt-5.6-terra",
      "low",
      "gpt-5.6-sol",
      "max",
      localThreadB.id,
      "up",
      5
    );
    reasoningProgressTransitionByKey.delete(`control:${localThreadB.id}`);
    const terraVisual = reasoningControlSvg({
      threadId: localThreadB.id,
      model: "gpt-5.6-terra",
      enabled: false,
      available: true,
      reasoningEffort: "low",
      failed: false
    }, localThreadB.id, "up");
    reasoningGlobalOptionCatalog = previousCatalog;
    if (previousEfforts) reasoningAvailableEffortsByThreadId.set(localThreadB.id, previousEfforts);
    else reasoningAvailableEffortsByThreadId.delete(localThreadB.id);
    if (previousPowerSelections) {
      reasoningPowerSelectionsByThreadId.set(localThreadB.id, previousPowerSelections);
    } else reasoningPowerSelectionsByThreadId.delete(localThreadB.id);
    return selections.map((selection) => selection.id).join(",") === [
      "gpt-5.6-terra:low",
      "gpt-5.6-sol:low",
      "gpt-5.6-sol:medium",
      "gpt-5.6-sol:high",
      "gpt-5.6-sol:xhigh",
      "gpt-5.6-sol:max",
      "gpt-5.6-sol:ultra"
    ].join(",")
      && downFromSolLight?.model === "gpt-5.6-terra"
      && downFromSolLight.effort === "low"
      && downFromSolLight.direction === "up"
      && upFromTerraLight?.model === "gpt-5.6-sol"
      && upFromTerraLight.effort === "low"
      && terraPlan.mode === "power"
      && terraPlan.powerTarget?.id === "gpt-5.6-terra:low"
      && maxPlan.mode === "power-exact"
      && maxPlan.powerTarget?.id === "gpt-5.6-sol:xhigh"
      && terraVisual.includes(">TERRA LIGHT</text>")
      && terraVisual.includes('data-reasoning-progress="0.000"');
  })();
  const reasoningFinalTargetPlanningIsSafe = (() => {
    const options = [...REASONING_EFFORT_ORDER];
    const lighter = reasoningEffortExecutionPlan(
      "xhigh",
      "low",
      options,
      "up",
      7
    );
    const roundTrip = reasoningEffortExecutionPlan(
      "xhigh",
      "xhigh",
      options,
      "up",
      4
    );
    const leavingAdvanced = reasoningEffortExecutionPlan(
      "max",
      "high",
      options,
      "down",
      1
    );
    const enteringUltra = reasoningEffortExecutionPlan(
      "xhigh",
      "ultra",
      options,
      "up",
      2
    );
    const enteringMax = reasoningEffortExecutionPlan(
      "xhigh",
      "max",
      options,
      "up",
      1
    );
    return lighter.mode === "micro"
      && lighter.direction === "down"
      && lighter.count === 3
      && roundTrip.mode === "none"
      && leavingAdvanced.mode === "exact"
      && enteringMax.mode === "exact"
      && enteringMax.targetEffort === "max"
      && enteringUltra.mode === "exact"
      && reasoningInputSettleMs({}, "high", true) === REASONING_INPUT_SETTLE_MS;
  })();
  const advancedReasoningForegroundPreparation = await (async () => {
    const operations = [];
    const focused = await focusAdvancedReasoningComposer(null, {
      openApp: async () => { operations.push("open"); },
      waitFrontmost: async () => { operations.push("frontmost"); },
      focusComposer: async () => {
        operations.push("composer");
        return true;
      }
    });
    return focused && operations.join(",") === "open,frontmost,composer";
  })();
  reasoningAvailableEffortsByThreadId.set(
    localThreadB.id,
    [...REASONING_EFFORT_ORDER]
  );
  fastModeState = {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "xhigh",
    failed: false
  };
  reasoningDirectionByThreadId.set(localThreadB.id, "down");
  reasoningVisualOverrideByThreadId.delete(localThreadB.id);
  const rapidReasoningRequests = [];
  let rapidReasoningCalls = 0;
  const rapidReasoningOptions = {
    settleMs: 0,
    synchronizeCurrent: async () => localThreadB,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stepEffort: async (direction, count) => {
      rapidReasoningRequests.push(`${direction}:${count}`);
      rapidReasoningCalls += 1;
      return {
        stdout: "previous=xhigh reasoning=low options=low,medium,high,xhigh,max,ultra steps=3 service_tier=priority available=1 changed=1 verified=1 direction=down at_min=1 at_max=0 composer_focused=1\n"
      };
    }
  };
  const rapidReasoningA = stepReasoningEffort(reasoningContext, rapidReasoningOptions);
  const rapidReasoningB = stepReasoningEffort(reasoningContext, rapidReasoningOptions);
  const rapidReasoningC = stepReasoningEffort(reasoningContext, rapidReasoningOptions);
  const rapidReasoningImmediateVisual = staticActionSvg(ACTIONS.reasoning, reasoningContext);
  const rapidReasoningPaintsEveryTapImmediately = rapidReasoningCalls === 0
    && rapidReasoningImmediateVisual.includes('data-reasoning-state="low"')
    && reasoningPendingCountByThreadId.get(localThreadB.id) === 3
    && reasoningPendingCountByContext.get(reasoningContext) === 3;
  const rapidReasoningResults = await Promise.all([
    rapidReasoningA,
    rapidReasoningB,
    rapidReasoningC
  ]);
  const rapidReasoningCoalescesToFinalTarget = rapidReasoningPaintsEveryTapImmediately
    && rapidReasoningResults.every(Boolean)
    && rapidReasoningCalls === 1
    && rapidReasoningRequests.join(",") === "down:3"
    && fastModeState.reasoningEffort === "low"
    && reasoningDirectionByThreadId.get(localThreadB.id) === "up"
    && !reasoningVisualOverrideByThreadId.has(localThreadB.id)
    && !reasoningPendingCountByThreadId.has(localThreadB.id)
    && !reasoningPendingCountByContext.has(reasoningContext)
    && !reasoningBusyContexts.has(reasoningContext);
  fastModeState = {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "low",
    failed: false
  };
  reasoningDirectionByThreadId.set(localThreadB.id, "up");
  let releaseFirstReasoningApply;
  const firstReasoningApplyGate = new Promise((resolve) => {
    releaseFirstReasoningApply = resolve;
  });
  let markFirstReasoningApplyStarted;
  const firstReasoningApplyStarted = new Promise((resolve) => {
    markFirstReasoningApplyStarted = resolve;
  });
  const duringApplyRequests = [];
  const duringApplyOptions = {
    settleMs: 0,
    synchronizeCurrent: async () => localThreadB,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stepEffort: async (direction, count) => {
      duringApplyRequests.push(`${direction}:${count}`);
      if (duringApplyRequests.length === 1) {
        markFirstReasoningApplyStarted();
        await firstReasoningApplyGate;
        return {
          stdout: "previous=low reasoning=medium options=low,medium,high,xhigh,max,ultra steps=1 service_tier=priority available=1 changed=1 verified=1 direction=up at_min=0 at_max=0 composer_focused=1\n"
        };
      }
      return {
        stdout: "previous=medium reasoning=xhigh options=low,medium,high,xhigh,max,ultra steps=2 service_tier=priority available=1 changed=1 verified=1 direction=up at_min=0 at_max=0 composer_focused=1\n"
      };
    }
  };
  const duringApplyFirst = stepReasoningEffort(reasoningContext, duringApplyOptions);
  await firstReasoningApplyStarted;
  const duringApplySecond = stepReasoningEffort(reasoningContext, duringApplyOptions);
  const duringApplyThird = stepReasoningEffort(reasoningContext, duringApplyOptions);
  releaseFirstReasoningApply();
  const duringApplyResults = await Promise.all([
    duringApplyFirst,
    duringApplySecond,
    duringApplyThird
  ]);
  const reasoningInputDuringApplyStartsOneSuccessor = duringApplyResults.every(Boolean)
    && duringApplyRequests.join(",") === "up:1,up:2"
    && fastModeState.reasoningEffort === "xhigh"
    && !reasoningInputBatchByKey.size
    && !reasoningVisualOverrideByThreadId.has(localThreadB.id)
    && !reasoningPendingCountByThreadId.has(localThreadB.id)
    && !reasoningPendingCountByContext.has(reasoningContext)
    && !reasoningBusyContexts.has(reasoningContext);
  const reasoningVisual = reasoningControlSvg({
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "ultra",
    failed: false
  }, localThreadB.id, "down");
  const reasoningControlUsesCenteredAnimatedTrack = reasoningVisual.includes(
    'data-reasoning-state="ultra"'
  ) && reasoningVisual.includes('data-reasoning-direction="down"')
    && reasoningVisual.includes('data-fast-state="on"')
    && reasoningVisual.includes('data-reasoning-fast="on"')
    && reasoningVisual.includes('data-reasoning-fast-overlay="label-left"')
    && reasoningVisual.includes('data-reasoning-label-layer="center"')
    && reasoningVisual.includes('data-reasoning-label="ultra"')
    && reasoningVisual.includes('>ULTRA</text>')
    && reasoningVisual.indexOf('data-reasoning-fast="on"')
      > reasoningVisual.indexOf('data-reasoning-label="ultra"')
    && reasoningVisual.includes('x="72" y="58"')
    && reasoningVisual.includes('text-anchor="middle">ULTRA</text>')
    && reasoningVisual.includes('x="16" y="79" width="114" height="24"')
    && !reasoningVisual.includes('M59 109L50 100L59 91');
  const previousFixedRenderTimeMs = fixedRenderTimeMs;
  reasoningProgressTransitionByKey.delete(`control:${localThreadB.id}`);
  reasoningProgressTransitionByKey.delete(`thread:${localThreadB.id}`);
  fixedRenderTimeMs = 2_000;
  reasoningControlSvg({
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    reasoningEffort: "medium",
    failed: false
  }, localThreadB.id);
  threadSvg({
    ...localThreadB,
    status: "working",
    reasoningEffort: "medium",
    serviceTier: "default"
  }, 0);
  const controlTransitionStart = reasoningControlSvg({
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    reasoningEffort: "high",
    failed: false
  }, localThreadB.id);
  const threadTransitionStart = threadSvg({
    ...localThreadB,
    status: "working",
    reasoningEffort: "high",
    serviceTier: "default"
  }, 0);
  fixedRenderTimeMs = 2_160;
  const controlTransitionMiddle = reasoningControlSvg({
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    reasoningEffort: "high",
    failed: false
  }, localThreadB.id);
  const threadTransitionMiddle = threadSvg({
    ...localThreadB,
    status: "working",
    reasoningEffort: "high",
    serviceTier: "default"
  }, 0);
  const progressOf = (svg) => Number.parseFloat(
    svg.match(/data-reasoning-progress="([0-9.]+)"/)?.[1] ?? "NaN"
  );
  const effortBarsAnimateBidirectionally = progressOf(controlTransitionStart) === 0.41
    && progressOf(threadTransitionStart) === 0.41
    && progressOf(controlTransitionMiddle) > 0.41
    && progressOf(controlTransitionMiddle) < 0.59
    && progressOf(threadTransitionMiddle) > 0.41
    && progressOf(threadTransitionMiddle) < 0.59
    && reasoningProgressTransitionActive("control", localThreadB.id)
    && reasoningProgressTransitionActive("thread", localThreadB.id)
    && reasoningEffortNeedsAdvancedFallback("max")
    && reasoningEffortNeedsAdvancedFallback("ultra")
    && !reasoningEffortNeedsAdvancedFallback("xhigh");
  const fastHighState = {
    threadId: localThreadB.id,
    enabled: true,
    available: true,
    reasoningEffort: "high",
    failed: false
  };
  const fastAnimatedThread = {
    ...localThreadB,
    status: "working",
    reasoningEffort: "high",
    serviceTier: "priority"
  };
  fixedRenderTimeMs = 1_000;
  const fastReasoningFrameA = reasoningControlSvg(fastHighState, localThreadB.id);
  const fastThreadFrameA = threadSvg(fastAnimatedThread, 0);
  fixedRenderTimeMs = 1_140;
  const fastReasoningFrameB = reasoningControlSvg(fastHighState, localThreadB.id);
  const fastThreadFrameB = threadSvg(fastAnimatedThread, 0);
  const standardHighTransitionStart = reasoningControlSvg({
    ...fastHighState,
    enabled: false
  }, localThreadB.id);
  fixedRenderTimeMs = 1_400;
  const standardHighTransitionMiddle = reasoningControlSvg({
    ...fastHighState,
    enabled: false
  }, localThreadB.id);
  const decelerationWasActive = reasoningParticleTransitionActive(
    "control",
    localThreadB.id,
    fixedRenderTimeMs
  );
  fixedRenderTimeMs = 1_700;
  const standardHighVisual = reasoningControlSvg({
    ...fastHighState,
    enabled: false
  }, localThreadB.id);
  const accelerationThreadId = "particle-acceleration";
  const accelerationState = {
    ...fastHighState,
    threadId: accelerationThreadId,
    enabled: false
  };
  fixedRenderTimeMs = 2_000;
  reasoningControlSvg(accelerationState, accelerationThreadId);
  reasoningControlSvg({ ...accelerationState, enabled: true }, accelerationThreadId);
  fixedRenderTimeMs = 2_210;
  const accelerationMiddle = reasoningControlSvg(
    { ...accelerationState, enabled: true },
    accelerationThreadId
  );
  const accelerationWasActive = reasoningParticleTransitionActive(
    "control",
    accelerationThreadId,
    fixedRenderTimeMs
  );
  fixedRenderTimeMs = 2_480;
  const accelerationSettled = reasoningControlSvg(
    { ...accelerationState, enabled: true },
    accelerationThreadId
  );
  fixedRenderTimeMs = 1_000;
  const standardUltraThreadId = "standard-ultra-particles";
  const standardUltraState = {
    ...fastHighState,
    threadId: standardUltraThreadId,
    enabled: false,
    reasoningEffort: "ultra"
  };
  const standardUltraFrameA = reasoningControlSvg(standardUltraState, standardUltraThreadId);
  fixedRenderTimeMs = 1_140;
  const standardUltraFrameB = reasoningControlSvg(standardUltraState, standardUltraThreadId);
  const reasoningFastLabelCases = [
    ["low", "gpt-5.6-terra", "TERRA LIGHT"],
    ["low", "gpt-5.6-sol", "LIGHT"],
    ["medium", "gpt-5.6-sol", "MEDIUM"],
    ["high", "gpt-5.6-sol", "HIGH"],
    ["xhigh", "gpt-5.6-sol", "XHIGH"],
    ["max", "gpt-5.6-sol", "MAX"],
    ["ultra", "gpt-5.6-sol", "ULTRA"]
  ];
  const reasoningFastGlyphStaysLeftOfLabel = reasoningFastLabelCases.every(([
    effort,
    model,
    label
  ]) => {
    const threadId = `layout-${effort}-${model}`;
    const svg = reasoningControlSvg({
      threadId,
      enabled: true,
      available: true,
      reasoningEffort: effort,
      model,
      failed: false
    }, threadId);
    const glyphX = Number.parseFloat(
      svg.match(/data-reasoning-fast="on"[^>]*data-reasoning-fast-left="([0-9.]+)"/)?.[1]
        ?? "NaN"
    );
    const metrics = REASONING_CONTROL_LABEL_METRICS[label];
    const labelLeftX = 72 - metrics.width / 2;
    const expectedGlyphX = Math.max(
      2,
      labelLeftX - 7 - REASONING_FAST_GLYPH_WIDTH
    );
    return Number.isFinite(glyphX)
      && glyphX >= 2
      && Math.abs(glyphX - expectedGlyphX) <= 0.051
      && labelLeftX - (glyphX + REASONING_FAST_GLYPH_WIDTH) >= 5.4
      && svg.includes('data-reasoning-fast-overlay="label-left"')
      && !svg.includes('<svg data-reasoning-fast="on"')
      && svg.includes(
        `transform="translate(${(
          expectedGlyphX
          - REASONING_FAST_GLYPH_SOURCE_LEFT * REASONING_FAST_GLYPH_SCALE
        ).toFixed(1)} ${REASONING_FAST_GLYPH_TRANSLATE_Y}) scale(${REASONING_FAST_GLYPH_SCALE})"`
      )
      && svg.includes(`d="${REASONING_FAST_BOLT_PATH}"`)
      && svg.includes('data-reasoning-label-layer="center"')
      && svg.indexOf('data-reasoning-fast="on"')
        > svg.indexOf(`data-reasoning-label="${effort}"`)
      && svg.includes('x="72" y="58"')
      && svg.includes(`text-anchor="middle">${label}</text>`);
  })
    && !reasoningVisual.includes('M117 15L108 29H114L111 39L124 24H117Z')
    && !standardHighVisual.includes('data-reasoning-fast="on"')
    && standardHighVisual.includes('x="72" y="58"')
    && standardHighVisual.includes('text-anchor="middle">HIGH</text>');
  fixedRenderTimeMs = previousFixedRenderTimeMs;
  const particleSpeedOf = (svg) => Number.parseFloat(
    svg.match(/data-reasoning-particle-speed="([0-9.]+)"/)?.[1] ?? "NaN"
  );
  const fastParticlesAnimateAcrossFrames = fastReasoningFrameA.includes('<circle cx="')
    && fastThreadFrameA.includes('<circle cx="')
    && fastReasoningFrameA.includes('data-reasoning-particles="flow"')
    && fastThreadFrameA.includes('data-reasoning-particles="flow"')
    && fastReasoningFrameA !== fastReasoningFrameB
    && fastThreadFrameA !== fastThreadFrameB
    && !standardHighVisual.includes('<circle cx="')
    && reasoningControlShouldAnimate(fastHighState, localThreadB.id)
    && threadReasoningTrackShouldAnimate(fastAnimatedThread);
  const fastParticlesEaseBetweenSpeeds = standardHighTransitionStart.includes(
    'data-reasoning-particles="decelerating"'
  )
    && particleSpeedOf(standardHighTransitionStart) >= 0.998
    && standardHighTransitionMiddle.includes('data-reasoning-particles="decelerating"')
    && particleSpeedOf(standardHighTransitionMiddle) > 0
    && particleSpeedOf(standardHighTransitionMiddle) < 1
    && decelerationWasActive
    && !standardHighVisual.includes('<circle cx="')
    && accelerationMiddle.includes('data-reasoning-particles="accelerating"')
    && particleSpeedOf(accelerationMiddle) > 0
    && particleSpeedOf(accelerationMiddle) < 1
    && accelerationWasActive
    && accelerationSettled.includes('data-reasoning-particles="flow"')
    && particleSpeedOf(accelerationSettled) >= 0.998;
  const firstParticlePosition = (svg) => {
    const match = svg.match(/<circle cx="([0-9.]+)" cy="([0-9.]+)"/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  const standardUltraParticleA = firstParticlePosition(standardUltraFrameA);
  const standardUltraParticleB = firstParticlePosition(standardUltraFrameB);
  const ultraStandardParticlesJitterInPlace = standardUltraFrameA.includes(
    'data-reasoning-particles="jitter"'
  ) && standardUltraFrameB.includes('data-reasoning-particles="jitter"')
    && !standardUltraFrameA.includes('data-reasoning-particles="flow"')
    && standardUltraFrameA !== standardUltraFrameB
    && standardUltraParticleA !== null
    && standardUltraParticleB !== null
    && Math.abs(standardUltraParticleA.x - standardUltraParticleB.x) <= 1
    && Math.abs(standardUltraParticleA.y - standardUltraParticleB.y) <= 2
    && reasoningControlShouldAnimate(standardUltraState, standardUltraThreadId);

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
  // This scenario only verifies creation actions waiting behind Fast mode.
  // Do not let its intentionally provisional New Task composer become the
  // parent of the independent Side Chat scenario below.
  clearComposerFocusLease({ render: false });

  let resolveSideChatLease;
  const sideChatLease = new Promise((resolve) => { resolveSideChatLease = resolve; });
  activeFastModeUpdate = sideChatLease;
  let sideChatMutations = 0;
  const deferredSideChat = openSideChat("interaction-side-chat-after-fast", {
    nowMs: 1234,
    synchronizeCurrent: async () => currentThreadForDisplay(),
    openApp: async () => { sideChatMutations += 1; },
    sleep: async () => {},
    bridge: () => {
      sideChatMutations += 1;
      return true;
    },
    scheduleRefreshes: () => { sideChatMutations += 1; },
    waitComposerReady: async (requestedAtMs) => ({ requestedAtMs }),
    waitFocused: async () => {
      sideChatMutations += 1;
      return { id: "00000000-0000-7000-8000-000000000033" };
    }
  });
  await Promise.resolve();
  const sideChatWaited = sideChatMutations === 0;
  activeFastModeUpdate = null;
  resolveSideChatLease(true);
  const sideChatOpened = await deferredSideChat;
  const sideChatUsesCurrentParent = pendingSideChatTarget?.parentId === primaryThreadId;
  const composerCreatingActionsWaitForFastToggle = newThreadWaited
    && newThreadOpened
    && newThreadMutations === 2
    && sideChatWaited
    && sideChatOpened
    && sideChatMutations === 4;
  pendingSideChatTarget = null;

  clearComposerFocusLease({ render: false });
  const projectRoot = "/tmp/threaddeck-project";
  const promotedProjectThreadId = "00000000-0898-7000-8000-000000000043";
  const projectState = {
    "local-projects": {
      "threaddeck-project": {
        id: "threaddeck-project",
        rootPaths: [projectRoot]
      }
    },
    "thread-project-assignments": {
      [localThreadA.id]: {
        projectKind: "local",
        projectId: "threaddeck-project",
        cwd: projectRoot
      },
      [promotedProjectThreadId]: {
        projectKind: "local",
        projectId: "threaddeck-project",
        cwd: projectRoot
      }
    },
    "projectless-thread-ids": [localThreadB.id]
  };
  const knownNewThreadIds = new Set([
    localThreadA.id,
    localThreadB.id,
    localThreadC.id
  ]);
  const projectNewThreadCommands = [];
  const projectNewThreadOpened = await openNewThread("interaction-project-new-thread", {
    nowMs: 2_000,
    synchronizeCurrent: async () => ({ ...localThreadA, cwd: projectRoot }),
    readGlobalState: async () => projectState,
    readKnownThreadIds: async () => knownNewThreadIds,
    openApp: async () => {},
    sleep: async () => {},
    bridge: (command) => {
      projectNewThreadCommands.push(command);
      return true;
    },
    scheduleRefreshes: () => {}
  });
  const projectNewThreadPlaceholder = currentThreadForDisplay();
  const projectNewThreadKeepsScope = projectNewThreadOpened
    && projectNewThreadCommands.join(",") === "new-project-thread"
    && isProvisionalNewThread(projectNewThreadPlaceholder)
    && currentControlThreadId() === projectNewThreadPlaceholder?.id
    && activeComposerFocusLease?.projectContext?.inProject === true
    && activeComposerFocusLease?.projectContext?.projectId === "threaddeck-project";
  const promotedProjectThread = {
    id: promotedProjectThreadId,
    title: "프로젝트 새 작업",
    cwd: projectRoot,
    status: "idle",
    recency_at: 2.2
  };
  const resolvedProjectThread = await resolvePendingNewThreadTarget(
    [promotedProjectThread],
    Promise.resolve(projectState)
  );
  const projectNewThreadPromotesMatchingTask = resolvedProjectThread?.id
      === promotedProjectThreadId
    && currentControlThreadId() === promotedProjectThreadId
    && !isProvisionalNewThread(currentThreadForDisplay());
  const manualSwitchRevokesNewThreadPlaceholder = revokeComposerFocusForRendererCurrent(
    localThreadB.id,
    { render: false }
  ) && activeComposerFocusLease === null;

  const standaloneNewThreadCommands = [];
  const standaloneNewThreadOpened = await openNewThread(
    "interaction-standalone-new-thread",
    {
      nowMs: 3_000,
      synchronizeCurrent: async () => localThreadB,
      readGlobalState: async () => projectState,
      readKnownThreadIds: async () => knownNewThreadIds,
      openApp: async () => {},
      sleep: async () => {},
      bridge: (command) => {
        standaloneNewThreadCommands.push(command);
        return true;
      },
      scheduleRefreshes: () => {}
    }
  );
  const standaloneNewThreadPlaceholder = currentThreadForDisplay();
  const standaloneNewThreadKeepsScope = standaloneNewThreadOpened
    && standaloneNewThreadCommands.join(",") === "new-thread"
    && isProvisionalNewThread(standaloneNewThreadPlaceholder)
    && currentControlThreadId() === standaloneNewThreadPlaceholder?.id
    && activeComposerFocusLease?.projectContext?.inProject === false;
  clearComposerFocusLease({ render: false });

  const focusedSideChatThread = {
    id: "00000000-0000-7000-8000-000000000034",
    title: "새 사이드챗",
    parentId: localThreadB.id,
    remote: false,
    ephemeral: true,
    status: "idle"
  };
  let releaseSideChatFocus;
  let sideChatFocusWaitStarted;
  const sideChatFocusFeedbackKinds = [];
  const sideChatFocusGate = new Promise((resolve) => { releaseSideChatFocus = resolve; });
  const sideChatFocusReady = new Promise((resolve) => { sideChatFocusWaitStarted = resolve; });
  const sideChatCreationForVoice = openSideChat("interaction-side-chat-focus-voice", {
    nowMs: 2234,
    synchronizeCurrent: async () => localThreadB,
    openApp: async () => {},
    sleep: async () => {},
    bridge: () => true,
    feedback: (_context, kind) => { sideChatFocusFeedbackKinds.push(kind); },
    scheduleRefreshes: () => {},
    waitComposerReady: async (requestedAtMs) => ({ requestedAtMs }),
    waitFocused: async () => {
      sideChatFocusWaitStarted();
      await sideChatFocusGate;
      primaryThreadId = focusedSideChatThread.id;
      primaryThreadRow = focusedSideChatThread;
      threadSlots = [focusedSideChatThread, ...Array(THREAD_COUNT - 1).fill(null)];
      pendingSideChatTarget = null;
      return focusedSideChatThread;
    }
  });
  await sideChatFocusReady;
  await activeComposerCreation?.composerReadyPromise;
  const sideChatButtonClearsLoadingAtComposerReady =
    sideChatFocusFeedbackKinds.join(",") === "loading,success";
  const sideChatVoiceContext = "interaction-side-chat-focus-voice-control";
  contexts.set(sideChatVoiceContext, ACTIONS.voice);
  contextImages.set(sideChatVoiceContext, voiceSvg("idle"));
  let sideChatVoiceSynchronizations = 0;
  let sideChatVoiceTargetId = null;
  let sideChatVoiceProvisionalAtMs = null;
  const sideChatVoiceStarted = beginCurrentVoicePress(sideChatVoiceContext, {
    synchronizeCurrent: async () => {
      sideChatVoiceSynchronizations += 1;
      return focusedSideChatThread;
    },
    focusComposer: async () => true,
    focusSideChatComposer: async () => true,
    focusProbe: async () => ({ stdout: "match=uuid" }),
    beginVoice: (voiceContext, voiceOptions) => {
      sideChatVoiceTargetId = voiceOptions.targetThreadId;
      sideChatVoiceProvisionalAtMs = voiceOptions.provisionalSideChatRequestedAtMs;
      voiceTranscriptionByContext.set(voiceContext, {
        targetThreadId: null,
        provisionalSideChatRequestedAtMs: voiceOptions.provisionalSideChatRequestedAtMs
      });
      return true;
    }
  });
  const sideChatVoiceState = currentVoicePressByContext.get(sideChatVoiceContext);
  const sideChatVoicePrepared = await sideChatVoiceState?.promise;
  const sideChatVoiceStartedBeforeIdentity = sideChatVoicePrepared
    && sideChatVoiceSynchronizations === 0
    && sideChatVoiceTargetId === ""
    && sideChatVoiceProvisionalAtMs === 2234
    && voiceTranscriptionByContext.get(sideChatVoiceContext)
      ?.provisionalSideChatRequestedAtMs === 2234;
  releaseSideChatFocus();
  const sideChatCreationFocused = await sideChatCreationForVoice;
  const sideChatVoiceWasBoundToRealTask = voiceTargetThreadByContext.get(sideChatVoiceContext)
      === focusedSideChatThread.id
    && voiceTranscriptionByContext.get(sideChatVoiceContext)?.targetThreadId
      === focusedSideChatThread.id
    && voiceTranscriptionByContext.get(sideChatVoiceContext)
      ?.provisionalSideChatRequestedAtMs === undefined;
  cancelCurrentVoicePress(sideChatVoiceContext, false);
  cancelVoiceTranscription(sideChatVoiceContext, true);
  contexts.delete(sideChatVoiceContext);
  contextImages.delete(sideChatVoiceContext);
  const sideChatVoiceUsesProvisionalComposer = sideChatVoiceStarted
    && sideChatVoiceStartedBeforeIdentity
    && sideChatCreationFocused
    && sideChatVoiceWasBoundToRealTask
    && sideChatVoiceSynchronizations === 0;

  primaryThreadId = localThreadB.id;
  primaryThreadRow = localThreadB;
  threadSlots = [localThreadB, focusedSideChatThread, ...Array(THREAD_COUNT - 2).fill(null)];
  fastModeState = {
    threadId: localThreadB.id,
    enabled: false,
    available: true,
    reasoningEffort: "low",
    failed: false
  };
  let releaseReasoningSideChatFocus;
  const reasoningSideChatFocusGate = new Promise((resolve) => {
    releaseReasoningSideChatFocus = resolve;
  });
  activeComposerCreation = {
    kind: "side-chat",
    controller: new AbortController(),
    promise: reasoningSideChatFocusGate.then(() => {
      primaryThreadId = focusedSideChatThread.id;
      primaryThreadRow = focusedSideChatThread;
      threadSlots = [focusedSideChatThread, localThreadB, ...Array(THREAD_COUNT - 2).fill(null)];
      return true;
    })
  };
  const sideChatReasoningContext = "interaction-side-chat-focus-reasoning";
  contexts.set(sideChatReasoningContext, ACTIONS.reasoning);
  let sideChatReasoningSynchronizations = 0;
  let sideChatReasoningSteps = 0;
  const sideChatReasoning = stepReasoningEffort(sideChatReasoningContext, {
    synchronizeCurrent: async () => {
      sideChatReasoningSynchronizations += 1;
      return focusedSideChatThread;
    },
    focusProbe: async () => ({ stdout: "match=uuid" }),
    stepEffort: async () => {
      sideChatReasoningSteps += 1;
      return {
        stdout: "previous=low reasoning=medium options=low,medium,high,xhigh,ultra steps=1 service_tier=default available=1 changed=1 verified=1 direction=up at_min=0 at_max=0 composer_focused=1\n"
      };
    }
  });
  await Promise.resolve();
  const sideChatReasoningWaitedForFocus = sideChatReasoningSynchronizations === 0
    && sideChatReasoningSteps === 0;
  releaseReasoningSideChatFocus();
  const sideChatReasoningApplied = await sideChatReasoning;
  activeComposerCreation = null;
  contexts.delete(sideChatReasoningContext);
  const sideChatReasoningUsesFocusedTask = sideChatReasoningWaitedForFocus
    && sideChatReasoningApplied
    && sideChatReasoningSynchronizations === 1
    && sideChatReasoningSteps === 1
    && fastModeState.threadId === focusedSideChatThread.id
    && fastModeState.reasoningEffort === "medium";

  let persistentSideChatWindowReads = 0;
  const persistentSideChatSync = await synchronizeCurrentCodexThread({
    force: true,
    readWindows: async () => {
      persistentSideChatWindowReads += 1;
      return [];
    },
    refreshFastMode: false
  });
  const persistentVoiceContext = "interaction-side-chat-persistent-voice";
  contexts.set(persistentVoiceContext, ACTIONS.voice);
  contextImages.set(persistentVoiceContext, voiceSvg("idle"));
  let persistentVoiceFocuses = 0;
  let persistentVoiceTargetId = null;
  beginCurrentVoicePress(persistentVoiceContext, {
    sideChatCreation: null,
    synchronizeCurrent: async (syncOptions) => synchronizeCurrentCodexThread({
      ...syncOptions,
      readWindows: async () => {
        persistentSideChatWindowReads += 1;
        return [];
      }
    }),
    focusComposer: async () => {
      persistentVoiceFocuses += 1;
      return true;
    },
    focusProbe: async () => ({ stdout: "match=uuid" }),
    beginVoice: (_voiceContext, voiceOptions) => {
      persistentVoiceTargetId = voiceOptions.targetThreadId;
      return true;
    }
  });
  const persistentVoiceState = currentVoicePressByContext.get(persistentVoiceContext);
  const persistentVoiceStarted = await persistentVoiceState?.promise;
  cancelCurrentVoicePress(persistentVoiceContext, false);
  contexts.delete(persistentVoiceContext);
  contextImages.delete(persistentVoiceContext);

  const persistentSendContext = "interaction-side-chat-persistent-send";
  contexts.set(persistentSendContext, ACTIONS.send);
  beginSendPress(persistentSendContext);
  let persistentSendFocuses = 0;
  let persistentSendCommand = null;
  const persistentSendResult = await endSendPress(persistentSendContext, {
    synchronizeCurrent: async (syncOptions) => synchronizeCurrentCodexThread({
      ...syncOptions,
      readWindows: async () => {
        persistentSideChatWindowReads += 1;
        return [];
      }
    }),
    focusComposer: async () => {
      persistentSendFocuses += 1;
      return true;
    },
    focusProbe: async () => ({ stdout: "match=uuid" }),
    sendCommand: async (command) => {
      persistentSendCommand = command;
      return true;
    }
  });
  contexts.delete(persistentSendContext);
  const sideChatFocusPersistsAcrossControls = persistentSideChatSync?.id
      === focusedSideChatThread.id
    && persistentSideChatWindowReads === 0
    && currentThreadForDisplay()?.id === focusedSideChatThread.id
    && persistentVoiceStarted
    && persistentVoiceFocuses === 1
    && persistentVoiceTargetId === focusedSideChatThread.id
    && persistentSendResult
    && persistentSendFocuses === 1
    && persistentSendCommand === "send";

  let pairedParentNavigations = 0;
  let pairedTabActivations = 0;
  let pairedFocusChecks = 0;
  const pairedSideChatNavigation = await performListedSideChatNavigation(
    focusedSideChatThread,
    1,
    {
      parentThread: localThreadB,
      focusSideChatComposer: async () => true,
      sideChatFocused: async () => {
        pairedFocusChecks += 1;
        return pairedFocusChecks >= 2;
      },
      activateMountedSideChat: async () => null,
      navigateParent: async (parent) => {
        if (parent.id === localThreadB.id) pairedParentNavigations += 1;
        return true;
      },
      activateSideChat: async () => {
        pairedTabActivations += 1;
        return true;
      }
    }
  );
  const listedSideChatRestoresPairedView = pairedSideChatNavigation
    && pairedParentNavigations === 1
    && pairedTabActivations === 1
    && pairedFocusChecks === 2;

  let exactSideChatTabActivations = 0;
  let staleSideChatTitleChecks = 0;
  const exactSideChatNavigation = await performListedSideChatNavigation(
    focusedSideChatThread,
    1,
    {
      parentThread: localThreadB,
      focusSideChatComposer: async () => true,
      sideChatFocused: async () => {
        staleSideChatTitleChecks += 1;
        return false;
      },
      activateMountedSideChat: async () => null,
      navigateParent: async () => true,
      activateSideChat: async () => {
        exactSideChatTabActivations += 1;
        return { identityVerified: true };
      }
    }
  );
  const exactSideChatUuidBypassesStaleTitle = exactSideChatNavigation
    && exactSideChatTabActivations === 1
    && staleSideChatTitleChecks === 1;

  let mountedSideChatFocuses = 0;
  let mountedSideChatActivations = 0;
  let mountedSideChatParentNavigations = 0;
  const mountedSideChatNavigation = await performListedSideChatNavigation(
    focusedSideChatThread,
    1,
    {
      parentThread: localThreadB,
      focusSideChatComposer: async () => {
        mountedSideChatFocuses += 1;
        return mountedSideChatFocuses >= 2;
      },
      sideChatFocused: async () => false,
      activateMountedSideChat: async () => {
        mountedSideChatActivations += 1;
        return { identityVerified: true };
      },
      navigateParent: async () => {
        mountedSideChatParentNavigations += 1;
        return true;
      }
    }
  );
  const mountedSideChatSwitchesWithoutParentReplay = mountedSideChatNavigation
    && mountedSideChatFocuses === 2
    && mountedSideChatActivations === 1
    && mountedSideChatParentNavigations === 0;

  let listedSideChatFinalFocuses = 0;
  const listedSideChatOpenResult = await openListedSideChat(
    "interaction-listed-side-chat-focus",
    focusedSideChatThread,
    {
      navigateSideChat: async () => true,
      focusSideChatComposer: async () => {
        listedSideChatFinalFocuses += 1;
        return activeComposerFocusLease?.targetThreadId === focusedSideChatThread.id;
      },
      rememberThread: (thread) => {
        primaryThreadId = thread.id;
        primaryThreadRow = thread;
        return true;
      },
      acknowledgeCompletion: () => {},
      feedback: () => {},
      scheduleRefresh: () => {}
    }
  );
  const listedSideChatKeyFocusesComposer = listedSideChatOpenResult
    && listedSideChatFinalFocuses === 1
    && activeComposerFocusLease?.targetThreadId === focusedSideChatThread.id
    && primaryThreadId === focusedSideChatThread.id;

  let explicitTaskComposerFocuses = 0;
  const explicitSwitchResult = await openThread(
    "interaction-side-chat-explicit-switch",
    0,
    {
      thread: localThreadA,
      feedback: () => {},
      navigateDeepLink: async () => true,
      focusThreadComposer: async () => {
        explicitTaskComposerFocuses += 1;
        return activeComposerFocusLease === null;
      },
      rememberThread: (thread) => {
        primaryThreadId = thread.id;
        primaryThreadRow = thread;
        return true;
      },
      acknowledgeCompletion: () => {},
      scheduleRefresh: () => {}
    }
  );
  const explicitTaskSwitchClearsSideChatPlaceholder = explicitSwitchResult
    && activeComposerFocusLease === null
    && primaryThreadId === localThreadA.id
    && explicitTaskComposerFocuses === 1;

  primaryThreadId = focusedSideChatThread.id;
  primaryThreadRow = focusedSideChatThread;
  activateSideChatFocusLease({
    requestedAtMs: 5566,
    parentId: localThreadB.id,
    targetThreadId: focusedSideChatThread.id,
    thread: focusedSideChatThread,
    render: false
  });
  pendingSideChatTarget = {
    requestedAtMs: 5566,
    knownIds: new Set(),
    parentId: localThreadB.id,
    targetThreadId: focusedSideChatThread.id
  };
  let manualOverrideComposerReadyCleared = false;
  const manualOverrideController = new AbortController();
  activeComposerCreation = {
    kind: "side-chat",
    controller: manualOverrideController,
    markComposerReady(value) {
      manualOverrideComposerReadyCleared = value === null;
      return true;
    }
  };
  const rendererSelectedSideChat = applyMicroReadOnlySnapshot({
    activeThreadKey: localThreadB.id,
    activeSideChatThreadId: focusedSideChatThread.id,
    focusedComposerKind: "side-chat",
    reasoningEffort: "high",
    fastEnabled: false
  }, {
    candidates: [localThreadA, localThreadB, focusedSideChatThread],
    promote: false
  });
  const rendererSideChatSelectionPreservesLease =
    rendererSelectedSideChat?.id === focusedSideChatThread.id
    && primaryThreadId === focusedSideChatThread.id
    && currentControlThreadId() === focusedSideChatThread.id
    && activeComposerFocusLease?.targetThreadId === focusedSideChatThread.id
    && pendingSideChatTarget?.targetThreadId === focusedSideChatThread.id
    && !manualOverrideController.signal.aborted
    && !manualOverrideComposerReadyCleared;
  const rendererSelectedCurrent = applyMicroReadOnlySnapshot({
    activeThreadKey: localThreadA.id,
    reasoningEffort: "high",
    fastEnabled: false
  }, {
    candidates: [localThreadA, localThreadB, focusedSideChatThread],
    promote: false
  });
  const rendererSelectionRevokesSideChatLease = rendererSelectedCurrent?.id === localThreadA.id
    && primaryThreadId === localThreadA.id
    && currentControlThreadId() === localThreadA.id
    && activeComposerFocusLease === null
    && pendingSideChatTarget === null
    && manualOverrideController.signal.aborted
    && manualOverrideComposerReadyCleared;
  activeComposerCreation = null;

  primaryThreadId = focusedSideChatThread.id;
  primaryThreadRow = focusedSideChatThread;
  activateSideChatFocusLease({
    requestedAtMs: 6677,
    parentId: localThreadB.id,
    targetThreadId: focusedSideChatThread.id,
    thread: focusedSideChatThread,
    render: false
  });
  pendingSideChatTarget = {
    requestedAtMs: 6677,
    knownIds: new Set(),
    parentId: localThreadB.id,
    targetThreadId: focusedSideChatThread.id
  };
  const rendererFocusedMainComposer = applyMicroReadOnlySnapshot({
    activeThreadKey: localThreadB.id,
    activeSideChatThreadId: focusedSideChatThread.id,
    focusedComposerKind: "main",
    reasoningEffort: "high",
    fastEnabled: false
  }, {
    candidates: [localThreadA, localThreadB, focusedSideChatThread],
    promote: false
  });
  const focusedMainComposerRevokesSelectedSideChat =
    rendererFocusedMainComposer?.id === localThreadB.id
    && primaryThreadId === localThreadB.id
    && currentControlThreadId() === localThreadB.id
    && activeComposerFocusLease === null
    && pendingSideChatTarget === null;

  clearComposerFocusLease({ render: false });
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
    synchronizeCurrent: async () => currentThreadForDisplay(),
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
    && compactGoalQueueTimingIsVerticallyCentered
    && completedGoalLifetimeFollowsTurn
    && remoteGoalProbeNeedsStableAbsence
    && unknownNewGoalDoesNotInheritCompletedTime
    && expiredRemoteGoalCacheIsPruned
    && knownTitleAmbiguityDetected
    && ambiguousTitleUsesStrictIdentity
    && sameTitleVoiceTargetIsIdentitySafe
    && manualCodexSelectionOverridesStreamDeckHistory
    && sameTaskComposerStateRecoversWithoutIdentityChange
    && dashboardControlsUseCurrentTask
    && microVoiceDoesNotNeedForegroundFocus
    && microVoiceMismatchFailsClosed
    && composerChangesStayNextTurnOnly
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
    && shortTaskTapBringsCodexForward
    && missingBaselineRejected
    && mediaPauseLeaseIsBalanced
    && alreadyPausedMediaIsNeverToggled
    && multiOwnerResumeDebouncesOnce
    && failedResumeRetainsState
    && concurrentResumeBeforeDispatchIsCoalesced
    && postDispatchResumeRaceReassertsPause
    && wrongTargetCannotSubmit
    && microSubmitDoesNotActivateCodex
    && offExitIsConfirmedState
    && passiveComposerReadDoesNotClaimSpeed
    && taskMetadataRestoresFastWithoutMenu
    && confirmedComposerStateSurvivesStaleMetadata
    && directCodexComposerChangeRefreshesControlOnly
    && fastModeVisualsAreIconFirst
    && fastToggleWaitedForNavigation
    && fastToggleIsCoalescedAndConfirmed
    && fastSetTimeoutIsReconciled
    && singleShotFastToggleUsesOneNativeAction
    && fastToggleRestoresComposerAfterNativeFocusMiss
    && fastModeWorksOnRelease
    && reasoningFastToggleStartsAtThreshold
    && reasoningFastHoldSurvivesEffortSuccessor
    && reasoningPingPongStateIsVerified
    && optimisticReasoningMovesBeforeNativeConfirmation
    && userSpecificReasoningOptionsAreRespected
    && terraLightPowerAxisIsConnected
    && reasoningFinalTargetPlanningIsSafe
    && advancedReasoningForegroundPreparation
    && rapidReasoningCoalescesToFinalTarget
    && reasoningInputDuringApplyStartsOneSuccessor
    && reasoningControlUsesCenteredAnimatedTrack
    && reasoningFastGlyphStaysLeftOfLabel
    && effortBarsAnimateBidirectionally
    && fastParticlesAnimateAcrossFrames
    && fastParticlesEaseBetweenSpeeds
    && ultraStandardParticlesJitterInPlace
    && staleFastRefreshCannotOverwriteToggle
    && fastRefreshRecoversWithoutPageReentry
    && navigationWaitsForFastToggle
    && composerCreatingActionsWaitForFastToggle
    && sideChatUsesCurrentParent
    && projectNewThreadKeepsScope
    && projectNewThreadPromotesMatchingTask
    && manualSwitchRevokesNewThreadPlaceholder
    && standaloneNewThreadKeepsScope
    && sideChatButtonClearsLoadingAtComposerReady
    && sideChatVoiceUsesProvisionalComposer
    && sideChatReasoningUsesFocusedTask
    && sideChatFocusPersistsAcrossControls
    && listedSideChatRestoresPairedView
    && exactSideChatUuidBypassesStaleTitle
    && mountedSideChatSwitchesWithoutParentReplay
    && listedSideChatKeyFocusesComposer
    && explicitTaskSwitchClearsSideChatPlaceholder
    && rendererSideChatSelectionPreservesLease
    && rendererSelectionRevokesSideChatLease
    && focusedMainComposerRevokesSelectedSideChat
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
    compactGoalQueueTimingIsVerticallyCentered,
    completedGoalLifetimeFollowsTurn,
    remoteGoalProbeNeedsStableAbsence,
    unknownNewGoalDoesNotInheritCompletedTime,
    expiredRemoteGoalCacheIsPruned,
    knownTitleAmbiguityDetected,
    ambiguousTitleUsesStrictIdentity,
    sameTitleVoiceTargetIsIdentitySafe,
    manualCodexSelectionOverridesStreamDeckHistory,
    sameTaskComposerStateRecoversWithoutIdentityChange,
    dashboardControlsUseCurrentTask,
    microVoiceDoesNotNeedForegroundFocus,
    microVoiceMismatchFailsClosed,
    composerChangesStayNextTurnOnly,
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
    shortTaskTapBringsCodexForward,
    missingBaselineRejected,
    mediaPauseLeaseIsBalanced,
    alreadyPausedMediaIsNeverToggled,
    multiOwnerResumeDebouncesOnce,
    failedResumeRetainsState,
    concurrentResumeBeforeDispatchIsCoalesced,
    postDispatchResumeRaceReassertsPause,
    wrongTargetCannotSubmit,
    microSubmitDoesNotActivateCodex,
    offExitIsConfirmedState,
    passiveComposerReadDoesNotClaimSpeed,
    taskMetadataRestoresFastWithoutMenu,
    confirmedComposerStateSurvivesStaleMetadata,
    directCodexComposerChangeRefreshesControlOnly,
    fastModeVisualsAreIconFirst,
    fastToggleWaitedForNavigation,
    fastToggleIsCoalescedAndConfirmed,
    fastSetTimeoutIsReconciled,
    singleShotFastToggleUsesOneNativeAction,
    fastToggleRestoresComposerAfterNativeFocusMiss,
    fastModeWorksOnRelease,
    reasoningFastToggleStartsAtThreshold,
    reasoningFastHoldSurvivesEffortSuccessor,
    reasoningPingPongStateIsVerified,
    optimisticReasoningMovesBeforeNativeConfirmation,
    userSpecificReasoningOptionsAreRespected,
    terraLightPowerAxisIsConnected,
    reasoningFinalTargetPlanningIsSafe,
    advancedReasoningForegroundPreparation,
    rapidReasoningCoalescesToFinalTarget,
    reasoningInputDuringApplyStartsOneSuccessor,
    reasoningControlUsesCenteredAnimatedTrack,
    reasoningFastGlyphStaysLeftOfLabel,
    effortBarsAnimateBidirectionally,
    fastParticlesAnimateAcrossFrames,
    fastParticlesEaseBetweenSpeeds,
    ultraStandardParticlesJitterInPlace,
    staleFastRefreshCannotOverwriteToggle,
    passiveUnknownFastRefreshPreservesConfirmedState,
    fastRefreshRecoversWithoutPageReentry,
    navigationWaitsForFastToggle,
    composerCreatingActionsWaitForFastToggle,
    sideChatUsesCurrentParent,
    projectNewThreadKeepsScope,
    projectNewThreadPromotesMatchingTask,
    manualSwitchRevokesNewThreadPlaceholder,
    standaloneNewThreadKeepsScope,
    sideChatButtonClearsLoadingAtComposerReady,
    sideChatVoiceUsesProvisionalComposer,
    sideChatReasoningUsesFocusedTask,
    sideChatFocusPersistsAcrossControls,
    listedSideChatRestoresPairedView,
    exactSideChatUuidBypassesStaleTitle,
    mountedSideChatSwitchesWithoutParentReplay,
    listedSideChatKeyFocusesComposer,
    explicitTaskSwitchClearsSideChatPlaceholder,
    rendererSideChatSelectionPreservesLease,
    rendererSelectionRevokesSideChatLease,
    focusedMainComposerRevokesSelectedSideChat,
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
  activeComposerFocusLease = null;
  activeFastModeRefresh = null;
  activeFastModeUpdate = null;
  activeCurrentThreadSync = null;
  currentThreadIdentityCandidates = [];
  lastCurrentThreadSyncAtMs = 0;
  threadPressByContext.clear();
  currentVoicePressByContext.clear();
  activeSendDispatchByContext.clear();
  fastModePressStartedAt.clear();
  for (const timer of fastModeLongPressTimers.values()) clearTimeout(timer);
  fastModeLongPressTimers.clear();
  fastModeLongPressArmedContexts.clear();
  fastModeLongPressUpdates.clear();
  cancelReasoningInputBatches();
  reasoningBusyContexts.clear();
  reasoningDirectionByThreadId.clear();
  reasoningAvailableEffortsByThreadId.clear();
  reasoningPowerSelectionsByThreadId.clear();
  reasoningVisualOverrideByThreadId.clear();
  reasoningProgressTransitionByKey.clear();
  reasoningParticleMotionByKey.clear();
  reasoningPendingCountByThreadId.clear();
  reasoningPendingCountByContext.clear();
  voiceHeldContexts.clear();
  voiceReleasePendingContexts.clear();
  voiceTranscriptionByContext.clear();
  voiceStateByContext.clear();
  voiceStateResetAtMs.clear();
  voiceTargetThreadByContext.clear();
  voiceSessionIdByContext.clear();
  voiceBackendByContext.clear();
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
    codexMicroBootstrap.close();
    codexControlPlane.close();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    releaseVoiceKeysSync();
    codexMicroBootstrap.close();
    codexControlPlane.close();
    process.exit(0);
  });
  process.on("exit", () => {
    releaseVoiceKeysSync();
    codexMicroBootstrap.close();
    codexControlPlane.close();
  });
}

function runSelectedMode() {
  if (keyBridgePermissionContractMode) {
    fsSync.accessSync(KEY_BRIDGE, fsSync.constants.X_OK);
    console.log(JSON.stringify({
      passed: true,
      keybridgeExecutable: true,
      packagedPath: PACKAGED_KEY_BRIDGE,
      runtimePath: KEY_BRIDGE
    }));
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
  if (!renderingOnly) KEY_BRIDGE = prepareKeyBridgeExecutable(PACKAGED_KEY_BRIDGE);
  installShutdownHandlers();
  runSelectedMode();
}

if (require.main === module) main();

module.exports = { main, shouldProbeRemoteComposerState };
