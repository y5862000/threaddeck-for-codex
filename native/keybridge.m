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

static bool stop_codex_composer_dictation_if_visible(void);
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

static void voice_up(void) {
  release_voice_keys();
  // Current Codex builds expose Control+Shift+D as the app-scoped "Start
  // dictation" command. Its key-up is intentionally ignored, so a Stream Deck
  // hold would otherwise keep recording forever. Activate the visible stop
  // control on release; older builds with a true global hold shortcut have
  // already stopped after the physical key-up, making this a safe no-op.
  // Give a true global hold shortcut a moment to stop on its own. The helper
  // below additionally requires an active Codex input stream, so an idle
  // composer microphone can never be mistaken for the stop control.
  usleep(50000);
  stop_codex_composer_dictation_if_visible();
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

static bool codex_audio_input_is_running(void) {
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
    address.mSelector = kAudioProcessPropertyIsRunningInput;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &is_running) != noErr
        || !is_running) continue;

    CFStringRef bundle_id = NULL;
    value_size = sizeof(bundle_id);
    address.mSelector = kAudioProcessPropertyBundleID;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &bundle_id) == noErr
        && bundle_id != NULL) {
      active = CFStringHasPrefix(bundle_id, CFSTR("com.openai.codex"));
      CFRelease(bundle_id);
    }
  }
  free(processes);
  return active;
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
    printf("window\t%ld\n", (long)window_index);
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
  StringFingerprint fingerprint;
  CFArrayRef attributes;
  AXUIElementRef targets[CODEX_THREAD_TARGET_MAX];
  unsigned target_count;
  unsigned matched_elements;
  unsigned visited;
} CodexThreadTargetState;

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

static bool click_element_center(AXUIElementRef element) {
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (!copy_element_position(element, &position)
      || !copy_element_size(element, &size)
      || size.width < 2
      || size.height < 2) return false;

  CGPoint click_position = {
    .x = position.x + size.width / 2,
    .y = position.y + size.height / 2
  };
  CGEventRef current = CGEventCreate(NULL);
  CGPoint original_position = current != NULL
    ? CGEventGetLocation(current)
    : click_position;
  if (current != NULL) CFRelease(current);

  CGEventRef down = CGEventCreateMouseEvent(
    NULL,
    kCGEventLeftMouseDown,
    click_position,
    kCGMouseButtonLeft
  );
  CGEventRef up = CGEventCreateMouseEvent(
    NULL,
    kCGEventLeftMouseUp,
    click_position,
    kCGMouseButtonLeft
  );
  if (down == NULL || up == NULL) {
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    return false;
  }
  CGEventPost(kCGHIDEventTap, down);
  usleep(20000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  usleep(50000);
  CGWarpMouseCursorPosition(original_position);
  return true;
}

#define CODEX_DICTATION_BUTTON_MAX 96

typedef struct {
  AXUIElementRef element;
  CGPoint position;
  CGSize size;
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
  bool is_button = role != NULL
    && CFGetTypeID(role) == CFStringGetTypeID()
    && CFEqual(role, kAXButtonRole);
  bool is_hidden = hidden != NULL
    && CFGetTypeID(hidden) == CFBooleanGetTypeID()
    && CFBooleanGetValue((CFBooleanRef)hidden);
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
      .size = size
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

static bool stop_codex_composer_dictation_if_visible(void) {
  if (!codex_audio_input_is_running()) return false;
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return false;
  AXUIElementSetMessagingTimeout(application, 0.5);

  CFTypeRef window_value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window_value)
        != kAXErrorSuccess
      || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    CFRelease(application);
    return false;
  }
  AXUIElementRef window = (AXUIElementRef)window_value;
  CGPoint window_origin = CGPointZero;
  CGSize window_size = CGSizeZero;
  if (!copy_element_position(window, &window_origin)
      || !copy_element_size(window, &window_size)) {
    CFRelease(window_value);
    CFRelease(application);
    return false;
  }

  const void *attribute_values[DICTATION_ATTR_COUNT] = {
    kAXRoleAttribute,
    kAXHiddenAttribute,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXChildrenAttribute
  };
  CFArrayRef attributes = CFArrayCreate(
    kCFAllocatorDefault,
    attribute_values,
    DICTATION_ATTR_COUNT,
    &kCFTypeArrayCallBacks
  );
  if (attributes == NULL) {
    CFRelease(window_value);
    CFRelease(application);
    return false;
  }

  CodexDictationButtonState state = {
    .attributes = attributes,
    .button_count = 0,
    .visited = 0
  };
  collect_codex_dictation_buttons(window, 0, &state);

  AXUIElementRef stop_button = NULL;
  double best_y = -1;
  double best_x = -1;
  double lower_region = window_origin.y + window_size.height * 0.60;
  double right_region = window_origin.x + window_size.width * 0.45;
  for (unsigned left_index = 0; left_index < state.button_count; left_index += 1) {
    CodexDictationButton left = state.buttons[left_index];
    if (left.position.y < lower_region || left.position.x < right_region) continue;
    for (unsigned right_index = 0; right_index < state.button_count; right_index += 1) {
      if (left_index == right_index) continue;
      CodexDictationButton right = state.buttons[right_index];
      double row_delta = left.position.y - right.position.y;
      if (row_delta < 0) row_delta = -row_delta;
      double gap = right.position.x - (left.position.x + left.size.width);
      if (row_delta > 3 || gap < 4 || gap > 18) continue;
      if (left.position.y > best_y
          || (left.position.y == best_y && right.position.x > best_x)) {
        stop_button = left.element;
        best_y = left.position.y;
        best_x = right.position.x;
      }
    }
  }

  bool stopped = false;
  if (stop_button != NULL) {
    // Chromium currently reports AXPress success without dispatching this
    // React button's pointer handler. Use a real click while Codex is frontmost;
    // if focus moved during the hold, AXPress remains the safe best effort and
    // can never land on another application's window.
    if (codex_is_frontmost()) {
      stopped = click_element_center(stop_button);
    } else {
      stopped = AXUIElementPerformAction(stop_button, kAXPressAction) == kAXErrorSuccess;
    }
  }

  release_codex_dictation_buttons(&state);
  CFRelease(attributes);
  CFRelease(window_value);
  CFRelease(application);
  return stopped;
}

