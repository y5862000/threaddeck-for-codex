#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <CoreAudio/CoreAudio.h>
#include <dispatch/dispatch.h>
#include <IOKit/hidsystem/IOLLEvent.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <ctype.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum {
  KEY_A = 0x00,
  KEY_S = 0x01,
  KEY_D = 0x02,
  KEY_O = 0x1F,
  KEY_K = 0x28,
  KEY_RETURN = 0x24,
  KEY_TAB = 0x30,
  KEY_ESCAPE = 0x35,
  KEY_COMMAND = 0x37,
  KEY_SHIFT = 0x38,
  KEY_OPTION = 0x3A,
  KEY_CONTROL = 0x3B
};

enum {
  MEDIA_SOUND_UP = 0,
  MEDIA_SOUND_DOWN = 1,
  MEDIA_MUTE = 7,
  MEDIA_PLAY_PAUSE = 16,
  MEDIA_NEXT = 17,
  MEDIA_PREVIOUS = 18,
  MEDIA_FAST_FORWARD = 19,
  MEDIA_REWIND = 20
};

typedef enum {
  VOICE_AUDIO_UNKNOWN = -1,
  VOICE_AUDIO_INACTIVE = 0,
  VOICE_AUDIO_ACTIVE = 1
} VoiceAudioState;

static bool stop_codex_composer_dictation_if_visible(void);
static bool focus_codex_composer_if_visible(void);
static bool submit_codex_composer_if_visible(void);
static VoiceAudioState codex_audio_input_state(void);
static bool codex_audio_input_is_running(void);

static CGEventRef create_key_event(
  CGKeyCode key,
  bool down,
  CGEventFlags flags,
  const UniChar *characters,
  UniCharCount character_count
) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
  if (event == NULL) return NULL;
  CGEventSetFlags(event, flags);
  if (characters != NULL && character_count > 0) {
    CGEventKeyboardSetUnicodeString(event, character_count, characters);
  }
  return event;
}

static void post_key(CGKeyCode key, bool down, CGEventFlags flags) {
  CGEventRef event = create_key_event(key, down, flags, NULL, 0);
  if (event == NULL) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(9000);
}

static void post_latin_key(
  CGKeyCode key,
  bool down,
  CGEventFlags flags,
  UniChar character
) {
  CGEventRef event = create_key_event(key, down, flags, &character, 1);
  if (event == NULL) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(9000);
}

static void voice_down(void) {
  post_key(KEY_CONTROL, true, kCGEventFlagMaskControl);
  post_key(KEY_SHIFT, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  // Electron's shortcut matching can use the layout-dependent character.
  // Attach an explicit Latin "D" while retaining the physical D key code so
  // Control+Shift+D works under Korean and other non-Latin input sources.
  post_latin_key(KEY_D, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift, 'D');
}

static void release_voice_keys(void) {
  // Keep the explicit Latin character on key-down so the shortcut works with
  // non-Latin input sources, but release the physical key without a Unicode
  // payload. Codex's global hold-hotkey watcher matches the physical key-up.
  post_key(KEY_D, false, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  post_key(KEY_SHIFT, false, kCGEventFlagMaskControl);
  post_key(KEY_CONTROL, false, 0);
}

typedef VoiceAudioState (*VoiceAudioStateProbe)(void *context);
typedef bool (*VoiceStopActivator)(void *context);
typedef void (*VoiceReleaseWaiter)(useconds_t delay_us, void *context);

typedef enum {
  VOICE_RELEASE_INACTIVE = 0,
  VOICE_RELEASE_UNCONFIRMED_NO_ACTION = 1,
  VOICE_RELEASE_UNCONFIRMED_AFTER_STOP_ACTION = 2,
  VOICE_RELEASE_UNKNOWN = 3
} VoiceReleaseOutcome;

typedef struct {
  VoiceAudioStateProbe audio_state;
  VoiceStopActivator activate_stop;
  VoiceReleaseWaiter wait;
  void *context;
} VoiceReleaseOperations;

enum {
  VOICE_RELEASE_STOP_ATTEMPTS = 4,
  VOICE_RELEASE_INACTIVE_POLLS = 12
};

static const useconds_t VOICE_RELEASE_POLL_DELAY_US = 55000;

// Complete the release without assuming that Chromium publishes its Stop
// control in the same accessibility frame as the physical key-up. This core is
// deliberately injectable so the retry/confirmation policy can be tested
// without touching the keyboard, microphone, or accessibility tree.
static VoiceReleaseOutcome finish_voice_release(VoiceReleaseOperations operations) {
  if (operations.audio_state == NULL || operations.activate_stop == NULL) {
    return VOICE_RELEASE_UNKNOWN;
  }
  for (unsigned attempt = 0; attempt < VOICE_RELEASE_STOP_ATTEMPTS; attempt += 1) {
    VoiceAudioState state = operations.audio_state(operations.context);
    if (state == VOICE_AUDIO_INACTIVE) return VOICE_RELEASE_INACTIVE;
    // An unavailable CoreAudio query is not evidence that recording stopped.
    // Retry the probe without touching an ambiguous composer control; only an
    // explicit active result authorizes the Stop-button fallback.
    bool activated = state == VOICE_AUDIO_ACTIVE
      && operations.activate_stop(operations.context);
    unsigned polls = activated ? VOICE_RELEASE_INACTIVE_POLLS : 1;
    for (unsigned poll = 0; poll < polls; poll += 1) {
      if (operations.wait != NULL) {
        operations.wait(VOICE_RELEASE_POLL_DELAY_US, operations.context);
      }
      if (operations.audio_state(operations.context) == VOICE_AUDIO_INACTIVE) {
        return VOICE_RELEASE_INACTIVE;
      }
    }
    // Once Stop accepted an action, never press the same composer control a
    // second time: during CoreAudio drain the button can already have changed
    // back to Start, and a retry would restart dictation. Poll only, then fail
    // closed if the input remains active for the full confirmation window.
    if (activated) return VOICE_RELEASE_UNCONFIRMED_AFTER_STOP_ACTION;
  }
  // A final probe closes the small gap after the last bounded wait. Never
  // report success merely because a Stop control accepted an AX action.
  VoiceAudioState final_state = operations.audio_state(operations.context);
  if (final_state == VOICE_AUDIO_INACTIVE) return VOICE_RELEASE_INACTIVE;
  return final_state == VOICE_AUDIO_UNKNOWN
    ? VOICE_RELEASE_UNKNOWN
    : VOICE_RELEASE_UNCONFIRMED_NO_ACTION;
}

static const char *voice_release_outcome_name(VoiceReleaseOutcome outcome) {
  switch (outcome) {
    case VOICE_RELEASE_INACTIVE: return "inactive";
    case VOICE_RELEASE_UNCONFIRMED_NO_ACTION: return "unconfirmed-no-action";
    case VOICE_RELEASE_UNCONFIRMED_AFTER_STOP_ACTION:
      return "unconfirmed-after-stop-action";
    case VOICE_RELEASE_UNKNOWN: return "unknown";
  }
  return "unknown";
}

static VoiceAudioState live_voice_audio_state(void *context) {
  (void)context;
  return codex_audio_input_state();
}

static bool live_voice_stop_activate(void *context) {
  (void)context;
  return stop_codex_composer_dictation_if_visible();
}

static void live_voice_release_wait(useconds_t delay_us, void *context) {
  (void)context;
  usleep(delay_us);
}

static bool voice_up(void) {
  // Release the physical shortcut first, before any CoreAudio or accessibility
  // work. Older Codex builds with a true global hold shortcut can stop here and
  // the first audio probe returns success without activating any UI control.
  release_voice_keys();
  VoiceReleaseOutcome outcome = finish_voice_release((VoiceReleaseOperations) {
    .audio_state = live_voice_audio_state,
    .activate_stop = live_voice_stop_activate,
    .wait = live_voice_release_wait,
    .context = NULL
  });
  printf("outcome=%s\n", voice_release_outcome_name(outcome));
  return outcome == VOICE_RELEASE_INACTIVE;
}

static bool voice_down_event_is_layout_independent(void) {
  UniChar expected = 'D';
  CGEventRef event = create_key_event(
    KEY_D,
    true,
    kCGEventFlagMaskControl | kCGEventFlagMaskShift,
    &expected,
    1
  );
  if (event == NULL) return false;
  UniChar actual[2] = { 0, 0 };
  UniCharCount actual_count = 0;
  CGEventKeyboardGetUnicodeString(event, 2, &actual_count, actual);
  bool matches = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == KEY_D
    && actual_count == 1
    && actual[0] == expected
    && (CGEventGetFlags(event) & (kCGEventFlagMaskControl | kCGEventFlagMaskShift))
      == (kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  CFRelease(event);
  return matches;
}

static bool voice_up_event_is_physical_release(void) {
  CGEventRef event = create_key_event(
    KEY_D,
    false,
    kCGEventFlagMaskControl | kCGEventFlagMaskShift,
    NULL,
    0
  );
  if (event == NULL) return false;
  bool matches = CGEventGetType(event) == kCGEventKeyUp
    && CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == KEY_D
    && (CGEventGetFlags(event) & (kCGEventFlagMaskControl | kCGEventFlagMaskShift))
      == (kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  CFRelease(event);
  return matches;
}

typedef struct {
  bool active;
  bool unknown;
  bool never_stops;
  bool stop_activated;
  unsigned stop_visible_on_call;
  unsigned inactive_after_activation_probes;
  unsigned probes_after_activation;
  unsigned audio_probe_calls;
  unsigned stop_activation_calls;
  unsigned wait_calls;
} VoiceReleaseSelftestState;

static VoiceAudioState selftest_voice_audio_state(void *context) {
  VoiceReleaseSelftestState *state = context;
  state->audio_probe_calls += 1;
  if (state->unknown) return VOICE_AUDIO_UNKNOWN;
  if (state->active && state->stop_activated && !state->never_stops) {
    state->probes_after_activation += 1;
    if (state->probes_after_activation >= state->inactive_after_activation_probes) {
      state->active = false;
    }
  }
  return state->active ? VOICE_AUDIO_ACTIVE : VOICE_AUDIO_INACTIVE;
}

static bool selftest_voice_stop_activate(void *context) {
  VoiceReleaseSelftestState *state = context;
  state->stop_activation_calls += 1;
  if (state->stop_activation_calls < state->stop_visible_on_call) return false;
  state->stop_activated = true;
  return true;
}

static void selftest_voice_release_wait(useconds_t delay_us, void *context) {
  (void)delay_us;
  VoiceReleaseSelftestState *state = context;
  state->wait_calls += 1;
}

static VoiceReleaseOutcome run_voice_release_selftest_case(VoiceReleaseSelftestState *state) {
  return finish_voice_release((VoiceReleaseOperations) {
    .audio_state = selftest_voice_audio_state,
    .activate_stop = selftest_voice_stop_activate,
    .wait = selftest_voice_release_wait,
    .context = state
  });
}

static int voice_release_retry_selftest(void) {
  VoiceReleaseSelftestState global_hold = {
    .active = false,
    .stop_visible_on_call = 1,
    .inactive_after_activation_probes = 1
  };
  bool global_hold_stopped = run_voice_release_selftest_case(&global_hold)
      == VOICE_RELEASE_INACTIVE
    && global_hold.audio_probe_calls == 1
    && global_hold.stop_activation_calls == 0
    && global_hold.wait_calls == 0;

  VoiceReleaseSelftestState delayed_stop = {
    .active = true,
    .stop_visible_on_call = 3,
    .inactive_after_activation_probes = 2
  };
  bool delayed_stop_retried = run_voice_release_selftest_case(&delayed_stop)
      == VOICE_RELEASE_INACTIVE
    && delayed_stop.stop_activation_calls == 3
    && delayed_stop.probes_after_activation == 2
    && delayed_stop.wait_calls == 4
    && !delayed_stop.active;

  VoiceReleaseSelftestState never_stops = {
    .active = true,
    .never_stops = true,
    .stop_visible_on_call = 1,
    .inactive_after_activation_probes = 1
  };
  bool persistent_audio_fails = run_voice_release_selftest_case(&never_stops)
      == VOICE_RELEASE_UNCONFIRMED_AFTER_STOP_ACTION
    && never_stops.stop_activation_calls == 1
    && never_stops.wait_calls == VOICE_RELEASE_INACTIVE_POLLS
    && never_stops.audio_probe_calls == VOICE_RELEASE_INACTIVE_POLLS + 1;

  VoiceReleaseSelftestState stop_never_visible = {
    .active = true,
    .stop_visible_on_call = VOICE_RELEASE_STOP_ATTEMPTS + 1,
    .inactive_after_activation_probes = 1
  };
  bool missing_stop_fails = run_voice_release_selftest_case(&stop_never_visible)
      == VOICE_RELEASE_UNCONFIRMED_NO_ACTION
    && stop_never_visible.stop_activation_calls == VOICE_RELEASE_STOP_ATTEMPTS
    && stop_never_visible.wait_calls == VOICE_RELEASE_STOP_ATTEMPTS
    && stop_never_visible.active;

  VoiceReleaseSelftestState unknown_audio = {
    .unknown = true,
    .stop_visible_on_call = 1,
    .inactive_after_activation_probes = 1
  };
  bool unknown_audio_fails_closed = run_voice_release_selftest_case(&unknown_audio)
      == VOICE_RELEASE_UNKNOWN
    && unknown_audio.stop_activation_calls == 0
    && unknown_audio.wait_calls == VOICE_RELEASE_STOP_ATTEMPTS;

  printf(
    "global_hold_stopped=%d delayed_stop_retried=%d persistent_audio_fails=%d "
    "missing_stop_fails=%d unknown_audio_fails_closed=%d\n",
    global_hold_stopped ? 1 : 0,
    delayed_stop_retried ? 1 : 0,
    persistent_audio_fails ? 1 : 0,
    missing_stop_fails ? 1 : 0,
    unknown_audio_fails_closed ? 1 : 0
  );
  return global_hold_stopped
    && delayed_stop_retried
    && persistent_audio_fails
    && missing_stop_fails
    && unknown_audio_fails_closed
    ? 0
    : 1;
}

static void tap_key(CGKeyCode key, CGEventFlags flags) {
  post_key(key, true, flags);
  post_key(key, false, flags);
}

static void post_media_key(int key, bool down) {
  @autoreleasepool {
    NSEvent *event = [NSEvent
      otherEventWithType:NSEventTypeSystemDefined
      location:NSZeroPoint
      modifierFlags:0
      timestamp:0
      windowNumber:0
      context:nil
      subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
      data1:(key << 16) | ((down ? 0x0A : 0x0B) << 8)
      data2:-1
    ];
    if (event == nil || event.CGEvent == NULL) return;
    CGEventPost(kCGHIDEventTap, event.CGEvent);
    usleep(9000);
  }
}

static void tap_media_key(int key) {
  post_media_key(key, true);
  post_media_key(key, false);
}

static bool pausable_media_bundle(CFStringRef bundle_id) {
  if (bundle_id == NULL) return false;
  const CFStringRef exact_bundles[] = {
    CFSTR("com.apple.Music"),
    CFSTR("com.apple.podcasts"),
    CFSTR("com.apple.TV"),
    CFSTR("com.apple.QuickTimePlayerX"),
    CFSTR("com.spotify.client"),
    CFSTR("com.google.Chrome"),
    CFSTR("com.apple.Safari"),
    CFSTR("company.thebrowser.Browser"),
    CFSTR("com.brave.Browser"),
    CFSTR("com.microsoft.edgemac"),
    CFSTR("com.vivaldi.Vivaldi"),
    CFSTR("com.operasoftware.Opera"),
    CFSTR("org.mozilla.firefox"),
    CFSTR("org.videolan.vlc"),
    CFSTR("com.colliderli.iina"),
    CFSTR("tv.plex.desktop"),
    CFSTR("com.plexamp.plexamp")
  };
  for (size_t index = 0; index < sizeof(exact_bundles) / sizeof(exact_bundles[0]); index += 1) {
    if (CFEqual(bundle_id, exact_bundles[index])) return true;
  }
  // Browser helpers can own the CoreAudio process instead of their parent app.
  const CFStringRef browser_prefixes[] = {
    CFSTR("com.google.Chrome."),
    CFSTR("com.apple.WebKit."),
    CFSTR("com.brave.Browser."),
    CFSTR("com.microsoft.edgemac."),
    CFSTR("com.vivaldi.Vivaldi."),
    CFSTR("com.operasoftware.Opera."),
    CFSTR("org.mozilla.firefox.")
  };
  for (size_t index = 0; index < sizeof(browser_prefixes) / sizeof(browser_prefixes[0]); index += 1) {
    if (CFStringHasPrefix(bundle_id, browser_prefixes[index])) return true;
  }
  return false;
}

static bool supported_media_output_is_running(void) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr
      || size == 0) return false;
  AudioObjectID *processes = malloc(size);
  if (processes == NULL) return false;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, processes) != noErr) {
    free(processes);
    return false;
  }

  bool active = false;
  UInt32 count = size / sizeof(AudioObjectID);
  for (UInt32 index = 0; index < count && !active; index += 1) {
    UInt32 is_running = 0;
    UInt32 value_size = sizeof(is_running);
    address.mSelector = kAudioProcessPropertyIsRunningOutput;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &is_running) != noErr
        || !is_running) continue;

    CFStringRef bundle_id = NULL;
    value_size = sizeof(bundle_id);
    address.mSelector = kAudioProcessPropertyBundleID;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &bundle_id) == noErr
        && bundle_id != NULL) {
      active = pausable_media_bundle(bundle_id);
      CFRelease(bundle_id);
    }
  }
  free(processes);
  return active;
}

typedef enum {
  SYSTEM_MEDIA_PLAYBACK_UNKNOWN = -1,
  SYSTEM_MEDIA_PLAYBACK_PAUSED = 0,
  SYSTEM_MEDIA_PLAYBACK_PLAYING = 1
} SystemMediaPlaybackState;

typedef void (*MediaRemoteIsPlayingFunction)(
  dispatch_queue_t queue,
  void (^completion)(Boolean is_playing)
);

static MediaRemoteIsPlayingFunction media_remote_is_playing_function(void) {
  static MediaRemoteIsPlayingFunction function = NULL;
  static dispatch_once_t once_token;
  dispatch_once(&once_token, ^{
    // MediaRemote is intentionally loaded at runtime: it is present in the
    // macOS shared cache but has no public SDK import library. If Apple moves
    // or removes the symbol, voice input must fail closed and leave playback
    // untouched instead of falling back to a blind play/pause toggle.
    void *handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY | RTLD_LOCAL
    );
    if (handle == NULL) return;
    void *symbol = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
    if (symbol == NULL) return;
    memcpy(&function, &symbol, sizeof(function));
  });
  return function;
}

static SystemMediaPlaybackState system_media_playback_state(void) {
  MediaRemoteIsPlayingFunction function = media_remote_is_playing_function();
  if (function == NULL) return SYSTEM_MEDIA_PLAYBACK_UNKNOWN;

  __block SystemMediaPlaybackState state = SYSTEM_MEDIA_PLAYBACK_UNKNOWN;
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  function(
    dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
    ^(Boolean is_playing) {
      state = is_playing
        ? SYSTEM_MEDIA_PLAYBACK_PLAYING
        : SYSTEM_MEDIA_PLAYBACK_PAUSED;
      dispatch_semaphore_signal(completed);
    }
  );
  long timed_out = dispatch_semaphore_wait(
    completed,
    dispatch_time(DISPATCH_TIME_NOW, 350 * NSEC_PER_MSEC)
  );
  return timed_out == 0 ? state : SYSTEM_MEDIA_PLAYBACK_UNKNOWN;
}

static bool should_pause_media(
  bool supported_output_running,
  SystemMediaPlaybackState playback_state
) {
  return supported_output_running
    && playback_state == SYSTEM_MEDIA_PLAYBACK_PLAYING;
}

static int print_system_media_playback_state(void) {
  bool supported_output_running = supported_media_output_is_running();
  SystemMediaPlaybackState playback_state = system_media_playback_state();
  const char *state = playback_state == SYSTEM_MEDIA_PLAYBACK_PLAYING
    ? "playing"
    : playback_state == SYSTEM_MEDIA_PLAYBACK_PAUSED
      ? "paused"
      : "unknown";
  printf(
    "state=%s supported_output=%d\n",
    state,
    supported_output_running ? 1 : 0
  );
  return playback_state == SYSTEM_MEDIA_PLAYBACK_UNKNOWN ? 2 : 0;
}

static int pause_media_if_playing(void) {
  bool supported_output_running = supported_media_output_is_running();
  if (!supported_output_running) return 2;
  SystemMediaPlaybackState playback_state = system_media_playback_state();
  if (!should_pause_media(supported_output_running, playback_state)) {
    return playback_state == SYSTEM_MEDIA_PLAYBACK_UNKNOWN ? 3 : 2;
  }
  // Use the normal system media command instead of freezing a process with
  // SIGSTOP. Players can drain their audio buffer cleanly, avoiding a click,
  // and the matching resume command remains independent of screen layout.
  // Crucially, never treat a merely alive CoreAudio process as proof of
  // playback: a blind toggle would start media that was already paused.
  tap_media_key(MEDIA_PLAY_PAUSE);
  return 0;
}

static int media_bundle_selftest(void) {
  bool direct = pausable_media_bundle(CFSTR("com.apple.Music"));
  bool helper = pausable_media_bundle(CFSTR("com.google.Chrome.helper"));
  bool rejects_codex = !pausable_media_bundle(CFSTR("com.openai.codex"));
  bool rejects_unknown = !pausable_media_bundle(CFSTR("example.unrelated.audio"));
  bool playing_pauses = should_pause_media(true, SYSTEM_MEDIA_PLAYBACK_PLAYING);
  bool paused_stays_paused = !should_pause_media(true, SYSTEM_MEDIA_PLAYBACK_PAUSED);
  bool unknown_fails_closed = !should_pause_media(true, SYSTEM_MEDIA_PLAYBACK_UNKNOWN);
  bool unsupported_stays_untouched = !should_pause_media(false, SYSTEM_MEDIA_PLAYBACK_PLAYING);
  printf(
    "direct=%d helper=%d codex_rejected=%d unknown_rejected=%d "
    "playing_pauses=%d paused_safe=%d unknown_safe=%d unsupported_safe=%d\n",
    direct ? 1 : 0,
    helper ? 1 : 0,
    rejects_codex ? 1 : 0,
    rejects_unknown ? 1 : 0,
    playing_pauses ? 1 : 0,
    paused_stays_paused ? 1 : 0,
    unknown_fails_closed ? 1 : 0,
    unsupported_stays_untouched ? 1 : 0
  );
  return direct
    && helper
    && rejects_codex
    && rejects_unknown
    && playing_pauses
    && paused_stays_paused
    && unknown_fails_closed
    && unsupported_stays_untouched
    ? 0
    : 1;
}

static void print_running_audio_processes(AudioObjectPropertySelector running_selector) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) return;
  AudioObjectID *processes = malloc(size);
  if (processes == NULL) return;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, processes) != noErr) {
    free(processes);
    return;
  }

  UInt32 count = size / sizeof(AudioObjectID);
  for (UInt32 index = 0; index < count; index += 1) {
    UInt32 is_running = 0;
    UInt32 value_size = sizeof(is_running);
    address.mSelector = running_selector;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &is_running) != noErr || !is_running) continue;

    pid_t pid = 0;
    value_size = sizeof(pid);
    address.mSelector = kAudioProcessPropertyPID;
    AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &pid);

    CFStringRef bundle_id = NULL;
    value_size = sizeof(bundle_id);
    address.mSelector = kAudioProcessPropertyBundleID;
    AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &bundle_id);
    char bundle[512] = "";
    if (bundle_id != NULL) {
      CFStringGetCString(bundle_id, bundle, sizeof(bundle), kCFStringEncodingUTF8);
      CFRelease(bundle_id);
    }
    printf("%d\t%s\n", pid, bundle);
  }
  free(processes);
}

static VoiceAudioState codex_audio_input_state(void) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) {
    return VOICE_AUDIO_UNKNOWN;
  }
  if (size == 0) return VOICE_AUDIO_INACTIVE;
  AudioObjectID *processes = malloc(size);
  if (processes == NULL) return VOICE_AUDIO_UNKNOWN;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, processes) != noErr) {
    free(processes);
    return VOICE_AUDIO_UNKNOWN;
  }

  VoiceAudioState state = VOICE_AUDIO_INACTIVE;
  UInt32 count = size / sizeof(AudioObjectID);
  for (UInt32 index = 0; index < count && state != VOICE_AUDIO_ACTIVE; index += 1) {
    UInt32 is_running = 0;
    UInt32 value_size = sizeof(is_running);
    address.mSelector = kAudioProcessPropertyIsRunningInput;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &is_running) != noErr) {
      state = VOICE_AUDIO_UNKNOWN;
      continue;
    }
    if (!is_running) continue;

    CFStringRef bundle_id = NULL;
    value_size = sizeof(bundle_id);
    address.mSelector = kAudioProcessPropertyBundleID;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &bundle_id) == noErr
        && bundle_id != NULL) {
      if (CFStringHasPrefix(bundle_id, CFSTR("com.openai.codex"))) {
        state = VOICE_AUDIO_ACTIVE;
      }
      CFRelease(bundle_id);
    } else {
      // An unidentified active input process could be Codex. Preserve unknown
      // rather than turning a transient CoreAudio lookup failure into a false
      // release confirmation.
      state = VOICE_AUDIO_UNKNOWN;
    }
  }
  free(processes);
  return state;
}

static bool codex_audio_input_is_running(void) {
  return codex_audio_input_state() == VOICE_AUDIO_ACTIVE;
}

