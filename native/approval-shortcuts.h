#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>

// This transport invokes a configured command in the foreground window. A
// window token is not an approval-request identity or an acknowledgment.
typedef struct {
  const char *command;
  const char *accelerator;
  CGKeyCode key;
  CGEventFlags flags;
} ApprovalShortcutSpec;

typedef struct {
  pid_t pid;
  CGWindowID window;
  uint32_t session_user;
  uint32_t session_console;
} ApprovalShortcutContext;

typedef struct {
  CGKeyCode key;
  CGEventFlags flags;
  bool down;
} ApprovalShortcutKeyEvent;

typedef struct {
  const char *(*validate_keymap)(const ApprovalShortcutSpec *, void *);
  const char *(*read_context)(ApprovalShortcutContext *, void *);
  bool (*prepare_events)(const ApprovalShortcutSpec *, void *);
  void (*post_pair)(pid_t, void *);
  void *context;
} ApprovalShortcutOperations;

static bool approval_shortcut_spec(const char *decision, ApprovalShortcutSpec *spec) {
  if (decision == NULL || spec == NULL) return false;
  if (strcmp(decision, "approve") == 0) {
    *spec = (ApprovalShortcutSpec) {
      "approval.approve", "Control+Alt+Command+F13", 0x69,
      kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand
    };
    return true;
  }
  if (strcmp(decision, "decline") == 0) {
    *spec = (ApprovalShortcutSpec) {
      "approval.decline", "Control+Alt+Command+F14", 0x6B,
      kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand
    };
    return true;
  }
  return false;
}

static void approval_shortcut_event_pair(
  const ApprovalShortcutSpec *spec, ApprovalShortcutKeyEvent events[2]
) {
  events[0] = (ApprovalShortcutKeyEvent) { spec->key, spec->flags, true };
  events[1] = (ApprovalShortcutKeyEvent) { spec->key, spec->flags, false };
}