static bool batched_element_matches_thread_target(
  CFArrayRef values,
  CodexThreadTargetState *state
) {
  if (values == NULL || CFArrayGetCount(values) < THREAD_ATTR_COUNT) return false;
  for (CFIndex index = THREAD_ATTR_TITLE; index <= THREAD_ATTR_DOM_IDENTIFIER; index += 1) {
    CFTypeRef value = CFArrayGetValueAtIndex(values, index);
    StringFingerprint fingerprint = { 0 };
    if (string_fingerprint(value, &fingerprint.length, &fingerprint.hash)
        && fingerprints_equal(fingerprint, state->fingerprint)) return true;
  }
  return false;
}

static void add_codex_thread_target(
  CodexThreadTargetState *state,
  AXUIElementRef target
) {
  for (unsigned index = 0; index < state->target_count; index += 1) {
    if (CFEqual(state->targets[index], target)) return;
  }
  if (state->target_count >= CODEX_THREAD_TARGET_MAX) return;
  state->targets[state->target_count++] = (AXUIElementRef)CFRetain(target);
}

static void collect_codex_thread_targets(
  AXUIElementRef element,
  unsigned depth,
  CodexThreadTargetState *state
) {
  if (element == NULL || depth > 30 || state->visited >= 8000) return;
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
  if (!hidden && batched_element_matches_thread_target(values, state)) {
    state->matched_elements += 1;
    // Click the exact text-bearing element. Electron's accessible parent for a
    // command-palette result can point at the following row even though its
    // AXPress action reports success.
    add_codex_thread_target(state, element);
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
  }
  state->target_count = 0;
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

static int find_or_open_codex_thread(
  const char *uuid,
  const char *fingerprint_input,
  bool press
) {
  StringFingerprint fingerprint = { 0 };
  if (uuid == NULL || strlen(uuid) != 36 || !parse_fingerprint(fingerprint_input, &fingerprint)) {
    return 64;
  }
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return 1;
  AXUIElementSetMessagingTimeout(application, 0.8);

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

  CodexThreadTargetState state = {
    .fingerprint = fingerprint,
    .attributes = attributes,
    .target_count = 0,
    .matched_elements = 0,
    .visited = 0
  };
  collect_codex_thread_targets(application, 0, &state);

  printf(
    "strategy=title matched=%u targets=%u visited=%u\n",
    state.matched_elements,
    state.target_count,
    state.visited
  );
  int result = 1;
  if (!press) {
    for (unsigned index = 0; index < state.target_count; index += 1) {
      CGPoint position = CGPointZero;
      CGSize size = CGSizeZero;
      bool has_position = copy_element_position(state.targets[index], &position);
      bool has_size = copy_element_size(state.targets[index], &size);
      printf(
        "target=%u x=%.0f y=%.0f width=%.0f height=%.0f\n",
        index,
        has_position ? position.x : -1,
        has_position ? position.y : -1,
        has_size ? size.width : -1,
        has_size ? size.height : -1
      );
    }
    result = state.target_count == 1 ? 0 : state.target_count > 1 ? 3 : 1;
  } else if (state.target_count == 1) {
    // Chromium can report a successful AXPress for a sidebar task row without
    // dispatching React's pointer handler. A real click at the verified row
    // bounds consistently runs Codex's host activation and navigation path.
    result = click_element_center(state.targets[0]) ? 0 : 1;
  } else if (state.target_count > 1) {
    result = 3;
  }

  release_codex_thread_targets(&state);
  CFRelease(attributes);
  CFRelease(application);
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

static AXUIElementRef copy_codex_focused_search_field(void) {
  AXUIElementRef application = copy_codex_application();
  if (application == NULL) return NULL;
  AXUIElementSetMessagingTimeout(application, 0.8);
  CFTypeRef focused_value = NULL;
  AXError focused_error = AXUIElementCopyAttributeValue(
    application,
    kAXFocusedUIElementAttribute,
    &focused_value
  );
  CFRelease(application);
  if (focused_error != kAXErrorSuccess || focused_value == NULL
      || CFGetTypeID(focused_value) != AXUIElementGetTypeID()) {
    if (focused_value != NULL) CFRelease(focused_value);
    return NULL;
  }
  CFTypeRef role_value = NULL;
  AXError role_error = AXUIElementCopyAttributeValue(
    (AXUIElementRef)focused_value,
    kAXRoleAttribute,
    &role_value
  );
  bool is_search_field = role_error == kAXErrorSuccess && role_value != NULL
    && CFGetTypeID(role_value) == CFStringGetTypeID()
    && CFEqual(role_value, kAXComboBoxRole);
  if (role_value != NULL) CFRelease(role_value);
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

static int fill_codex_search_from_stdin(void) {
  size_t title_length = 0;
  char *title = read_stdin_utf8(&title_length);
  if (title == NULL) return 64;

  tap_key(KEY_K, kCGEventFlagMaskCommand);
  usleep(300000);
  AXUIElementRef search_field = copy_codex_focused_search_field();
  bool typed = false;
  if (search_field != NULL) {
    typed = set_codex_search_text(search_field, title, title_length);
    if (!typed) {
      tap_key(KEY_A, kCGEventFlagMaskCommand);
      typed = post_unicode_text(title, title_length);
    }
    CFRelease(search_field);
  }
  free(title);
  if (!typed) {
    tap_key(KEY_ESCAPE, 0);
    return 1;
  }
  return 0;
}

static int search_and_open_codex_thread(
  const char *uuid,
  const char *fingerprint_input
) {
  StringFingerprint fingerprint = { 0 };
  if (uuid == NULL || strlen(uuid) != 36 || !parse_fingerprint(fingerprint_input, &fingerprint)) {
    return 64;
  }
  int fill_result = fill_codex_search_from_stdin();
  if (fill_result != 0) return fill_result;
  usleep(700000);
  // Confirm that exactly one accessibility result matches the private title
  // fingerprint, then activate Codex's already-selected first search result.
  // This avoids Electron's incorrect AX row coordinates while still running
  // the result's own host-selection hook before navigation.
  int result = find_or_open_codex_thread(uuid, fingerprint_input, false);
  if (result == 0) {
    tap_key(KEY_RETURN, 0);
    usleep(300000);
    AXUIElementRef search_field = copy_codex_focused_search_field();
    if (search_field != NULL) {
      CFRelease(search_field);
      result = 1;
    }
  }
  if (result != 0) tap_key(KEY_ESCAPE, 0);
  return result;
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (strcmp(argv[1], "codex-find-thread") == 0) {
    if (argc != 4) return 64;
    return find_or_open_codex_thread(argv[2], argv[3], false);
  }
  if (strcmp(argv[1], "codex-open-thread") == 0) {
    if (argc != 4) return 64;
    return find_or_open_codex_thread(argv[2], argv[3], true);
  }
  if (strcmp(argv[1], "codex-search-thread") == 0) {
    if (argc != 4) return 64;
    return search_and_open_codex_thread(argv[2], argv[3]);
  }
  if (argc != 2) return 64;
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
  if (strcmp(argv[1], "voice-down") == 0) voice_down();
  else if (strcmp(argv[1], "voice-up") == 0) voice_up();
  else if (strcmp(argv[1], "send") == 0) tap_key(KEY_RETURN, 0);
  else if (strcmp(argv[1], "send-command") == 0) command_return();
  else if (strcmp(argv[1], "app-switch") == 0) app_switch();
  else if (strcmp(argv[1], "new-thread") == 0) new_thread();
  else if (strcmp(argv[1], "side-chat") == 0) side_chat();
  else if (strcmp(argv[1], "media-previous") == 0) tap_media_key(MEDIA_PREVIOUS);
  else if (strcmp(argv[1], "media-rewind") == 0) tap_media_key(MEDIA_REWIND);
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
  else if (strcmp(argv[1], "focused-text-state") == 0) return print_focused_text_state();
  else if (strcmp(argv[1], "editable-text-state") == 0) return print_editable_text_state();
  else if (strcmp(argv[1], "focused-element-info") == 0) return print_focused_element_info();
  else if (strcmp(argv[1], "editable-element-info") == 0) return print_editable_element_info();
  else if (strcmp(argv[1], "selected-element-info") == 0) return print_selected_element_info();
  else if (strcmp(argv[1], "codex-queue-state") == 0) return print_codex_queue_state();
  else if (strcmp(argv[1], "codex-stop-dictation") == 0) {
    return stop_codex_composer_dictation_if_visible() ? 0 : 1;
  }
  else if (strcmp(argv[1], "release") == 0) release_voice_keys();
  else return 64;
  return 0;
}