static void app_switch(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  tap_key(KEY_TAB, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static void new_thread(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  post_key(KEY_OPTION, true, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  tap_key(KEY_O, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  post_key(KEY_OPTION, false, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static void side_chat(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  post_key(KEY_OPTION, true, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  tap_key(KEY_S, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  post_key(KEY_OPTION, false, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static void command_return(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  tap_key(KEY_RETURN, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static AXError copy_frontmost_focused_element(CFTypeRef *focused_value) {
  *focused_value = NULL;
  AXUIElementRef system_wide = AXUIElementCreateSystemWide();
  AXError focused_error = kAXErrorFailure;
  if (system_wide != NULL) {
    focused_error = AXUIElementCopyAttributeValue(
      system_wide,
      kAXFocusedUIElementAttribute,
      focused_value
    );
    CFRelease(system_wide);
    if (focused_error == kAXErrorSuccess && *focused_value != NULL
        && CFGetTypeID(*focused_value) == AXUIElementGetTypeID()) {
      return kAXErrorSuccess;
    }
    if (*focused_value != NULL) {
      CFRelease(*focused_value);
      *focused_value = NULL;
    }
  }

  pid_t pid = 0;
  @autoreleasepool {
    pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  }
  if (pid <= 0) return focused_error;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return focused_error;
  focused_error = AXUIElementCopyAttributeValue(
    application,
    kAXFocusedUIElementAttribute,
    focused_value
  );
  CFRelease(application);
  if (focused_error != kAXErrorSuccess || *focused_value == NULL
      || CFGetTypeID(*focused_value) != AXUIElementGetTypeID()) {
    if (*focused_value != NULL) {
      CFRelease(*focused_value);
      *focused_value = NULL;
    }
    return focused_error;
  }
  return kAXErrorSuccess;
}

// Print a privacy-preserving fingerprint for the currently focused editable
// text field. The actual text never leaves this process and is never logged.
// Output: <UTF-8 byte length>\t<64-bit FNV-1a hash>
static int print_focused_text_state(void) {
  CFTypeRef focused_value = NULL;
  AXError focused_error = copy_frontmost_focused_element(&focused_value);
  if (focused_error != kAXErrorSuccess || focused_value == NULL) return 1;

  AXUIElementRef focused = (AXUIElementRef)focused_value;
  Boolean settable = false;
  AXError settable_error = AXUIElementIsAttributeSettable(focused, kAXValueAttribute, &settable);
  if (settable_error != kAXErrorSuccess || !settable) {
    CFRelease(focused_value);
    return 1;
  }

  CFTypeRef text_value = NULL;
  AXError text_error = AXUIElementCopyAttributeValue(focused, kAXValueAttribute, &text_value);
  CFRelease(focused_value);
  if (text_error != kAXErrorSuccess || text_value == NULL
      || CFGetTypeID(text_value) != CFStringGetTypeID()) {
    if (text_value != NULL) CFRelease(text_value);
    return 1;
  }

  CFStringRef text = (CFStringRef)text_value;
  CFIndex utf8_capacity = CFStringGetMaximumSizeForEncoding(
    CFStringGetLength(text),
    kCFStringEncodingUTF8
  ) + 1;
  char *utf8 = calloc((size_t)utf8_capacity, sizeof(char));
  if (utf8 == NULL || !CFStringGetCString(text, utf8, utf8_capacity, kCFStringEncodingUTF8)) {
    free(utf8);
    CFRelease(text_value);
    return 1;
  }

  size_t length = strlen(utf8);
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < length; index += 1) {
    hash ^= (uint8_t)utf8[index];
    hash *= UINT64_C(1099511628211);
  }
  printf("%zu\t%016llx\n", length, (unsigned long long)hash);
  free(utf8);
  CFRelease(text_value);
  return 0;
}

static int print_focused_element_info(void) {
  @autoreleasepool {
    NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
    const char *bundle_value = frontmost.bundleIdentifier.UTF8String;
    const char *bundle = bundle_value != NULL ? bundle_value : "unknown";
    pid_t pid = frontmost.processIdentifier;
    CFTypeRef focused_value = NULL;
    AXError focused_error = copy_frontmost_focused_element(&focused_value);
    if (focused_error != kAXErrorSuccess || focused_value == NULL) {
      printf("bundle=%s pid=%d focused_error=%d\n", bundle, pid, (int)focused_error);
      return 1;
    }

    AXUIElementRef focused = (AXUIElementRef)focused_value;
    CFTypeRef role_value = NULL;
    AXError role_error = AXUIElementCopyAttributeValue(focused, kAXRoleAttribute, &role_value);
    char role[128] = "unknown";
    if (role_error == kAXErrorSuccess && role_value != NULL
        && CFGetTypeID(role_value) == CFStringGetTypeID()) {
      CFStringGetCString((CFStringRef)role_value, role, sizeof(role), kCFStringEncodingUTF8);
    }
    if (role_value != NULL) CFRelease(role_value);

    Boolean settable = false;
    AXError settable_error = AXUIElementIsAttributeSettable(focused, kAXValueAttribute, &settable);
    CFTypeRef text_value = NULL;
    AXError value_error = AXUIElementCopyAttributeValue(focused, kAXValueAttribute, &text_value);
    const char *value_type = "none";
    if (value_error == kAXErrorSuccess && text_value != NULL) {
      CFTypeID type_id = CFGetTypeID(text_value);
      if (type_id == CFStringGetTypeID()) value_type = "string";
      else if (type_id == CFAttributedStringGetTypeID()) value_type = "attributed-string";
      else value_type = "other";
    }
    if (text_value != NULL) CFRelease(text_value);
    CFRelease(focused_value);
    printf(
      "bundle=%s pid=%d role=%s settable=%d settable_error=%d value_type=%s value_error=%d\n",
      bundle,
      pid,
      role,
      settable ? 1 : 0,
      (int)settable_error,
      value_type,
      (int)value_error
    );
    return 0;
  }
}

static bool role_is_text_input(CFTypeRef role_value) {
  if (role_value == NULL || CFGetTypeID(role_value) != CFStringGetTypeID()) return false;
  CFStringRef role = (CFStringRef)role_value;
  return CFEqual(role, kAXTextAreaRole)
    || CFEqual(role, kAXTextFieldRole)
    || CFEqual(role, kAXComboBoxRole);
}

typedef struct {
  uint64_t hash;
  size_t total_bytes;
  unsigned candidates;
  unsigned visited;
} EditableTextState;

static void hash_editable_bytes(EditableTextState *state, const void *bytes, size_t length) {
  const uint8_t *cursor = (const uint8_t *)bytes;
  for (size_t index = 0; index < length; index += 1) {
    state->hash ^= cursor[index];
    state->hash *= UINT64_C(1099511628211);
  }
}

static void collect_editable_text_state(
  AXUIElementRef element,
  unsigned depth,
  EditableTextState *state
) {
  if (element == NULL || depth > 24 || state->visited >= 4000) return;
  state->visited += 1;
  Boolean settable = false;
  AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
  if (settable) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value) == kAXErrorSuccess
        && value != NULL) {
      CFStringRef string = NULL;
      if (CFGetTypeID(value) == CFStringGetTypeID()) string = (CFStringRef)value;
      else if (CFGetTypeID(value) == CFAttributedStringGetTypeID()) {
        string = CFAttributedStringGetString((CFAttributedStringRef)value);
      }
      if (string != NULL) {
        CFIndex capacity = CFStringGetMaximumSizeForEncoding(
          CFStringGetLength(string),
          kCFStringEncodingUTF8
        ) + 1;
        char *utf8 = calloc((size_t)capacity, sizeof(char));
        if (utf8 != NULL && CFStringGetCString(string, utf8, capacity, kCFStringEncodingUTF8)) {
          size_t length = strlen(utf8);
          uint8_t marker = 0xFF;
          hash_editable_bytes(state, &marker, sizeof(marker));
          hash_editable_bytes(state, &depth, sizeof(depth));
          hash_editable_bytes(state, &length, sizeof(length));
          hash_editable_bytes(state, utf8, length);
          state->total_bytes += length;
          state->candidates += 1;
        }
        free(utf8);
      }
      CFRelease(value);
    }
  }

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_editable_text_state((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static int print_editable_text_state(void) {
  pid_t pid = 0;
  @autoreleasepool {
    pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  }
  if (pid <= 0) return 1;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.4);
  EditableTextState state = {
    .hash = UINT64_C(14695981039346656037),
    .total_bytes = 0,
    .candidates = 0,
    .visited = 0
  };
  collect_editable_text_state(application, 0, &state);
  CFRelease(application);
  if (state.candidates == 0) return 1;
  printf(
    "%u\t%zu\t%016llx\n",
    state.candidates,
    state.total_bytes,
    (unsigned long long)state.hash
  );
  return 0;
}

static void print_editable_descendants(
  AXUIElementRef element,
  unsigned depth,
  unsigned *visited,
  unsigned *found
) {
  if (element == NULL || depth > 24 || *visited >= 4000) return;
  *visited += 1;
  CFTypeRef role_value = NULL;
  AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role_value);
  Boolean settable = false;
  AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
  CFTypeRef focused_value = NULL;
  bool focused = false;
  if (AXUIElementCopyAttributeValue(element, kAXFocusedAttribute, &focused_value) == kAXErrorSuccess
      && focused_value != NULL && CFGetTypeID(focused_value) == CFBooleanGetTypeID()) {
    focused = CFBooleanGetValue((CFBooleanRef)focused_value);
  }
  if (focused_value != NULL) CFRelease(focused_value);
  if (role_is_text_input(role_value) || settable || focused) {
    char role[128] = "unknown";
    if (role_value != NULL && CFGetTypeID(role_value) == CFStringGetTypeID()) {
      CFStringGetCString((CFStringRef)role_value, role, sizeof(role), kCFStringEncodingUTF8);
    }
    CFTypeRef value = NULL;
    AXError value_error = AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value);
    const char *value_type = "none";
    CFIndex value_length = -1;
    if (value_error == kAXErrorSuccess && value != NULL) {
      CFTypeID type_id = CFGetTypeID(value);
      if (type_id == CFStringGetTypeID()) {
        value_type = "string";
        value_length = CFStringGetLength((CFStringRef)value);
      } else if (type_id == CFAttributedStringGetTypeID()) {
        value_type = "attributed-string";
        value_length = CFAttributedStringGetLength((CFAttributedStringRef)value);
      }
      else value_type = "other";
    }
    if (value != NULL) CFRelease(value);
    printf(
      "input=%u depth=%u role=%s focused=%d settable=%d value_type=%s value_length=%ld value_error=%d\n",
      *found,
      depth,
      role,
      focused ? 1 : 0,
      settable ? 1 : 0,
      value_type,
      (long)value_length,
      (int)value_error
    );
    *found += 1;
  }
  if (role_value != NULL) CFRelease(role_value);

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      print_editable_descendants((AXUIElementRef)child, depth + 1, visited, found);
    }
  }
  CFRelease(children_value);
}

static int print_editable_element_info(void) {
  pid_t pid = 0;
  @autoreleasepool {
    pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  }
  if (pid <= 0) return 1;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.4);
  unsigned visited = 0;
  unsigned found = 0;
  print_editable_descendants(application, 0, &visited, &found);
  CFRelease(application);
  printf("visited=%u inputs=%u\n", visited, found);
  return found > 0 ? 0 : 1;
}

static void print_string_fingerprint(const char *name, CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) {
    printf(" %s=none", name);
    return;
  }
  CFStringRef string = (CFStringRef)value;
  CFIndex capacity = CFStringGetMaximumSizeForEncoding(
    CFStringGetLength(string),
    kCFStringEncodingUTF8
  ) + 1;
  char *utf8 = calloc((size_t)capacity, sizeof(char));
  if (utf8 == NULL || !CFStringGetCString(string, utf8, capacity, kCFStringEncodingUTF8)) {
    free(utf8);
    printf(" %s=unavailable", name);
    return;
  }
  size_t length = strlen(utf8);
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < length; index += 1) {
    hash ^= (uint8_t)utf8[index];
    hash *= UINT64_C(1099511628211);
  }
  printf(" %s=%zu:%016llx", name, length, (unsigned long long)hash);
  free(utf8);
}

static void print_selected_descendants(
  AXUIElementRef element,
  unsigned depth,
  unsigned *visited,
  unsigned *found
) {
  if (element == NULL || depth > 24 || *visited >= 4000) return;
  *visited += 1;
  CFTypeRef selected_value = NULL;
  bool selected = false;
  if (AXUIElementCopyAttributeValue(element, kAXSelectedAttribute, &selected_value) == kAXErrorSuccess
      && selected_value != NULL && CFGetTypeID(selected_value) == CFBooleanGetTypeID()) {
    selected = CFBooleanGetValue((CFBooleanRef)selected_value);
  }
  if (selected_value != NULL) CFRelease(selected_value);
  if (selected) {
    CFTypeRef role_value = NULL;
    CFTypeRef title_value = NULL;
    CFTypeRef value = NULL;
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role_value);
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &title_value);
    AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value);
    char role[128] = "unknown";
    if (role_value != NULL && CFGetTypeID(role_value) == CFStringGetTypeID()) {
      CFStringGetCString((CFStringRef)role_value, role, sizeof(role), kCFStringEncodingUTF8);
    }
    printf("selected=%u depth=%u role=%s", *found, depth, role);
    print_string_fingerprint("title", title_value);
    print_string_fingerprint("value", value);
    printf("\n");
    if (role_value != NULL) CFRelease(role_value);
    if (title_value != NULL) CFRelease(title_value);
    if (value != NULL) CFRelease(value);
    *found += 1;
  }

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      print_selected_descendants((AXUIElementRef)child, depth + 1, visited, found);
    }
  }
  CFRelease(children_value);
}

static int print_selected_element_info(void) {
  pid_t pid = 0;
  @autoreleasepool {
    pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  }
  if (pid <= 0) return 1;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.4);
  unsigned visited = 0;
  unsigned found = 0;
  print_selected_descendants(application, 0, &visited, &found);
  CFRelease(application);
  printf("visited=%u selected=%u\n", visited, found);
  return found > 0 ? 0 : 1;
}

static AXUIElementRef copy_codex_application(void) {
  @autoreleasepool {
    NSArray<NSRunningApplication *> *applications =
      [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.openai.codex"];
    for (NSRunningApplication *application in applications) {
      if (application.terminated || application.processIdentifier <= 0) continue;
      return AXUIElementCreateApplication(application.processIdentifier);
    }
  }
  return NULL;
}

static bool string_fingerprint(CFTypeRef value, size_t *length, uint64_t *hash) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  CFStringRef string = (CFStringRef)value;
  CFIndex capacity = CFStringGetMaximumSizeForEncoding(
    CFStringGetLength(string),
    kCFStringEncodingUTF8
  ) + 1;
  char *utf8 = calloc((size_t)capacity, sizeof(char));
  if (utf8 == NULL || !CFStringGetCString(string, utf8, capacity, kCFStringEncodingUTF8)) {
    free(utf8);
    return false;
  }
  *length = strlen(utf8);
  *hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < *length; index += 1) {
    *hash ^= (uint8_t)utf8[index];
    *hash *= UINT64_C(1099511628211);
  }
  free(utf8);
  return *length > 0;
}

static bool copy_element_position(AXUIElementRef element, CGPoint *position);
static bool copy_element_size(AXUIElementRef element, CGSize *size);
static bool element_is_hidden(AXUIElementRef element);
static bool codex_accessibility_element_supports_press(AXUIElementRef element);

typedef struct {
  const char *effort;
  int score;
  unsigned visited;
  CGPoint window_origin;
  CGSize window_size;
} CodexReasoningState;

static const char *reasoning_effort_from_accessibility_string(
  CFTypeRef value,
  bool *has_context
) {
  if (has_context != NULL) *has_context = false;
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  NSString *text = [(__bridge NSString *)value lowercaseString];
  if (text.length == 0) return NULL;
  bool context = [text containsString:@"reasoning"]
    || [text containsString:@"effort"]
    || [text containsString:@"thinking"]
    || [text containsString:@"추론 강도"];
  if (has_context != NULL) *has_context = context;

  // Check the compound values first so "extra high" cannot collapse to
  // "high". Only fixed UI vocabulary is returned; arbitrary AX text never
  // leaves this helper.
  if ([text containsString:@"ultra"] || [text containsString:@"울트라"]) return "ultra";
  if ([text containsString:@"extra high"] || [text containsString:@"xhigh"]
      || [text containsString:@"매우 높음"]) return "xhigh";
  if ([text containsString:@"maximum"] || [text containsString:@" max"]
      || [text hasPrefix:@"max"] || [text containsString:@"최대"]) return "max";
  if ([text containsString:@"minimal"] || [text containsString:@"최소한"]
      || [text containsString:@"최소"]) return "minimal";
  if ([text containsString:@"medium"] || [text containsString:@"중간"]) return "medium";
  if ([text containsString:@"high"] || [text containsString:@"높음"]) return "high";
  if ([text containsString:@"light"] || [text containsString:@" low"]
      || [text hasPrefix:@"low"] || [text containsString:@"낮음"]) return "low";
  if ([text containsString:@"none"] || [text containsString:@"없음"]) return "none";
  return NULL;
}

// Codex Work intentionally reuses the word "Standard" for two unrelated
// settings: medium reasoning in the closed intelligence trigger and standard
// response speed inside its popover. Keep these aliases out of the generic
// parser and admit them only after the element has been proven to be the
// composer intelligence trigger.
static const char *reasoning_effort_from_intelligence_alias_string(CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  @autoreleasepool {
    NSString *text = [[(__bridge NSString *)value lowercaseString]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSArray<NSString *> *parts = [text
      componentsSeparatedByCharactersInSet:[[NSCharacterSet alphanumericCharacterSet]
        invertedSet]];
    for (NSString *part in parts) {
      if ([part isEqualToString:@"extended"]) return "high";
      if ([part isEqualToString:@"standard"]) return "medium";
    }
  }
  return NULL;
}

static bool accessibility_string_has_codex_model_context(CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  @autoreleasepool {
    NSString *text = [[(__bridge NSString *)value lowercaseString]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return [text containsString:@"gpt-"]
      || [text containsString:@"codex"]
      || [text containsString:@"terra"]
      || [text containsString:@" sol"]
      || [text hasPrefix:@"sol "];
  }
}

static const char *reasoning_effort_from_intelligence_trigger_label(CFTypeRef value) {
  if (!accessibility_string_has_codex_model_context(value)) return NULL;
  bool ignored_context = false;
  const char *effort = reasoning_effort_from_accessibility_string(
    value,
    &ignored_context
  );
  return effort != NULL
    ? effort
    : reasoning_effort_from_intelligence_alias_string(value);
}

typedef struct {
  bool model_context;
  const char *effort;
  unsigned visited;
} CodexIntelligenceTextState;

static void collect_codex_intelligence_text_state(
  AXUIElementRef element,
  unsigned depth,
  CodexIntelligenceTextState *state
) {
  if (element == NULL || state == NULL || depth > 4 || state->visited >= 64) return;
  state->visited += 1;
  CFStringRef attributes[] = {
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    CFSTR("AXDOMIdentifier")
  };
  for (size_t index = 0; index < sizeof(attributes) / sizeof(attributes[0]); index += 1) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attributes[index], &value) != kAXErrorSuccess
        || value == NULL) {
      if (value != NULL) CFRelease(value);
      continue;
    }
    state->model_context |= accessibility_string_has_codex_model_context(value);
    bool ignored_context = false;
    const char *effort = reasoning_effort_from_accessibility_string(
      value,
      &ignored_context
    );
    if (effort == NULL) effort = reasoning_effort_from_intelligence_alias_string(value);
    if (effort != NULL) state->effort = effort;
    CFRelease(value);
  }

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value)
        != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  for (CFIndex index = 0; index < CFArrayGetCount(children); index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_intelligence_text_state(
        (AXUIElementRef)child,
        depth + 1,
        state
      );
    }
  }
  CFRelease(children_value);
}

static void collect_codex_reasoning_state(
  AXUIElementRef element,
  unsigned depth,
  CodexReasoningState *state
) {
  if (element == NULL || state == NULL || depth > 28 || state->visited >= 6000) return;
  state->visited += 1;
  if (element_is_hidden(element)) return;

  CFTypeRef role_value = NULL;
  AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role_value);
  bool is_button = role_value != NULL && CFGetTypeID(role_value) == CFStringGetTypeID()
    && (CFEqual(role_value, kAXButtonRole)
      || CFEqual(role_value, kAXPopUpButtonRole)
      || CFEqual(role_value, kAXRadioButtonRole));
  bool is_slider = role_value != NULL && CFGetTypeID(role_value) == CFStringGetTypeID()
    && CFEqual(role_value, kAXSliderRole);
  if (role_value != NULL) CFRelease(role_value);

  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool visible_geometry = copy_element_position(element, &position)
    && copy_element_size(element, &size)
    && size.width > 1
    && size.height > 1
    && position.x + size.width >= state->window_origin.x
    && position.x <= state->window_origin.x + state->window_size.width
    && position.y + size.height >= state->window_origin.y
    && position.y <= state->window_origin.y + state->window_size.height;
  bool composer_region = visible_geometry
    && position.x >= state->window_origin.x + state->window_size.width * 0.25
    && position.y >= state->window_origin.y + state->window_size.height * 0.62
    && size.width <= 320
    && size.height <= 56;

  if (is_button && composer_region
      && codex_accessibility_element_supports_press(element)) {
    CodexIntelligenceTextState intelligence = { 0 };
    collect_codex_intelligence_text_state(element, 0, &intelligence);
    if (intelligence.model_context && intelligence.effort != NULL
        && 150 > state->score) {
      state->effort = intelligence.effort;
      state->score = 150;
    }
  }

  CFStringRef attributes[] = {
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    CFSTR("AXDOMIdentifier")
  };
  for (size_t index = 0; index < sizeof(attributes) / sizeof(attributes[0]); index += 1) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attributes[index], &value) != kAXErrorSuccess
        || value == NULL) {
      if (value != NULL) CFRelease(value);
      continue;
    }
    bool has_context = false;
    const char *effort = reasoning_effort_from_accessibility_string(value, &has_context);
    if (effort != NULL) {
      // A task title or chat message can contain words such as "reasoning" or
      // "high". Accept contextual labels only from an actual composer control
      // (or a slider) so arbitrary task content can never become the reported
      // effort value.
      int score = has_context && ((is_button && composer_region) || is_slider)
        ? 120
        : is_slider
          ? 100
          : is_button && composer_region
            ? 80
            : 0;
      if (score > state->score) {
        state->effort = effort;
        state->score = score;
      }
    }
    CFRelease(value);
  }

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_reasoning_state((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static int print_codex_reasoning_state(void) {
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.8);

  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window_value) != kAXErrorSuccess
      || window_value == NULL || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(application);
    return 1;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(window, &origin) || !copy_element_size(window, &size)) {
    CFRelease(window_value);
    CFRelease(application);
    return 1;
  }
  CodexReasoningState state = {
    .effort = NULL,
    .score = 0,
    .visited = 0,
    .window_origin = origin,
    .window_size = size
  };
  collect_codex_reasoning_state(window, 0, &state);
  printf(
    "effort=%s confidence=%d visited=%u\n",
    state.effort != NULL ? state.effort : "unknown",
    state.score,
    state.visited
  );
  CFRelease(window_value);
  CFRelease(application);
  return state.effort != NULL ? 0 : 1;
}

static int reasoning_state_selftest(void) {
  struct {
    NSString *text;
    const char *expected;
  } cases[] = {
    { @"Reasoning effort Extra high", "xhigh" },
    { @"추론 강도 매우 높음", "xhigh" },
    { @"추론 강도 최대", "max" },
    { @"Reasoning effort Light", "low" },
    { @"추론 강도 울트라", "ultra" }
  };
  bool passed = true;
  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index += 1) {
    bool has_context = false;
    const char *actual = reasoning_effort_from_accessibility_string(
      (__bridge CFStringRef)cases[index].text,
      &has_context
    );
    if (!has_context || actual == NULL || strcmp(actual, cases[index].expected) != 0) {
      passed = false;
      break;
    }
  }
  bool work_aliases = strcmp(
    reasoning_effort_from_intelligence_trigger_label(CFSTR("5.6 Sol Standard")),
    "medium"
  ) == 0 && strcmp(
    reasoning_effort_from_intelligence_trigger_label(CFSTR("5.6 Sol Extended")),
    "high"
  ) == 0;
  bool speed_collision_rejected = reasoning_effort_from_intelligence_trigger_label(
    CFSTR("Speed Standard")
  ) == NULL && reasoning_effort_from_intelligence_trigger_label(
    CFSTR("Enable standard mode")
  ) == NULL;
  printf(
    "localized_effort_mapping=%d work_aliases=%d speed_collision_rejected=%d\n",
    passed ? 1 : 0,
    work_aliases ? 1 : 0,
    speed_collision_rejected ? 1 : 0
  );
  return passed && work_aliases && speed_collision_rejected ? 0 : 1;
}

typedef enum {
  CODEX_GOAL_UNKNOWN = 0,
  CODEX_GOAL_ACTIVE,
  CODEX_GOAL_PAUSED,
  CODEX_GOAL_BLOCKED,
  CODEX_GOAL_USAGE_LIMITED,
  CODEX_GOAL_BUDGET_LIMITED,
  CODEX_GOAL_COMPLETE
} CodexGoalStatus;

typedef struct {
  CodexGoalStatus status;
  CGPoint position;
  CGSize size;
} CodexGoalStatusCandidate;

typedef struct {
  uint64_t elapsed_seconds;
  CGPoint position;
  CGSize size;
} CodexGoalDurationCandidate;

typedef struct {
  CGPoint position;
  CGSize size;
} CodexGoalTokenProgressCandidate;

#define CODEX_GOAL_MAX_STATUS_CANDIDATES 32
#define CODEX_GOAL_MAX_DURATION_CANDIDATES 64
#define CODEX_GOAL_MAX_TOKEN_PROGRESS_CANDIDATES 64
#define CODEX_GOAL_MAX_SCAN_DEPTH 28
#define CODEX_GOAL_MAX_VISITED_ELEMENTS 6000

typedef struct {
  CodexGoalStatusCandidate statuses[CODEX_GOAL_MAX_STATUS_CANDIDATES];
  unsigned status_count;
  CodexGoalDurationCandidate durations[CODEX_GOAL_MAX_DURATION_CANDIDATES];
  unsigned duration_count;
  CodexGoalTokenProgressCandidate token_progress[CODEX_GOAL_MAX_TOKEN_PROGRESS_CANDIDATES];
  unsigned token_progress_count;
  unsigned visited;
  bool traversal_failed;
  CGPoint window_origin;
  CGSize window_size;
} CodexGoalScanState;

