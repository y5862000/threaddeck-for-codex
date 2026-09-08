// Read-only process/session identity for direct IPC approvals. No window or
// foreground requirement, and no inventory of renderer/thread owners. The IPC
// caller must separately validate the explicitly selected task/request.
typedef struct {
  pid_t pid;
  NSTimeInterval launch_seconds;
  uint64_t launch_microseconds;
  uint32_t session_user;
  uint32_t session_console;
} ApprovalApiContext;

static bool approval_api_pid(id value, pid_t *result) {
  if (value == nil || CFGetTypeID((__bridge CFTypeRef)value) != CFNumberGetTypeID()) return false;
  int64_t number = -1;
  double exact = 0;
  if (!CFNumberGetValue((__bridge CFNumberRef)value, kCFNumberSInt64Type, &number)
      || number <= 1 || number > INT_MAX
      || !CFNumberGetValue((__bridge CFNumberRef)value, kCFNumberDoubleType, &exact)
      || exact != (double)number) return false;
  *result = (pid_t)number;
  return true;
}

static bool approval_api_launch_time(id value, NSTimeInterval *seconds, uint64_t *microseconds) {
  if (value == nil || CFGetTypeID((__bridge CFTypeRef)value) != CFNumberGetTypeID()) return false;
  double time = 0;
  if (!CFNumberGetValue((__bridge CFNumberRef)value, kCFNumberDoubleType, &time) || !isfinite(time) || time <= 0) return false;
  long double scaled = (long double)time * 1000000.0L;
  if (!isfinite(scaled) || scaled < 1 || scaled >= (long double)INT64_MAX) return false;
  *seconds = time;
  *microseconds = (uint64_t)llroundl(scaled);
  return true;
}

static const char *approval_api_select_application(id applications, ApprovalApiContext *selected) {
  if (![applications isKindOfClass:NSArray.class]) return "codex-unavailable";
  unsigned count = 0;
  ApprovalApiContext context = {0};
  for (id app in applications) {
    if (![app isKindOfClass:NSDictionary.class]
        || ![app[@"bundle"] isEqual:@"com.openai.codex"]
        || app[@"terminated"] == nil
        || CFGetTypeID((__bridge CFTypeRef)app[@"terminated"]) != CFBooleanGetTypeID()) return "codex-unavailable";
    if ([app[@"terminated"] boolValue]) continue;
    if (!approval_api_pid(app[@"pid"], &context.pid)) return "codex-unavailable";
    if (!approval_api_launch_time(app[@"launchTime"], &context.launch_seconds, &context.launch_microseconds)) return "launch-unavailable";
    count += 1;
  }
  if (count == 0) return "codex-unavailable";
  if (count != 1) return "multiple-instances";
  *selected = context;
  return NULL;
}

static bool approval_api_context_stable(ApprovalApiContext first, ApprovalApiContext final) {
  return first.pid == final.pid && first.launch_seconds == final.launch_seconds
    && first.launch_microseconds == final.launch_microseconds
    && first.session_user == final.session_user && first.session_console == final.session_console;
}

static NSString *approval_api_context_token(ApprovalApiContext context) {
  if (context.pid <= 1 || context.launch_microseconds == 0) return nil;
  return [NSString stringWithFormat:@"api1:%d:%llu:%u:%u", context.pid,
    (unsigned long long)context.launch_microseconds, context.session_user, context.session_console];
}

static const char *approval_api_live_application(ApprovalApiContext *selected) {
  NSArray<NSRunningApplication *> *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.openai.codex"];
  if (running == nil) return "codex-unavailable";
  NSMutableArray *applications = [NSMutableArray arrayWithCapacity:running.count];
  for (NSRunningApplication *app in running) {
    NSDate *launch = app.launchDate;
    [applications addObject:@{ @"bundle": app.bundleIdentifier != nil ? app.bundleIdentifier : NSNull.null,
      @"pid": @(app.processIdentifier), @"terminated": @(app.terminated),
      @"launchTime": launch != nil ? @(launch.timeIntervalSince1970) : NSNull.null }];
  }
  return approval_api_select_application(applications, selected);
}