// Normalize just the first stroke: a chord using the dedicated stroke would
// intercept it too. Whitespace within the stroke is not a Codex accelerator.
static NSString *approval_shortcut_first_stroke(NSString *key) {
  NSString *trimmed = [key stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSString *stroke = [trimmed componentsSeparatedByCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet].firstObject;
  if (stroke.length == 0) return nil;
  bool control = false, alt = false, command = false, shift = false;
  NSString *main_key = nil;
  for (NSString *part in [stroke.lowercaseString componentsSeparatedByString:@"+"]) {
    if ([part isEqualToString:@"ctrl"] || [part isEqualToString:@"control"]) {
      control = true;
    } else if ([part isEqualToString:@"alt"] || [part isEqualToString:@"option"]
               || [part isEqualToString:@"opt"]) {
      alt = true;
    } else if ([part isEqualToString:@"command"] || [part isEqualToString:@"cmd"]
               || [part isEqualToString:@"meta"] || [part isEqualToString:@"super"]
               || [part isEqualToString:@"cmdorctrl"]
               || [part isEqualToString:@"commandorcontrol"]) {
      command = true;
    } else if ([part isEqualToString:@"shift"]) {
      shift = true;
    } else {
      if (main_key != nil || part.length == 0) return nil;
      main_key = part;
    }
  }
  if (main_key == nil) return nil;
  return [NSString stringWithFormat:@"%d:%d:%d:%d:%@",
    control, alt, command, shift, main_key];
}

// Conflict detection deliberately accepts broad aliases. Establishing that
// Codex can run our command is stricter: its renderer accepts these modifier
// spellings case-sensitively, with one function-key name (case-insensitive).
static bool approval_shortcut_has_codex_syntax(NSString *stroke) {
  unsigned keys = 0;
  for (NSString *part in [stroke componentsSeparatedByString:@"+"]) {
    if ([part isEqualToString:@"CmdOrCtrl"] || [part isEqualToString:@"Command"]
        || [part isEqualToString:@"Cmd"] || [part isEqualToString:@"Control"]
        || [part isEqualToString:@"Ctrl"] || [part isEqualToString:@"Alt"]
        || [part isEqualToString:@"Option"] || [part isEqualToString:@"Shift"]) continue;
    if ([part.lowercaseString isEqualToString:@"f13"] || [part.lowercaseString isEqualToString:@"f14"]) keys += 1;
    else return false;
  }
  return keys == 1;
}

static const char *approval_validate_keymap(id keymap, const ApprovalShortcutSpec *spec) {
  if (![keymap isKindOfClass:NSArray.class]) return "keymap-invalid";
  NSString *command = [NSString stringWithUTF8String:spec->command];
  NSString *dedicated = approval_shortcut_first_stroke(
    [NSString stringWithUTF8String:spec->accelerator]);
  bool configured = false, disabled = false, conflict = false;
  for (id item in (NSArray *)keymap) {
    if (![item isKindOfClass:NSDictionary.class]) return "keymap-invalid";
    id item_command = item[@"command"];
    id key = item[@"key"];
    if (![item_command isKindOfClass:NSString.class]
        || [item_command length] == 0
        || (key != NSNull.null && ![key isKindOfClass:NSString.class])) {
      return "keymap-invalid";
    }
    bool selected = [item_command isEqualToString:command];
    if (key == NSNull.null) {
      if (selected) disabled = true;
      continue;
    }
    NSString *normalized = approval_shortcut_first_stroke(key);
    if (![normalized isEqualToString:dedicated]) continue;
    NSString *trimmed = [key stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
    bool has_chord = [trimmed rangeOfCharacterFromSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet].location != NSNotFound;
    if (!selected) conflict = true;
    else if (!has_chord && approval_shortcut_has_codex_syntax(trimmed)) configured = true;
    else if (has_chord) {
      NSString *first = [trimmed componentsSeparatedByCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet].firstObject;
      if (approval_shortcut_has_codex_syntax(first)) conflict = true;
    }
  }
  if (disabled) return "command-disabled";
  if (conflict) return "shortcut-conflict";
  return configured ? NULL : "shortcut-unconfigured";
}

static NSString *approval_context_token(ApprovalShortcutContext context) {
  if (context.pid <= 1 || context.window == 0) return nil;
  return [NSString stringWithFormat:@"v2:%d:%u:%u:%u", context.pid, context.window,
    context.session_user, context.session_console];
}

static bool approval_context_matches(
  ApprovalShortcutContext actual, pid_t expected_pid, NSString *expected_token
) {
  return actual.pid == expected_pid && expected_pid > 1
    && expected_token.length > 0
    && [approval_context_token(actual) isEqualToString:expected_token];
}

static const char *approval_dispatch_shortcut(
  const ApprovalShortcutSpec *spec, pid_t expected_pid, NSString *expected_token,
  ApprovalShortcutOperations operations
) {
  const char *error = operations.validate_keymap(spec, operations.context);
  if (error != NULL) return error;
  ApprovalShortcutContext current = { 0 };
  error = operations.read_context(&current, operations.context);
  if (error != NULL) return error;
  if (!approval_context_matches(current, expected_pid, expected_token)) {
    return "context-changed";
  }
  if (!operations.prepare_events(spec, operations.context)) return "event-unavailable";
  // Recheck both inputs after event allocation, immediately before dispatch.
  error = operations.validate_keymap(spec, operations.context);
  if (error != NULL) return error;
  error = operations.read_context(&current, operations.context);
  if (error != NULL) return error;
  if (!approval_context_matches(current, expected_pid, expected_token)) {
    return "context-changed";
  }
  operations.post_pair(current.pid, operations.context);
  return NULL;
}

static const char *approval_session_from_dictionary(
  NSDictionary *session, uid_t expected_user, uint32_t *user, uint32_t *console
) {
  if (![session isKindOfClass:NSDictionary.class]) return "session-unavailable";
  id on_console = session[(__bridge NSString *)kCGSessionOnConsoleKey];
  id login_done = session[(__bridge NSString *)kCGSessionLoginDoneKey];
  id user_value = session[(__bridge NSString *)kCGSessionUserIDKey];
  id console_value = session[(__bridge NSString *)kCGSessionConsoleSetKey];
  if (on_console == nil || login_done == nil || user_value == nil
      || CFGetTypeID((__bridge CFTypeRef)on_console) != CFBooleanGetTypeID()
      || CFGetTypeID((__bridge CFTypeRef)login_done) != CFBooleanGetTypeID()
      || CFGetTypeID((__bridge CFTypeRef)user_value) != CFNumberGetTypeID()
      || (console_value != nil && CFGetTypeID((__bridge CFTypeRef)console_value) != CFNumberGetTypeID())) {
    return "session-unavailable";
  }
  // macOS 26 can omit the console-set key. UID plus the Codex PID/window
  // still identify this foreground session; include the extra key if present.
  int64_t user_number = -1, console_number = 0;
  if (!CFNumberGetValue((__bridge CFNumberRef)user_value, kCFNumberSInt64Type, &user_number)
      || (console_value != nil && !CFNumberGetValue((__bridge CFNumberRef)console_value,
        kCFNumberSInt64Type, &console_number))
      || user_number < 0 || user_number > UINT32_MAX
      || console_number < 0 || console_number > UINT32_MAX) return "session-unavailable";
  if (![on_console boolValue] || ![login_done boolValue]
      || (uid_t)user_number != expected_user) return "session-inactive";
  // Public CGSession keys establish a logged-in console session, not an
  // authoritative unlocked state. Some macOS versions additionally publish
  // this undocumented lock flag; honor explicit true but do not interpret a
  // missing key as proof of unlocked state or require undocumented false.
  id locked = session[@"CGSSessionScreenIsLocked"];
  if (locked != nil) {
    if (CFGetTypeID((__bridge CFTypeRef)locked) != CFBooleanGetTypeID()
        && CFGetTypeID((__bridge CFTypeRef)locked) != CFNumberGetTypeID()) {
      return "session-unavailable";
    }
    if ([locked boolValue]) return "session-locked";
  }
  *user = (uint32_t)user_number;
  *console = (uint32_t)console_number;
  return NULL;
}

static const char *approval_read_live_session(uint32_t *user, uint32_t *console) {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  const char *error = approval_session_from_dictionary(
    (__bridge NSDictionary *)session, getuid(), user, console);
  if (session != NULL) CFRelease(session);
  return error;
}

static const char *approval_read_live_context(
  ApprovalShortcutContext *result, void *unused
) {
  (void)unused;
  uint32_t session_user = 0, session_console = 0;
  const char *session_error = approval_read_live_session(&session_user, &session_console);
  if (session_error != NULL) return session_error;
  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (![frontmost.bundleIdentifier isEqualToString:@"com.openai.codex"]
      || frontmost.terminated || frontmost.processIdentifier <= 1) return "not-frontmost";
  pid_t pid = frontmost.processIdentifier;
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) return "context-unavailable";
  AXUIElementSetMessagingTimeout(application, 0.35);
  CFTypeRef window_value = NULL;
  AXError error = AXUIElementCopyAttributeValue(
    application, kAXFocusedWindowAttribute, &window_value);
  CFRelease(application);
  if (error != kAXErrorSuccess || window_value == NULL
      || CFGetTypeID(window_value) != AXUIElementGetTypeID()) {
    if (window_value != NULL) CFRelease(window_value);
    return "context-unavailable";
  }
  CFTypeRef position_value = NULL, size_value = NULL;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool geometry_available = AXUIElementCopyAttributeValue(
      (AXUIElementRef)window_value, kAXPositionAttribute, &position_value) == kAXErrorSuccess
    && position_value != NULL && CFGetTypeID(position_value) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType, &position)
    && AXUIElementCopyAttributeValue(
      (AXUIElementRef)window_value, kAXSizeAttribute, &size_value) == kAXErrorSuccess
    && size_value != NULL && CFGetTypeID(size_value) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, &size)
    && size.width > 0 && size.height > 0;
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  CFRelease(window_value);
  if (!geometry_available) return "context-unavailable";

  // Window number, PID and bounds are sufficient; do not read titles, AX text,
  // screenshots or other content. Ambiguous identical windows fail closed.
  CFArrayRef windows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID);
  if (windows == NULL) return "context-unavailable";
  CGWindowID selected = 0;
  unsigned matches = 0;
  for (NSDictionary *window in (__bridge NSArray *)windows) {
    if ([window[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid
        || [window[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    CGRect bounds = CGRectZero;
    id bounds_value = window[(__bridge NSString *)kCGWindowBounds];
    if (![bounds_value isKindOfClass:NSDictionary.class]
        || !CGRectMakeWithDictionaryRepresentation(
          (__bridge CFDictionaryRef)bounds_value, &bounds)) continue;
    if (fabs(bounds.origin.x - position.x) > 0.5
        || fabs(bounds.origin.y - position.y) > 0.5
        || fabs(bounds.size.width - size.width) > 0.5
        || fabs(bounds.size.height - size.height) > 0.5) continue;
    selected = [window[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    matches += 1;
  }
  CFRelease(windows);
  if (matches != 1 || selected == 0) return "context-unavailable";
  uint32_t final_user = 0, final_console = 0;
  session_error = approval_read_live_session(&final_user, &final_console);
  if (session_error != NULL) return session_error;
  if (final_user != session_user || final_console != session_console) return "context-changed";
  NSRunningApplication *final_frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (final_frontmost.processIdentifier != pid
      || ![final_frontmost.bundleIdentifier isEqualToString:@"com.openai.codex"]) {
    return "context-changed";
  }
  *result = (ApprovalShortcutContext) { pid, selected, session_user, session_console };
  return NULL;
}

typedef struct {
  const char *keymap_path;
  CGEventRef down;
  CGEventRef up;
} ApprovalShortcutLiveState;

static const char *approval_validate_live_keymap(
  const ApprovalShortcutSpec *spec, void *context
) {
  ApprovalShortcutLiveState *state = context;
  int descriptor = open(state->keymap_path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (descriptor < 0) return "keymap-invalid";
  struct stat info;
  const size_t limit = 1024 * 1024;
  if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode)
      || info.st_size <= 0 || info.st_size > (off_t)limit) {
    close(descriptor);
    return "keymap-invalid";
  }
  NSMutableData *data = [NSMutableData dataWithLength:limit + 1];
  size_t used = 0;
  while (used <= limit) {
    ssize_t count = read(descriptor, (uint8_t *)data.mutableBytes + used, limit + 1 - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { close(descriptor); return "keymap-invalid"; }
    if (count == 0) break;
    used += (size_t)count;
  }
  close(descriptor);
  if (used > limit) return "keymap-invalid";
  data.length = used;
  id keymap = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  return approval_validate_keymap(keymap, spec);
}

static bool approval_prepare_live_events(const ApprovalShortcutSpec *spec, void *context) {
  ApprovalShortcutLiveState *state = context;
  ApprovalShortcutKeyEvent events[2];
  approval_shortcut_event_pair(spec, events);
  state->down = create_key_event(events[0].key, events[0].down, events[0].flags, NULL, 0);
  state->up = create_key_event(events[1].key, events[1].down, events[1].flags, NULL, 0);
  return state->down != NULL && state->up != NULL;
}

static void approval_post_live_pair(pid_t pid, void *context) {
  ApprovalShortcutLiveState *state = context;
  CGEventPostToPid(pid, state->down);
  CGEventPostToPid(pid, state->up);
}

static int approval_print_error(const char *error, int code) {
  printf("{\"sent\":false,\"error\":\"%s\"}\n", error);
  return code;
}

static int codex_approval_shortcut(int argc, char **argv) {
  ApprovalShortcutSpec spec;
  if (argc != 6 || !approval_shortcut_spec(argv[2], &spec)
      || argv[3][0] != '/' || strlen(argv[5]) > 64) {
    return approval_print_error("invalid-arguments", 64);
  }
  char *end = NULL;
  errno = 0;
  long expected_pid = strtol(argv[4], &end, 10);
  if (errno != 0 || end == argv[4] || *end != '\0'
      || expected_pid <= 1 || expected_pid > INT_MAX) {
    return approval_print_error("invalid-arguments", 64);
  }
  NSString *token = [NSString stringWithUTF8String:argv[5]];
  if (token.length == 0) return approval_print_error("invalid-arguments", 64);
  ApprovalShortcutLiveState state = { argv[3], NULL, NULL };
  const char *error = approval_dispatch_shortcut(
    &spec, (pid_t)expected_pid, token, (ApprovalShortcutOperations) {
      .validate_keymap = approval_validate_live_keymap,
      .read_context = approval_read_live_context,
      .prepare_events = approval_prepare_live_events,
      .post_pair = approval_post_live_pair,
      .context = &state
    });
  if (state.down != NULL) CFRelease(state.down);
  if (state.up != NULL) CFRelease(state.up);
  if (error != NULL) return approval_print_error(error, 1);
  // Quartz does not acknowledge that a command handler accepted the event.
  printf("{\"sent\":true}\n");
  return 0;
}

typedef struct {
  ApprovalShortcutContext contexts[2];
  const char *context_errors[2];
  const char *keymap_errors[2];
  unsigned reads, validations, prepares, posts;
  bool prepared;
  pid_t posted_pid;
  CGKeyCode prepared_key;
  CGEventFlags prepared_flags;
} ApprovalShortcutSelftestState;

static const char *approval_selftest_validate(const ApprovalShortcutSpec *spec, void *context) {
  (void)spec;
  ApprovalShortcutSelftestState *state = context;
  return state->keymap_errors[state->validations++ > 0 ? 1 : 0];
}

static const char *approval_selftest_context(ApprovalShortcutContext *result, void *context) {
  ApprovalShortcutSelftestState *state = context;
  unsigned index = state->reads++ > 0 ? 1 : 0;
  *result = state->contexts[index];
  return state->context_errors[index];
}

static bool approval_selftest_prepare(const ApprovalShortcutSpec *spec, void *context) {
  ApprovalShortcutSelftestState *state = context;
  state->prepares += 1;
  state->prepared_key = spec->key;
  state->prepared_flags = spec->flags;
  return state->prepared;
}

static void approval_selftest_post(pid_t pid, void *context) {
  ApprovalShortcutSelftestState *state = context;
  state->posts += 1;
  state->posted_pid = pid;
}

static const char *approval_run_selftest_case(ApprovalShortcutSelftestState *state) {
  ApprovalShortcutSpec spec;
  approval_shortcut_spec("approve", &spec);
  return approval_dispatch_shortcut(&spec, 123, @"v2:123:45:501:1", (ApprovalShortcutOperations) {
    .validate_keymap = approval_selftest_validate,
    .read_context = approval_selftest_context,
    .prepare_events = approval_selftest_prepare,
    .post_pair = approval_selftest_post,
    .context = state
  });
}

static bool approval_error_is(const char *actual, const char *expected) {
  return actual != NULL && strcmp(actual, expected) == 0;
}

static int approval_shortcut_selftest(void) {
  // All dependencies below are in-memory fakes. Do not probe the host, create
  // CGEvents, activate an application or post input from this selftest.
  unsigned checks = 0, failures = 0;
#define APPROVAL_CHECK(condition) do { checks += 1; if (!(condition)) failures += 1; } while (0)
  ApprovalShortcutSpec approve, decline;
  APPROVAL_CHECK(approval_shortcut_spec("approve", &approve));
  APPROVAL_CHECK(approval_shortcut_spec("decline", &decline));
  APPROVAL_CHECK(!approval_shortcut_spec("other", &decline));
  APPROVAL_CHECK(approve.key == 0x69 && decline.key == 0x6B);
  APPROVAL_CHECK(approve.flags == (kCGEventFlagMaskControl | kCGEventFlagMaskAlternate
    | kCGEventFlagMaskCommand) && decline.flags == approve.flags);
  ApprovalShortcutKeyEvent events[2];
  approval_shortcut_event_pair(&approve, events);
  APPROVAL_CHECK(events[0].down && !events[1].down && events[0].key == 0x69
    && events[1].key == 0x69 && events[0].flags == approve.flags
    && events[1].flags == approve.flags);
  approval_shortcut_event_pair(&decline, events);
  APPROVAL_CHECK(events[0].down && !events[1].down && events[0].key == 0x6B
    && events[1].key == 0x6B && events[0].flags == decline.flags
    && events[1].flags == decline.flags);
  NSArray *valid = @[
    @{ @"command": @"approval.approve", @"key": @"Enter" },
    @{ @"command": @"approval.approve", @"key": @"Control+Alt+Command+F13" },
    @{ @"command": @"approval.decline", @"key": @"Escape" },
    @{ @"command": @"approval.decline", @"key": @"Control+Alt+Command+F14" }
  ];
  APPROVAL_CHECK(approval_validate_keymap(valid, &approve) == NULL);
  APPROVAL_CHECK(approval_validate_keymap(valid, &decline) == NULL);
  for (NSString *alias in @[@"Cmd+Ctrl+Option+F13", @"Control+Alt+CmdOrCtrl+F13",
       @"F13+Ctrl+Command+Alt", @"Command+Control+Alt+f13"]) {
    APPROVAL_CHECK(approval_validate_keymap(@[
      @{ @"command": @"approval.approve", @"key": alias }
    ], &approve) == NULL);
  }
  for (NSString *invalid_alias in @[@"Meta+Ctrl+Option+F13", @"Super+Ctrl+Alt+F13",
       @"Cmd+Ctrl+Opt+F13", @"CommandOrControl+Control+Alt+F13",
       @"command+control+alt+F13",
       @"Meta+Ctrl+Option+F13 A"]) {
    NSDictionary *entry = @{ @"command": @"approval.approve", @"key": invalid_alias };
    APPROVAL_CHECK(approval_error_is(approval_validate_keymap(@[entry], &approve),
      "shortcut-unconfigured"));
    APPROVAL_CHECK(approval_validate_keymap([valid arrayByAddingObject:entry], &approve) == NULL);
  }
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap(@[], &approve),
    "shortcut-unconfigured"));
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap(@{}, &approve), "keymap-invalid"));
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap(@[@{ @"command": @"x" }], &approve),
    "keymap-invalid"));
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap(@[
    @{ @"command": @"x", @"key": @1 }
  ], &approve), "keymap-invalid"));
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap([valid arrayByAddingObject:
    @{ @"command": @"approval.approve", @"key": NSNull.null }], &approve), "command-disabled"));
  for (NSString *collision in @[@"Meta+Ctrl+Option+F13", @"F13+Ctrl+Cmd+Alt",
       @"Control+Alt+CmdOrCtrl+F13", @"CommandOrControl+Alt+Control+F13",
       @"Control+Alt+Command+F13 A"]) {
    APPROVAL_CHECK(approval_error_is(approval_validate_keymap([valid arrayByAddingObject:
      @{ @"command": @"other", @"key": collision }], &approve), "shortcut-conflict"));
  }
  APPROVAL_CHECK(approval_error_is(approval_validate_keymap([valid arrayByAddingObject:
    @{ @"command": @"approval.approve", @"key": @"Control+Alt+Command+F13 A" }],
    &approve), "shortcut-conflict"));
  APPROVAL_CHECK(approval_validate_keymap([valid arrayByAddingObject:
    @{ @"command": @"other", @"key": @"Shift+Control+Alt+Command+F13" }], &approve) == NULL);
  APPROVAL_CHECK(approval_context_matches((ApprovalShortcutContext){123, 45, 501, 1},
    123, @"v2:123:45:501:1"));
  APPROVAL_CHECK(!approval_context_matches((ApprovalShortcutContext){124, 45, 501, 1},
    123, @"v2:123:45:501:1"));
  APPROVAL_CHECK(!approval_context_matches((ApprovalShortcutContext){123, 46, 501, 1},
    123, @"v2:123:45:501:1"));
  APPROVAL_CHECK(!approval_context_matches((ApprovalShortcutContext){123, 0, 501, 1},
    123, @"v2:123:0:501:1"));
  APPROVAL_CHECK(!approval_context_matches((ApprovalShortcutContext){123, 45, 502, 1},
    123, @"v2:123:45:501:1"));
  APPROVAL_CHECK(!approval_context_matches((ApprovalShortcutContext){123, 45, 501, 2},
    123, @"v2:123:45:501:1"));
  ApprovalShortcutSelftestState success = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = true
  };
  APPROVAL_CHECK(approval_run_selftest_case(&success) == NULL);
  APPROVAL_CHECK(success.validations == 2 && success.reads == 2 && success.prepares == 1
    && success.posts == 1 && success.posted_pid == 123
    && success.prepared_key == approve.key && success.prepared_flags == approve.flags);
  ApprovalShortcutSelftestState changed = {
    .contexts = {{123, 45, 501, 1}, {123, 46, 501, 1}}, .prepared = true
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&changed), "context-changed"));
  APPROVAL_CHECK(changed.posts == 0 && changed.reads == 2);
  ApprovalShortcutSelftestState foreign = {
    .contexts = {{999, 45, 501, 1}, {999, 45, 501, 1}}, .prepared = true
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&foreign), "context-changed"));
  APPROVAL_CHECK(foreign.posts == 0 && foreign.prepares == 0);
  ApprovalShortcutSelftestState background = {
    .context_errors = {"not-frontmost", NULL}, .prepared = true
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&background), "not-frontmost"));
  APPROVAL_CHECK(background.posts == 0 && background.prepares == 0);
  ApprovalShortcutSelftestState background_during_prepare = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = true,
    .context_errors = {NULL, "not-frontmost"}
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&background_during_prepare),
    "not-frontmost"));
  APPROVAL_CHECK(background_during_prepare.posts == 0 && background_during_prepare.reads == 2);
  ApprovalShortcutSelftestState disabled = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = true,
    .keymap_errors = {"command-disabled", NULL}
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&disabled), "command-disabled"));
  APPROVAL_CHECK(disabled.posts == 0 && disabled.reads == 0 && disabled.prepares == 0);
  ApprovalShortcutSelftestState changed_binding = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = true,
    .keymap_errors = {NULL, "shortcut-conflict"}
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&changed_binding), "shortcut-conflict"));
  APPROVAL_CHECK(changed_binding.posts == 0 && changed_binding.reads == 1);
  ApprovalShortcutSelftestState no_event = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = false
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&no_event), "event-unavailable"));
  APPROVAL_CHECK(no_event.posts == 0 && no_event.reads == 1);
  ApprovalShortcutSelftestState changed_session = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 2}}, .prepared = true
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&changed_session), "context-changed"));
  APPROVAL_CHECK(changed_session.posts == 0 && changed_session.reads == 2);
  ApprovalShortcutSelftestState locked_during_prepare = {
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}}, .prepared = true,
    .context_errors = {NULL, "session-locked"}
  };
  APPROVAL_CHECK(approval_error_is(approval_run_selftest_case(&locked_during_prepare),
    "session-locked"));
  APPROVAL_CHECK(locked_during_prepare.posts == 0 && locked_during_prepare.reads == 2);
  NSDictionary *active_session = @{
    (__bridge NSString *)kCGSessionOnConsoleKey: @YES,
    (__bridge NSString *)kCGSessionLoginDoneKey: @YES,
    (__bridge NSString *)kCGSessionUserIDKey: @501,
    (__bridge NSString *)kCGSessionConsoleSetKey: @1
  };
  uint32_t session_user = 0, session_console = 0;
  APPROVAL_CHECK(approval_session_from_dictionary(active_session, 501,
    &session_user, &session_console) == NULL && session_user == 501 && session_console == 1);
  NSMutableDictionary *modern_session = [active_session mutableCopy];
  [modern_session removeObjectForKey:(__bridge NSString *)kCGSessionConsoleSetKey];
  APPROVAL_CHECK(approval_session_from_dictionary(modern_session, 501,
    &session_user, &session_console) == NULL && session_user == 501 && session_console == 0);
  modern_session[(__bridge NSString *)kCGSessionConsoleSetKey] = @"invalid";
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(modern_session, 501,
    &session_user, &session_console), "session-unavailable"));
  NSMutableDictionary *inactive_session = [active_session mutableCopy];
  inactive_session[(__bridge NSString *)kCGSessionOnConsoleKey] = @NO;
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(inactive_session, 501,
    &session_user, &session_console), "session-inactive"));
  inactive_session = [active_session mutableCopy];
  inactive_session[(__bridge NSString *)kCGSessionLoginDoneKey] = @NO;
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(inactive_session, 501,
    &session_user, &session_console), "session-inactive"));
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(active_session, 502,
    &session_user, &session_console), "session-inactive"));
  NSMutableDictionary *locked_session = [active_session mutableCopy];
  locked_session[@"CGSSessionScreenIsLocked"] = @YES;
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(locked_session, 501,
    &session_user, &session_console), "session-locked"));
  locked_session[@"CGSSessionScreenIsLocked"] = @NO;
  APPROVAL_CHECK(approval_session_from_dictionary(locked_session, 501,
    &session_user, &session_console) == NULL);
  locked_session[@"CGSSessionScreenIsLocked"] = @"false";
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(locked_session, 501,
    &session_user, &session_console), "session-unavailable"));
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(nil, 501,
    &session_user, &session_console), "session-unavailable"));
  APPROVAL_CHECK(approval_error_is(approval_session_from_dictionary(@{}, 501,
    &session_user, &session_console), "session-unavailable"));
#undef APPROVAL_CHECK
  printf("{\"checks\":%u,\"failures\":%u,\"live_io\":false}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