static NSString *normalized_accessibility_label(CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return nil;
  NSString *text = [(__bridge NSString *)value
    stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (text.length == 0) return nil;
  NSArray<NSString *> *parts = [text
    componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSMutableArray<NSString *> *words = [NSMutableArray arrayWithCapacity:parts.count];
  for (NSString *part in parts) {
    if (part.length > 0) [words addObject:part];
  }
  return [[words componentsJoinedByString:@" "] lowercaseString];
}

// Match only Codex's fixed summary vocabulary. Substring matching would let a
// task title or assistant message impersonate goal state, so even punctuation
// or surrounding prose intentionally makes this return UNKNOWN.
static CodexGoalStatus codex_goal_status_from_accessibility_string(CFTypeRef value) {
  NSString *label = normalized_accessibility_label(value);
  if (label == nil) return CODEX_GOAL_UNKNOWN;
  if ([label isEqualToString:@"pursuing goal"]
      || [label isEqualToString:@"진행 중인 목표"]) return CODEX_GOAL_ACTIVE;
  if ([label isEqualToString:@"paused goal"]
      || [label isEqualToString:@"일시중지된 목표"]) return CODEX_GOAL_PAUSED;
  if ([label isEqualToString:@"goal blocked"]
      || [label isEqualToString:@"목표가 차단됨"]) return CODEX_GOAL_BLOCKED;
  if ([label isEqualToString:@"goal usage limited"]
      || [label isEqualToString:@"목표 사용 제한"]) return CODEX_GOAL_USAGE_LIMITED;
  if ([label isEqualToString:@"goal limited"]
      || [label isEqualToString:@"목표 제한됨"]) return CODEX_GOAL_BUDGET_LIMITED;
  if ([label isEqualToString:@"goal achieved"]
      || [label isEqualToString:@"목표 달성"]) return CODEX_GOAL_COMPLETE;
  return CODEX_GOAL_UNKNOWN;
}

static const char *codex_goal_status_name(CodexGoalStatus status) {
  switch (status) {
    case CODEX_GOAL_ACTIVE: return "active";
    case CODEX_GOAL_PAUSED: return "paused";
    case CODEX_GOAL_BLOCKED: return "blocked";
    case CODEX_GOAL_USAGE_LIMITED: return "usage_limited";
    case CODEX_GOAL_BUDGET_LIMITED: return "budget_limited";
    case CODEX_GOAL_COMPLETE: return "complete";
    case CODEX_GOAL_UNKNOWN: return "none";
  }
  return "none";
}

// Parse only the compact duration emitted by Codex (for example, "2h 3m 4s"
// or "• 3m"). No surrounding words are allowed, which keeps ordinary task
// text out of the goal-state channel.
static bool compact_goal_duration_seconds(CFTypeRef value, uint64_t *seconds_out) {
  NSString *text = normalized_accessibility_label(value);
  if (text == nil) return false;
  if ([text hasPrefix:@"•"] || [text hasPrefix:@"·"]) {
    text = [[text substringFromIndex:1]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  }
  const char *cursor = text.UTF8String;
  if (cursor == NULL || *cursor == '\0') return false;

  uint64_t total = 0;
  unsigned previous_rank = 5;
  bool found = false;
  while (*cursor != '\0') {
    while (isspace((unsigned char)*cursor)) cursor += 1;
    if (!isdigit((unsigned char)*cursor)) return false;
    uint64_t amount = 0;
    while (isdigit((unsigned char)*cursor)) {
      unsigned digit = (unsigned)(*cursor - '0');
      if (amount > (UINT64_MAX - digit) / 10) return false;
      amount = amount * 10 + digit;
      cursor += 1;
    }

    uint64_t multiplier = 0;
    unsigned rank = 0;
    switch (*cursor) {
      case 'd': multiplier = 86400; rank = 4; break;
      case 'h': multiplier = 3600; rank = 3; break;
      case 'm': multiplier = 60; rank = 2; break;
      case 's': multiplier = 1; rank = 1; break;
      default: return false;
    }
    if (rank >= previous_rank || amount > (UINT64_MAX - total) / multiplier) return false;
    total += amount * multiplier;
    previous_rank = rank;
    found = true;
    cursor += 1;
    if (*cursor != '\0' && !isspace((unsigned char)*cursor)) return false;
  }
  if (!found) return false;
  if (seconds_out != NULL) *seconds_out = total;
  return true;
}

static bool consume_compact_token_scale(const char **cursor_in_out) {
  if (cursor_in_out == NULL || *cursor_in_out == NULL) return false;
  const char *cursor = *cursor_in_out;
  if (*cursor == 'k' || *cursor == 'm' || *cursor == 'b') {
    *cursor_in_out = cursor + 1;
    return true;
  }
  const char *korean_scales[] = { "천", "만", "억" };
  for (size_t index = 0; index < sizeof(korean_scales) / sizeof(korean_scales[0]); index += 1) {
    size_t length = strlen(korean_scales[index]);
    if (strncmp(cursor, korean_scales[index], length) == 0) {
      *cursor_in_out = cursor + length;
      return true;
    }
  }
  return false;
}

// Accept only Codex's localized compact token-budget progress shape, such as
// "1.2K / 10K" or "1.2천 / 1만". Requiring a known scaled denominator keeps
// generic fractions, paths, URLs, and prose containing a slash out of this
// fallback.
static bool compact_goal_token_progress(CFTypeRef value) {
  NSString *text = normalized_accessibility_label(value);
  if (text == nil) return false;
  if ([text hasPrefix:@"•"] || [text hasPrefix:@"·"]) {
    text = [[text substringFromIndex:1]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  }
  const char *cursor = text.UTF8String;
  if (cursor == NULL || *cursor == '\0') return false;

  bool denominator_scaled = false;
  for (unsigned quantity = 0; quantity < 2; quantity += 1) {
    while (isspace((unsigned char)*cursor)) cursor += 1;
    if (!isdigit((unsigned char)*cursor)) return false;
    bool quantity_nonzero = false;
    while (isdigit((unsigned char)*cursor)) {
      if (*cursor != '0') quantity_nonzero = true;
      cursor += 1;
    }

    bool has_decimal = false;
    if (*cursor == '.') {
      has_decimal = true;
      cursor += 1;
      unsigned decimal_digits = 0;
      while (isdigit((unsigned char)*cursor) && decimal_digits < 2) {
        if (*cursor != '0') quantity_nonzero = true;
        cursor += 1;
        decimal_digits += 1;
      }
      if (decimal_digits == 0 || isdigit((unsigned char)*cursor)) return false;
    }

    bool scaled = consume_compact_token_scale(&cursor);
    if (has_decimal && !scaled) return false;
    if (quantity == 1) {
      denominator_scaled = scaled;
      if (!quantity_nonzero) return false;
    }

    while (isspace((unsigned char)*cursor)) cursor += 1;
    if (quantity == 0) {
      if (*cursor != '/') return false;
      cursor += 1;
    }
  }
  return denominator_scaled && *cursor == '\0';
}

static bool codex_goal_candidate_geometry(
  CGPoint window_origin,
  CGSize window_size,
  CGPoint position,
  CGSize size,
  bool duration
) {
  if (window_size.width <= 1 || window_size.height <= 1
      || size.width <= 1 || size.height <= 1) return false;
  double right = window_origin.x + window_size.width;
  double bottom = window_origin.y + window_size.height;
  bool inside_window = position.x + size.width >= window_origin.x
    && position.x <= right
    && position.y + size.height >= window_origin.y
    && position.y <= bottom;
  if (!inside_window) return false;

  // The goal summary is a compact row immediately above the composer in the
  // main content column. Excluding the title/sidebar and the upper transcript
  // is the geometry half of the false-positive guard.
  return position.x >= window_origin.x + window_size.width * 0.20
    && position.y >= window_origin.y + window_size.height * 0.52
    && position.y <= bottom - 36
    && size.width <= (duration ? 220 : 440)
    && size.height <= 60;
}

static void add_codex_goal_status_candidate(
  CodexGoalScanState *state,
  CodexGoalStatus status,
  CGPoint position,
  CGSize size
) {
  for (unsigned index = 0; index < state->status_count; index += 1) {
    CodexGoalStatusCandidate existing = state->statuses[index];
    if (existing.status == status
        && existing.position.x == position.x
        && existing.position.y == position.y
        && existing.size.width == size.width
        && existing.size.height == size.height) return;
  }
  if (state->status_count >= CODEX_GOAL_MAX_STATUS_CANDIDATES) {
    state->traversal_failed = true;
    return;
  }
  state->statuses[state->status_count++] = (CodexGoalStatusCandidate) {
    .status = status,
    .position = position,
    .size = size
  };
}

static void add_codex_goal_duration_candidate(
  CodexGoalScanState *state,
  uint64_t elapsed_seconds,
  CGPoint position,
  CGSize size
) {
  for (unsigned index = 0; index < state->duration_count; index += 1) {
    CodexGoalDurationCandidate existing = state->durations[index];
    if (existing.elapsed_seconds == elapsed_seconds
        && existing.position.x == position.x
        && existing.position.y == position.y
        && existing.size.width == size.width
        && existing.size.height == size.height) return;
  }
  if (state->duration_count >= CODEX_GOAL_MAX_DURATION_CANDIDATES) {
    state->traversal_failed = true;
    return;
  }
  state->durations[state->duration_count++] = (CodexGoalDurationCandidate) {
    .elapsed_seconds = elapsed_seconds,
    .position = position,
    .size = size
  };
}

static void add_codex_goal_token_progress_candidate(
  CodexGoalScanState *state,
  CGPoint position,
  CGSize size
) {
  for (unsigned index = 0; index < state->token_progress_count; index += 1) {
    CodexGoalTokenProgressCandidate existing = state->token_progress[index];
    if (existing.position.x == position.x
        && existing.position.y == position.y
        && existing.size.width == size.width
        && existing.size.height == size.height) return;
  }
  if (state->token_progress_count >= CODEX_GOAL_MAX_TOKEN_PROGRESS_CANDIDATES) {
    state->traversal_failed = true;
    return;
  }
  state->token_progress[state->token_progress_count++] = (CodexGoalTokenProgressCandidate) {
    .position = position,
    .size = size
  };
}

static bool begin_codex_goal_scan_visit(unsigned depth, CodexGoalScanState *state) {
  if (state == NULL) return false;
  if (depth > CODEX_GOAL_MAX_SCAN_DEPTH
      || state->visited >= CODEX_GOAL_MAX_VISITED_ELEMENTS) {
    // A safety-limit cutoff is an incomplete scan, not proof that the focused
    // task has no goal. Report unknown so the caller retains its last snapshot.
    state->traversal_failed = true;
    return false;
  }
  state->visited += 1;
  return true;
}

static void collect_codex_goal_state(
  AXUIElementRef element,
  unsigned depth,
  CodexGoalScanState *state
) {
  if (element == NULL || !begin_codex_goal_scan_visit(depth, state)) return;
  if (element_is_hidden(element)) return;

  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool has_geometry = copy_element_position(element, &position)
    && copy_element_size(element, &size);
  Boolean value_settable = false;
  AXUIElementIsAttributeSettable(element, kAXValueAttribute, &value_settable);
  // In particular, never interpret text currently typed into the composer as
  // UI state, even if it exactly repeats one of the fixed labels.
  bool status_geometry = !value_settable && has_geometry && codex_goal_candidate_geometry(
    state->window_origin,
    state->window_size,
    position,
    size,
    false
  );
  bool duration_geometry = !value_settable && has_geometry && codex_goal_candidate_geometry(
    state->window_origin,
    state->window_size,
    position,
    size,
    true
  );

  if (status_geometry || duration_geometry) {
    CFStringRef attributes[] = {
      kAXTitleAttribute,
      kAXValueAttribute,
      kAXDescriptionAttribute,
      kAXHelpAttribute,
      kAXIdentifierAttribute,
      CFSTR("AXDOMIdentifier")
    };
    for (size_t index = 0; index < sizeof(attributes) / sizeof(attributes[0]); index += 1) {
      CFTypeRef value = NULL;
      if (AXUIElementCopyAttributeValue(element, attributes[index], &value) != kAXErrorSuccess
          || value == NULL) {
        if (value != NULL) CFRelease(value);
        continue;
      }
      if (status_geometry) {
        CodexGoalStatus status = codex_goal_status_from_accessibility_string(value);
        if (status != CODEX_GOAL_UNKNOWN) {
          add_codex_goal_status_candidate(state, status, position, size);
        }
      }
      if (duration_geometry) {
        uint64_t elapsed_seconds = 0;
        if (compact_goal_duration_seconds(value, &elapsed_seconds)) {
          add_codex_goal_duration_candidate(state, elapsed_seconds, position, size);
        } else if (compact_goal_token_progress(value)) {
          add_codex_goal_token_progress_candidate(state, position, size);
        }
      }
      CFRelease(value);
    }
  }

  CFTypeRef children_value = NULL;
  AXError children_error = AXUIElementCopyAttributeValue(
    element,
    kAXChildrenAttribute,
    &children_value
  );
  if (children_error != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    // Leaf elements normally report no children. A failed root traversal or a
    // messaging timeout is different: it cannot prove that no goal exists.
    if (depth == 0 || children_error == kAXErrorCannotComplete) {
      state->traversal_failed = true;
    }
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_goal_state((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static bool select_codex_goal_state(
  const CodexGoalScanState *state,
  CodexGoalStatus *status_out,
  uint64_t *elapsed_seconds_out,
  bool *elapsed_known_out
) {
  int best_score = -1;
  CodexGoalStatus best_status = CODEX_GOAL_UNKNOWN;
  uint64_t best_elapsed_seconds = 0;
  for (unsigned status_index = 0; status_index < state->status_count; status_index += 1) {
    CodexGoalStatusCandidate status = state->statuses[status_index];
    double status_center_x = status.position.x + status.size.width / 2;
    double status_center_y = status.position.y + status.size.height / 2;
    for (unsigned duration_index = 0; duration_index < state->duration_count; duration_index += 1) {
      CodexGoalDurationCandidate duration = state->durations[duration_index];
      double duration_center_x = duration.position.x + duration.size.width / 2;
      double duration_center_y = duration.position.y + duration.size.height / 2;
      double dx = duration_center_x - status_center_x;
      double dy = duration_center_y - status_center_y;
      if (dy < 0) dy = -dy;

      // Codex lays the elapsed value after the localized status on the same
      // summary row. This rejects an exact phrase copied into the transcript
      // unless a compact duration is also aligned with it like the real UI.
      if (dy > 28 || dx < -8 || dx > state->window_size.width * 0.72 || dx > 900) continue;
      int score = 1000
        + (int)((status.position.y - state->window_origin.y) * 100 / state->window_size.height)
        - (int)(dy * 8)
        - (int)(dx / 24);
      if (score > best_score) {
        best_score = score;
        best_status = status.status;
        best_elapsed_seconds = duration.elapsed_seconds;
      }
    }
  }
  bool elapsed_known = best_status != CODEX_GOAL_UNKNOWN;

  // Some Codex builds replace the elapsed duration with token-budget progress.
  // Use that only as a tighter same-row fallback; an aligned duration always
  // wins, even when the token candidate would receive a higher score.
  if (!elapsed_known) {
    for (unsigned status_index = 0; status_index < state->status_count; status_index += 1) {
      CodexGoalStatusCandidate status = state->statuses[status_index];
      double status_center_x = status.position.x + status.size.width / 2;
      double status_center_y = status.position.y + status.size.height / 2;
      for (unsigned token_index = 0;
           token_index < state->token_progress_count;
           token_index += 1) {
        CodexGoalTokenProgressCandidate token = state->token_progress[token_index];
        double token_center_x = token.position.x + token.size.width / 2;
        double token_center_y = token.position.y + token.size.height / 2;
        double dx = token_center_x - status_center_x;
        double dy = token_center_y - status_center_y;
        if (dy < 0) dy = -dy;

        // The token fallback intentionally requires a closer pair than a
        // duration. It proves that the exact status and exact progress value
        // belong to the compact goal row rather than separate transcript text.
        if (dy > 18 || dx < -8
            || dx > state->window_size.width * 0.52 || dx > 620) continue;
        int score = 1000
          + (int)((status.position.y - state->window_origin.y) * 100 / state->window_size.height)
          - (int)(dy * 12)
          - (int)(dx / 20);
        if (score > best_score) {
          best_score = score;
          best_status = status.status;
        }
      }
    }
  }
  if (best_status == CODEX_GOAL_UNKNOWN) return false;
  if (status_out != NULL) *status_out = best_status;
  if (elapsed_seconds_out != NULL) *elapsed_seconds_out = best_elapsed_seconds;
  if (elapsed_known_out != NULL) *elapsed_known_out = elapsed_known;
  return true;
}

static int print_codex_goal_state(void) {
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.8);

  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window_value)
      != kAXErrorSuccess || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(application);
    return 1;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(window, &origin) || !copy_element_size(window, &size)) {
    CFRelease(window_value);
    CFRelease(application);
    return 1;
  }

  CodexGoalScanState scan = {
    .status_count = 0,
    .duration_count = 0,
    .token_progress_count = 0,
    .visited = 0,
    .traversal_failed = false,
    .window_origin = origin,
    .window_size = size
  };
  collect_codex_goal_state(window, 0, &scan);
  CodexGoalStatus status = CODEX_GOAL_UNKNOWN;
  uint64_t elapsed_seconds = 0;
  bool elapsed_known = false;
  bool found = select_codex_goal_state(&scan, &status, &elapsed_seconds, &elapsed_known);
  const char *reported_state = found ? codex_goal_status_name(status)
    : scan.traversal_failed ? "unknown"
      : "none";
  if (found && !elapsed_known) {
    printf("state=%s elapsed=unknown visited=%u\n", reported_state, scan.visited);
  } else {
    printf(
      "state=%s elapsed=%llu visited=%u\n",
      reported_state,
      (unsigned long long)(found ? elapsed_seconds : 0),
      scan.visited
    );
  }
  CFRelease(window_value);
  CFRelease(application);
  // Exit 2 means the focused window was read successfully and contains no
  // goal row. Exit 1 is reserved for application/window/AX failures so the
  // caller can debounce a real removal without mistaking a probe failure for
  // one.
  return found ? 0 : scan.traversal_failed ? 1 : 2;
}

static int goal_state_selftest(void) {
  @autoreleasepool {
    struct {
      NSString *label;
      CodexGoalStatus expected;
    } status_cases[] = {
      { @"Pursuing goal", CODEX_GOAL_ACTIVE },
      { @"진행 중인 목표", CODEX_GOAL_ACTIVE },
      { @"Paused goal", CODEX_GOAL_PAUSED },
      { @"일시중지된 목표", CODEX_GOAL_PAUSED },
      { @"Goal blocked", CODEX_GOAL_BLOCKED },
      { @"목표가 차단됨", CODEX_GOAL_BLOCKED },
      { @"Goal usage limited", CODEX_GOAL_USAGE_LIMITED },
      { @"목표 사용 제한", CODEX_GOAL_USAGE_LIMITED },
      { @"Goal limited", CODEX_GOAL_BUDGET_LIMITED },
      { @"목표 제한됨", CODEX_GOAL_BUDGET_LIMITED },
      { @"Goal achieved", CODEX_GOAL_COMPLETE },
      { @"목표 달성", CODEX_GOAL_COMPLETE }
    };
    bool mappings_passed = true;
    for (size_t index = 0; index < sizeof(status_cases) / sizeof(status_cases[0]); index += 1) {
      CodexGoalStatus actual = codex_goal_status_from_accessibility_string(
        (__bridge CFStringRef)status_cases[index].label
      );
      if (actual != status_cases[index].expected) {
        mappings_passed = false;
        break;
      }
    }

    struct {
      NSString *duration;
      uint64_t expected;
    } duration_cases[] = {
      { @"0s", 0 },
      { @"59s", 59 },
      { @"1m 2s", 62 },
      { @"2h 3m 4s", 7384 },
      { @"1d 2h 3m 4s", 93784 },
      { @"• 3m 5s", 185 },
      { @"  · 4h  ", 14400 }
    };
    bool durations_passed = true;
    for (size_t index = 0; index < sizeof(duration_cases) / sizeof(duration_cases[0]); index += 1) {
      uint64_t actual = 0;
      if (!compact_goal_duration_seconds(
          (__bridge CFStringRef)duration_cases[index].duration,
          &actual
        ) || actual != duration_cases[index].expected) {
        durations_passed = false;
        break;
      }
    }
    NSString *rejected_durations[] = {
      @"elapsed 2m", @"2m remaining", @"1m 2h", @"2m, 3s", @"•"
    };
    for (size_t index = 0;
         durations_passed && index < sizeof(rejected_durations) / sizeof(rejected_durations[0]);
         index += 1) {
      durations_passed = !compact_goal_duration_seconds(
        (__bridge CFStringRef)rejected_durations[index],
        NULL
      );
    }

    NSString *accepted_token_progress[] = {
      @"1.2K / 10K",
      @"800 / 10K",
      @"0/10K",
      @"• 2M / 10M",
      @"1.2B / 10B",
      @"1.2천 / 1만",
      @"900 / 1만",
      @"1만 / 1억"
    };
    bool token_progress_parser_passed = true;
    for (size_t index = 0;
         index < sizeof(accepted_token_progress) / sizeof(accepted_token_progress[0]);
         index += 1) {
      if (!compact_goal_token_progress(
          (__bridge CFStringRef)accepted_token_progress[index]
        )) {
        token_progress_parser_passed = false;
        break;
      }
    }
    NSString *rejected_token_progress[] = {
      @"1 / 2",
      @"tokens 1.2K / 10K",
      @"1.2K / 10K remaining",
      @"docs/setup",
      @"https://example.com/path",
      @"1.2K / about 10K",
      @"1.2K / 10K / 20K",
      @"1.234K / 10K",
      @"1K / 0K",
      @"천 / 만",
      @"1.2 천 / 1 만",
      @"1.2천 tokens / 1만",
      @"1.2천 / 목표 1만",
      @"1.2천 / 1만 남음",
      @"1.2조 / 1억"
    };
    for (size_t index = 0;
         token_progress_parser_passed
           && index < sizeof(rejected_token_progress) / sizeof(rejected_token_progress[0]);
         index += 1) {
      token_progress_parser_passed = !compact_goal_token_progress(
        (__bridge CFStringRef)rejected_token_progress[index]
      );
    }

    bool exact_label_guard = codex_goal_status_from_accessibility_string(
        CFSTR("The Pursuing goal message")
      ) == CODEX_GOAL_UNKNOWN
      && codex_goal_status_from_accessibility_string(
        CFSTR("진행 중인 목표를 설명")
      ) == CODEX_GOAL_UNKNOWN;
    CGPoint window_origin = CGPointMake(100, 100);
    CGSize window_size = CGSizeMake(1200, 800);
    bool geometry_guard = codex_goal_candidate_geometry(
        window_origin,
        window_size,
        CGPointMake(440, 640),
        CGSizeMake(140, 24),
        false
      )
      && !codex_goal_candidate_geometry(
        window_origin,
        window_size,
        CGPointMake(440, 130),
        CGSizeMake(140, 24),
        false
      )
      && !codex_goal_candidate_geometry(
        window_origin,
        window_size,
        CGPointMake(140, 640),
        CGSizeMake(140, 24),
        false
      );
    CodexGoalScanState aligned_scan = {
      .status_count = 1,
      .duration_count = 1,
      .token_progress_count = 1,
      .window_origin = window_origin,
      .window_size = window_size
    };
    aligned_scan.statuses[0] = (CodexGoalStatusCandidate) {
      .status = CODEX_GOAL_BLOCKED,
      .position = CGPointMake(440, 640),
      .size = CGSizeMake(140, 24)
    };
    aligned_scan.durations[0] = (CodexGoalDurationCandidate) {
      .elapsed_seconds = 125,
      .position = CGPointMake(610, 642),
      .size = CGSizeMake(60, 22)
    };
    aligned_scan.token_progress[0] = (CodexGoalTokenProgressCandidate) {
      .position = CGPointMake(610, 642),
      .size = CGSizeMake(96, 22)
    };
    CodexGoalStatus paired_status = CODEX_GOAL_UNKNOWN;
    uint64_t paired_elapsed = 0;
    bool paired_elapsed_known = false;
    bool proximity_guard = select_codex_goal_state(
        &aligned_scan,
        &paired_status,
        &paired_elapsed,
        &paired_elapsed_known
      )
      && paired_status == CODEX_GOAL_BLOCKED
      && paired_elapsed == 125
      && paired_elapsed_known;

    CodexGoalScanState token_only_scan = aligned_scan;
    token_only_scan.duration_count = 0;
    paired_status = CODEX_GOAL_UNKNOWN;
    paired_elapsed_known = true;
    bool token_progress_pairing = select_codex_goal_state(
        &token_only_scan,
        &paired_status,
        NULL,
        &paired_elapsed_known
      )
      && paired_status == CODEX_GOAL_BLOCKED
      && !paired_elapsed_known;
    token_only_scan.token_progress[0].position.y = 430;
    token_progress_pairing = token_progress_pairing
      && !select_codex_goal_state(&token_only_scan, NULL, NULL, NULL);

    aligned_scan.durations[0].position.y = 430;
    aligned_scan.token_progress_count = 0;
    proximity_guard = proximity_guard
      && !select_codex_goal_state(&aligned_scan, NULL, NULL, NULL);

    CodexGoalScanState scan_limit = { 0 };
    bool scan_truncation_guard = begin_codex_goal_scan_visit(
        CODEX_GOAL_MAX_SCAN_DEPTH,
        &scan_limit
      )
      && scan_limit.visited == 1
      && !scan_limit.traversal_failed;
    scan_limit.visited = CODEX_GOAL_MAX_VISITED_ELEMENTS;
    scan_truncation_guard = scan_truncation_guard
      && !begin_codex_goal_scan_visit(0, &scan_limit)
      && scan_limit.traversal_failed;
    scan_limit = (CodexGoalScanState) { 0 };
    scan_truncation_guard = scan_truncation_guard
      && !begin_codex_goal_scan_visit(CODEX_GOAL_MAX_SCAN_DEPTH + 1, &scan_limit)
      && scan_limit.traversal_failed;

    CodexGoalScanState overflow_scan = {
      .status_count = CODEX_GOAL_MAX_STATUS_CANDIDATES
    };
    add_codex_goal_status_candidate(
      &overflow_scan,
      CODEX_GOAL_ACTIVE,
      CGPointMake(12, 34),
      CGSizeMake(56, 20)
    );
    bool candidate_overflow_guard = overflow_scan.traversal_failed
      && overflow_scan.status_count == CODEX_GOAL_MAX_STATUS_CANDIDATES;
    overflow_scan = (CodexGoalScanState) {
      .duration_count = CODEX_GOAL_MAX_DURATION_CANDIDATES
    };
    add_codex_goal_duration_candidate(
      &overflow_scan,
      42,
      CGPointMake(12, 34),
      CGSizeMake(56, 20)
    );
    candidate_overflow_guard = candidate_overflow_guard
      && overflow_scan.traversal_failed
      && overflow_scan.duration_count == CODEX_GOAL_MAX_DURATION_CANDIDATES;
    overflow_scan = (CodexGoalScanState) {
      .token_progress_count = CODEX_GOAL_MAX_TOKEN_PROGRESS_CANDIDATES
    };
    add_codex_goal_token_progress_candidate(
      &overflow_scan,
      CGPointMake(12, 34),
      CGSizeMake(56, 20)
    );
    candidate_overflow_guard = candidate_overflow_guard
      && overflow_scan.traversal_failed
      && overflow_scan.token_progress_count == CODEX_GOAL_MAX_TOKEN_PROGRESS_CANDIDATES;

    printf(
      "localized_status_mapping=%d duration_parser=%d token_progress_parser=%d "
      "exact_label_guard=%d composer_geometry_guard=%d proximity_guard=%d "
      "token_progress_pairing=%d scan_truncation_guard=%d "
      "candidate_overflow_guard=%d\n",
      mappings_passed ? 1 : 0,
      durations_passed ? 1 : 0,
      token_progress_parser_passed ? 1 : 0,
      exact_label_guard ? 1 : 0,
      geometry_guard ? 1 : 0,
      proximity_guard ? 1 : 0,
      token_progress_pairing ? 1 : 0,
      scan_truncation_guard ? 1 : 0,
      candidate_overflow_guard ? 1 : 0
    );
    return mappings_passed && durations_passed && token_progress_parser_passed
      && exact_label_guard && geometry_guard && proximity_guard
      && token_progress_pairing && scan_truncation_guard
      && candidate_overflow_guard ? 0 : 1;
  }
}

#define CODEX_QUEUE_MAX_HEADERS 128
#define CODEX_QUEUE_MAX_BUTTONS 512

typedef struct {
  size_t length;
  uint64_t hash;
} StringFingerprint;

typedef struct {
  StringFingerprint fingerprint;
  unsigned count;
} CountedFingerprint;

typedef struct {
  StringFingerprint headers[CODEX_QUEUE_MAX_HEADERS];
  unsigned header_count;
  CountedFingerprint buttons[CODEX_QUEUE_MAX_BUTTONS];
  unsigned button_count;
  unsigned visited;
  CGPoint window_origin;
  CGSize window_size;
} CodexQueueWindowState;

static bool fingerprints_equal(StringFingerprint left, StringFingerprint right) {
  return left.length == right.length && left.hash == right.hash;
}

static bool copy_element_fingerprint(
  AXUIElementRef element,
  CFStringRef attribute,
  StringFingerprint *fingerprint
) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess
      || value == NULL) {
    if (value != NULL) CFRelease(value);
    return false;
  }
  bool found = string_fingerprint(value, &fingerprint->length, &fingerprint->hash);
  CFRelease(value);
  return found;
}

static bool copy_element_position(AXUIElementRef element, CGPoint *position) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &value) != kAXErrorSuccess
      || value == NULL || CFGetTypeID(value) != AXValueGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return false;
  }
  bool found = AXValueGetValue((AXValueRef)value, kAXValueCGPointType, position);
  CFRelease(value);
  return found;
}