static const char *approval_api_read_live_context(ApprovalApiContext *result, bool *frontmost) {
  // Reuse the existing logged-in console/UID checks and explicit lock-flag
  // rejection. An absent undocumented lock flag is not proof of unlocked state.
  uint32_t user = 0, console = 0;
  const char *error = approval_read_live_session(&user, &console);
  if (error != NULL) return error;
  ApprovalApiContext first = {0}, final = {0};
  error = approval_api_live_application(&first);
  if (error != NULL) return error;
  first.session_user = user;
  first.session_console = console;
  error = approval_api_live_application(&final);
  if (error != NULL) return error;
  error = approval_read_live_session(&final.session_user, &final.session_console);
  if (error != NULL) return error;
  if (!approval_api_context_stable(first, final)) return "context-changed";
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  *frontmost = front.processIdentifier == final.pid && [front.bundleIdentifier isEqualToString:@"com.openai.codex"];
  *result = final;
  return NULL;
}

static NSDictionary *approval_api_context_payload(ApprovalApiContext context, bool frontmost) {
  NSString *token = approval_api_context_token(context);
  if (token == nil) return @{ @"ok": @NO, @"error": @"context-unavailable" };
  return @{ @"ok": @YES, @"pid": @(context.pid), @"token": token, @"frontmost": @(frontmost) };
}

static int approval_api_print_error(const char *error, int code) {
  printf("{\"ok\":false,\"error\":\"%s\"}\n", error);
  return code;
}

static int print_codex_approval_api_context(void) {
  ApprovalApiContext context = {0};
  bool frontmost = false;
  const char *error = approval_api_read_live_context(&context, &frontmost);
  if (error != NULL) return approval_api_print_error(error, 1);
  NSData *data = [NSJSONSerialization dataWithJSONObject:approval_api_context_payload(context, frontmost) options:0 error:NULL];
  if (data == nil) return approval_api_print_error("context-unavailable", 1);
  puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
}

