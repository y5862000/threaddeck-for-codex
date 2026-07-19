#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <CoreAudio/CoreAudio.h>
#include <IOKit/hidsystem/IOLLEvent.h>
#include <IOKit/hidsystem/ev_keymap.h>
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

static int pause_media_if_playing(void) {
  if (!supported_media_output_is_running()) return 2;
  // Use the normal system media command instead of freezing a process with
  // SIGSTOP. Players can drain their audio buffer cleanly, avoiding a click,
  // and the matching resume command remains independent of screen layout.
  tap_media_key(MEDIA_PLAY_PAUSE);
  return 0;
}

static int media_bundle_selftest(void) {
  bool direct = pausable_media_bundle(CFSTR("com.apple.Music"));
  bool helper = pausable_media_bundle(CFSTR("com.google.Chrome.helper"));
  bool rejects_codex = !pausable_media_bundle(CFSTR("com.openai.codex"));
  bool rejects_unknown = !pausable_media_bundle(CFSTR("example.unrelated.audio"));
  printf(
    "direct=%d helper=%d codex_rejected=%d unknown_rejected=%d\n",
    direct ? 1 : 0,
    helper ? 1 : 0,
    rejects_codex ? 1 : 0,
    rejects_unknown ? 1 : 0
  );
  return direct && helper && rejects_codex && rejects_unknown ? 0 : 1;
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
  printf("localized_effort_mapping=%d\n", passed ? 1 : 0);
  return passed ? 0 : 1;
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

  CFTypeRef windows_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows_value) != kAXErrorSuccess
      || windows_value == NULL || CFGetTypeID(windows_value) != CFArrayGetTypeID()) {
    if (windows_value != NULL) CFRelease(windows_value);
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
    bool focused = false;
    if (AXUIElementCopyAttributeValue(window, kAXFocusedAttribute, &focused_value) == kAXErrorSuccess
        && focused_value != NULL && CFGetTypeID(focused_value) == CFBooleanGetTypeID()) {
      focused = CFBooleanGetValue((CFBooleanRef)focused_value);
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

// Verify only the focused Codex window's compact header. Unlike
// `codex-queue-state`, this command does not scan every window or emit hashes
// for unrelated controls. Output contains only the match class and visit count.
static int verify_focused_codex_thread(
  const char *uuid_text,
  const char * const *fingerprint_inputs,
  unsigned fingerprint_input_count,
  bool uuid_only
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
  if (!codex_is_frontmost()) {
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
      false
    );
  }
  if (strcmp(argv[1], "codex-focused-thread-strict") == 0) {
    if (argc != 3) return 64;
    return verify_focused_codex_thread(argv[2], NULL, 0, true);
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