static bool copy_element_size(AXUIElementRef element, CGSize *size) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &value) != kAXErrorSuccess
      || value == NULL || CFGetTypeID(value) != AXValueGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return false;
  }
  bool found = AXValueGetValue((AXValueRef)value, kAXValueCGSizeType, size);
  CFRelease(value);
  return found;
}

static bool element_is_hidden(AXUIElementRef element) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXHiddenAttribute, &value) != kAXErrorSuccess
      || value == NULL || CFGetTypeID(value) != CFBooleanGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return false;
  }
  bool hidden = CFBooleanGetValue((CFBooleanRef)value);
  CFRelease(value);
  return hidden;
}

static void add_header_fingerprint(CodexQueueWindowState *state, StringFingerprint fingerprint) {
  for (unsigned index = 0; index < state->header_count; index += 1) {
    if (fingerprints_equal(state->headers[index], fingerprint)) return;
  }
  if (state->header_count >= CODEX_QUEUE_MAX_HEADERS) return;
  state->headers[state->header_count++] = fingerprint;
}

static void add_button_fingerprint(CodexQueueWindowState *state, StringFingerprint fingerprint) {
  for (unsigned index = 0; index < state->button_count; index += 1) {
    if (!fingerprints_equal(state->buttons[index].fingerprint, fingerprint)) continue;
    state->buttons[index].count += 1;
    return;
  }
  if (state->button_count >= CODEX_QUEUE_MAX_BUTTONS) return;
  state->buttons[state->button_count++] = (CountedFingerprint) {
    .fingerprint = fingerprint,
    .count = 1
  };
}

// Traverse only accessibility metadata. Queue message text is deliberately
// ignored; the caller receives hashes of the current window title and button
// labels, plus counts, so it can identify queue rows without logging content.
static void collect_codex_queue_descendants(
  AXUIElementRef element,
  unsigned depth,
  CodexQueueWindowState *state
) {
  if (element == NULL || depth > 28 || state->visited >= 6000) return;
  state->visited += 1;

  CFTypeRef role_value = NULL;
  AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role_value);
  bool is_button = role_value != NULL
    && CFGetTypeID(role_value) == CFStringGetTypeID()
    && CFEqual(role_value, kAXButtonRole);
  if (role_value != NULL) CFRelease(role_value);

  CGPoint position = CGPointZero;
  bool has_position = copy_element_position(element, &position);
  CGSize size = CGSizeZero;
  bool has_size = copy_element_size(element, &size);
  bool is_visible_button = is_button
    && has_position
    && has_size
    && size.width > 1
    && size.height > 1
    && position.x + size.width >= state->window_origin.x
    && position.x <= state->window_origin.x + state->window_size.width
    && position.y + size.height >= state->window_origin.y
    && position.y <= state->window_origin.y + state->window_size.height
    && !element_is_hidden(element);
  bool is_header_region = has_position
    && position.x >= state->window_origin.x + 240
    && position.y >= state->window_origin.y - 2
    && position.y <= state->window_origin.y + 74;

  CFStringRef attributes[] = {
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute
  };
  StringFingerprint element_fingerprints[5];
  unsigned element_fingerprint_count = 0;
  for (size_t index = 0; index < sizeof(attributes) / sizeof(attributes[0]); index += 1) {
    StringFingerprint fingerprint = { 0 };
    if (!copy_element_fingerprint(element, attributes[index], &fingerprint)) continue;
    bool duplicate = false;
    for (unsigned local_index = 0; local_index < element_fingerprint_count; local_index += 1) {
      if (fingerprints_equal(element_fingerprints[local_index], fingerprint)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    element_fingerprints[element_fingerprint_count++] = fingerprint;
    if (is_header_region) add_header_fingerprint(state, fingerprint);
    if (is_visible_button) add_button_fingerprint(state, fingerprint);
  }

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_queue_descendants((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static int print_codex_queue_state(void) {
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.8);

  // kAXFocusedWindowAttribute keeps the window Codex considers active even
  // after another macOS app moves to the foreground. That is the identity the
  // Current Task key should follow; kAXFocusedAttribute alone drops to false
  // as soon as Codex is backgrounded.
  CFTypeRef active_window_value = NULL;
  AXUIElementCopyAttributeValue(
    application,
    kAXFocusedWindowAttribute,
    &active_window_value
  );

  CFTypeRef windows_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows_value) != kAXErrorSuccess
      || windows_value == NULL || CFGetTypeID(windows_value) != CFArrayGetTypeID()) {
    if (windows_value != NULL) CFRelease(windows_value);
    if (active_window_value != NULL) CFRelease(active_window_value);
    CFRelease(application);
    return 1;
  }

  CFArrayRef windows = (CFArrayRef)windows_value;
  CFIndex window_count = CFArrayGetCount(windows);
  unsigned emitted = 0;
  for (CFIndex window_index = 0; window_index < window_count; window_index += 1) {
    CFTypeRef window_value = CFArrayGetValueAtIndex(windows, window_index);
    if (window_value == NULL || CFGetTypeID(window_value) != AXUIElementGetTypeID()) continue;
    AXUIElementRef window = (AXUIElementRef)window_value;
    CGPoint origin = CGPointZero;
    CGSize size = CGSizeZero;
    if (!copy_element_position(window, &origin) || !copy_element_size(window, &size)) continue;
    CodexQueueWindowState state = {
      .header_count = 0,
      .button_count = 0,
      .visited = 0,
      .window_origin = origin,
      .window_size = size
    };
    collect_codex_queue_descendants(window, 0, &state);
    CFTypeRef focused_value = NULL;
    bool focused = active_window_value != NULL
      && CFGetTypeID(active_window_value) == AXUIElementGetTypeID()
      && CFEqual(window_value, active_window_value);
    if (AXUIElementCopyAttributeValue(window, kAXFocusedAttribute, &focused_value) == kAXErrorSuccess
        && focused_value != NULL && CFGetTypeID(focused_value) == CFBooleanGetTypeID()) {
      focused = focused || CFBooleanGetValue((CFBooleanRef)focused_value);
    }
    if (focused_value != NULL) CFRelease(focused_value);
    printf("window\t%ld\t%d\n", (long)window_index, focused ? 1 : 0);
    for (unsigned index = 0; index < state.header_count; index += 1) {
      printf(
        "header\t%zu:%016llx\n",
        state.headers[index].length,
        (unsigned long long)state.headers[index].hash
      );
    }
    for (unsigned index = 0; index < state.button_count; index += 1) {
      printf(
        "button\t%zu:%016llx\t%u\n",
        state.buttons[index].fingerprint.length,
        (unsigned long long)state.buttons[index].fingerprint.hash,
        state.buttons[index].count
      );
    }
    printf("end\n");
    emitted += 1;
  }
  if (active_window_value != NULL) CFRelease(active_window_value);
  CFRelease(windows_value);
  CFRelease(application);
  return emitted > 0 ? 0 : 1;
}

#define CODEX_THREAD_TARGET_MAX 64

typedef struct {
  const StringFingerprint *fingerprints;
  unsigned fingerprint_count;
  CFStringRef uuid;
  bool uuid_only;
  CFArrayRef attributes;
  AXUIElementRef targets[CODEX_THREAD_TARGET_MAX];
  unsigned target_strengths[CODEX_THREAD_TARGET_MAX];
  unsigned target_count;
  unsigned uuid_matched_elements;
  unsigned title_matched_elements;
  unsigned visited;
  unsigned visit_limit;
} CodexThreadTargetState;

enum {
  CODEX_THREAD_MATCH_NONE = 0,
  CODEX_THREAD_MATCH_TITLE = 1,
  CODEX_THREAD_MATCH_UUID = 2
};

static AXUIElementRef copy_codex_thread_activation_target(AXUIElementRef element);

enum {
  THREAD_ATTR_TITLE = 0,
  THREAD_ATTR_VALUE,
  THREAD_ATTR_DESCRIPTION,
  THREAD_ATTR_HELP,
  THREAD_ATTR_IDENTIFIER,
  THREAD_ATTR_URL,
  THREAD_ATTR_DOM_IDENTIFIER,
  THREAD_ATTR_HIDDEN,
  THREAD_ATTR_CHILDREN,
  THREAD_ATTR_COUNT
};

static bool focus_accessibility_element(AXUIElementRef element) {
  if (element == NULL) return false;
  Boolean settable = false;
  if (AXUIElementIsAttributeSettable(element, kAXFocusedAttribute, &settable) != kAXErrorSuccess
      || !settable) return false;
  return AXUIElementSetAttributeValue(
    element,
    kAXFocusedAttribute,
    kCFBooleanTrue
  ) == kAXErrorSuccess;
}

static bool activate_accessibility_element_with_return(AXUIElementRef element) {
  if (!focus_accessibility_element(element)) return false;
  // Chromium exposes the task and composer controls as keyboard-focusable
  // buttons. Activating the verified element with Return triggers React's
  // normal handler without synthesizing a mouse event or using screen pixels.
  usleep(12000);
  tap_key(KEY_RETURN, 0);
  usleep(18000);
  return true;
}

#define CODEX_DICTATION_BUTTON_MAX 96

typedef struct {
  AXUIElementRef element;
  CGPoint position;
  CGSize size;
  bool enabled;
} CodexDictationButton;

typedef struct {
  CFArrayRef attributes;
  CodexDictationButton buttons[CODEX_DICTATION_BUTTON_MAX];
  unsigned button_count;
  unsigned visited;
} CodexDictationButtonState;

enum {
  DICTATION_ATTR_ROLE = 0,
  DICTATION_ATTR_HIDDEN,
  DICTATION_ATTR_ENABLED,
  DICTATION_ATTR_POSITION,
  DICTATION_ATTR_SIZE,
  DICTATION_ATTR_CHILDREN,
  DICTATION_ATTR_COUNT
};

static bool copy_batched_point(CFArrayRef values, CFIndex index, CGPoint *point) {
  if (values == NULL || CFArrayGetCount(values) <= index) return false;
  CFTypeRef value = CFArrayGetValueAtIndex(values, index);
  return value != NULL
    && CFGetTypeID(value) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)value, kAXValueCGPointType, point);
}

static bool copy_batched_size(CFArrayRef values, CFIndex index, CGSize *size) {
  if (values == NULL || CFArrayGetCount(values) <= index) return false;
  CFTypeRef value = CFArrayGetValueAtIndex(values, index);
  return value != NULL
    && CFGetTypeID(value) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)value, kAXValueCGSizeType, size);
}

static void collect_codex_dictation_buttons(
  AXUIElementRef element,
  unsigned depth,
  CodexDictationButtonState *state
) {
  if (element == NULL || depth > 30 || state->visited >= 6000) return;
  state->visited += 1;

  CFArrayRef values = NULL;
  AXError error = AXUIElementCopyMultipleAttributeValues(
    element,
    state->attributes,
    0,
    &values
  );
  if (error != kAXErrorSuccess || values == NULL
      || CFArrayGetCount(values) < DICTATION_ATTR_COUNT) {
    if (values != NULL) CFRelease(values);
    return;
  }

  CFTypeRef role = CFArrayGetValueAtIndex(values, DICTATION_ATTR_ROLE);
  CFTypeRef hidden = CFArrayGetValueAtIndex(values, DICTATION_ATTR_HIDDEN);
  CFTypeRef enabled = CFArrayGetValueAtIndex(values, DICTATION_ATTR_ENABLED);
  bool is_button = role != NULL
    && CFGetTypeID(role) == CFStringGetTypeID()
    && CFEqual(role, kAXButtonRole);
  bool is_hidden = hidden != NULL
    && CFGetTypeID(hidden) == CFBooleanGetTypeID()
    && CFBooleanGetValue((CFBooleanRef)hidden);
  bool is_enabled = enabled == NULL
    || CFGetTypeID(enabled) != CFBooleanGetTypeID()
    || CFBooleanGetValue((CFBooleanRef)enabled);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool has_geometry = copy_batched_point(values, DICTATION_ATTR_POSITION, &position)
    && copy_batched_size(values, DICTATION_ATTR_SIZE, &size);
  bool is_compact_square = size.width >= 26
    && size.width <= 32
    && size.height >= 26
    && size.height <= 32;
  if (is_button && !is_hidden && has_geometry && is_compact_square
      && state->button_count < CODEX_DICTATION_BUTTON_MAX) {
    state->buttons[state->button_count++] = (CodexDictationButton) {
      .element = (AXUIElementRef)CFRetain(element),
      .position = position,
      .size = size,
      .enabled = is_enabled
    };
  }

  CFTypeRef children_value = CFArrayGetValueAtIndex(values, DICTATION_ATTR_CHILDREN);
  if (children_value != NULL && CFGetTypeID(children_value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)children_value;
    for (CFIndex index = 0; index < CFArrayGetCount(children); index += 1) {
      CFTypeRef child = CFArrayGetValueAtIndex(children, index);
      if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
        collect_codex_dictation_buttons((AXUIElementRef)child, depth + 1, state);
      }
    }
  }
  CFRelease(values);
}

static void release_codex_dictation_buttons(CodexDictationButtonState *state) {
  for (unsigned index = 0; index < state->button_count; index += 1) {
    if (state->buttons[index].element != NULL) CFRelease(state->buttons[index].element);
    state->buttons[index].element = NULL;
  }
  state->button_count = 0;
}

static bool codex_is_frontmost(void) {
  @autoreleasepool {
    NSString *bundle_id = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
    return [bundle_id isEqualToString:@"com.openai.codex"];
  }
}

static int wait_for_codex_frontmost(CFTimeInterval timeout_seconds) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  do {
    if (codex_is_frontmost()) return 0;
    usleep(25000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return 1;
}

typedef enum {
  CODEX_FAST_MODE_UNKNOWN = -1,
  CODEX_FAST_MODE_OFF = 0,
  CODEX_FAST_MODE_ON = 1
} CodexFastModeValue;

typedef enum {
  CODEX_FAST_CONTROL_NONE = 0,
  CODEX_FAST_CONTROL_DIRECT = 1,
  CODEX_FAST_CONTROL_SELECTOR = 2
} CodexFastControlKind;

typedef enum {
  CODEX_FAST_ACTION_UNAVAILABLE = 0,
  CODEX_FAST_ACTION_NONE = 1,
  CODEX_FAST_ACTION_PRESS_DIRECT = 2,
  CODEX_FAST_ACTION_SELECT_OPTION = 3
} CodexFastAction;

typedef struct {
  bool fast_context;
  bool standard_mode_context;
  bool speed_context;
  bool mentions_fast;
  bool mentions_standard;
  bool enable_action;
  bool disable_action;
  bool explicit_on;
  bool explicit_off;
  bool exact_fast;
  bool exact_standard;
  bool exact_speed;
} CodexFastTextSignals;

typedef struct {
  CFArrayRef attributes;
  AXUIElementRef intelligence_trigger;
  unsigned intelligence_trigger_count;
  CGPoint intelligence_trigger_position;
  CGSize intelligence_trigger_size;
  bool intelligence_trigger_expanded;
  bool intelligence_trigger_expanded_known;
  const char *reasoning_effort;
  AXUIElementRef control;
  CodexFastControlKind control_kind;
  int control_score;
  unsigned control_count;
  CGPoint control_position;
  CGSize control_size;
  AXUIElementRef on_option;
  AXUIElementRef off_option;
  unsigned on_option_count;
  unsigned off_option_count;
  CodexFastModeValue value;
  int value_score;
  bool value_conflict;
  bool available;
  bool allow_popup_options;
  bool composer_input_found;
  CGPoint composer_input_position;
  CGSize composer_input_size;
  double composer_input_score;
  unsigned visited;
  CGPoint window_origin;
  CGSize window_size;
} CodexFastModeScan;

enum {
  FAST_ATTR_ROLE = 0,
  FAST_ATTR_TITLE,
  FAST_ATTR_VALUE,
  FAST_ATTR_DESCRIPTION,
  FAST_ATTR_HELP,
  FAST_ATTR_IDENTIFIER,
  FAST_ATTR_ROLE_DESCRIPTION,
  FAST_ATTR_DOM_IDENTIFIER,
  FAST_ATTR_SELECTED,
  FAST_ATTR_EXPANDED,
  FAST_ATTR_ENABLED,
  FAST_ATTR_HIDDEN,
  FAST_ATTR_POSITION,
  FAST_ATTR_SIZE,
  FAST_ATTR_CHILDREN,
  FAST_ATTR_MENU_MARK,
  FAST_ATTR_COUNT
};

static bool codex_fast_text_contains_any(
  NSString *text,
  NSArray<NSString *> *needles
) {
  for (NSString *needle in needles) {
    if ([text containsString:needle]) return true;
  }
  return false;
}

static CodexFastTextSignals codex_fast_signals_from_string(CFTypeRef value) {
  CodexFastTextSignals signals = { 0 };
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return signals;
  @autoreleasepool {
    NSString *text = [[(__bridge NSString *)value lowercaseString]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length == 0) return signals;
    NSString *normalized = [[text stringByReplacingOccurrencesOfString:@"_" withString:@"-"]
      stringByReplacingOccurrencesOfString:@"–" withString:@"-"];
    signals.exact_fast = [normalized isEqualToString:@"fast"]
      || [normalized isEqualToString:@"fast mode"]
      || [normalized isEqualToString:@"빠름"]
      || [normalized isEqualToString:@"빠른 모드"]
      || [normalized isEqualToString:@"고속"]
      || [normalized isEqualToString:@"고속 모드"];
    signals.exact_standard = [normalized isEqualToString:@"standard"]
      || [normalized isEqualToString:@"standard mode"]
      || [normalized isEqualToString:@"표준"]
      || [normalized isEqualToString:@"표준 모드"];
    signals.exact_speed = [normalized isEqualToString:@"speed"]
      || [normalized isEqualToString:@"response speed"]
      || [normalized isEqualToString:@"속도"]
      || [normalized isEqualToString:@"응답 속도"];
    signals.mentions_fast = [normalized containsString:@"fast"]
      || [normalized containsString:@"빠름"]
      || [normalized containsString:@"빠른"]
      || [normalized containsString:@"고속"];
    signals.mentions_standard = [normalized containsString:@"standard"]
      || [normalized containsString:@"표준"];
    signals.speed_context = [normalized containsString:@"speed"]
      || [normalized containsString:@"속도"];
    signals.fast_context = [normalized containsString:@"fast mode"]
      || [normalized containsString:@"fast-mode"]
      || [normalized containsString:@"/fast"]
      || [normalized containsString:@"빠른 모드"]
      || [normalized containsString:@"고속 모드"];
    signals.standard_mode_context = [normalized containsString:@"standard mode"]
      || [normalized containsString:@"standard-mode"]
      || [normalized containsString:@"standard 모드"]
      || [normalized containsString:@"표준 모드"];
    signals.enable_action = codex_fast_text_contains_any(normalized, @[
      @"turn on", @"switch on", @"enable", @"activate",
      @"켜기", @"사용하기", @"활성화"
    ]);
    signals.disable_action = codex_fast_text_contains_any(normalized, @[
      @"turn off", @"switch off", @"disable", @"deactivate",
      @"끄기", @"사용 중지", @"비활성화"
    ]);
    signals.explicit_on = codex_fast_text_contains_any(normalized, @[
      @"mode on", @"mode: on", @"enabled", @"active",
      @"켜짐", @"사용 중", @"활성"
    ]);
    signals.explicit_off = codex_fast_text_contains_any(normalized, @[
      @"mode off", @"mode: off", @"disabled", @"inactive",
      @"꺼짐", @"사용 안 함", @"비활성"
    ]);
    // Negative forms contain their positive suffixes in English (deactivate /
    // active) and Korean (비활성화 / 활성화). Keep those labels one-sided so
    // a clear "turn off" control cannot degrade to an unknown state.
    if ([normalized containsString:@"deactivate"]
        || [normalized containsString:@"비활성화"]) {
      signals.enable_action = false;
    }
    if ([normalized containsString:@"inactive"]
        || [normalized containsString:@"비활성"]) {
      signals.explicit_on = false;
    }
    // Korean action nouns contain the shorter state adjective. Treat the
    // fixed composer commands 활성화/비활성화 as actions, while standalone
    // 활성/비활성 continues to describe the current state.
    if ([normalized containsString:@"비활성화"]) {
      signals.explicit_off = false;
    } else if ([normalized containsString:@"활성화"]) {
      signals.explicit_on = false;
    }
  }
  return signals;
}

static void merge_codex_fast_signals(
  CodexFastTextSignals *destination,
  CodexFastTextSignals source
) {
  destination->fast_context |= source.fast_context;
  destination->standard_mode_context |= source.standard_mode_context;
  destination->speed_context |= source.speed_context;
  destination->mentions_fast |= source.mentions_fast;
  destination->mentions_standard |= source.mentions_standard;
  destination->enable_action |= source.enable_action;
  destination->disable_action |= source.disable_action;
  destination->explicit_on |= source.explicit_on;
  destination->explicit_off |= source.explicit_off;
  destination->exact_fast |= source.exact_fast;
  destination->exact_standard |= source.exact_standard;
  destination->exact_speed |= source.exact_speed;
}

static bool codex_fast_role_equals(CFTypeRef role, CFStringRef expected) {
  return role != NULL && CFGetTypeID(role) == CFStringGetTypeID()
    && CFEqual(role, expected);
}

static bool codex_fast_batched_boolean(
  CFArrayRef values,
  CFIndex index,
  bool *result
) {
  if (values == NULL || result == NULL || CFArrayGetCount(values) <= index) return false;
  CFTypeRef value = CFArrayGetValueAtIndex(values, index);
  if (value == NULL || CFGetTypeID(value) != CFBooleanGetTypeID()) return false;
  *result = CFBooleanGetValue((CFBooleanRef)value);
  return true;
}

static bool codex_fast_batched_numeric_boolean(
  CFArrayRef values,
  CFIndex index,
  bool *result
) {
  if (values == NULL || result == NULL || CFArrayGetCount(values) <= index) return false;
  CFTypeRef value = CFArrayGetValueAtIndex(values, index);
  if (value == NULL || CFGetTypeID(value) != CFNumberGetTypeID()) return false;
  int number = 0;
  if (!CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &number)) return false;
  if (number != 0 && number != 1) return false;
  *result = number == 1;
  return true;
}

static bool codex_fast_has_menu_mark(CFArrayRef values) {
  if (values == NULL || CFArrayGetCount(values) <= FAST_ATTR_MENU_MARK) return false;
  CFTypeRef value = CFArrayGetValueAtIndex(values, FAST_ATTR_MENU_MARK);
  return value != NULL && CFGetTypeID(value) == CFStringGetTypeID()
    && CFStringGetLength((CFStringRef)value) > 0;
}

static bool codex_fast_control_geometry_is_plausible(
  CGPoint position,
  CGSize size,
  CGPoint window_origin,
  CGSize window_size
) {
  if (window_size.width < 420 || window_size.height < 280
      || size.width < 16 || size.width > 420
      || size.height < 16 || size.height > 76) return false;
  return position.x >= window_origin.x + window_size.width * 0.18
    && position.x + size.width <= window_origin.x + window_size.width + 2
    && position.y >= window_origin.y + window_size.height * 0.52
    && position.y + size.height <= window_origin.y + window_size.height + 2;
}

static bool codex_fast_option_geometry_is_plausible(
  CGPoint position,
  CGSize size,
  CGPoint window_origin,
  CGSize window_size
) {
  if (size.width < 20 || size.width > 460 || size.height < 16 || size.height > 76) {
    return false;
  }
  // Chromium popovers can extend a few pixels outside the focused window.
  return position.x + size.width >= window_origin.x - 24
    && position.x <= window_origin.x + window_size.width + 24
    && position.y + size.height >= window_origin.y - 24
    && position.y <= window_origin.y + window_size.height + 24;
}

static bool codex_fast_control_is_near_composer(
  CGPoint control_position,
  CGSize control_size,
  CGPoint input_position,
  CGSize input_size
) {
  if (control_size.width <= 0 || control_size.height <= 0
      || input_size.width < 120 || input_size.height < 18) return false;
  double control_center_x = control_position.x + control_size.width / 2.0;
  double control_center_y = control_position.y + control_size.height / 2.0;
  return control_center_x >= input_position.x - 120
    && control_center_x <= input_position.x + input_size.width + 120
    && control_center_y >= input_position.y - 100
    && control_center_y <= input_position.y + input_size.height + 100;
}

static bool codex_accessibility_element_supports_press(AXUIElementRef element) {
  if (element == NULL) return false;
  CFArrayRef actions = NULL;
  AXError error = AXUIElementCopyActionNames(element, &actions);
  bool supports = error == kAXErrorSuccess && actions != NULL
    && CFArrayContainsValue(
      actions,
      CFRangeMake(0, CFArrayGetCount(actions)),
      kAXPressAction
    );
  if (actions != NULL) CFRelease(actions);
  return supports;
}

static void consider_codex_fast_value(
  CodexFastModeScan *scan,
  CodexFastModeValue value,
  int score
) {
  if (value == CODEX_FAST_MODE_UNKNOWN || score <= 0) return;
  if (score > scan->value_score) {
    scan->value = value;
    scan->value_score = score;
    scan->value_conflict = false;
  } else if (score == scan->value_score && scan->value != value) {
    scan->value = CODEX_FAST_MODE_UNKNOWN;
    scan->value_conflict = true;
  }
}

