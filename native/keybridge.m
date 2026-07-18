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
  KEY_S = 0x01,
  KEY_D = 0x02,
  KEY_O = 0x1F,
  KEY_RETURN = 0x24,
  KEY_TAB = 0x30,
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

static void post_key(CGKeyCode key, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
  if (event == NULL) return;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(9000);
}

static void voice_down(void) {
  post_key(KEY_CONTROL, true, kCGEventFlagMaskControl);
  post_key(KEY_SHIFT, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  post_key(KEY_D, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
}

static void voice_up(void) {
  post_key(KEY_D, false, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  post_key(KEY_SHIFT, false, kCGEventFlagMaskControl);
  post_key(KEY_CONTROL, false, 0);
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

static void print_running_audio_processes(void) {
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
    address.mSelector = kAudioProcessPropertyIsRunningOutput;
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

int main(int argc, char **argv) {
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
    voice_up();
    usleep(30000);
    bool released = !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_CONTROL)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_SHIFT)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_D);
    printf("held=%d released=%d\n", held ? 1 : 0, released ? 1 : 0);
    return held && released ? 0 : 1;
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
  else if (strcmp(argv[1], "audio-processes") == 0) print_running_audio_processes();
  else if (strcmp(argv[1], "focused-text-state") == 0) return print_focused_text_state();
  else if (strcmp(argv[1], "editable-text-state") == 0) return print_editable_text_state();
  else if (strcmp(argv[1], "focused-element-info") == 0) return print_focused_element_info();
  else if (strcmp(argv[1], "editable-element-info") == 0) return print_editable_element_info();
  else if (strcmp(argv[1], "selected-element-info") == 0) return print_selected_element_info();
  else if (strcmp(argv[1], "codex-queue-state") == 0) return print_codex_queue_state();
  else if (strcmp(argv[1], "release") == 0) voice_up();
  else return 64;
  return 0;
}