static int approval_api_context_selftest(void) {
  // Pure process/launch/session/identity fixtures. No app reads or input.
  unsigned checks = 0, failures = 0;
#define API_CHECK(condition) do { checks += 1; if (!(condition)) { failures += 1; fprintf(stderr, "approval-api-context-selftest line %d failed\n", __LINE__); } } while (0)
  NSDictionary *app = @{ @"pid": @123, @"bundle": @"com.openai.codex", @"terminated": @NO, @"launchTime": @1700000000.25 };
  ApprovalApiContext context = {0};
  API_CHECK(approval_api_select_application(@[app], &context) == NULL && context.pid == 123
    && context.launch_seconds == 1700000000.25 && context.launch_microseconds == UINT64_C(1700000000250000));
  API_CHECK(approval_error_is(approval_api_select_application(@[], &context), "codex-unavailable"));
  API_CHECK(approval_error_is(approval_api_select_application(nil, &context), "codex-unavailable"));
  API_CHECK(approval_error_is(approval_api_select_application(@[app, app], &context), "multiple-instances"));
  for (id invalid in @[@1, @{}, @{ @"pid": @123, @"bundle": @"com.example.other", @"terminated": @NO },
      @{ @"pid": @123, @"bundle": @"com.openai.codex", @"terminated": @0 }]) {
    API_CHECK(approval_error_is(approval_api_select_application(@[invalid], &context), "codex-unavailable"));
  }
  for (id invalid in @[@0, @1, @(-1), @YES, @"123", @2147483648, @123.5]) {
    NSMutableDictionary *bad = [app mutableCopy]; bad[@"pid"] = invalid;
    API_CHECK(approval_error_is(approval_api_select_application(@[bad], &context), "codex-unavailable"));
  }
  for (id invalid in @[NSNull.null, @0, @(-1), @YES, @"1700000000.25", @(NAN), @(INFINITY), @(DBL_MAX), @0.0000001]) {
    NSMutableDictionary *bad = [app mutableCopy]; bad[@"launchTime"] = invalid;
    API_CHECK(approval_error_is(approval_api_select_application(@[bad], &context), "launch-unavailable"));
  }
  NSMutableDictionary *missing = [app mutableCopy]; [missing removeObjectForKey:@"launchTime"];
  API_CHECK(approval_error_is(approval_api_select_application(@[missing], &context), "launch-unavailable"));
  NSMutableDictionary *terminated = [app mutableCopy]; terminated[@"terminated"] = @YES;
  [terminated removeObjectForKey:@"launchTime"];
  API_CHECK(approval_api_select_application(@[app, terminated], &context) == NULL);
  API_CHECK(approval_error_is(approval_api_select_application(@[terminated], &context), "codex-unavailable"));
  NSDictionary *session = @{ (__bridge NSString *)kCGSessionOnConsoleKey: @YES,
    (__bridge NSString *)kCGSessionLoginDoneKey: @YES, (__bridge NSString *)kCGSessionUserIDKey: @501,
    (__bridge NSString *)kCGSessionConsoleSetKey: @1, @"CGSSessionScreenIsLocked": @NO };
  uint32_t user = 0, console = 0;
  API_CHECK(approval_session_from_dictionary(session, 501, &user, &console) == NULL && user == 501 && console == 1);
  API_CHECK(approval_error_is(approval_session_from_dictionary(session, 502, &user, &console), "session-inactive"));
  for (NSString *key in @[(__bridge NSString *)kCGSessionOnConsoleKey, (__bridge NSString *)kCGSessionLoginDoneKey]) {
    NSMutableDictionary *inactive = [session mutableCopy]; inactive[key] = @NO;
    API_CHECK(approval_error_is(approval_session_from_dictionary(inactive, 501, &user, &console), "session-inactive"));
  }
  NSMutableDictionary *locked = [session mutableCopy]; locked[@"CGSSessionScreenIsLocked"] = @YES;
  API_CHECK(approval_error_is(approval_session_from_dictionary(locked, 501, &user, &console), "session-locked"));
  locked[@"CGSSessionScreenIsLocked"] = @"false";
  API_CHECK(approval_error_is(approval_session_from_dictionary(locked, 501, &user, &console), "session-unavailable"));
  API_CHECK(approval_error_is(approval_session_from_dictionary(nil, 501, &user, &console), "session-unavailable"));
  NSMutableDictionary *optional = [session mutableCopy];
  [optional removeObjectForKey:@"CGSSessionScreenIsLocked"];
  [optional removeObjectForKey:(__bridge NSString *)kCGSessionConsoleSetKey];
  API_CHECK(approval_session_from_dictionary(optional, 501, &user, &console) == NULL && console == 0);
  context.session_user = 501; context.session_console = 1;
  API_CHECK(approval_api_context_stable(context, context));
  for (unsigned field = 0; field < 5; field++) {
    ApprovalApiContext changed = context;
    if (field == 0) changed.pid += 1;
    if (field == 1) changed.launch_seconds += 0.0000002;
    if (field == 2) changed.launch_microseconds += 1;
    if (field == 3) changed.session_user += 1;
    if (field == 4) changed.session_console += 1;
    API_CHECK(!approval_api_context_stable(context, changed));
  }
  NSDictionary *background = approval_api_context_payload(context, false);
  API_CHECK([background[@"ok"] isEqual:@YES] && [background[@"frontmost"] isEqual:@NO]
    && [background[@"token"] isEqual:@"api1:123:1700000000250000:501:1"]);
  API_CHECK([approval_api_context_payload(context, true)[@"frontmost"] isEqual:@YES]);
  API_CHECK(background.count == 4 && background[@"windowCount"] == nil);
  API_CHECK([approval_api_context_payload((ApprovalApiContext){0}, false)[@"ok"] isEqual:@NO]);
  for (unsigned field = 0; field < 4; field++) {
    ApprovalApiContext changed = context;
    if (field == 0) changed.pid += 1;
    if (field == 1) changed.launch_microseconds += 1;
    if (field == 2) changed.session_user += 1;
    if (field == 3) changed.session_console += 1;
    API_CHECK(![approval_api_context_token(context) isEqualToString:approval_api_context_token(changed)]);
  }
#undef API_CHECK
  printf("{\"checks\":%u,\"failures\":%u,\"live_io\":false}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