static void consider_codex_fast_control(
  CodexFastModeScan *scan,
  AXUIElementRef element,
  CodexFastControlKind kind,
  int score,
  CGPoint position,
  CGSize size
) {
  if (element == NULL || kind == CODEX_FAST_CONTROL_NONE || score <= 0) return;
  if (score > scan->control_score) {
    if (scan->control != NULL) CFRelease(scan->control);
    scan->control = (AXUIElementRef)CFRetain(element);
    scan->control_kind = kind;
    scan->control_score = score;
    scan->control_count = 1;
    scan->control_position = position;
    scan->control_size = size;
  } else if (score == scan->control_score
      && (scan->control == NULL || !CFEqual(scan->control, element))) {
    scan->control_count += 1;
  }
}

static void consider_codex_fast_option(
  CodexFastModeScan *scan,
  AXUIElementRef element,
  CodexFastModeValue option
) {
  AXUIElementRef *target = option == CODEX_FAST_MODE_ON
    ? &scan->on_option
    : &scan->off_option;
  unsigned *count = option == CODEX_FAST_MODE_ON
    ? &scan->on_option_count
    : &scan->off_option_count;
  if (*target == NULL) {
    *target = (AXUIElementRef)CFRetain(element);
    *count = 1;
  } else if (!CFEqual(*target, element)) {
    *count += 1;
  }
}

static void consider_codex_intelligence_trigger(
  CodexFastModeScan *scan,
  AXUIElementRef element,
  CGPoint position,
  CGSize size,
  bool expanded,
  bool expanded_known,
  const char *reasoning_effort
) {
  if (scan == NULL || element == NULL || reasoning_effort == NULL) return;
  if (scan->intelligence_trigger == NULL) {
    scan->intelligence_trigger = (AXUIElementRef)CFRetain(element);
    scan->intelligence_trigger_count = 1;
    scan->intelligence_trigger_position = position;
    scan->intelligence_trigger_size = size;
    scan->intelligence_trigger_expanded = expanded;
    scan->intelligence_trigger_expanded_known = expanded_known;
    scan->reasoning_effort = reasoning_effort;
  } else if (!CFEqual(scan->intelligence_trigger, element)) {
    scan->intelligence_trigger_count += 1;
  }
}

static CodexFastModeValue codex_fast_semantic_value(
  CodexFastTextSignals signals
) {
  // State adjectives such as "enabled" and "disabled" contain the action
  // stems "enable" and "disable". Prefer an explicit state before using a
  // button's action label to infer the inverse current state.
  if (signals.explicit_on && !signals.explicit_off) return CODEX_FAST_MODE_ON;
  if (signals.explicit_off && !signals.explicit_on) return CODEX_FAST_MODE_OFF;
  if (signals.fast_context) {
    if (signals.disable_action && !signals.enable_action) return CODEX_FAST_MODE_ON;
    if (signals.enable_action && !signals.disable_action) return CODEX_FAST_MODE_OFF;
  }
  // "Enable standard mode" is shown only while Fast is currently enabled;
  // its target is the inverse of "Enable fast mode".
  if (signals.standard_mode_context) {
    if (signals.enable_action && !signals.disable_action) return CODEX_FAST_MODE_ON;
    if (signals.disable_action && !signals.enable_action) return CODEX_FAST_MODE_OFF;
  }
  if (signals.speed_context && signals.mentions_fast && !signals.mentions_standard) {
    return CODEX_FAST_MODE_ON;
  }
  if (signals.speed_context && signals.mentions_standard && !signals.mentions_fast) {
    return CODEX_FAST_MODE_OFF;
  }
  return CODEX_FAST_MODE_UNKNOWN;
}

static void collect_codex_fast_mode_controls(
  AXUIElementRef element,
  unsigned depth,
  CodexFastModeScan *scan
) {
  if (element == NULL || scan == NULL || depth > 30 || scan->visited >= 6000) return;
  scan->visited += 1;

  CFArrayRef values = NULL;
  AXError error = AXUIElementCopyMultipleAttributeValues(
    element,
    scan->attributes,
    0,
    &values
  );
  if (error != kAXErrorSuccess || values == NULL
      || CFArrayGetCount(values) < FAST_ATTR_COUNT) {
    if (values != NULL) CFRelease(values);
    return;
  }

  CFTypeRef role = CFArrayGetValueAtIndex(values, FAST_ATTR_ROLE);
  bool is_button = codex_fast_role_equals(role, kAXButtonRole);
  bool is_popup = codex_fast_role_equals(role, kAXPopUpButtonRole);
  bool is_checkbox = codex_fast_role_equals(role, kAXCheckBoxRole)
    || codex_fast_role_equals(role, CFSTR("AXSwitch"));
  bool is_radio = codex_fast_role_equals(role, kAXRadioButtonRole);
  bool is_menu_item = codex_fast_role_equals(role, CFSTR("AXMenuItem"));
  bool actionable_role = is_button || is_popup || is_checkbox || is_radio || is_menu_item;

  bool hidden = false;
  bool enabled = true;
  codex_fast_batched_boolean(values, FAST_ATTR_HIDDEN, &hidden);
  codex_fast_batched_boolean(values, FAST_ATTR_ENABLED, &enabled);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool has_geometry = copy_batched_point(values, FAST_ATTR_POSITION, &position)
    && copy_batched_size(values, FAST_ATTR_SIZE, &size);
  if (!hidden && has_geometry && role_is_text_input(role)) {
    Boolean value_settable = false;
    Boolean focus_settable = false;
    AXUIElementIsAttributeSettable(element, kAXValueAttribute, &value_settable);
    AXUIElementIsAttributeSettable(element, kAXFocusedAttribute, &focus_settable);
    const double tolerance = 2.0;
    bool in_composer_region = value_settable && focus_settable
      && position.x >= scan->window_origin.x - tolerance
      && position.x + size.width <= scan->window_origin.x + scan->window_size.width + tolerance
      && position.y >= scan->window_origin.y + scan->window_size.height * 0.55
      && position.y + size.height <= scan->window_origin.y + scan->window_size.height + tolerance
      && size.width >= 120 && size.height >= 18;
    if (in_composer_region) {
      bool is_text_area = codex_fast_role_equals(role, kAXTextAreaRole);
      double score = position.y + size.height
        + (is_text_area ? scan->window_size.height : 0)
        + size.width / 10000.0;
      if (!scan->composer_input_found || score > scan->composer_input_score) {
        scan->composer_input_found = true;
        scan->composer_input_position = position;
        scan->composer_input_size = size;
        scan->composer_input_score = score;
      }
    }
  }

  CodexFastTextSignals signals = { 0 };
  const CFIndex text_indices[] = {
    FAST_ATTR_TITLE,
    FAST_ATTR_VALUE,
    FAST_ATTR_DESCRIPTION,
    FAST_ATTR_HELP,
    FAST_ATTR_IDENTIFIER,
    FAST_ATTR_ROLE_DESCRIPTION,
    FAST_ATTR_DOM_IDENTIFIER
  };
  for (size_t index = 0; index < sizeof(text_indices) / sizeof(text_indices[0]); index += 1) {
    merge_codex_fast_signals(
      &signals,
      codex_fast_signals_from_string(CFArrayGetValueAtIndex(values, text_indices[index]))
    );
  }

  bool selected = false;
  bool has_selected = codex_fast_batched_boolean(values, FAST_ATTR_SELECTED, &selected);
  if (!has_selected && codex_fast_has_menu_mark(values)) {
    selected = true;
    has_selected = true;
  }
  bool expanded = false;
  bool has_expanded = codex_fast_batched_boolean(
    values,
    FAST_ATTR_EXPANDED,
    &expanded
  );
  bool boolean_value = false;
  bool has_boolean_value = codex_fast_batched_boolean(
    values,
    FAST_ATTR_VALUE,
    &boolean_value
  ) || codex_fast_batched_numeric_boolean(
    values,
    FAST_ATTR_VALUE,
    &boolean_value
  );

  CodexFastModeValue semantic_value = codex_fast_semantic_value(signals);
  CFTypeRef title_value = CFArrayGetValueAtIndex(values, FAST_ATTR_TITLE);
  bool has_option_title = title_value != NULL
    && CFGetTypeID(title_value) == CFStringGetTypeID()
    && CFStringGetLength((CFStringRef)title_value) > 0;
  bool descriptive_speed_option = scan->allow_popup_options
    && is_menu_item
    && has_option_title
    && signals.speed_context
    && semantic_value != CODEX_FAST_MODE_UNKNOWN
    && (!has_expanded || !expanded);
  bool is_option = (is_radio || is_menu_item || (scan->allow_popup_options && is_button))
    && (signals.exact_fast || signals.exact_standard || descriptive_speed_option);
  bool in_control_region = has_geometry && codex_fast_control_geometry_is_plausible(
    position,
    size,
    scan->window_origin,
    scan->window_size
  );
  bool plausible_option = scan->allow_popup_options && has_geometry
    && codex_fast_option_geometry_is_plausible(
      position,
      size,
      scan->window_origin,
      scan->window_size
    );
  bool supports_press = actionable_role && !hidden && enabled
    && codex_accessibility_element_supports_press(element);

  if ((is_button || is_popup) && !hidden && enabled && in_control_region
      && supports_press) {
    CodexIntelligenceTextState intelligence = { 0 };
    collect_codex_intelligence_text_state(element, 0, &intelligence);
    if (intelligence.model_context && intelligence.effort != NULL) {
      consider_codex_intelligence_trigger(
        scan,
        element,
        position,
        size,
        expanded,
        has_expanded,
        intelligence.effort
      );
    }
  }

  if (is_option && (in_control_region || plausible_option)) {
    scan->available = true;
    CodexFastModeValue option = signals.exact_fast
      ? CODEX_FAST_MODE_ON
      : signals.exact_standard
        ? CODEX_FAST_MODE_OFF
        : semantic_value;
    if (has_selected && selected) consider_codex_fast_value(scan, option, 360);
    if (supports_press && (scan->allow_popup_options || in_control_region)) {
      consider_codex_fast_option(scan, element, option);
    }
    if (supports_press && has_selected && selected && in_control_region) {
      // Always-visible Fast/Standard radio groups have no separate selector.
      // Use only the selected option as the anchored group control while the
      // exact requested option remains the idempotent action target.
      consider_codex_fast_control(
        scan,
        element,
        CODEX_FAST_CONTROL_SELECTOR,
        405,
        position,
        size
      );
    }
  }

  // A model or reasoning popup also lives in the composer. Never classify a
  // generic AXPopUpButton as the speed selector unless its own fixed metadata
  // names Speed/Fast/Standard.
  bool popup_control_region = scan->allow_popup_options && plausible_option;
  bool selector = !is_option && (in_control_region || popup_control_region) && (
    (is_popup && (signals.exact_speed || signals.speed_context
      || signals.fast_context || signals.exact_fast || signals.exact_standard))
    || ((is_button || is_radio || (popup_control_region && is_menu_item))
      && (signals.exact_speed || signals.speed_context))
  );
  bool compact_popup_toggle = popup_control_region
    && (is_menu_item || is_checkbox)
    && (signals.fast_context || signals.standard_mode_context)
    && (signals.enable_action || signals.disable_action);
  bool direct = (in_control_region || compact_popup_toggle)
    && (is_button || is_checkbox || is_radio || compact_popup_toggle)
    && (signals.fast_context || signals.exact_fast) && !selector && !is_option;
  if (compact_popup_toggle) direct = !selector && !is_option;
  if (selector) {
    scan->available = true;
    if (semantic_value != CODEX_FAST_MODE_UNKNOWN) {
      consider_codex_fast_value(scan, semantic_value, 390);
    }
    if (supports_press) {
      consider_codex_fast_control(
        scan,
        element,
        CODEX_FAST_CONTROL_SELECTOR,
        semantic_value == CODEX_FAST_MODE_UNKNOWN ? 360 : 410,
        position,
        size
      );
    }
  } else if (direct) {
    scan->available = true;
    CodexFastModeValue direct_value = semantic_value;
    int value_score = semantic_value == CODEX_FAST_MODE_UNKNOWN
      ? 0
      : compact_popup_toggle ? 520 : 440;
    if (direct_value == CODEX_FAST_MODE_UNKNOWN && has_selected) {
      direct_value = selected ? CODEX_FAST_MODE_ON : CODEX_FAST_MODE_OFF;
      value_score = 420;
    } else if (direct_value == CODEX_FAST_MODE_UNKNOWN && has_boolean_value) {
      direct_value = boolean_value ? CODEX_FAST_MODE_ON : CODEX_FAST_MODE_OFF;
      value_score = 400;
    }
    consider_codex_fast_value(scan, direct_value, value_score);
    if (supports_press) {
      // Prefer a selector over an unknowable blind toggle, but prefer a direct
      // toggle when its current state is explicit.
      int control_score = direct_value == CODEX_FAST_MODE_UNKNOWN
        ? 330
        : compact_popup_toggle ? 510 : 430;
      consider_codex_fast_control(
        scan,
        element,
        CODEX_FAST_CONTROL_DIRECT,
        control_score,
        position,
        size
      );
    }
  }

  CFTypeRef children_value = CFArrayGetValueAtIndex(values, FAST_ATTR_CHILDREN);
  if (children_value != NULL && CFGetTypeID(children_value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)children_value;
    for (CFIndex index = 0; index < CFArrayGetCount(children); index += 1) {
      CFTypeRef child = CFArrayGetValueAtIndex(children, index);
      if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
        collect_codex_fast_mode_controls((AXUIElementRef)child, depth + 1, scan);
      }
    }
  }
  CFRelease(values);
}

static void release_codex_fast_mode_scan(CodexFastModeScan *scan) {
  if (scan == NULL) return;
  if (scan->intelligence_trigger != NULL) CFRelease(scan->intelligence_trigger);
  if (scan->control != NULL) CFRelease(scan->control);
  if (scan->on_option != NULL) CFRelease(scan->on_option);
  if (scan->off_option != NULL) CFRelease(scan->off_option);
  scan->intelligence_trigger = NULL;
  scan->control = NULL;
  scan->on_option = NULL;
  scan->off_option = NULL;
}

static bool copy_codex_fast_mode_scan(
  bool include_popup_options,
  CodexFastModeScan *scan
) {
  if (scan == NULL || !codex_is_frontmost()) return false;
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return false;
  AXUIElementSetMessagingTimeout(application, include_popup_options ? 0.45 : 0.65);
  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window_value)
        != kAXErrorSuccess
      || window_value == NULL || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(application);
    return false;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(window, &origin) || !copy_element_size(window, &size)) {
    CFRelease(window_value);
    CFRelease(application);
    return false;
  }

  const void *attribute_values[FAST_ATTR_COUNT] = {
    kAXRoleAttribute,
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    kAXRoleDescriptionAttribute,
    CFSTR("AXDOMIdentifier"),
    kAXSelectedAttribute,
    kAXExpandedAttribute,
    kAXEnabledAttribute,
    kAXHiddenAttribute,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXChildrenAttribute,
    CFSTR("AXMenuItemMarkChar")
  };
  CFArrayRef attributes = CFArrayCreate(
    kCFAllocatorDefault,
    attribute_values,
    FAST_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  if (attributes == NULL) {
    CFRelease(window_value);
    CFRelease(application);
    return false;
  }
  *scan = (CodexFastModeScan) {
    .attributes = attributes,
    .intelligence_trigger = NULL,
    .intelligence_trigger_count = 0,
    .intelligence_trigger_position = CGPointZero,
    .intelligence_trigger_size = CGSizeZero,
    .intelligence_trigger_expanded = false,
    .intelligence_trigger_expanded_known = false,
    .reasoning_effort = NULL,
    .control = NULL,
    .control_kind = CODEX_FAST_CONTROL_NONE,
    .control_score = 0,
    .control_count = 0,
    .control_position = CGPointZero,
    .control_size = CGSizeZero,
    .on_option = NULL,
    .off_option = NULL,
    .on_option_count = 0,
    .off_option_count = 0,
    .value = CODEX_FAST_MODE_UNKNOWN,
    .value_score = 0,
    .value_conflict = false,
    .available = false,
    .allow_popup_options = include_popup_options,
    .composer_input_found = false,
    .composer_input_position = CGPointZero,
    .composer_input_size = CGSizeZero,
    .composer_input_score = -1,
    .visited = 0,
    .window_origin = origin,
    .window_size = size
  };
  collect_codex_fast_mode_controls(
    include_popup_options ? application : window,
    0,
    scan
  );
  if (scan->value_conflict) scan->value = CODEX_FAST_MODE_UNKNOWN;
  bool intelligence_anchored = scan->composer_input_found
    && scan->intelligence_trigger != NULL
    && scan->intelligence_trigger_count == 1
    && codex_fast_control_is_near_composer(
      scan->intelligence_trigger_position,
      scan->intelligence_trigger_size,
      scan->composer_input_position,
      scan->composer_input_size
    );
  if (!intelligence_anchored) {
    if (scan->intelligence_trigger != NULL) CFRelease(scan->intelligence_trigger);
    scan->intelligence_trigger = NULL;
    scan->intelligence_trigger_count = 0;
    scan->reasoning_effort = NULL;
  }
  bool composer_anchored = scan->composer_input_found
    && scan->control != NULL
    && scan->control_count == 1
    && (
      codex_fast_control_is_near_composer(
        scan->control_position,
        scan->control_size,
        scan->composer_input_position,
        scan->composer_input_size
      )
      || (include_popup_options && intelligence_anchored
        && codex_fast_option_geometry_is_plausible(
          scan->control_position,
          scan->control_size,
          scan->window_origin,
          scan->window_size
        ))
    );
  if (!composer_anchored) {
    if (scan->control != NULL) CFRelease(scan->control);
    if (scan->on_option != NULL) CFRelease(scan->on_option);
    if (scan->off_option != NULL) CFRelease(scan->off_option);
    scan->control = NULL;
    scan->on_option = NULL;
    scan->off_option = NULL;
    scan->control_kind = CODEX_FAST_CONTROL_NONE;
    scan->control_count = 0;
    scan->on_option_count = 0;
    scan->off_option_count = 0;
    scan->value = CODEX_FAST_MODE_UNKNOWN;
    scan->value_score = 0;
    scan->available = false;
  }
  CFRelease(attributes);
  scan->attributes = NULL;
  CFRelease(window_value);
  CFRelease(application);
  return true;
}

static const char *codex_fast_mode_value_name(CodexFastModeValue value) {
  return value == CODEX_FAST_MODE_ON ? "on"
    : value == CODEX_FAST_MODE_OFF ? "off"
      : "unknown";
}

static bool perform_codex_accessibility_press(AXUIElementRef element);

static bool perform_codex_accessibility_show_menu(AXUIElementRef element) {
  return element != NULL && codex_is_frontmost()
    && AXUIElementPerformAction(element, kAXShowMenuAction) == kAXErrorSuccess;
}

static bool codex_intelligence_trigger_expanded(
  AXUIElementRef trigger,
  bool *expanded_out
) {
  if (trigger == NULL || expanded_out == NULL) return false;
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(trigger, kAXExpandedAttribute, &value);
  bool known = error == kAXErrorSuccess && value != NULL
    && CFGetTypeID(value) == CFBooleanGetTypeID();
  if (known) *expanded_out = CFBooleanGetValue((CFBooleanRef)value);
  if (value != NULL) CFRelease(value);
  return known;
}

static void close_codex_intelligence_popover_if_opened(AXUIElementRef trigger) {
  if (trigger == NULL || !codex_is_frontmost()) return;
  bool expanded = false;
  if (codex_intelligence_trigger_expanded(trigger, &expanded)) {
    if (expanded) {
      tap_key(KEY_ESCAPE, 0);
      usleep(30000);
    }
    return;
  }

  // Chromium normally exposes AXExpanded. If an older build omits it, press
  // the trigger only while an anchored speed control proves the popover is
  // still visible; this avoids reopening a menu that closed after selection.
  CodexFastModeScan scan = { 0 };
  bool popup_visible = copy_codex_fast_mode_scan(true, &scan)
    && scan.intelligence_trigger != NULL
    && scan.control != NULL
    && scan.control_count == 1;
  release_codex_fast_mode_scan(&scan);
  if (popup_visible) {
    tap_key(KEY_ESCAPE, 0);
    usleep(30000);
  }
}

