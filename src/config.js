"use strict";

const ACTIONS = {
  weekly: "com.yechan.threaddeck.weekly",
  topThread1: "com.yechan.threaddeck.thread.top1",
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
  fastMode: "com.yechan.threaddeck.fastmode",
  reasoning: "com.yechan.threaddeck.reasoning",
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

const RANKED_THREAD_ACTIONS = [
  ACTIONS.topThread1,
  ACTIONS.thread2,
  ACTIONS.thread3,
  ACTIONS.thread4,
  ACTIONS.thread5,
  ACTIONS.thread6,
  ACTIONS.thread7,
  ACTIONS.thread8
];
const THREAD_ACTIONS = [
  ACTIONS.thread1,
  ...RANKED_THREAD_ACTIONS
];
const THREAD_COUNT = RANKED_THREAD_ACTIONS.length;
const CURRENT_THREAD_SLOT = -1;
const THREAD_COMPLETION_PULSE_DURATION_MS = 5200;
const THREAD_REFRESH_RETRY_DELAYS_MS = [120, 360];
const THREAD_REFRESH_STARTUP_ERROR_FAILURES = 3;
const GLOBAL_COMPLETION_PULSE_DURATION_MS = 2600;
const GLOBAL_COMPLETION_FRAME_INTERVAL_MS = 40;
const GLOBAL_COMPLETION_GROUP_COUNT = 1;
const UNREAD_COMPLETION_PULSE_PERIOD_MS = 2800;
const UNREAD_COMPLETION_FRAME_INTERVAL_MS = 33;
const UNREAD_COMPLETION_GROUP_COUNT = 1;
const UNREAD_COMPLETION_DISMISS_FADE_MS = 720;
const COMPLETION_STARTUP_GRACE_MS = 15_000;
const COMPLETION_OBSERVATION_OVERLAP_MS = 1_500;
const SEND_LONG_PRESS_MS = 600;
const FAST_MODE_LONG_PRESS_MS = 600;
const THREAD_VOICE_LONG_PRESS_MS = 550;
const THREAD_VOICE_FOCUS_PREP_LEAD_MS = 200;
const THREAD_VOICE_FOCUS_SETTLE_MS = 60;
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
const SIDE_CHAT_COMPOSER_READY_DELAYS_MS = [0, 60, 100, 160, 260, 420, 650];
const SIDE_CHAT_TARGET_REFRESH_DELAYS_MS = [180, 500, 1_000, 1_800, 3_000, 4_800];
const SIDE_CHAT_TARGET_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const APP_SERVER_SESSION_CACHE_MS = 5_000;
const APP_SERVER_START_TOLERANCE_MS = 5_000;
const DESKTOP_LOG_PATH_CACHE_MS = 5_000;
const SIDE_CHAT_LOG_SEARCH_LIMIT_BYTES = 64 * 1024 * 1024;
const THREAD_REFRESH_ERROR_STATE = Object.freeze({
  titleKey: "thread.stateUnavailable",
  status: "error",
  pinned: false,
  activity: { kind: "error", code: "activity.error" }
});
const THREAD_SLOT_BY_ACTION = new Map([
  [ACTIONS.thread1, CURRENT_THREAD_SLOT],
  ...RANKED_THREAD_ACTIONS.map((action, index) => [action, index])
]);
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

module.exports = {
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
  FAST_MODE_LONG_PRESS_MS,
  MEDIA_COMMAND_BY_ACTION,
  PAGE_DIRECTION_BY_ACTION,
  QUEUE_ZERO_CONFIRM_MS,
  RANKED_THREAD_ACTIONS,
  SEND_LONG_PRESS_MS,
  SIDE_CHAT_COMPOSER_READY_DELAYS_MS,
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
};