static bool copy_codex_fast_mode_scan_with_intelligence_fallback(
  CodexFastModeScan *scan,
  AXUIElementRef *opened_trigger_out
) {
  if (scan == NULL) return false;
  if (opened_trigger_out != NULL) *opened_trigger_out = NULL;

  CodexFastModeScan shallow = { 0 };
  if (!copy_codex_fast_mode_scan(false, &shallow)) return false;
  if (shallow.value != CODEX_FAST_MODE_UNKNOWN
      || shallow.intelligence_trigger == NULL
      || shallow.intelligence_trigger_count != 1) {
    *scan = shallow;
    return true;
  }

  AXUIElementRef trigger = (AXUIElementRef)CFRetain(shallow.intelligence_trigger);
  bool expanded = shallow.intelligence_trigger_expanded;
  bool expanded_known = shallow.intelligence_trigger_expanded_known;
  if (!expanded_known) {
    expanded_known = codex_intelligence_trigger_expanded(trigger, &expanded);
  }
  bool opened_here = !(expanded_known && expanded);
  if (opened_here
      && !activate_accessibility_element_with_return(trigger)
      && !perform_codex_accessibility_show_menu(trigger)
      && !perform_codex_accessibility_press(trigger)) {
    CFRelease(trigger);
    *scan = shallow;
    return true;
  }
  release_codex_fast_mode_scan(&shallow);

  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 0.85;
  CodexFastModeScan last = { 0 };
  bool have_last = false;
  do {
    CodexFastModeScan candidate = { 0 };
    if (copy_codex_fast_mode_scan(true, &candidate)) {
      if (have_last) release_codex_fast_mode_scan(&last);
      last = candidate;
      have_last = true;
      if (last.value != CODEX_FAST_MODE_UNKNOWN || last.available) break;
    }
    usleep(45000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);

  if (!have_last) {
    if (opened_here) close_codex_intelligence_popover_if_opened(trigger);
    CFRelease(trigger);
    return false;
  }
  *scan = last;
  if (opened_here && opened_trigger_out != NULL) {
    *opened_trigger_out = trigger;
  } else {
    CFRelease(trigger);
  }
  return true;
}

static int print_codex_fast_mode_state(void) {
  CodexFastModeScan scan = { 0 };
  // This command is polled after navigation. A state read must never activate
  // the model picker; only an explicit physical Fast action may open it.
  bool scanned = copy_codex_fast_mode_scan(false, &scan);
  CodexFastModeValue value = scanned ? scan.value : CODEX_FAST_MODE_UNKNOWN;
  printf(
    "state=%s available=%d confidence=%d visited=%u\n",
    codex_fast_mode_value_name(value),
    scanned && scan.available ? 1 : 0,
    scanned ? scan.value_score : 0,
    scanned ? scan.visited : 0
  );
  release_codex_fast_mode_scan(&scan);
  // Known on and off states are both successful queries. Unknown remains a
  // distinct exit so callers never silently render a stale toggle state.
  return value == CODEX_FAST_MODE_UNKNOWN ? 2 : 0;
}

static int print_codex_composer_state(void) {
  CodexFastModeScan scan = { 0 };
  // Keep passive refresh visually inert. The compact trigger exposes the
  // reasoning label, while speed is merged from exact task metadata by the
  // plugin until a user-requested Fast toggle verifies a newer value.
  bool scanned = copy_codex_fast_mode_scan(false, &scan);
  const char *reasoning = scanned && scan.reasoning_effort != NULL
    ? scan.reasoning_effort
    : "unknown";
  const char *service_tier = scanned && scan.value == CODEX_FAST_MODE_ON
    ? "priority"
    : scanned && scan.value == CODEX_FAST_MODE_OFF
      ? "default"
      : "unknown";
  bool reasoning_available = strcmp(reasoning, "unknown") != 0;
  bool service_tier_available = strcmp(service_tier, "unknown") != 0;
  printf(
    "reasoning=%s service_tier=%s available=%d reasoning_available=%d service_tier_available=%d confidence=%d visited=%u\n",
    reasoning,
    service_tier,
    reasoning_available || service_tier_available ? 1 : 0,
    reasoning_available ? 1 : 0,
    service_tier_available ? 1 : 0,
    scanned ? scan.value_score : 0,
    scanned ? scan.visited : 0
  );
  release_codex_fast_mode_scan(&scan);
  return reasoning_available || service_tier_available ? 0 : 2;
}

static CodexFastAction codex_fast_action_for_state(
  CodexFastModeValue current,
  CodexFastModeValue requested,
  CodexFastControlKind control_kind,
  bool exact_option_available
) {
  if (current == requested) return CODEX_FAST_ACTION_NONE;
  if (exact_option_available || control_kind == CODEX_FAST_CONTROL_SELECTOR) {
    return CODEX_FAST_ACTION_SELECT_OPTION;
  }
  if (current != CODEX_FAST_MODE_UNKNOWN
      && control_kind == CODEX_FAST_CONTROL_DIRECT) {
    return CODEX_FAST_ACTION_PRESS_DIRECT;
  }
  return CODEX_FAST_ACTION_UNAVAILABLE;
}

static bool perform_codex_accessibility_press(AXUIElementRef element) {
  return element != NULL && codex_is_frontmost()
    && codex_accessibility_element_supports_press(element)
    && AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess;
}

static CodexFastModeValue wait_for_codex_fast_mode_value(
  CodexFastModeValue requested,
  CFTimeInterval timeout_seconds,
  int *confidence_out,
  unsigned *visited_out
) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  CodexFastModeValue last = CODEX_FAST_MODE_UNKNOWN;
  do {
    CodexFastModeScan scan = { 0 };
    AXUIElementRef opened_trigger = NULL;
    if (!copy_codex_fast_mode_scan_with_intelligence_fallback(
          &scan,
          &opened_trigger
        )) return CODEX_FAST_MODE_UNKNOWN;
    last = scan.value;
    if (confidence_out != NULL) *confidence_out = scan.value_score;
    if (visited_out != NULL) *visited_out = scan.visited;
    close_codex_intelligence_popover_if_opened(opened_trigger);
    if (opened_trigger != NULL) CFRelease(opened_trigger);
    release_codex_fast_mode_scan(&scan);
    if (last == requested) return last;
    usleep(60000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return last;
}

static AXUIElementRef wait_for_codex_fast_option(
  CodexFastModeValue requested,
  CFTimeInterval timeout_seconds
) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  do {
    CodexFastModeScan scan = { 0 };
    if (!copy_codex_fast_mode_scan(true, &scan)) return NULL;
    AXUIElementRef option = requested == CODEX_FAST_MODE_ON
      ? scan.on_option
      : scan.off_option;
    unsigned count = requested == CODEX_FAST_MODE_ON
      ? scan.on_option_count
      : scan.off_option_count;
    AXUIElementRef result = option != NULL && count == 1
      ? (AXUIElementRef)CFRetain(option)
      : NULL;
    release_codex_fast_mode_scan(&scan);
    if (result != NULL) return result;
    usleep(40000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return NULL;
}

static bool perform_codex_fast_action_for_scan(
  CodexFastModeScan *scan,
  CodexFastModeValue requested,
  CodexFastAction action
) {
  if (scan == NULL) return false;
  if (action == CODEX_FAST_ACTION_PRESS_DIRECT) {
    return scan->control_count == 1
      && (activate_accessibility_element_with_return(scan->control)
        || perform_codex_accessibility_press(scan->control));
  }
  if (action != CODEX_FAST_ACTION_SELECT_OPTION) return false;

  AXUIElementRef option = requested == CODEX_FAST_MODE_ON
    ? scan->on_option
    : scan->off_option;
  unsigned option_count = requested == CODEX_FAST_MODE_ON
    ? scan->on_option_count
    : scan->off_option_count;
  if (option != NULL && option_count == 1) {
    return activate_accessibility_element_with_return(option)
      || perform_codex_accessibility_press(option);
  }
  if (scan->control_count != 1
      || scan->control_kind != CODEX_FAST_CONTROL_SELECTOR
      || (!activate_accessibility_element_with_return(scan->control)
        && !perform_codex_accessibility_press(scan->control))) return false;

  AXUIElementRef requested_option = wait_for_codex_fast_option(requested, 0.7);
  bool acted = requested_option != NULL
    && (activate_accessibility_element_with_return(requested_option)
      || perform_codex_accessibility_press(requested_option));
  if (requested_option != NULL) CFRelease(requested_option);
  return acted;
}

static bool wait_for_codex_intelligence_popover_closed(
  AXUIElementRef trigger,
  CodexFastModeValue requested,
  CFTimeInterval timeout_seconds
) {
  if (trigger == NULL) return true;
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  do {
    bool expanded = false;
    if (codex_intelligence_trigger_expanded(trigger, &expanded) && !expanded) {
      return true;
    }
    // Current Chromium builds can leave AXExpanded stuck at true after a
    // keyboard-selected menu item has already dismissed the popover. A
    // read-only scan neither reopens nor clicks anything: accept an updated
    // selected item, or the disappearance of both exact speed options, as the
    // same successful consumption signal.
    CodexFastModeScan popup = { 0 };
    if (copy_codex_fast_mode_scan(true, &popup)) {
      bool selected_target = popup.value == requested;
      bool exact_options_visible = popup.on_option_count > 0
        || popup.off_option_count > 0;
      release_codex_fast_mode_scan(&popup);
      if (selected_target || !exact_options_visible) return true;
    }
    usleep(25000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return false;
}

static bool restore_codex_composer_after_fast_mode(void) {
  // A keyboard-selected speed option can update successfully while Chromium
  // leaves focus on the model picker. If its exact speed choices are still
  // visible, dismiss only that verified popover before restoring the composer.
  CodexFastModeScan popup = { 0 };
  bool speed_options_visible = copy_codex_fast_mode_scan(true, &popup)
    && (popup.on_option_count > 0 || popup.off_option_count > 0);
  release_codex_fast_mode_scan(&popup);
  if (speed_options_visible && codex_is_frontmost()) {
    tap_key(KEY_ESCAPE, 0);
    usleep(30000);
  }

  // The composer subtree can be replaced as the model setting is applied.
  // Retry the exact Accessibility focus briefly so the next hardware Send,
  // dictation, or shortcut action never lands on the old model control.
  for (unsigned attempt = 0; attempt < 3; attempt += 1) {
    if (focus_codex_composer_if_visible()) return true;
    usleep(45000);
  }
  return false;
}

static int toggle_codex_fast_mode(void) {
  CodexFastModeScan scan = { 0 };
  AXUIElementRef opened_trigger = NULL;
  if (!copy_codex_fast_mode_scan_with_intelligence_fallback(
        &scan,
        &opened_trigger
      )) {
    bool composer_focused = restore_codex_composer_after_fast_mode();
    printf(
      "state=unknown available=0 changed=0 verified=0 composer_focused=%d\n",
      composer_focused ? 1 : 0
    );
    return 2;
  }

  CodexFastModeValue observed = scan.value;
  CodexFastModeValue requested = observed == CODEX_FAST_MODE_ON
    ? CODEX_FAST_MODE_OFF
    : observed == CODEX_FAST_MODE_OFF
      ? CODEX_FAST_MODE_ON
      : CODEX_FAST_MODE_UNKNOWN;
  bool exact_option_available = requested == CODEX_FAST_MODE_ON
    ? scan.on_option != NULL && scan.on_option_count == 1
    : requested == CODEX_FAST_MODE_OFF
      ? scan.off_option != NULL && scan.off_option_count == 1
      : false;
  CodexFastAction action = codex_fast_action_for_state(
    observed,
    requested,
    scan.control_count == 1 ? scan.control_kind : CODEX_FAST_CONTROL_NONE,
    exact_option_available
  );
  bool acted = requested != CODEX_FAST_MODE_UNKNOWN
    && action != CODEX_FAST_ACTION_UNAVAILABLE
    && action != CODEX_FAST_ACTION_NONE
    && perform_codex_fast_action_for_scan(&scan, requested, action);
  bool verified = acted && wait_for_codex_intelligence_popover_closed(
    scan.intelligence_trigger,
    requested,
    0.55
  );
  if (!verified && opened_trigger != NULL) {
    close_codex_intelligence_popover_if_opened(opened_trigger);
  }
  bool composer_focused = restore_codex_composer_after_fast_mode();

  const char *reasoning = scan.reasoning_effort != NULL
    ? scan.reasoning_effort
    : "unknown";
  printf(
    "requested=%s state=%s available=%d changed=%d verified=%d reasoning=%s service_tier=%s composer_focused=%d\n",
    codex_fast_mode_value_name(requested),
    verified ? codex_fast_mode_value_name(requested) : codex_fast_mode_value_name(observed),
    scan.available ? 1 : 0,
    acted ? 1 : 0,
    verified ? 1 : 0,
    reasoning,
    verified && requested == CODEX_FAST_MODE_ON ? "priority"
      : verified && requested == CODEX_FAST_MODE_OFF ? "default"
        : "unknown",
    composer_focused ? 1 : 0
  );
  if (opened_trigger != NULL) CFRelease(opened_trigger);
  bool available = scan.available;
  release_codex_fast_mode_scan(&scan);
  return verified ? 0 : available ? 1 : 2;
}

static int set_codex_fast_mode(CodexFastModeValue requested) {
  bool changed = false;
  unsigned action_attempts = 0;
  int confidence = 0;
  unsigned visited = 0;
  bool available = false;
  CodexFastModeValue observed = CODEX_FAST_MODE_UNKNOWN;

  for (unsigned attempt = 0; attempt < 2; attempt += 1) {
    CodexFastModeScan scan = { 0 };
    AXUIElementRef opened_trigger = NULL;
    if (!copy_codex_fast_mode_scan_with_intelligence_fallback(
          &scan,
          &opened_trigger
        )) break;
    observed = scan.value;
    confidence = scan.value_score;
    visited = scan.visited;
    available = scan.available;
    bool exact_option_available = requested == CODEX_FAST_MODE_ON
      ? scan.on_option != NULL && scan.on_option_count == 1
      : scan.off_option != NULL && scan.off_option_count == 1;
    CodexFastAction action = codex_fast_action_for_state(
      observed,
      requested,
      scan.control_count == 1 ? scan.control_kind : CODEX_FAST_CONTROL_NONE,
      exact_option_available
    );
    if (action == CODEX_FAST_ACTION_NONE) {
      close_codex_intelligence_popover_if_opened(opened_trigger);
      if (opened_trigger != NULL) CFRelease(opened_trigger);
      release_codex_fast_mode_scan(&scan);
      printf(
        "requested=%s state=%s changed=%d verified=1 available=%d attempts=%u confidence=%d visited=%u\n",
        codex_fast_mode_value_name(requested),
        codex_fast_mode_value_name(observed),
        changed ? 1 : 0,
        available ? 1 : 0,
        action_attempts,
        confidence,
        visited
      );
      return 0;
    }
    if (action == CODEX_FAST_ACTION_UNAVAILABLE) {
      close_codex_intelligence_popover_if_opened(opened_trigger);
      if (opened_trigger != NULL) CFRelease(opened_trigger);
      release_codex_fast_mode_scan(&scan);
      break;
    }

    bool acted = perform_codex_fast_action_for_scan(&scan, requested, action);
    release_codex_fast_mode_scan(&scan);
    close_codex_intelligence_popover_if_opened(opened_trigger);
    if (opened_trigger != NULL) CFRelease(opened_trigger);
    if (!acted) break;
    changed = true;
    action_attempts += 1;
    observed = wait_for_codex_fast_mode_value(
      requested,
      1.0,
      &confidence,
      &visited
    );
    if (observed == requested) {
      printf(
        "requested=%s state=%s changed=1 verified=1 available=1 attempts=%u confidence=%d visited=%u\n",
        codex_fast_mode_value_name(requested),
        codex_fast_mode_value_name(observed),
        action_attempts,
        confidence,
        visited
      );
      return 0;
    }
    // Never press a direct toggle twice in one invocation: Chromium may have
    // changed the mode while exposing a stale accessibility value. An exact
    // Fast/Standard selection is idempotent and may safely retry once.
    if (action == CODEX_FAST_ACTION_PRESS_DIRECT) break;
  }

  printf(
    "requested=%s state=%s changed=%d verified=0 available=%d attempts=%u confidence=%d visited=%u\n",
    codex_fast_mode_value_name(requested),
    codex_fast_mode_value_name(observed),
    changed ? 1 : 0,
    available ? 1 : 0,
    action_attempts,
    confidence,
    visited
  );
  return available ? 1 : 2;
}

static int codex_fast_mode_selftest(void) {
  CodexFastTextSignals disable = codex_fast_signals_from_string(
    CFSTR("Turn off Fast mode")
  );
  CodexFastTextSignals enable = codex_fast_signals_from_string(
    CFSTR("Enable Fast mode")
  );
  CodexFastTextSignals korean = codex_fast_signals_from_string(
    CFSTR("빠른 모드 끄기")
  );
  CodexFastTextSignals korean_enable = codex_fast_signals_from_string(
    CFSTR("빠른 모드 활성화")
  );
  CodexFastTextSignals korean_disable = codex_fast_signals_from_string(
    CFSTR("빠른 모드 비활성화")
  );
  CodexFastTextSignals deactivate = codex_fast_signals_from_string(
    CFSTR("Deactivate Fast mode")
  );
  CodexFastTextSignals inactive = codex_fast_signals_from_string(
    CFSTR("Fast mode inactive")
  );
  CodexFastTextSignals enabled = codex_fast_signals_from_string(
    CFSTR("Fast mode enabled")
  );
  CodexFastTextSignals disabled = codex_fast_signals_from_string(
    CFSTR("Fast mode disabled")
  );
  CodexFastTextSignals enable_standard = codex_fast_signals_from_string(
    CFSTR("Enable standard mode")
  );
  CodexFastTextSignals korean_enable_standard = codex_fast_signals_from_string(
    CFSTR("Standard 모드 활성화")
  );
  CodexFastTextSignals breakfast = codex_fast_signals_from_string(
    CFSTR("Breakfast discussion")
  );
  CodexFastTextSignals speed = codex_fast_signals_from_string(CFSTR("Speed"));
  merge_codex_fast_signals(
    &speed,
    codex_fast_signals_from_string(CFSTR("Fast"))
  );
  bool localized_labels = codex_fast_semantic_value(disable) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(enable) == CODEX_FAST_MODE_OFF
    && codex_fast_semantic_value(korean) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(korean_enable) == CODEX_FAST_MODE_OFF
    && codex_fast_semantic_value(korean_disable) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(deactivate) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(inactive) == CODEX_FAST_MODE_OFF
    && codex_fast_semantic_value(enabled) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(disabled) == CODEX_FAST_MODE_OFF;
  bool exact_context_only = !breakfast.fast_context
    && !breakfast.speed_context
    && !breakfast.exact_fast;
  bool split_speed_value = codex_fast_semantic_value(speed) == CODEX_FAST_MODE_ON;
  CodexFastTextSignals standard_speed = codex_fast_signals_from_string(
    CFSTR("Speed Standard")
  );
  CodexFastTextSignals korean_standard_speed = codex_fast_signals_from_string(
    CFSTR("표준 기본 속도")
  );
  CodexFastTextSignals korean_fast_speed = codex_fast_signals_from_string(
    CFSTR("빠름 1.5배 속도, 사용량 증가")
  );
  bool localized_speed_options =
    codex_fast_semantic_value(korean_standard_speed) == CODEX_FAST_MODE_OFF
    && codex_fast_semantic_value(korean_fast_speed) == CODEX_FAST_MODE_ON;
  bool compact_target_inversion = codex_fast_semantic_value(enable_standard)
      == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(korean_enable_standard) == CODEX_FAST_MODE_ON
    && codex_fast_semantic_value(standard_speed) == CODEX_FAST_MODE_OFF;
  bool idempotent_plan = codex_fast_action_for_state(
    CODEX_FAST_MODE_ON,
    CODEX_FAST_MODE_ON,
    CODEX_FAST_CONTROL_DIRECT,
    false
  ) == CODEX_FAST_ACTION_NONE;
  bool known_direct_toggle = codex_fast_action_for_state(
    CODEX_FAST_MODE_OFF,
    CODEX_FAST_MODE_ON,
    CODEX_FAST_CONTROL_DIRECT,
    false
  ) == CODEX_FAST_ACTION_PRESS_DIRECT;
  bool unknown_direct_rejected = codex_fast_action_for_state(
    CODEX_FAST_MODE_UNKNOWN,
    CODEX_FAST_MODE_ON,
    CODEX_FAST_CONTROL_DIRECT,
    false
  ) == CODEX_FAST_ACTION_UNAVAILABLE;
  bool unknown_selector_exact = codex_fast_action_for_state(
    CODEX_FAST_MODE_UNKNOWN,
    CODEX_FAST_MODE_ON,
    CODEX_FAST_CONTROL_SELECTOR,
    false
  ) == CODEX_FAST_ACTION_SELECT_OPTION;
  bool exact_option_beats_direct = codex_fast_action_for_state(
    CODEX_FAST_MODE_ON,
    CODEX_FAST_MODE_OFF,
    CODEX_FAST_CONTROL_DIRECT,
    true
  ) == CODEX_FAST_ACTION_SELECT_OPTION;
  CGPoint origin = CGPointMake(100, 80);
  CGSize window = CGSizeMake(1200, 800);
  bool composer_control = codex_fast_control_geometry_is_plausible(
    CGPointMake(760, 760),
    CGSizeMake(140, 34),
    origin,
    window
  );
  bool body_rejected = !codex_fast_control_geometry_is_plausible(
    CGPointMake(760, 300),
    CGSizeMake(140, 34),
    origin,
    window
  );
  bool composer_anchored = codex_fast_control_is_near_composer(
    CGPointMake(760, 760),
    CGSizeMake(140, 34),
    CGPointMake(500, 680),
    CGSizeMake(600, 120)
  );
  bool foreign_panel_rejected = !codex_fast_control_is_near_composer(
    CGPointMake(180, 760),
    CGSizeMake(140, 34),
    CGPointMake(500, 680),
    CGSizeMake(600, 120)
  );
  printf(
    "localized_labels=%d localized_speed_options=%d exact_context_only=%d split_speed_value=%d compact_target_inversion=%d idempotent_plan=%d known_direct_toggle=%d unknown_direct_rejected=%d unknown_selector_exact=%d exact_option_beats_direct=%d composer_geometry=%d body_rejected=%d composer_anchored=%d foreign_panel_rejected=%d\n",
    localized_labels ? 1 : 0,
    localized_speed_options ? 1 : 0,
    exact_context_only ? 1 : 0,
    split_speed_value ? 1 : 0,
    compact_target_inversion ? 1 : 0,
    idempotent_plan ? 1 : 0,
    known_direct_toggle ? 1 : 0,
    unknown_direct_rejected ? 1 : 0,
    unknown_selector_exact ? 1 : 0,
    exact_option_beats_direct ? 1 : 0,
    composer_control ? 1 : 0,
    body_rejected ? 1 : 0,
    composer_anchored ? 1 : 0,
    foreign_panel_rejected ? 1 : 0
  );
  return localized_labels && localized_speed_options
    && exact_context_only && split_speed_value
    && compact_target_inversion
    && idempotent_plan && known_direct_toggle && unknown_direct_rejected
    && unknown_selector_exact && exact_option_beats_direct
    && composer_control && body_rejected
    && composer_anchored && foreign_panel_rejected ? 0 : 1;
}

typedef struct {
  AXUIElementRef application;
  AXUIElementRef window;
  CFArrayRef attributes;
  CodexDictationButtonState button_state;
  CGPoint window_origin;
  CGSize window_size;
  unsigned left_index;
  unsigned right_index;
} CodexComposerControls;

static bool find_codex_composer_button_pair(
  CodexDictationButtonState *state,
  CGPoint window_origin,
  CGSize window_size,
  unsigned *left_index_out,
  unsigned *right_index_out
) {
  bool found = false;
  double best_y = -1;
  double best_x = -1;
  double lower_region = window_origin.y + window_size.height * 0.60;
  double right_region = window_origin.x + window_size.width * 0.45;
  for (unsigned left_index = 0; left_index < state->button_count; left_index += 1) {
    CodexDictationButton left = state->buttons[left_index];
    if (left.position.y < lower_region || left.position.x < right_region) continue;
    for (unsigned right_index = 0; right_index < state->button_count; right_index += 1) {
      if (left_index == right_index) continue;
      CodexDictationButton right = state->buttons[right_index];
      double row_delta = left.position.y - right.position.y;
      if (row_delta < 0) row_delta = -row_delta;
      double gap = right.position.x - (left.position.x + left.size.width);
      if (row_delta > 3 || gap < 4 || gap > 18) continue;
      if (!found || left.position.y > best_y
          || (left.position.y == best_y && right.position.x > best_x)) {
        found = true;
        *left_index_out = left_index;
        *right_index_out = right_index;
        best_y = left.position.y;
        best_x = right.position.x;
      }
    }
  }
  return found;
}

static void release_codex_composer_controls(CodexComposerControls *controls) {
  release_codex_dictation_buttons(&controls->button_state);
  if (controls->attributes != NULL) CFRelease(controls->attributes);
  if (controls->window != NULL) CFRelease(controls->window);
  if (controls->application != NULL) CFRelease(controls->application);
  memset(controls, 0, sizeof(*controls));
}

static bool copy_codex_composer_controls_with_timeout(
  CodexComposerControls *controls,
  float messaging_timeout_seconds
) {
  memset(controls, 0, sizeof(*controls));
  controls->application = copy_codex_application();
  if (controls->application == NULL) return false;
  AXUIElementSetMessagingTimeout(controls->application, messaging_timeout_seconds);

  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(
        controls->application,
        kAXFocusedWindowAttribute,
        &window_value
      ) != kAXErrorSuccess
      || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    release_codex_composer_controls(controls);
    return false;
  }
  controls->window = (AXUIElementRef)window_value;
  if (!copy_element_position(controls->window, &controls->window_origin)
      || !copy_element_size(controls->window, &controls->window_size)) {
    release_codex_composer_controls(controls);
    return false;
  }

  const void *attribute_values[DICTATION_ATTR_COUNT] = {
    kAXRoleAttribute,
    kAXHiddenAttribute,
    kAXEnabledAttribute,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXChildrenAttribute
  };
  controls->attributes = CFArrayCreate(
    kCFAllocatorDefault,
    attribute_values,
    DICTATION_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  if (controls->attributes == NULL) {
    release_codex_composer_controls(controls);
    return false;
  }

  controls->button_state = (CodexDictationButtonState) {
    .attributes = controls->attributes,
    .button_count = 0,
    .visited = 0
  };
  collect_codex_dictation_buttons(controls->window, 0, &controls->button_state);
  if (!find_codex_composer_button_pair(
        &controls->button_state,
        controls->window_origin,
        controls->window_size,
        &controls->left_index,
        &controls->right_index
      )) {
    release_codex_composer_controls(controls);
    return false;
  }
  return true;
}

static bool copy_codex_composer_controls(CodexComposerControls *controls) {
  return copy_codex_composer_controls_with_timeout(controls, 0.5);
}

static bool frontmost_focused_element_is_text_input(void) {
  CFTypeRef focused_value = NULL;
  if (copy_frontmost_focused_element(&focused_value) != kAXErrorSuccess
      || focused_value == NULL) return false;
  AXUIElementRef focused = (AXUIElementRef)focused_value;
  CFTypeRef role_value = NULL;
  AXUIElementCopyAttributeValue(focused, kAXRoleAttribute, &role_value);
  Boolean settable = false;
  AXUIElementIsAttributeSettable(focused, kAXValueAttribute, &settable);
  CFTypeRef text_value = NULL;
  AXError value_error = AXUIElementCopyAttributeValue(focused, kAXValueAttribute, &text_value);
  bool is_text_input = role_is_text_input(role_value)
    && settable
    && value_error == kAXErrorSuccess
    && text_value != NULL
    && (CFGetTypeID(text_value) == CFStringGetTypeID()
      || CFGetTypeID(text_value) == CFAttributedStringGetTypeID());
  if (text_value != NULL) CFRelease(text_value);
  if (role_value != NULL) CFRelease(role_value);
  CFRelease(focused_value);
  return is_text_input;
}

typedef struct {
  AXUIElementRef element;
  unsigned visited;
  CGPoint window_origin;
  CGSize window_size;
  double best_score;
} CodexComposerInputState;

static void collect_codex_composer_inputs(
  AXUIElementRef element,
  unsigned depth,
  CodexComposerInputState *state
) {
  if (element == NULL || state == NULL || depth > 30 || state->visited >= 6000) return;
  state->visited += 1;
  if (element_is_hidden(element)) return;

  CFTypeRef role_value = NULL;
  AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role_value);
  Boolean value_settable = false;
  Boolean focus_settable = false;
  AXUIElementIsAttributeSettable(element, kAXValueAttribute, &value_settable);
  AXUIElementIsAttributeSettable(element, kAXFocusedAttribute, &focus_settable);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool has_geometry = copy_element_position(element, &position)
    && copy_element_size(element, &size);
  const double geometry_tolerance = 2.0;
  bool in_composer_region = has_geometry
    && position.x >= state->window_origin.x - geometry_tolerance
    && position.x + size.width <= state->window_origin.x + state->window_size.width + geometry_tolerance
    && position.y >= state->window_origin.y + state->window_size.height * 0.55
    && position.y + size.height <= state->window_origin.y + state->window_size.height + geometry_tolerance
    && size.width >= 120
    && size.height >= 18;
  if (role_is_text_input(role_value) && value_settable && focus_settable && in_composer_region) {
    bool is_text_area = CFEqual(role_value, kAXTextAreaRole);
    double score = position.y + size.height
      + (is_text_area ? state->window_size.height : 0)
      + size.width / 10000.0;
    if (state->element == NULL || score > state->best_score) {
      if (state->element != NULL) CFRelease(state->element);
      state->element = (AXUIElementRef)CFRetain(element);
      state->best_score = score;
    }
  }
  if (role_value != NULL) CFRelease(role_value);

  CFTypeRef children_value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess
      || children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != NULL) CFRelease(children_value);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  for (CFIndex index = 0; index < CFArrayGetCount(children); index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_composer_inputs((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static AXUIElementRef copy_codex_composer_input(CodexComposerControls *controls) {
  CodexComposerInputState state = {
    .element = NULL,
    .visited = 0,
    .window_origin = controls->window_origin,
    .window_size = controls->window_size,
    .best_score = -1
  };
  collect_codex_composer_inputs(controls->window, 0, &state);
  return state.element;
}

static bool focus_codex_composer_with_controls(CodexComposerControls *controls) {
  if (!codex_is_frontmost()) return false;
  AXUIElementRef input = copy_codex_composer_input(controls);
  bool focused = focus_accessibility_element(input);
  if (input != NULL) CFRelease(input);
  if (!focused) return false;
  usleep(12000);
  return frontmost_focused_element_is_text_input();
}

static bool focus_codex_composer_if_visible(void) {
  if (!codex_is_frontmost()) return false;
  CodexComposerControls controls = { 0 };
  controls.application = copy_codex_application();
  if (controls.application == NULL) return false;
  AXUIElementSetMessagingTimeout(controls.application, 0.5);
  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(
        controls.application,
        kAXFocusedWindowAttribute,
        &window_value
      ) != kAXErrorSuccess
      || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    release_codex_composer_controls(&controls);
    return false;
  }
  controls.window = (AXUIElementRef)window_value;
  if (!copy_element_position(controls.window, &controls.window_origin)
      || !copy_element_size(controls.window, &controls.window_size)) {
    release_codex_composer_controls(&controls);
    return false;
  }
  bool focused = focus_codex_composer_with_controls(&controls);
  release_codex_composer_controls(&controls);
  return focused;
}

static bool submit_codex_composer_if_visible(void) {
  if (!codex_is_frontmost() || codex_audio_input_is_running()) return false;
  CodexComposerControls controls;
  if (!copy_codex_composer_controls(&controls)) return false;
  CodexDictationButton submit = controls.button_state.buttons[controls.right_index];
  bool submitted = submit.enabled
    && activate_accessibility_element_with_return(submit.element);
  if (submitted) {
    // Put focus back in the composer so the caller can verify that the draft
    // returned to its pre-dictation state instead of assuming a click sent it.
    usleep(120000);
    focus_codex_composer_with_controls(&controls);
  }
  release_codex_composer_controls(&controls);
  return submitted;
}

static bool stop_codex_composer_dictation_if_visible(void) {
  if (!codex_audio_input_is_running()) return false;
  CodexComposerControls controls;
  // Voice release is synchronously bounded by the plugin. A shorter AX
  // messaging timeout leaves room for multiple fresh tree scans when Chromium
  // publishes the Stop button late, while normal focus/submit operations keep
  // their more forgiving timeout.
  if (!copy_codex_composer_controls_with_timeout(&controls, 0.2)) return false;
  CodexDictationButton stop = controls.button_state.buttons[controls.left_index];

  bool stopped = stop.enabled && codex_is_frontmost()
    ? activate_accessibility_element_with_return(stop.element)
    : stop.enabled
      && AXUIElementPerformAction(stop.element, kAXPressAction) == kAXErrorSuccess;
  if (stopped && codex_is_frontmost()) {
    // Keyboard activation focuses Stop. Restore the exact AXTextArea before
    // the JS probe checks whether transcription has stabilized.
    usleep(50000);
    focus_codex_composer_with_controls(&controls);
  }

  release_codex_composer_controls(&controls);
  return stopped;
}

static bool valid_thread_uuid(const char *uuid) {
  if (uuid == NULL || strlen(uuid) != 36) return false;
  for (size_t index = 0; index < 36; index += 1) {
    bool separator = index == 8 || index == 13 || index == 18 || index == 23;
    if (separator) {
      if (uuid[index] != '-') return false;
      continue;
    }
    char character = uuid[index];
    bool hexadecimal = (character >= '0' && character <= '9')
      || (character >= 'a' && character <= 'f')
      || (character >= 'A' && character <= 'F');
    if (!hexadecimal) return false;
  }
  return true;
}

static bool accessibility_value_contains_uuid(CFTypeRef value, CFStringRef uuid) {
  if (value == NULL || uuid == NULL) return false;
  CFStringRef string = NULL;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    string = (CFStringRef)value;
  } else if (CFGetTypeID(value) == CFAttributedStringGetTypeID()) {
    string = CFAttributedStringGetString((CFAttributedStringRef)value);
  } else if (CFGetTypeID(value) == CFURLGetTypeID()) {
    string = CFURLGetString((CFURLRef)value);
  }
  if (string == NULL || CFStringGetLength(string) == 0) return false;
  return CFStringFind(
    string,
    uuid,
    kCFCompareCaseInsensitive
  ).location != kCFNotFound;
}

static unsigned batched_element_thread_match(
  CFArrayRef values,
  CodexThreadTargetState *state
) {
  if (values == NULL || state == NULL
      || CFArrayGetCount(values) < THREAD_ATTR_COUNT) return CODEX_THREAD_MATCH_NONE;
  // UUIDs are stable across title edits, Unicode normalization, and duplicate
  // task titles. Prefer a UUID found anywhere in the element's public AX
  // metadata; the value stays in-process and is never printed.
  for (CFIndex index = THREAD_ATTR_TITLE; index <= THREAD_ATTR_DOM_IDENTIFIER; index += 1) {
    if (accessibility_value_contains_uuid(CFArrayGetValueAtIndex(values, index), state->uuid)) {
      return CODEX_THREAD_MATCH_UUID;
    }
  }
  if (state->uuid_only) return CODEX_THREAD_MATCH_NONE;
  for (CFIndex index = THREAD_ATTR_TITLE; index <= THREAD_ATTR_DOM_IDENTIFIER; index += 1) {
    CFTypeRef value = CFArrayGetValueAtIndex(values, index);
    StringFingerprint fingerprint = { 0 };
    if (!string_fingerprint(value, &fingerprint.length, &fingerprint.hash)) continue;
    for (unsigned fingerprint_index = 0;
         fingerprint_index < state->fingerprint_count;
         fingerprint_index += 1) {
      if (fingerprints_equal(fingerprint, state->fingerprints[fingerprint_index])) {
        return CODEX_THREAD_MATCH_TITLE;
      }
    }
  }
  return CODEX_THREAD_MATCH_NONE;
}

static void add_codex_thread_target(
  CodexThreadTargetState *state,
  AXUIElementRef target,
  unsigned strength
) {
  for (unsigned index = 0; index < state->target_count; index += 1) {
    if (!CFEqual(state->targets[index], target)) continue;
    if (strength > state->target_strengths[index]) {
      state->target_strengths[index] = strength;
    }
    return;
  }
  if (state->target_count >= CODEX_THREAD_TARGET_MAX) return;
  state->targets[state->target_count] = (AXUIElementRef)CFRetain(target);
  state->target_strengths[state->target_count] = strength;
  state->target_count += 1;
}

static void collect_codex_thread_targets(
  AXUIElementRef element,
  unsigned depth,
  CodexThreadTargetState *state
) {
  unsigned visit_limit = state->visit_limit > 0 ? state->visit_limit : 8000;
  if (element == NULL || depth > 30 || state->visited >= visit_limit) return;
  state->visited += 1;
  CFArrayRef values = NULL;
  AXError values_error = AXUIElementCopyMultipleAttributeValues(
    element,
    state->attributes,
    0,
    &values
  );
  if (values_error != kAXErrorSuccess || values == NULL
      || CFArrayGetCount(values) < THREAD_ATTR_COUNT) {
    if (values != NULL) CFRelease(values);
    return;
  }

  CFTypeRef hidden_value = CFArrayGetValueAtIndex(values, THREAD_ATTR_HIDDEN);
  bool hidden = hidden_value != NULL
    && CFGetTypeID(hidden_value) == CFBooleanGetTypeID()
    && CFBooleanGetValue((CFBooleanRef)hidden_value);
  unsigned match = hidden
    ? CODEX_THREAD_MATCH_NONE
    : batched_element_thread_match(values, state);
  if (match != CODEX_THREAD_MATCH_NONE) {
    if (match == CODEX_THREAD_MATCH_UUID) state->uuid_matched_elements += 1;
    else state->title_matched_elements += 1;
    // A task title is often exposed by several nested text nodes, and the
    // active header can repeat it without being actionable. Resolve every
    // match to its nearest press-capable ancestor first, then deduplicate that
    // control. Static headers and the command-palette search field therefore
    // cannot become navigation candidates.
    AXUIElementRef activation_target = copy_codex_thread_activation_target(element);
    if (activation_target != NULL) {
      add_codex_thread_target(state, activation_target, match);
      CFRelease(activation_target);
    }
  }

  CFTypeRef children_value = CFArrayGetValueAtIndex(values, THREAD_ATTR_CHILDREN);
  if (children_value == NULL || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    CFRelease(values);
    return;
  }
  CFArrayRef children = (CFArrayRef)children_value;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, index);
    if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
      collect_codex_thread_targets((AXUIElementRef)child, depth + 1, state);
    }
  }
  CFRelease(values);
}

static void release_codex_thread_targets(CodexThreadTargetState *state) {
  for (unsigned index = 0; index < state->target_count; index += 1) {
    CFRelease(state->targets[index]);
    state->targets[index] = NULL;
    state->target_strengths[index] = CODEX_THREAD_MATCH_NONE;
  }
  state->target_count = 0;
}

static unsigned best_codex_thread_target_strength(const CodexThreadTargetState *state) {
  unsigned best = CODEX_THREAD_MATCH_NONE;
  for (unsigned index = 0; index < state->target_count; index += 1) {
    if (state->target_strengths[index] > best) best = state->target_strengths[index];
  }
  return best;
}

static unsigned count_codex_thread_targets_at_strength(
  const CodexThreadTargetState *state,
  unsigned strength,
  AXUIElementRef *single_target_out
) {
  unsigned count = 0;
  if (single_target_out != NULL) *single_target_out = NULL;
  for (unsigned index = 0; index < state->target_count; index += 1) {
    if (state->target_strengths[index] != strength) continue;
    count += 1;
    if (single_target_out != NULL) *single_target_out = state->targets[index];
  }
  return count;
}

static bool parse_fingerprint(const char *input, StringFingerprint *fingerprint) {
  if (input == NULL || fingerprint == NULL) return false;
  char trailing = '\0';
  unsigned long long hash = 0;
  size_t length = 0;
  if (sscanf(input, "%zu:%llx%c", &length, &hash, &trailing) != 2 || length == 0) return false;
  fingerprint->length = length;
  fingerprint->hash = (uint64_t)hash;
  return true;
}

static bool parse_fingerprint_inputs(
  const char * const *inputs,
  unsigned input_count,
  StringFingerprint **fingerprints_out,
  unsigned *fingerprint_count_out
) {
  if (inputs == NULL || input_count == 0
      || fingerprints_out == NULL || fingerprint_count_out == NULL) return false;
  StringFingerprint *fingerprints = calloc(input_count, sizeof(StringFingerprint));
  if (fingerprints == NULL) return false;

  unsigned fingerprint_count = 0;
  for (unsigned input_index = 0; input_index < input_count; input_index += 1) {
    StringFingerprint parsed = { 0 };
    if (!parse_fingerprint(inputs[input_index], &parsed)) {
      free(fingerprints);
      return false;
    }
    bool duplicate = false;
    for (unsigned existing_index = 0;
         existing_index < fingerprint_count;
         existing_index += 1) {
      if (fingerprints_equal(parsed, fingerprints[existing_index])) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) fingerprints[fingerprint_count++] = parsed;
  }
  if (fingerprint_count == 0) {
    free(fingerprints);
    return false;
  }
  *fingerprints_out = fingerprints;
  *fingerprint_count_out = fingerprint_count;
  return true;
}

static int codex_thread_fingerprint_selftest(void) {
  const char *uuid_text = "123e4567-e89b-12d3-a456-426614174000";
  const char *valid_inputs[] = {
    "3:e71fa2190541574b",
    "3:e71fa2190541574b",
    "4:0000000000000001"
  };
  StringFingerprint *fingerprints = NULL;
  unsigned fingerprint_count = 0;
  bool parsed = parse_fingerprint_inputs(
    valid_inputs,
    3,
    &fingerprints,
    &fingerprint_count
  );

  const void *title_values[THREAD_ATTR_COUNT] = {
    CFSTR("abc"),
    kCFNull,
    kCFNull,
    kCFNull,
    kCFNull,
    kCFNull,
    kCFNull,
    kCFBooleanFalse,
    kCFNull
  };
  CFArrayRef title_attributes = CFArrayCreate(
    kCFAllocatorDefault,
    title_values,
    THREAD_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  const void *uuid_values[THREAD_ATTR_COUNT] = {
    CFSTR("abc"),
    kCFNull,
    kCFNull,
    kCFNull,
    CFSTR("task-123e4567-e89b-12d3-a456-426614174000-row"),
    kCFNull,
    kCFNull,
    kCFBooleanFalse,
    kCFNull
  };
  CFArrayRef uuid_attributes = CFArrayCreate(
    kCFAllocatorDefault,
    uuid_values,
    THREAD_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  CFStringRef uuid = CFStringCreateWithCString(
    kCFAllocatorDefault,
    uuid_text,
    kCFStringEncodingUTF8
  );
  CodexThreadTargetState any_state = {
    .fingerprints = fingerprints,
    .fingerprint_count = fingerprint_count,
    .uuid = uuid,
    .uuid_only = false
  };
  bool title_match = parsed && title_attributes != NULL
    && batched_element_thread_match(title_attributes, &any_state)
      == CODEX_THREAD_MATCH_TITLE;
  bool uuid_preferred = parsed && uuid_attributes != NULL
    && batched_element_thread_match(uuid_attributes, &any_state)
      == CODEX_THREAD_MATCH_UUID;
  CodexThreadTargetState strict_state = {
    .fingerprints = fingerprints,
    .fingerprint_count = fingerprint_count,
    .uuid = uuid,
    .uuid_only = true
  };
  bool strict_uuid_match = uuid_attributes != NULL
    && batched_element_thread_match(uuid_attributes, &strict_state)
      == CODEX_THREAD_MATCH_UUID;
  bool strict_title_rejected = title_attributes != NULL
    && batched_element_thread_match(title_attributes, &strict_state)
      == CODEX_THREAD_MATCH_NONE;
  CodexThreadTargetState nonmatch_state = {
    .fingerprints = parsed && fingerprint_count > 1 ? &fingerprints[1] : NULL,
    .fingerprint_count = parsed && fingerprint_count > 1 ? 1 : 0,
    .uuid = uuid,
    .uuid_only = false
  };
  bool rejects_nonmatch = parsed && title_attributes != NULL
    && batched_element_thread_match(title_attributes, &nonmatch_state)
      == CODEX_THREAD_MATCH_NONE;

  const char *invalid_inputs[] = { "malformed" };
  StringFingerprint *invalid_fingerprints = NULL;
  unsigned invalid_count = 0;
  bool rejects_invalid = !parse_fingerprint_inputs(
    invalid_inputs,
    1,
    &invalid_fingerprints,
    &invalid_count
  );
  bool uuid_validation = valid_thread_uuid(uuid_text)
    && valid_thread_uuid("123E4567-E89B-12D3-A456-426614174000")
    && !valid_thread_uuid("123e4567-e89b-12d3-a456-42661417400z")
    && !valid_thread_uuid("123e4567e89b-12d3-a456-426614174000");
  CodexThreadTargetState strength_state = {
    .target_count = 3,
    .target_strengths = {
      CODEX_THREAD_MATCH_TITLE,
      CODEX_THREAD_MATCH_UUID,
      CODEX_THREAD_MATCH_TITLE
    }
  };
  unsigned best_strength = best_codex_thread_target_strength(&strength_state);
  bool uuid_target_preferred = best_strength == CODEX_THREAD_MATCH_UUID
    && count_codex_thread_targets_at_strength(&strength_state, best_strength, NULL) == 1;
  if (title_attributes != NULL) CFRelease(title_attributes);
  if (uuid_attributes != NULL) CFRelease(uuid_attributes);
  if (uuid != NULL) CFRelease(uuid);
  free(fingerprints);
  free(invalid_fingerprints);

  bool deduplicated = parsed && fingerprint_count == 2;
  printf(
    "multi_fingerprint_parse=%d duplicate_dedup=%d title_match=%d uuid_preferred=%d uuid_target_preferred=%d strict_uuid=%d strict_title_rejected=%d nonmatch_rejected=%d invalid_rejected=%d uuid_validation=%d\n",
    parsed ? 1 : 0,
    deduplicated ? 1 : 0,
    title_match ? 1 : 0,
    uuid_preferred ? 1 : 0,
    uuid_target_preferred ? 1 : 0,
    strict_uuid_match ? 1 : 0,
    strict_title_rejected ? 1 : 0,
    rejects_nonmatch ? 1 : 0,
    rejects_invalid ? 1 : 0,
    uuid_validation ? 1 : 0
  );
  return parsed && deduplicated && title_match && uuid_preferred && uuid_target_preferred
    && strict_uuid_match && strict_title_rejected && rejects_nonmatch
    && rejects_invalid && uuid_validation ? 0 : 1;
}

static AXUIElementRef copy_codex_thread_activation_target(AXUIElementRef element) {
  AXUIElementRef current = element != NULL ? (AXUIElementRef)CFRetain(element) : NULL;
  for (unsigned level = 0; current != NULL && level < 4; level += 1) {
    CFArrayRef actions = NULL;
    AXUIElementCopyActionNames(current, &actions);
    bool supports_press = actions != NULL
      && CFArrayContainsValue(
        actions,
        CFRangeMake(0, CFArrayGetCount(actions)),
        kAXPressAction
      );
    if (actions != NULL) CFRelease(actions);
    if (supports_press) return current;
    CFTypeRef parent_value = NULL;
    AXError parent_error = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &parent_value);
    CFRelease(current);
    current = parent_error == kAXErrorSuccess
      && parent_value != NULL
      && CFGetTypeID(parent_value) == AXUIElementGetTypeID()
      ? (AXUIElementRef)parent_value
      : NULL;
    if (current == NULL && parent_value != NULL) CFRelease(parent_value);
  }
  if (current != NULL) CFRelease(current);
  return NULL;
}

static int find_or_open_codex_thread_with_fingerprints(
  const char *uuid,
  const StringFingerprint *fingerprints,
  unsigned fingerprint_count,
  bool uuid_only,
  bool focused_window_only,
  bool press,
  bool emit_diagnostics
) {
  if (!valid_thread_uuid(uuid)
      || (!uuid_only && (fingerprints == NULL || fingerprint_count == 0))) return 64;
  // Return is delivered as a normal keyboard event after the exact AX control
  // is focused. Never risk delivering it to whichever other app is frontmost.
  if (press && !codex_is_frontmost()) return 1;
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, focused_window_only ? 0.35 : 0.8);

  const void *attribute_values[THREAD_ATTR_COUNT] = {
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    kAXURLAttribute,
    CFSTR("AXDOMIdentifier"),
    kAXHiddenAttribute,
    kAXChildrenAttribute
  };
  CFArrayRef attributes = CFArrayCreate(
    kCFAllocatorDefault,
    attribute_values,
    THREAD_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  if (attributes == NULL) {
    CFRelease(application);
    return 1;
  }
  CFStringRef uuid_string = CFStringCreateWithCString(
    kCFAllocatorDefault,
    uuid,
    kCFStringEncodingUTF8
  );
  if (uuid_string == NULL) {
    CFRelease(attributes);
    CFRelease(application);
    return 1;
  }

  CodexThreadTargetState state = {
    .fingerprints = fingerprints,
    .fingerprint_count = fingerprint_count,
    .uuid = uuid_string,
    .uuid_only = uuid_only,
    .attributes = attributes,
    .target_count = 0,
    .uuid_matched_elements = 0,
    .title_matched_elements = 0,
    .visited = 0,
    .visit_limit = focused_window_only ? 3500 : 8000
  };
  AXUIElementRef traversal_root = application;
  CFTypeRef focused_window_value = NULL;
  if (focused_window_only) {
    AXError focused_window_error = AXUIElementCopyAttributeValue(
      application,
      kAXFocusedWindowAttribute,
      &focused_window_value
    );
    if (focused_window_error != kAXErrorSuccess || focused_window_value == NULL
        || CFGetTypeID(focused_window_value) != AXUIElementGetTypeID()) {
      if (focused_window_value != NULL) CFRelease(focused_window_value);
      CFRelease(uuid_string);
      CFRelease(attributes);
      CFRelease(application);
      return 1;
    }
    traversal_root = (AXUIElementRef)focused_window_value;
  }
  collect_codex_thread_targets(traversal_root, 0, &state);

  unsigned best_strength = best_codex_thread_target_strength(&state);
  AXUIElementRef single_target = NULL;
  unsigned candidate_count = count_codex_thread_targets_at_strength(
    &state,
    best_strength,
    &single_target
  );

  if (emit_diagnostics) {
    printf(
      "strategy=%s fingerprints=%u uuid_matches=%u title_matches=%u targets=%u candidates=%u visited=%u\n",
      best_strength == CODEX_THREAD_MATCH_UUID ? "uuid"
        : best_strength == CODEX_THREAD_MATCH_TITLE ? "title"
          : "none",
      fingerprint_count,
      state.uuid_matched_elements,
      state.title_matched_elements,
      state.target_count,
      candidate_count,
      state.visited
    );
  }
  int result = 1;
  if (!press) {
    if (emit_diagnostics) {
      for (unsigned index = 0; index < state.target_count; index += 1) {
        if (state.target_strengths[index] != best_strength) continue;
        CGPoint position = CGPointZero;
        CGSize size = CGSizeZero;
        bool has_position = copy_element_position(state.targets[index], &position);
        bool has_size = copy_element_size(state.targets[index], &size);
        printf(
          "target=%u strength=%u x=%.0f y=%.0f width=%.0f height=%.0f\n",
          index,
          state.target_strengths[index],
          has_position ? position.x : -1,
          has_position ? position.y : -1,
          has_size ? size.width : -1,
          has_size ? size.height : -1
        );
      }
    }
    result = candidate_count == 1 ? 0 : candidate_count > 1 ? 3 : 1;
  } else if (candidate_count == 1 && single_target != NULL) {
    bool activated = codex_is_frontmost()
      && activate_accessibility_element_with_return(single_target);
    result = activated ? 0 : 1;
  } else if (candidate_count > 1) {
    result = 3;
  }

  release_codex_thread_targets(&state);
  if (focused_window_value != NULL) CFRelease(focused_window_value);
  CFRelease(uuid_string);
  CFRelease(attributes);
  CFRelease(application);
  return result;
}

static int find_or_open_codex_thread(
  const char *uuid,
  const char * const *fingerprint_inputs,
  unsigned fingerprint_input_count,
  bool uuid_only,
  bool press
) {
  StringFingerprint *fingerprints = NULL;
  unsigned fingerprint_count = 0;
  if (!valid_thread_uuid(uuid)) return 64;
  if (!uuid_only
      && !parse_fingerprint_inputs(
        fingerprint_inputs,
        fingerprint_input_count,
        &fingerprints,
        &fingerprint_count
      )) return 64;
  int result = find_or_open_codex_thread_with_fingerprints(
    uuid,
    fingerprints,
    fingerprint_count,
    uuid_only,
    false,
    press,
    true
  );
  free(fingerprints);
  return result;
}

typedef struct {
  CodexThreadTargetState matcher;
  CGPoint window_origin;
  CGSize window_size;
  bool uuid_matched;
  bool title_matched;
  unsigned visited;
} CodexFocusedThreadState;

static bool focused_thread_role_can_match(CFTypeRef role_value, bool value_settable) {
  // A command-palette query can equal the target task title while the current
  // conversation is still a different task. Never use editable AXValue text
  // (including ComboBox/TextField/TextArea roles) as focused-header identity.
  return !value_settable && !role_is_text_input(role_value);
}

static bool focused_thread_element_can_match(AXUIElementRef element) {
  if (element == NULL) return false;
  AXUIElementRef current = (AXUIElementRef)CFRetain(element);
  for (unsigned level = 0; current != NULL && level < 6; level += 1) {
    CFTypeRef role_value = NULL;
    AXUIElementCopyAttributeValue(current, kAXRoleAttribute, &role_value);
    Boolean value_settable = false;
    AXUIElementIsAttributeSettable(current, kAXValueAttribute, &value_settable);
    bool allowed = focused_thread_role_can_match(role_value, value_settable);
    if (role_value != NULL) CFRelease(role_value);
    if (!allowed) {
      CFRelease(current);
      return false;
    }

    CFTypeRef parent_value = NULL;
    AXError parent_error = AXUIElementCopyAttributeValue(
      current,
      kAXParentAttribute,
      &parent_value
    );
    CFRelease(current);
    current = parent_error == kAXErrorSuccess
      && parent_value != NULL
      && CFGetTypeID(parent_value) == AXUIElementGetTypeID()
      ? (AXUIElementRef)parent_value
      : NULL;
    if (current == NULL && parent_value != NULL) CFRelease(parent_value);
  }
  if (current != NULL) CFRelease(current);
  return true;
}

static bool codex_header_geometry_is_plausible(
  CGPoint position,
  CGSize size,
  CGPoint window_origin,
  CGSize window_size
) {
  if (size.width <= 1 || size.height <= 1 || window_size.width <= 0
      || window_size.height <= 0) return false;
  double header_bottom = window_origin.y + (window_size.height < 700 ? 96 : 112);
  double center_x = position.x + size.width / 2.0;
  double minimum_center_x = window_origin.x
    + (window_size.width < 720 ? window_size.width * 0.55 : 360);
  // A wide sidebar row can cross the content boundary even though all of its
  // text belongs to another task. Require either the element's own origin or
  // its center to live in the content header.
  bool content_aligned = position.x >= window_origin.x + 240
    || center_x >= minimum_center_x;
  return content_aligned
    && position.x < window_origin.x + window_size.width
    && position.y >= window_origin.y - 2
    && position.y <= header_bottom;
}

static bool element_is_in_codex_header(
  AXUIElementRef element,
  unsigned depth,
  const CodexFocusedThreadState *state
) {
  if (depth == 0) return true;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(element, &position)
      || !copy_element_size(element, &size)
      || !codex_header_geometry_is_plausible(
        position,
        size,
        state->window_origin,
        state->window_size
      )) return false;
  return position.x + size.width >= state->window_origin.x
    && !element_is_hidden(element);
}

static int focused_thread_geometry_selftest(void) {
  CGPoint origin = CGPointMake(100, 80);
  CGSize window = CGSizeMake(1200, 800);
  bool content_title = codex_header_geometry_is_plausible(
    CGPointMake(400, 105),
    CGSizeMake(480, 40),
    origin,
    window
  );
  bool full_header_container = codex_header_geometry_is_plausible(
    CGPointMake(100, 80),
    CGSizeMake(1200, 90),
    origin,
    window
  );
  bool rejects_wide_sidebar = !codex_header_geometry_is_plausible(
    CGPointMake(110, 105),
    CGSizeMake(310, 40),
    origin,
    window
  );
  bool rejects_content_body = !codex_header_geometry_is_plausible(
    CGPointMake(400, 360),
    CGSizeMake(480, 40),
    origin,
    window
  );
  bool rejects_combo_box = !focused_thread_role_can_match(kAXComboBoxRole, false);
  bool rejects_text_field = !focused_thread_role_can_match(kAXTextFieldRole, false);
  bool rejects_text_area = !focused_thread_role_can_match(kAXTextAreaRole, false);
  bool rejects_editable_value = !focused_thread_role_can_match(kAXStaticTextRole, true);
  bool accepts_static_title = focused_thread_role_can_match(kAXStaticTextRole, false);
  printf(
    "content_title=%d header_container=%d wide_sidebar_rejected=%d body_rejected=%d combo_rejected=%d text_field_rejected=%d text_area_rejected=%d editable_value_rejected=%d static_title_accepted=%d\n",
    content_title ? 1 : 0,
    full_header_container ? 1 : 0,
    rejects_wide_sidebar ? 1 : 0,
    rejects_content_body ? 1 : 0,
    rejects_combo_box ? 1 : 0,
    rejects_text_field ? 1 : 0,
    rejects_text_area ? 1 : 0,
    rejects_editable_value ? 1 : 0,
    accepts_static_title ? 1 : 0
  );
  return content_title && full_header_container && rejects_wide_sidebar
    && rejects_content_body && rejects_combo_box && rejects_text_field
    && rejects_text_area && rejects_editable_value && accepts_static_title ? 0 : 1;
}

static void collect_focused_codex_thread_header(
  AXUIElementRef element,
  unsigned depth,
  CodexFocusedThreadState *state
) {
  if (element == NULL || state == NULL || state->uuid_matched
      || depth > 20 || state->visited >= 1400) return;
  state->visited += 1;

  CFArrayRef values = NULL;
  AXError values_error = AXUIElementCopyMultipleAttributeValues(
    element,
    state->matcher.attributes,
    0,
    &values
  );
  if (values_error != kAXErrorSuccess || values == NULL
      || CFArrayGetCount(values) < THREAD_ATTR_COUNT) {
    if (values != NULL) CFRelease(values);
    return;
  }

  if (element_is_in_codex_header(element, depth, state)) {
    unsigned match = batched_element_thread_match(values, &state->matcher);
    if (match != CODEX_THREAD_MATCH_NONE && focused_thread_element_can_match(element)) {
      if (match == CODEX_THREAD_MATCH_UUID) state->uuid_matched = true;
      else if (match == CODEX_THREAD_MATCH_TITLE) state->title_matched = true;
    }
  }

  CFTypeRef children_value = CFArrayGetValueAtIndex(values, THREAD_ATTR_CHILDREN);
  if (!state->uuid_matched && children_value != NULL
      && CFGetTypeID(children_value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)children_value;
    for (CFIndex index = 0; index < CFArrayGetCount(children); index += 1) {
      CFTypeRef child = CFArrayGetValueAtIndex(children, index);
      if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
        collect_focused_codex_thread_header((AXUIElementRef)child, depth + 1, state);
      }
      if (state->uuid_matched) break;
    }
  }
  CFRelease(values);
}

// Verify only Codex's internally active window header. Safety-critical callers
// can additionally require Codex to be the frontmost macOS app; the passive
// Current Task observer deliberately does not. Unlike `codex-queue-state`,
// this does not scan every window or emit hashes for unrelated controls.
// Output contains only the match class and visit count.
static int verify_focused_codex_thread(
  const char *uuid_text,
  const char * const *fingerprint_inputs,
  unsigned fingerprint_input_count,
  bool uuid_only,
  bool require_frontmost
) {
  if (!valid_thread_uuid(uuid_text)) return 64;
  StringFingerprint *fingerprints = NULL;
  unsigned fingerprint_count = 0;
  if (!uuid_only
      && !parse_fingerprint_inputs(
        fingerprint_inputs,
        fingerprint_input_count,
        &fingerprints,
        &fingerprint_count
      )) return 64;
  if (require_frontmost && !codex_is_frontmost()) {
    free(fingerprints);
    return 1;
  }

  AXUIElementRef application = copy_codex_application();
  if (application == NULL) {
    free(fingerprints);
    return 1;
  }
  AXUIElementSetMessagingTimeout(application, 0.45);
  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window_value)
        != kAXErrorSuccess
      || window_value == NULL || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(application);
    free(fingerprints);
    return 1;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(window, &origin) || !copy_element_size(window, &size)) {
    CFRelease(window_value);
    CFRelease(application);
    free(fingerprints);
    return 1;
  }

  const void *attribute_values[THREAD_ATTR_COUNT] = {
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    kAXURLAttribute,
    CFSTR("AXDOMIdentifier"),
    kAXHiddenAttribute,
    kAXChildrenAttribute
  };
  CFArrayRef attributes = CFArrayCreate(
    kCFAllocatorDefault,
    attribute_values,
    THREAD_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  CFStringRef uuid = CFStringCreateWithCString(
    kCFAllocatorDefault,
    uuid_text,
    kCFStringEncodingUTF8
  );
  if (attributes == NULL || uuid == NULL) {
    if (attributes != NULL) CFRelease(attributes);
    if (uuid != NULL) CFRelease(uuid);
    CFRelease(window_value);
    CFRelease(application);
    free(fingerprints);
    return 1;
  }

  CodexFocusedThreadState state = {
    .matcher = {
      .fingerprints = fingerprints,
      .fingerprint_count = fingerprint_count,
      .uuid = uuid,
      .uuid_only = uuid_only,
      .attributes = attributes
    },
    .window_origin = origin,
    .window_size = size,
    .uuid_matched = false,
    .title_matched = false,
    .visited = 0
  };
  collect_focused_codex_thread_header(window, 0, &state);
  const char *match = state.uuid_matched ? "uuid"
    : state.title_matched && !uuid_only ? "title"
      : "none";
  printf("match=%s visited=%u\n", match, state.visited);
  int result = state.uuid_matched || (state.title_matched && !uuid_only) ? 0 : 1;

  CFRelease(uuid);
  CFRelease(attributes);
  CFRelease(window_value);
  CFRelease(application);
  free(fingerprints);
  return result;
}

static char *read_stdin_utf8(size_t *length_out) {
  size_t capacity = 4096;
  size_t length = 0;
  char *buffer = calloc(capacity, sizeof(char));
  if (buffer == NULL) return NULL;
  for (;;) {
    if (length == capacity - 1) {
      if (capacity >= 64 * 1024) {
        free(buffer);
        return NULL;
      }
      size_t next_capacity = capacity * 2;
      char *next = realloc(buffer, next_capacity);
      if (next == NULL) {
        free(buffer);
        return NULL;
      }
      memset(next + capacity, 0, next_capacity - capacity);
      buffer = next;
      capacity = next_capacity;
    }
    size_t count = fread(buffer + length, 1, capacity - length - 1, stdin);
    length += count;
    if (count == 0) break;
  }
  if (ferror(stdin) || length == 0) {
    free(buffer);
    return NULL;
  }
  buffer[length] = '\0';
  *length_out = length;
  return buffer;
}

static bool post_unicode_text(const char *utf8, size_t length) {
  CFStringRef string = CFStringCreateWithBytes(
    kCFAllocatorDefault,
    (const UInt8 *)utf8,
    (CFIndex)length,
    kCFStringEncodingUTF8,
    false
  );
  if (string == NULL) return false;
  CFIndex character_count = CFStringGetLength(string);
  UniChar *characters = calloc((size_t)character_count, sizeof(UniChar));
  if (characters == NULL) {
    CFRelease(string);
    return false;
  }
  CFStringGetCharacters(string, CFRangeMake(0, character_count), characters);
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  if (down == NULL || up == NULL) {
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    free(characters);
    CFRelease(string);
    return false;
  }
  CGEventKeyboardSetUnicodeString(down, character_count, characters);
  CGEventKeyboardSetUnicodeString(up, character_count, characters);
  CGEventPost(kCGHIDEventTap, down);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  free(characters);
  CFRelease(string);
  return true;
}

static bool element_descends_from(
  AXUIElementRef element,
  AXUIElementRef ancestor
) {
  if (element == NULL || ancestor == NULL) return false;
  AXUIElementRef current = (AXUIElementRef)CFRetain(element);
  for (unsigned depth = 0; current != NULL && depth < 32; depth += 1) {
    if (CFEqual(current, ancestor)) {
      CFRelease(current);
      return true;
    }
    CFTypeRef parent_value = NULL;
    AXError parent_error = AXUIElementCopyAttributeValue(
      current,
      kAXParentAttribute,
      &parent_value
    );
    CFRelease(current);
    current = parent_error == kAXErrorSuccess
      && parent_value != NULL
      && CFGetTypeID(parent_value) == AXUIElementGetTypeID()
      ? (AXUIElementRef)parent_value
      : NULL;
    if (current == NULL && parent_value != NULL) CFRelease(parent_value);
  }
  if (current != NULL) CFRelease(current);
  return false;
}

static bool accessibility_value_has_palette_hint(CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  @autoreleasepool {
    NSString *text = [(__bridge NSString *)value lowercaseString];
    if (text.length == 0) return false;
    return [text containsString:@"command"]
      || [text containsString:@"palette"]
      || [text containsString:@"search"]
      || [text containsString:@"find"]
      || [text containsString:@"task"]
      || [text containsString:@"thread"]
      || [text containsString:@"명령"]
      || [text containsString:@"검색"]
      || [text containsString:@"작업"];
  }
}

static bool element_has_command_palette_identity(AXUIElementRef element) {
  const CFStringRef attributes[] = {
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute,
    kAXRoleDescriptionAttribute,
    CFSTR("AXDOMIdentifier"),
    CFSTR("AXPlaceholderValue")
  };
  for (size_t index = 0; index < sizeof(attributes) / sizeof(attributes[0]); index += 1) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attributes[index], &value) != kAXErrorSuccess
        || value == NULL) {
      if (value != NULL) CFRelease(value);
      continue;
    }
    bool matched = accessibility_value_has_palette_hint(value);
    CFRelease(value);
    if (matched) return true;
  }
  return false;
}

static bool command_palette_geometry_is_plausible(
  CGPoint field_position,
  CGSize field_size,
  CGPoint window_origin,
  CGSize window_size,
  bool has_identity
) {
  if (window_size.width < 420 || window_size.height < 280
      || field_size.height < 24 || field_size.height > 72) return false;
  double minimum_width = window_size.width * 0.28;
  if (minimum_width < 240) minimum_width = 240;
  double relative_y = field_position.y - window_origin.y;
  double field_center = field_position.x + field_size.width / 2.0;
  double window_center = window_origin.x + window_size.width / 2.0;
  double center_delta = field_center - window_center;
  if (center_delta < 0) center_delta = -center_delta;
  bool palette_region = field_size.width >= minimum_width
    && field_size.width <= window_size.width * 0.94
    && relative_y >= -2
    && relative_y <= window_size.height * 0.42
    && center_delta <= window_size.width * 0.15 + 18;
  // Identity is preferred. Chromium versions that omit a useful placeholder
  // may still be reused only when the field has the unmistakable wide,
  // centered, upper-window command-palette shape.
  bool strong_geometry = field_size.width >= window_size.width * 0.42
    && relative_y <= window_size.height * 0.30;
  return palette_region && (has_identity || strong_geometry);
}

static int command_palette_selftest(void) {
  CGPoint window_origin = CGPointMake(100, 80);
  CGSize window_size = CGSizeMake(1200, 800);
  bool strong = command_palette_geometry_is_plausible(
    CGPointMake(390, 150),
    CGSizeMake(620, 42),
    window_origin,
    window_size,
    false
  );
  bool identified = command_palette_geometry_is_plausible(
    CGPointMake(500, 170),
    CGSizeMake(400, 36),
    window_origin,
    window_size,
    true
  );
  bool rejects_composer = !command_palette_geometry_is_plausible(
    CGPointMake(390, 760),
    CGSizeMake(620, 42),
    window_origin,
    window_size,
    true
  );
  bool rejects_small_combo = !command_palette_geometry_is_plausible(
    CGPointMake(610, 150),
    CGSizeMake(180, 32),
    window_origin,
    window_size,
    false
  );
  printf(
    "strong_geometry=%d identified_geometry=%d composer_rejected=%d small_combo_rejected=%d\n",
    strong ? 1 : 0,
    identified ? 1 : 0,
    rejects_composer ? 1 : 0,
    rejects_small_combo ? 1 : 0
  );
  return strong && identified && rejects_composer && rejects_small_combo ? 0 : 1;
}

static AXUIElementRef copy_codex_focused_search_field(void) {
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return NULL;
  AXUIElementSetMessagingTimeout(application, 0.8);
  CFTypeRef window_value = NULL;
  AXError window_error = AXUIElementCopyAttributeValue(
    application,
    kAXFocusedWindowAttribute,
    &window_value
  );
  CFTypeRef focused_value = NULL;
  AXError focused_error = AXUIElementCopyAttributeValue(
    application,
    kAXFocusedUIElementAttribute,
    &focused_value
  );
  CFRelease(application);
  if (window_error != kAXErrorSuccess || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()
      || focused_error != kAXErrorSuccess || focused_value == NULL
      || CFGetTypeID(focused_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    if (focused_value != NULL) CFRelease(focused_value);
    return NULL;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  AXUIElementRef focused = (AXUIElementRef)focused_value;
  CFTypeRef role_value = NULL;
  AXError role_error = AXUIElementCopyAttributeValue(
    focused,
    kAXRoleAttribute,
    &role_value
  );
  bool is_combo_box = role_error == kAXErrorSuccess && role_value != NULL
    && CFGetTypeID(role_value) == CFStringGetTypeID()
    && CFEqual(role_value, kAXComboBoxRole);
  if (role_value != NULL) CFRelease(role_value);
  if (!is_combo_box) {
    CFRelease(window_value);
    CFRelease(focused_value);
    return NULL;
  }
  Boolean value_settable = false;
  AXError settable_error = AXUIElementIsAttributeSettable(
    focused,
    kAXValueAttribute,
    &value_settable
  );
  CFTypeRef focused_attribute = NULL;
  AXError focused_attribute_error = AXUIElementCopyAttributeValue(
    focused,
    kAXFocusedAttribute,
    &focused_attribute
  );
  bool explicitly_not_focused = focused_attribute_error == kAXErrorSuccess
    && focused_attribute != NULL
    && CFGetTypeID(focused_attribute) == CFBooleanGetTypeID()
    && !CFBooleanGetValue((CFBooleanRef)focused_attribute);
  if (focused_attribute != NULL) CFRelease(focused_attribute);
  CGPoint field_position = CGPointZero;
  CGSize field_size = CGSizeZero;
  CGPoint window_origin = CGPointZero;
  CGSize window_size = CGSizeZero;
  bool has_geometry = copy_element_position(focused, &field_position)
    && copy_element_size(focused, &field_size)
    && copy_element_position(window, &window_origin)
    && copy_element_size(window, &window_size);
  bool unmistakable_geometry = has_geometry
    && command_palette_geometry_is_plausible(
      field_position,
      field_size,
      window_origin,
      window_size,
      false
    );
  bool has_identity = !unmistakable_geometry
    && element_has_command_palette_identity(focused);
  bool is_search_field = settable_error == kAXErrorSuccess
    && value_settable
    // kAXFocusedUIElement already identifies this exact node. Treat an
    // explicit false as a race, but do not reject Chromium builds that omit
    // the redundant AXFocused attribute.
    && !explicitly_not_focused
    && !element_is_hidden(focused)
    && element_descends_from(focused, window)
    && has_geometry
    && (unmistakable_geometry || command_palette_geometry_is_plausible(
      field_position,
      field_size,
      window_origin,
      window_size,
      has_identity
    ));
  CFRelease(window_value);
  if (!is_search_field) {
    CFRelease(focused_value);
    return NULL;
  }
  return (AXUIElementRef)focused_value;
}

static bool set_codex_search_text(
  AXUIElementRef search_field,
  const char *utf8,
  size_t length
) {
  CFStringRef string = CFStringCreateWithBytes(
    kCFAllocatorDefault,
    (const UInt8 *)utf8,
    (CFIndex)length,
    kCFStringEncodingUTF8,
    false
  );
  if (string == NULL) return false;
  bool set = AXUIElementSetAttributeValue(
    search_field,
    kAXValueAttribute,
    string
  ) == kAXErrorSuccess;
  CFRelease(string);
  return set;
}

static AXUIElementRef wait_for_codex_search_field(CFTimeInterval timeout_seconds) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  do {
    if (!codex_is_frontmost()) return NULL;
    AXUIElementRef search_field = copy_codex_focused_search_field();
    if (search_field != NULL) return search_field;
    usleep(25000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return NULL;
}

static bool codex_search_field_is_current(AXUIElementRef search_field) {
  if (search_field == NULL) return false;
  AXUIElementRef current = copy_codex_focused_search_field();
  bool matches = current != NULL && CFEqual(current, search_field);
  if (current != NULL) CFRelease(current);
  return matches;
}

static bool wait_for_codex_search_dismissal(
  AXUIElementRef search_field,
  CFTimeInterval timeout_seconds
) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  CFAbsoluteTime absent_since = 0;
  do {
    if (!codex_is_frontmost()) return false;
    // A detached Chromium AX node can retain its role and report AXHidden as
    // unsupported. Requery the app's current focused field instead of trusting
    // the retained object after navigation.
    if (!codex_search_field_is_current(search_field)) {
      if (absent_since == 0) absent_since = CFAbsoluteTimeGetCurrent();
      if (CFAbsoluteTimeGetCurrent() - absent_since >= 0.08) return true;
    } else {
      absent_since = 0;
    }
    usleep(40000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return false;
}

static int fill_codex_search_from_stdin(AXUIElementRef *search_field_out) {
  if (search_field_out == NULL) return 64;
  *search_field_out = NULL;
  size_t title_length = 0;
  char *title = read_stdin_utf8(&title_length);
  if (title == NULL) return 64;

  if (!codex_is_frontmost()) {
    free(title);
    return 1;
  }
  // Reuse an already-open palette left by an interrupted prior activation.
  // Otherwise issue Command+K exactly once and poll until Chromium publishes
  // the focused combo box instead of guessing with a fixed sleep.
  AXUIElementRef search_field = copy_codex_focused_search_field();
  if (search_field == NULL) {
    tap_key(KEY_K, kCGEventFlagMaskCommand);
    search_field = wait_for_codex_search_field(1.0);
  }
  bool typed = false;
  if (search_field != NULL && codex_is_frontmost()) {
    typed = set_codex_search_text(search_field, title, title_length);
    if (!typed && codex_is_frontmost()) {
      AXUIElementRef current = copy_codex_focused_search_field();
      bool still_focused = current != NULL && CFEqual(current, search_field);
      if (current != NULL) CFRelease(current);
      if (still_focused && codex_is_frontmost()) {
        tap_key(KEY_A, kCGEventFlagMaskCommand);
        typed = post_unicode_text(title, title_length);
      }
    }
  }
  free(title);
  if (!typed) {
    if (search_field != NULL) CFRelease(search_field);
    if (codex_is_frontmost()) tap_key(KEY_ESCAPE, 0);
    return 1;
  }
  *search_field_out = search_field;
  return 0;
}

static int wait_for_codex_thread_search_result(
  const char *uuid,
  const StringFingerprint *fingerprints,
  unsigned fingerprint_count,
  bool uuid_only,
  CFTimeInterval timeout_seconds
) {
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_seconds;
  CFAbsoluteTime candidate_since = 0;
  int candidate_result = 1;
  do {
    if (!codex_is_frontmost()) return 1;
    int result = find_or_open_codex_thread_with_fingerprints(
      uuid,
      fingerprints,
      fingerprint_count,
      uuid_only,
      true,
      false,
      false
    );
    if (result == 0 || result == 3) {
      if (result != candidate_result) {
        candidate_result = result;
        candidate_since = CFAbsoluteTimeGetCurrent();
      } else if (CFAbsoluteTimeGetCurrent() - candidate_since >= 0.12) {
        if (result == 3) return 3;
        // Re-scan once while activating so a stale result cannot be used after
        // the palette changed between the readiness check and key delivery.
        return find_or_open_codex_thread_with_fingerprints(
          uuid,
          fingerprints,
          fingerprint_count,
          uuid_only,
          true,
          true,
          false
        );
      }
    } else {
      candidate_result = 1;
      candidate_since = 0;
    }
    usleep(75000);
  } while (CFAbsoluteTimeGetCurrent() < deadline);
  return 1;
}

static int search_and_open_codex_thread(
  const char *uuid,
  const char * const *fingerprint_inputs,
  unsigned fingerprint_input_count,
  bool uuid_only
) {
  StringFingerprint *fingerprints = NULL;
  unsigned fingerprint_count = 0;
  if (!valid_thread_uuid(uuid)
      || (!uuid_only && !parse_fingerprint_inputs(
        fingerprint_inputs,
        fingerprint_input_count,
        &fingerprints,
        &fingerprint_count
      ))) return 64;
  AXUIElementRef search_field = NULL;
  int fill_result = fill_codex_search_from_stdin(&search_field);
  if (fill_result != 0) {
    free(fingerprints);
    return fill_result;
  }
  // Remote search fans out to every connected host and can take well over a
  // second. Poll the exact actionable result for up to 2.5 seconds, then focus
  // and keyboard-activate that verified row so Codex runs its host-selection
  // hook without mouse coordinates.
  int result = wait_for_codex_thread_search_result(
    uuid,
    fingerprints,
    fingerprint_count,
    uuid_only,
    2.5
  );
  if (result == 0) {
    result = wait_for_codex_search_dismissal(search_field, 2.5) ? 0 : 1;
  }
  if (result != 0 && codex_is_frontmost()) tap_key(KEY_ESCAPE, 0);
  printf("strategy=search fingerprints=%u result=%d\n", fingerprint_count, result);
  if (search_field != NULL) CFRelease(search_field);
  free(fingerprints);
  return result;
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (strcmp(argv[1], "fast-mode-set") == 0) {
    if (argc != 3) return 64;
    if (strcmp(argv[2], "on") == 0) {
      return set_codex_fast_mode(CODEX_FAST_MODE_ON);
    }
    if (strcmp(argv[2], "off") == 0) {
      return set_codex_fast_mode(CODEX_FAST_MODE_OFF);
    }
    return 64;
  }
  if (strcmp(argv[1], "codex-find-thread") == 0) {
    if (argc < 4) return 64;
    return find_or_open_codex_thread(
      argv[2],
      (const char * const *)&argv[3],
      (unsigned)(argc - 3),
      false,
      false
    );
  }
  if (strcmp(argv[1], "codex-find-thread-strict") == 0) {
    if (argc != 3) return 64;
    return find_or_open_codex_thread(argv[2], NULL, 0, true, false);
  }
  if (strcmp(argv[1], "codex-open-thread") == 0) {
    if (argc < 4) return 64;
    return find_or_open_codex_thread(
      argv[2],
      (const char * const *)&argv[3],
      (unsigned)(argc - 3),
      false,
      true
    );
  }
  if (strcmp(argv[1], "codex-open-thread-strict") == 0) {
    if (argc != 3) return 64;
    return find_or_open_codex_thread(argv[2], NULL, 0, true, true);
  }
  if (strcmp(argv[1], "codex-search-thread") == 0) {
    if (argc < 4) return 64;
    return search_and_open_codex_thread(
      argv[2],
      (const char * const *)&argv[3],
      (unsigned)(argc - 3),
      false
    );
  }
  if (strcmp(argv[1], "codex-search-thread-strict") == 0) {
    if (argc != 3) return 64;
    return search_and_open_codex_thread(argv[2], NULL, 0, true);
  }
  if (strcmp(argv[1], "codex-focused-thread") == 0) {
    if (argc < 4) return 64;
    return verify_focused_codex_thread(
      argv[2],
      (const char * const *)&argv[3],
      (unsigned)(argc - 3),
      false,
      true
    );
  }
  if (strcmp(argv[1], "codex-focused-thread-strict") == 0) {
    if (argc != 3) return 64;
    return verify_focused_codex_thread(argv[2], NULL, 0, true, true);
  }
  if (strcmp(argv[1], "codex-current-thread") == 0) {
    if (argc < 4) return 64;
    return verify_focused_codex_thread(
      argv[2],
      (const char * const *)&argv[3],
      (unsigned)(argc - 3),
      false,
      false
    );
  }
  if (strcmp(argv[1], "codex-current-thread-strict") == 0) {
    if (argc != 3) return 64;
    return verify_focused_codex_thread(argv[2], NULL, 0, true, false);
  }
  if (argc != 2) return 64;
  if (strcmp(argv[1], "codex-wait-frontmost") == 0) {
    return wait_for_codex_frontmost(2.5);
  }
  if (strcmp(argv[1], "thread-fingerprint-selftest") == 0) {
    return codex_thread_fingerprint_selftest();
  }
  if (strcmp(argv[1], "command-palette-selftest") == 0) {
    return command_palette_selftest();
  }
  if (strcmp(argv[1], "focused-thread-geometry-selftest") == 0) {
    return focused_thread_geometry_selftest();
  }
  if (strcmp(argv[1], "media-bundle-selftest") == 0) return media_bundle_selftest();
  if (strcmp(argv[1], "preflight") == 0) {
    bool trusted = CGPreflightPostEventAccess();
    printf("%d\n", trusted ? 1 : 0);
    return trusted ? 0 : 77;
  }
  if (strcmp(argv[1], "accessibility-preflight") == 0) {
    bool trusted = AXIsProcessTrusted();
    printf("%d\n", trusted ? 1 : 0);
    return trusted ? 0 : 77;
  }
  if (strcmp(argv[1], "selftest") == 0) {
    voice_down();
    usleep(30000);
    bool held = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_CONTROL)
      && CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_SHIFT)
      && CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_D);
    release_voice_keys();
    usleep(30000);
    bool released = !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_CONTROL)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_SHIFT)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_D);
    printf("held=%d released=%d\n", held ? 1 : 0, released ? 1 : 0);
    return held && released ? 0 : 1;
  }
  if (strcmp(argv[1], "voice-event-selftest") == 0) {
    bool down = voice_down_event_is_layout_independent();
    bool up = voice_up_event_is_physical_release();
    printf("layout_independent_down=%d physical_release_up=%d\n", down ? 1 : 0, up ? 1 : 0);
    return down && up ? 0 : 1;
  }
  if (strcmp(argv[1], "voice-release-selftest") == 0) {
    return voice_release_retry_selftest();
  }
  if (strcmp(argv[1], "reasoning-state-selftest") == 0) return reasoning_state_selftest();
  if (strcmp(argv[1], "goal-state-selftest") == 0) return goal_state_selftest();
  if (strcmp(argv[1], "fast-mode-selftest") == 0) return codex_fast_mode_selftest();
  if (strcmp(argv[1], "fast-mode-toggle") == 0) return toggle_codex_fast_mode();
  if (strcmp(argv[1], "fast-mode-state") == 0) return print_codex_fast_mode_state();
  if (strcmp(argv[1], "codex-composer-state") == 0) return print_codex_composer_state();
  if (strcmp(argv[1], "codex-restore-composer") == 0) {
    return restore_codex_composer_after_fast_mode() ? 0 : 1;
  }
  if (strcmp(argv[1], "media-playback-state") == 0) return print_system_media_playback_state();
  if (strcmp(argv[1], "voice-down") == 0) voice_down();
  else if (strcmp(argv[1], "voice-up") == 0) return voice_up() ? 0 : 1;
  else if (strcmp(argv[1], "send") == 0) tap_key(KEY_RETURN, 0);
  else if (strcmp(argv[1], "send-command") == 0) command_return();
  else if (strcmp(argv[1], "app-switch") == 0) app_switch();
  else if (strcmp(argv[1], "new-thread") == 0) new_thread();
  else if (strcmp(argv[1], "side-chat") == 0) side_chat();
  else if (strcmp(argv[1], "media-previous") == 0) tap_media_key(MEDIA_PREVIOUS);
  else if (strcmp(argv[1], "media-rewind") == 0) tap_media_key(MEDIA_REWIND);
  else if (strcmp(argv[1], "media-pause-if-playing") == 0) return pause_media_if_playing();
  else if (strcmp(argv[1], "media-play-pause") == 0) tap_media_key(MEDIA_PLAY_PAUSE);
  else if (strcmp(argv[1], "media-forward") == 0) tap_media_key(MEDIA_FAST_FORWARD);
  else if (strcmp(argv[1], "media-mute") == 0) tap_media_key(MEDIA_MUTE);
  else if (strcmp(argv[1], "media-volume-down") == 0) tap_media_key(MEDIA_SOUND_DOWN);
  else if (strcmp(argv[1], "media-volume-up") == 0) tap_media_key(MEDIA_SOUND_UP);
  else if (strcmp(argv[1], "media-next") == 0) tap_media_key(MEDIA_NEXT);
  else if (strcmp(argv[1], "audio-processes") == 0) {
    print_running_audio_processes(kAudioProcessPropertyIsRunningOutput);
  }
  else if (strcmp(argv[1], "audio-input-processes") == 0) {
    print_running_audio_processes(kAudioProcessPropertyIsRunningInput);
  }
  else if (strcmp(argv[1], "audio-input-state") == 0) {
    VoiceAudioState state = codex_audio_input_state();
    const char *name = state == VOICE_AUDIO_ACTIVE ? "active"
      : state == VOICE_AUDIO_INACTIVE ? "inactive"
        : "unknown";
    printf("%s\n", name);
    return state == VOICE_AUDIO_INACTIVE ? 0
      : state == VOICE_AUDIO_ACTIVE ? 1
        : 2;
  }
  else if (strcmp(argv[1], "focused-text-state") == 0) return print_focused_text_state();
  else if (strcmp(argv[1], "editable-text-state") == 0) return print_editable_text_state();
  else if (strcmp(argv[1], "focused-element-info") == 0) return print_focused_element_info();
  else if (strcmp(argv[1], "editable-element-info") == 0) return print_editable_element_info();
  else if (strcmp(argv[1], "selected-element-info") == 0) return print_selected_element_info();
  else if (strcmp(argv[1], "codex-reasoning-state") == 0) return print_codex_reasoning_state();
  else if (strcmp(argv[1], "codex-goal-state") == 0) return print_codex_goal_state();
  else if (strcmp(argv[1], "codex-queue-state") == 0) return print_codex_queue_state();
  else if (strcmp(argv[1], "codex-stop-dictation") == 0) {
    return stop_codex_composer_dictation_if_visible() ? 0 : 1;
  }
  else if (strcmp(argv[1], "codex-focus-composer") == 0) {
    return focus_codex_composer_if_visible() ? 0 : 1;
  }
  else if (strcmp(argv[1], "codex-submit-composer") == 0) {
    return submit_codex_composer_if_visible() ? 0 : 1;
  }
  else if (strcmp(argv[1], "release") == 0) release_voice_keys();
  else return 64;
  return 0;
}
