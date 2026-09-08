#include <CommonCrypto/CommonDigest.h>

// The review acknowledgment is owned by the user. This helper only presses
// the existing enabled button after two complete, matching read-only scans.
static NSString *const REVIEW_TITLE = @"Chat paused as a precaution";
static NSString *const REVIEW_HEADING = @"What we detected";
static NSString *const REVIEW_ACK =
  @"I confirm I have carefully reviewed and believe it is safe to continue";
static NSString *const REVIEW_CONTINUE = @"Continue chat";

typedef struct {
  NSString *__strong state;
  NSString *__strong token;
  id __strong target;
  id __strong checkbox;
  id __strong dialog;
} ReviewCapture;

typedef struct {
  const char *(*read_context)(ApprovalShortcutContext *, void *);
  ReviewCapture (*read_review)(pid_t, void *);
  bool (*same_element)(id, id, void *);
  const char *(*validate_controls)(ReviewCapture, void *);
  AXError (*press)(id, void *);
  void *context;
} ReviewContinueOperations;

static bool review_has_label(NSDictionary *node, NSString *label) {
  for (NSString *key in @[@"title", @"description", @"value", @"help"]) {
    if ([node[key] isKindOfClass:NSString.class] && [node[key] isEqualToString:label]) return true;
  }
  return false;
}

static bool review_node_is_dialog(NSDictionary *node) {
  return [node[@"role"] isEqualToString:@"AXDialog"]
    || [node[@"role"] isEqualToString:@"AXSheet"]
    || [node[@"subrole"] isEqualToString:@"AXDialog"]
    || ([node[@"role"] isEqualToString:@"AXGroup"]
      && [node[@"subrole"] isEqualToString:@"AXApplicationDialog"]);
}

static bool review_node_is_modal(NSDictionary *node) {
  return review_node_is_dialog(node)
    || [node[@"role"] isEqualToString:@"AXAlert"]
    || [node[@"role"] isEqualToString:@"AXAlertDialog"]
    || [node[@"subrole"] isEqualToString:@"AXAlertDialog"]
    || [node[@"subrole"] isEqualToString:@"AXApplicationDialog"]
    || [node[@"subrole"] isEqualToString:@"AXApplicationAlertDialog"];
}

static void review_collect_nodes(NSDictionary *node, NSMutableArray *nodes) {
  if ([node[@"hidden"] boolValue]) return;
  [nodes addObject:node];
  for (NSDictionary *child in node[@"children"]) review_collect_nodes(child, nodes);
}

static NSString *review_fingerprint(NSDictionary *tree) {
  // The digest includes accessible identity, control states and findings text,
  // but neither text nor element handles ever leave the helper process.
  NSMutableArray *nodes = [NSMutableArray array];
  review_collect_nodes(tree, nodes);
  NSMutableArray *fields = [NSMutableArray arrayWithCapacity:nodes.count];
  NSArray *keys = @[@"identity", @"path", @"role", @"subrole", @"title",
    @"description", @"help", @"value", @"identifier", @"enabled", @"hidden", @"pressable"];
  for (NSDictionary *node in nodes) {
    NSMutableArray *row = [NSMutableArray arrayWithCapacity:keys.count];
    for (NSString *key in keys) [row addObject:node[key] != nil ? node[key] : NSNull.null];
    [fields addObject:row];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:0 error:NULL];
  if (data == nil || data.length > UINT_MAX) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *token = [NSMutableString stringWithString:@"r1:"];
  for (unsigned i = 0; i < sizeof(digest); i++) [token appendFormat:@"%02x", digest[i]];
  return token;
}

static ReviewCapture review_classify_tree(NSDictionary *tree, bool complete) {
  ReviewCapture unavailable = { .state = @"unavailable" };
  if (!complete || tree == nil) return unavailable;
  NSMutableArray *nodes = [NSMutableArray array];
  review_collect_nodes(tree, nodes);
  NSMutableArray *dialogs = [NSMutableArray array];
  bool safety_marker = false;
  unsigned modal_count = 0;
  for (NSDictionary *node in nodes) {
    if (review_has_label(node, REVIEW_TITLE) || review_has_label(node, REVIEW_ACK)) safety_marker = true;
    if (review_node_is_modal(node)) modal_count += 1;
    if (review_node_is_dialog(node) && review_has_label(node, REVIEW_TITLE)) [dialogs addObject:node];
  }
  if (dialogs.count == 0) return safety_marker ? unavailable : (ReviewCapture){ 0 };
  // An unrelated sibling modal can own input while the review remains in the
  // AX tree. Require one modal across the entire visible window, not only
  // within the review subtree.
  if (dialogs.count != 1 || modal_count != 1) return unavailable;
  NSDictionary *dialog = dialogs.firstObject;
  NSMutableArray *inside = [NSMutableArray array];
  review_collect_nodes(dialog, inside);
  NSMutableArray *checkboxes = [NSMutableArray array], *buttons = [NSMutableArray array];
  bool findings_heading = false;
  unsigned nested_dialogs = 0;
  for (NSDictionary *node in inside) {
    if (review_node_is_dialog(node)) nested_dialogs += 1;
    if (review_has_label(node, REVIEW_HEADING)) findings_heading = true;
    if ([node[@"role"] isEqualToString:@"AXCheckBox"] && review_has_label(node, REVIEW_ACK)) {
      [checkboxes addObject:node];
    }
    if ([node[@"role"] isEqualToString:@"AXButton"] && review_has_label(node, REVIEW_CONTINUE)) {
      [buttons addObject:node];
    }
  }
  if (!findings_heading || nested_dialogs != 1 || checkboxes.count != 1 || buttons.count != 1) return unavailable;
  NSDictionary *checkbox = checkboxes.firstObject, *button = buttons.firstObject;
  id checked = checkbox[@"value"];
  if (![checked isKindOfClass:NSNumber.class] || ![checkbox[@"enabled"] isEqual:@YES]) return unavailable;
  bool is_checked = [checked isEqual:@1];
  if (!is_checked && ![checked isEqual:@0]) return unavailable;
  NSString *token = review_fingerprint(dialog);
  if (token == nil) return unavailable;
  if (!is_checked) return (ReviewCapture){ .state = @"unchecked", .token = token };
  if (![button[@"enabled"] isEqual:@YES] || ![button[@"pressable"] isEqual:@YES]) return unavailable;
  return (ReviewCapture){ .state = @"ready", .token = token,
    .target = button[@"element"], .checkbox = checkbox[@"element"], .dialog = dialog[@"element"] };
}

typedef struct {
  unsigned visited;
  size_t text_bytes;
  CFTimeInterval deadline;
  bool complete;
  const char *limit_reason;
  unsigned roles[13];
  unsigned subroles[6];
} ReviewScanBudget;

static NSArray *review_diagnostic_roles(void) {
  return @[@"AXWindow", @"AXGroup", @"AXDialog", @"AXSheet", @"AXAlert", @"AXAlertDialog",
    @"AXHeading", @"AXStaticText", @"AXCheckBox", @"AXButton", @"AXWebArea", @"missing", @"other"];
}

static NSArray *review_diagnostic_subroles(void) {
  return @[@"AXDialog", @"AXApplicationDialog", @"AXAlertDialog", @"AXApplicationAlertDialog", @"missing", @"other"];
}

static void review_count_diagnostic_value(id value, NSArray *names, unsigned *counts) {
  NSUInteger index = [value isKindOfClass:NSString.class] ? [names indexOfObject:value] : names.count - 2;
  if (index == NSNotFound) index = names.count - 1;
  counts[index] += 1;
}

static void review_scan_stop(ReviewScanBudget *budget, const char *reason) {
  budget->complete = false;
  if (budget->limit_reason == NULL) budget->limit_reason = reason;
}

static bool review_scan_begin_node(ReviewScanBudget *budget, unsigned depth, CFTimeInterval now) {
  if (!budget->complete) return false;
  if (depth > 48) { review_scan_stop(budget, "depth-limit"); return false; }
  // A real permission card can appear after more than 900 earlier chat nodes.
  // The existing deadline and text/depth limits still bound this larger count.
  if (budget->visited >= 4096) { review_scan_stop(budget, "node-limit"); return false; }
  if (now > budget->deadline) { review_scan_stop(budget, "deadline"); return false; }
  budget->visited += 1;
  return true;
}

static NSDictionary *review_scan_summary(ReviewScanBudget budget) {
  return @{ @"visited": @(budget.visited), @"complete": @(budget.complete),
    @"limitReason": budget.limit_reason != NULL ? [NSString stringWithUTF8String:budget.limit_reason] : NSNull.null };
}

static NSString *review_url_string(id value) {
  if ([value isKindOfClass:NSString.class]) return value;
  if (value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFURLGetTypeID()) {
    return [(NSURL *)value absoluteString];
  }
  return nil;
}

static NSDictionary *review_scan_diagnostics(ReviewScanBudget budget) {
  NSMutableDictionary *roles = [NSMutableDictionary dictionary], *subroles = [NSMutableDictionary dictionary];
  NSArray *role_names = review_diagnostic_roles(), *subrole_names = review_diagnostic_subroles();
  for (NSUInteger i = 0; i < role_names.count; i++) roles[role_names[i]] = @(budget.roles[i]);
  for (NSUInteger i = 0; i < subrole_names.count; i++) subroles[subrole_names[i]] = @(budget.subroles[i]);
  return @{ @"visited": @(budget.visited), @"complete": @(budget.complete),
    @"limitReason": budget.limit_reason != NULL ? [NSString stringWithUTF8String:budget.limit_reason] : NSNull.null,
    @"roles": roles, @"subroles": subroles };
}

static NSDictionary *review_copy_live_tree(AXUIElementRef element, NSString *path,
  unsigned depth, ReviewScanBudget *budget) {
  if (!review_scan_begin_node(budget, depth, CFAbsoluteTimeGetCurrent())) return nil;
  AXUIElementSetMessagingTimeout(element, 0.1);
  NSArray *attributes = @[(__bridge NSString *)kAXRoleAttribute,
    (__bridge NSString *)kAXSubroleAttribute, (__bridge NSString *)kAXTitleAttribute,
    (__bridge NSString *)kAXDescriptionAttribute, (__bridge NSString *)kAXHelpAttribute,
    (__bridge NSString *)kAXValueAttribute, (__bridge NSString *)kAXIdentifierAttribute,
    (__bridge NSString *)kAXEnabledAttribute, (__bridge NSString *)kAXHiddenAttribute,
    (__bridge NSString *)kAXURLAttribute,
    (__bridge NSString *)kAXChildrenAttribute];
  NSArray *keys = @[@"role", @"subrole", @"title", @"description", @"help", @"value",
    @"identifier", @"enabled", @"hidden", @"url", @"children"];
  CFArrayRef raw = NULL;
  AXError error = AXUIElementCopyMultipleAttributeValues(element, (__bridge CFArrayRef)attributes,
    0, &raw);
  if (error != kAXErrorSuccess || raw == NULL || CFArrayGetCount(raw) != (CFIndex)keys.count) {
    if (raw != NULL) CFRelease(raw);
    review_scan_stop(budget, "accessibility-read");
    return nil;
  }
  NSArray *values = CFBridgingRelease(raw);
  review_count_diagnostic_value(values[0], review_diagnostic_roles(), budget->roles);
  review_count_diagnostic_value(values[1], review_diagnostic_subroles(), budget->subroles);
  NSMutableDictionary *node = [NSMutableDictionary dictionaryWithDictionary:@{
    @"identity": @((uint64_t)CFHash(element)), @"path": path, @"element": (__bridge id)element
  }];
  for (NSUInteger i = 0; i + 1 < keys.count; i++) {
    id value = values[i];
    if ([keys[i] isEqualToString:@"url"]) value = review_url_string(value);
    if ([value isKindOfClass:NSString.class]) {
      budget->text_bytes += [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
      if (budget->text_bytes > 512 * 1024) { review_scan_stop(budget, "text-limit"); return nil; }
      node[keys[i]] = value;
    } else if ([value isKindOfClass:NSNumber.class]) node[keys[i]] = value;
  }
  if ([node[@"hidden"] boolValue]) { node[@"children"] = @[]; return node; }
  if (node[@"role"] == nil) { review_scan_stop(budget, "missing-role"); return nil; }
  bool approval_button_name = false;
  for (NSString *key in @[@"title", @"description", @"value"]) {
    id name = node[key];
    if ([name isKindOfClass:NSString.class] && ([name hasPrefix:@"Allow once"]
        || [name hasPrefix:@"Deny"])) approval_button_name = true;
  }
  if ([node[@"role"] isEqualToString:@"AXButton"]
      && (review_has_label(node, REVIEW_CONTINUE) || approval_button_name)) {
    CFArrayRef actions = NULL;
    bool pressable = AXUIElementCopyActionNames(element, &actions) == kAXErrorSuccess
      && actions != NULL && [(__bridge NSArray *)actions containsObject:(__bridge NSString *)kAXPressAction];
    if (actions != NULL) CFRelease(actions);
    node[@"pressable"] = @(pressable);
    if (approval_button_name) {
      Boolean focusable = false;
      bool focus_read = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute, &focusable) == kAXErrorSuccess;
      node[@"focusable"] = @(focus_read && focusable);
    }
  }
  NSMutableArray *children = [NSMutableArray array];
  id child_values = values.lastObject;
  if ([child_values isKindOfClass:NSArray.class]) {
    for (NSUInteger i = 0; i < [child_values count]; i++) {
      id child = child_values[i];
      if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) {
        review_scan_stop(budget, "invalid-children"); break;
      }
      NSDictionary *copied = review_copy_live_tree((__bridge AXUIElementRef)child,
        [path stringByAppendingFormat:@"/%lu", (unsigned long)i], depth + 1, budget);
      if (copied != nil) [children addObject:copied];
      if (!budget->complete) break;
    }
  } else if (CFGetTypeID((__bridge CFTypeRef)child_values) == AXValueGetTypeID()) {
    AXError child_error = kAXErrorFailure;
    bool missing_children = AXValueGetType((__bridge AXValueRef)child_values) == kAXValueAXErrorType
      && AXValueGetValue((__bridge AXValueRef)child_values, kAXValueAXErrorType, &child_error)
      && (child_error == kAXErrorAttributeUnsupported || child_error == kAXErrorNoValue);
    if (!missing_children) review_scan_stop(budget, "children-read");
  } else if (child_values != NSNull.null) review_scan_stop(budget, "invalid-children");
  node[@"children"] = children;
  return node;
}

static NSDictionary *review_read_live_snapshot(pid_t pid, ReviewScanBudget *budget) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (application == NULL) { review_scan_stop(budget, "application-unavailable"); return nil; }
  AXUIElementSetMessagingTimeout(application, 0.2);
  CFTypeRef window = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window);
  CFRelease(application);
  if (error != kAXErrorSuccess || window == NULL || CFGetTypeID(window) != AXUIElementGetTypeID()) {
    if (window != NULL) CFRelease(window);
    review_scan_stop(budget, "window-unavailable"); return nil;
  }
  budget->deadline = CFAbsoluteTimeGetCurrent() + 0.6;
  NSDictionary *tree = review_copy_live_tree((AXUIElementRef)window, @"0", 0, budget);
  CFRelease(window);
  if (CFAbsoluteTimeGetCurrent() > budget->deadline) review_scan_stop(budget, "deadline");
  return tree;
}

static ReviewCapture review_read_live(pid_t pid, void *unused) {
  (void)unused;
  ReviewScanBudget budget = { .complete = true };
  NSDictionary *tree = review_read_live_snapshot(pid, &budget);
  return review_classify_tree(tree, budget.complete);
}

static int print_codex_review_diagnostics(void) {
  ApprovalShortcutContext context = { 0 };
  const char *error = approval_read_live_context(&context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  ReviewScanBudget budget = { .complete = true };
  (void)review_read_live_snapshot(context.pid, &budget);
  ApprovalShortcutContext final_context = { 0 };
  error = approval_read_live_context(&final_context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  if (!approval_context_matches(final_context, context.pid, approval_context_token(context))) {
    return approval_print_error("context-changed", 1);
  }
  // Deliberately serialize this fixed aggregate allowlist only. Neither the
  // snapshot nor any identity, path, label, value or findings text is emitted.
  NSData *data = [NSJSONSerialization dataWithJSONObject:review_scan_diagnostics(budget) options:0 error:NULL];
  if (data == nil) return approval_print_error("diagnostics-unavailable", 1);
  printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
}

static bool review_same_live_element(id first, id second, void *unused) {
  (void)unused;
  return first != nil && second != nil && CFEqual((__bridge CFTypeRef)first, (__bridge CFTypeRef)second);
}

static AXError review_press_live(id target, void *unused) {
  (void)unused;
  return AXUIElementPerformAction((__bridge AXUIElementRef)target, kAXPressAction);
}

static NSDictionary *review_read_live_control(id target) {
  if (target == nil) return nil;
  AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)target, 0.1);
  NSArray *attributes = @[(__bridge NSString *)kAXRoleAttribute,
    (__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute,
    (__bridge NSString *)kAXHelpAttribute, (__bridge NSString *)kAXValueAttribute,
    (__bridge NSString *)kAXEnabledAttribute, (__bridge NSString *)kAXHiddenAttribute];
  NSArray *keys = @[@"role", @"title", @"description", @"help", @"value", @"enabled", @"hidden"];
  CFArrayRef raw = NULL;
  if (target == nil || AXUIElementCopyMultipleAttributeValues((__bridge AXUIElementRef)target,
      (__bridge CFArrayRef)attributes, 0, &raw) != kAXErrorSuccess || raw == NULL) {
    if (raw != NULL) CFRelease(raw);
    return nil;
  }
  NSArray *values = CFBridgingRelease(raw);
  if (values.count != keys.count) return nil;
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  for (NSUInteger i = 0; i < keys.count; i++) {
    if ([values[i] isKindOfClass:NSString.class] || [values[i] isKindOfClass:NSNumber.class]) {
      node[keys[i]] = values[i];
    }
  }
  return node;
}

static const char *review_validate_live_controls(ReviewCapture review, void *unused) {
  (void)unused;
  NSDictionary *checkbox = review_read_live_control(review.checkbox);
  NSDictionary *button = review_read_live_control(review.target);
  if (![checkbox[@"role"] isEqualToString:@"AXCheckBox"] || !review_has_label(checkbox, REVIEW_ACK)
      || ![checkbox[@"enabled"] isEqual:@YES] || ![button[@"role"] isEqualToString:@"AXButton"]
      || !review_has_label(button, REVIEW_CONTINUE)) return "review-changed";
  if (![checkbox[@"value"] isEqual:@1]) return "review-unchecked";
  if (![button[@"enabled"] isEqual:@YES]) return "review-unavailable";
  return NULL;
}

static const char *review_dispatch_continue(pid_t pid, NSString *window_token, NSString *review_token,
  ReviewContinueOperations ops, bool *attempted) {
  *attempted = false;
  ReviewCapture previous = { 0 };
  for (unsigned i = 0; i < 2; i++) {
    ApprovalShortcutContext current = { 0 };
    const char *error = ops.read_context(&current, ops.context);
    if (error != NULL) return error;
    if (!approval_context_matches(current, pid, window_token)) return "context-changed";
    ReviewCapture review = ops.read_review(pid, ops.context);
    if ([review.state isEqualToString:@"unchecked"]) return "review-unchecked";
    if (![review.state isEqualToString:@"ready"] || review.target == nil
        || review.checkbox == nil || review.dialog == nil) return "review-unavailable";
    if (![review.token isEqualToString:review_token]) return "review-changed";
    if (i > 0 && (!ops.same_element(previous.target, review.target, ops.context)
        || !ops.same_element(previous.checkbox, review.checkbox, ops.context)
        || !ops.same_element(previous.dialog, review.dialog, ops.context))) return "review-changed";
    previous = review;
  }
  // One final foreground/session check after the potentially slower AX scan.
  ApprovalShortcutContext current = { 0 };
  const char *error = ops.read_context(&current, ops.context);
  if (error != NULL) return error;
  if (!approval_context_matches(current, pid, window_token)) return "context-changed";
  // Re-read only the two held controls after the final window check. Never
  // mutate the checkbox, even if it was checked in either earlier snapshot.
  error = ops.validate_controls(previous, ops.context);
  if (error != NULL) return error;
  *attempted = true;
  return ops.press(previous.target, ops.context) == kAXErrorSuccess ? NULL : "delivery-unknown";
}

static NSDictionary *review_context_metadata(ReviewCapture review) {
  if (review.state == nil) return nil;
  return @{ @"state": review.state, @"token": review.token != nil ? review.token : NSNull.null };
}

static int codex_review_continue(int argc, char **argv) {
  if (argc != 5 || strlen(argv[3]) > 64 || strlen(argv[4]) != 67
      || strncmp(argv[4], "r1:", 3) != 0) return approval_print_error("invalid-arguments", 64);
  for (unsigned i = 3; i < 67; i++) {
    if (!isxdigit((unsigned char)argv[4][i])) return approval_print_error("invalid-arguments", 64);
  }
  char *end = NULL;
  errno = 0;
  long pid = strtol(argv[2], &end, 10);
  if (errno != 0 || end == argv[2] || *end != '\0' || pid <= 1 || pid > INT_MAX) {
    return approval_print_error("invalid-arguments", 64);
  }
  bool attempted = false;
  const char *error = review_dispatch_continue((pid_t)pid, [NSString stringWithUTF8String:argv[3]],
    [NSString stringWithUTF8String:argv[4]], (ReviewContinueOperations){
      .read_context = approval_read_live_context, .read_review = review_read_live,
      .same_element = review_same_live_element, .validate_controls = review_validate_live_controls,
      .press = review_press_live
    }, &attempted);
  if (error != NULL) {
    if (attempted) printf("{\"sent\":null,\"error\":\"delivery-unknown\"}\n");
    else return approval_print_error(error, 1);
    return 1;
  }
  // AXPress success acknowledges action dispatch, not completion of the chat.
  printf("{\"sent\":true}\n");
  return 0;
}

static NSMutableDictionary *review_selftest_dialog(void) {
  // Chromium maps an ARIA dialog to AXGroup / AXApplicationDialog on macOS.
  return [@{ @"role": @"AXGroup", @"subrole": @"AXApplicationDialog", @"title": REVIEW_TITLE,
    @"identity": @10, @"element": @"dialog-10", @"path": @"0/0", @"children": @[
      @{ @"role": @"AXHeading", @"title": REVIEW_HEADING, @"identity": @11 },
      @{ @"role": @"AXStaticText", @"value": @"Fixture findings A", @"identity": @12 },
      @{ @"role": @"AXCheckBox", @"title": REVIEW_ACK, @"value": @1, @"enabled": @YES,
         @"identity": @13, @"element": @"checkbox-13" },
      @{ @"role": @"AXButton", @"title": REVIEW_CONTINUE, @"enabled": @YES, @"pressable": @YES,
         @"identity": @14, @"element": @"button-14" }
    ] } mutableCopy];
}

static void review_selftest_set_child(NSMutableDictionary *dialog, NSUInteger index,
  NSString *key, id value) {
  NSMutableArray *children = [dialog[@"children"] mutableCopy];
  NSMutableDictionary *child = [children[index] mutableCopy];
  if (value == nil) [child removeObjectForKey:key]; else child[key] = value;
  children[index] = child;
  dialog[@"children"] = children;
}

typedef struct {
  ApprovalShortcutContext contexts[3];
  const char *context_errors[3];
  ReviewCapture reviews[2];
  unsigned context_reads, review_reads, presses;
  AXError press_result;
  const char *final_control_error;
} ReviewContinueSelftestState;

static const char *review_selftest_context(ApprovalShortcutContext *context, void *opaque) {
  ReviewContinueSelftestState *state = opaque;
  unsigned index = state->context_reads++;
  if (index > 2) return "unexpected-read";
  *context = state->contexts[index];
  return state->context_errors[index];
}

static ReviewCapture review_selftest_read(pid_t pid, void *opaque) {
  (void)pid;
  ReviewContinueSelftestState *state = opaque;
  unsigned index = state->review_reads++;
  return index < 2 ? state->reviews[index] : (ReviewCapture){ .state = @"unavailable" };
}

static AXError review_selftest_press(id target, void *opaque) {
  ReviewContinueSelftestState *state = opaque;
  state->presses += 1;
  return target != nil ? state->press_result : kAXErrorIllegalArgument;
}

static const char *review_selftest_validate_controls(ReviewCapture review, void *opaque) {
  (void)review;
  ReviewContinueSelftestState *state = opaque;
  return state->final_control_error;
}

static const char *review_run_selftest_dispatch(ReviewContinueSelftestState *state,
  NSString *token, bool *attempted) {
  return review_dispatch_continue(123, @"v2:123:45:501:1", token, (ReviewContinueOperations){
    .read_context = review_selftest_context, .read_review = review_selftest_read,
    .same_element = review_same_live_element, .validate_controls = review_selftest_validate_controls,
    .press = review_selftest_press, .context = state
  }, attempted);
}

static ReviewContinueSelftestState review_selftest_state(ReviewCapture capture) {
  return (ReviewContinueSelftestState){
    .contexts = {{123, 45, 501, 1}, {123, 45, 501, 1}, {123, 45, 501, 1}},
    .reviews = {capture, capture}, .press_result = kAXErrorSuccess
  };
}

static int review_continue_selftest(void) {
  // No host reads, AX traversal, input posting, or UI actions in these tests.
  unsigned checks = 0, failures = 0;
#define REVIEW_CHECK(condition) do { checks += 1; if (!(condition)) failures += 1; } while (0)
  ReviewScanBudget boundary = { .visited = 4095, .deadline = 10, .complete = true };
  REVIEW_CHECK(review_scan_begin_node(&boundary, 48, 10) && boundary.visited == 4096 && boundary.complete);
  REVIEW_CHECK(!review_scan_begin_node(&boundary, 48, 10) && boundary.visited == 4096
    && !boundary.complete && strcmp(boundary.limit_reason, "node-limit") == 0);
  REVIEW_CHECK(!review_scan_begin_node(&boundary, 0, 0) && boundary.visited == 4096);
  boundary = (ReviewScanBudget){ .visited = 900, .deadline = 10, .complete = true };
  REVIEW_CHECK(review_scan_begin_node(&boundary, 0, 9) && boundary.visited == 901 && boundary.complete);
  boundary = (ReviewScanBudget){ .deadline = 10, .complete = true };
  REVIEW_CHECK(!review_scan_begin_node(&boundary, 49, 9) && boundary.visited == 0
    && strcmp(boundary.limit_reason, "depth-limit") == 0);
  boundary = (ReviewScanBudget){ .deadline = 10, .complete = true };
  REVIEW_CHECK(!review_scan_begin_node(&boundary, 48, 10.01) && boundary.visited == 0
    && strcmp(boundary.limit_reason, "deadline") == 0);
  NSDictionary *summary = review_scan_summary(boundary);
  REVIEW_CHECK(summary.count == 3 && [summary[@"visited"] isEqual:@0]
    && [summary[@"complete"] isEqual:@NO] && [summary[@"limitReason"] isEqualToString:@"deadline"]);
  ReviewScanBudget diagnostic_budget = { .visited = 4, .complete = true };
  review_count_diagnostic_value(@"AXGroup", review_diagnostic_roles(), diagnostic_budget.roles);
  review_count_diagnostic_value(@"Fixture private unknown role", review_diagnostic_roles(), diagnostic_budget.roles);
  review_count_diagnostic_value(nil, review_diagnostic_roles(), diagnostic_budget.roles);
  review_count_diagnostic_value(@"AXCheckBox", review_diagnostic_roles(), diagnostic_budget.roles);
  review_count_diagnostic_value(@"AXApplicationDialog", review_diagnostic_subroles(), diagnostic_budget.subroles);
  review_count_diagnostic_value(@"Fixture private unknown subrole", review_diagnostic_subroles(), diagnostic_budget.subroles);
  review_count_diagnostic_value(nil, review_diagnostic_subroles(), diagnostic_budget.subroles);
  NSDictionary *diagnostic = review_scan_diagnostics(diagnostic_budget);
  NSSet *diagnostic_keys = [NSSet setWithArray:@[@"visited", @"complete", @"limitReason", @"roles", @"subroles"]];
  REVIEW_CHECK([NSSet setWithArray:diagnostic.allKeys].count == 5
    && [[NSSet setWithArray:diagnostic.allKeys] isEqualToSet:diagnostic_keys]);
  REVIEW_CHECK([diagnostic[@"visited"] isEqual:@4] && [diagnostic[@"complete"] isEqual:@YES]
    && diagnostic[@"limitReason"] == NSNull.null);
  REVIEW_CHECK([diagnostic[@"roles"] count] == 13 && [diagnostic[@"subroles"] count] == 6);
  REVIEW_CHECK([diagnostic[@"roles"][@"AXGroup"] isEqual:@1]
    && [diagnostic[@"roles"][@"AXCheckBox"] isEqual:@1]
    && [diagnostic[@"roles"][@"other"] isEqual:@1] && [diagnostic[@"roles"][@"missing"] isEqual:@1]);
  REVIEW_CHECK([diagnostic[@"subroles"][@"AXApplicationDialog"] isEqual:@1]
    && [diagnostic[@"subroles"][@"other"] isEqual:@1]
    && [diagnostic[@"subroles"][@"missing"] isEqual:@1]);
  NSData *diagnostic_data = [NSJSONSerialization dataWithJSONObject:diagnostic options:0 error:NULL];
  NSString *diagnostic_text = [[NSString alloc] initWithData:diagnostic_data encoding:NSUTF8StringEncoding];
  REVIEW_CHECK([diagnostic_text rangeOfString:@"Fixture private"].location == NSNotFound);
  review_scan_stop(&diagnostic_budget, "node-limit");
  review_scan_stop(&diagnostic_budget, "deadline");
  diagnostic = review_scan_diagnostics(diagnostic_budget);
  REVIEW_CHECK([diagnostic[@"complete"] isEqual:@NO] && [diagnostic[@"limitReason"] isEqualToString:@"node-limit"]);
  NSMutableDictionary *dialog = review_selftest_dialog();
  ReviewCapture ready = review_classify_tree(dialog, true);
  REVIEW_CHECK([ready.state isEqualToString:@"ready"] && ready.token.length == 67
    && ready.target != nil && ready.checkbox != nil && ready.dialog != nil);
  REVIEW_CHECK([review_classify_tree(dialog, true).token isEqualToString:ready.token]);
  REVIEW_CHECK(review_classify_tree(@{ @"role": @"AXWindow", @"children": @[] }, true).state == nil);
  REVIEW_CHECK([review_classify_tree(dialog, false).state isEqualToString:@"unavailable"]);
  REVIEW_CHECK([review_classify_tree(nil, true).state isEqualToString:@"unavailable"]);
  REVIEW_CHECK(review_context_metadata((ReviewCapture){0}) == nil);
  REVIEW_CHECK([review_context_metadata((ReviewCapture){ .state = @"unavailable" })[@"token"] isEqual:NSNull.null]);
  for (NSString *role in @[@"AXDialog", @"AXSheet"]) {
    dialog = review_selftest_dialog(); dialog[@"role"] = role;
    [dialog removeObjectForKey:@"subrole"];
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"ready"]);
  }
  dialog = review_selftest_dialog(); dialog[@"subrole"] = @"AXDialog";
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"ready"]);
  dialog = review_selftest_dialog(); dialog[@"role"] = @"AXButton";
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); dialog[@"subrole"] = @"AXApplicationAlertDialog";
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); review_selftest_set_child(dialog, 2, @"value", @0);
  ReviewCapture unchecked = review_classify_tree(dialog, true);
  REVIEW_CHECK([unchecked.state isEqualToString:@"unchecked"] && unchecked.target == nil);
  REVIEW_CHECK(![unchecked.token isEqualToString:ready.token]);
  for (id value in @[@2, @-1, @"1", NSNull.null]) {
    dialog = review_selftest_dialog(); review_selftest_set_child(dialog, 2, @"value", value);
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  }
  for (NSNumber *index in @[@2, @3]) {
    dialog = review_selftest_dialog(); review_selftest_set_child(dialog, index.unsignedIntegerValue, @"enabled", @NO);
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
    dialog = review_selftest_dialog(); review_selftest_set_child(dialog, index.unsignedIntegerValue, @"enabled", nil);
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  }
  dialog = review_selftest_dialog(); review_selftest_set_child(dialog, 3, @"pressable", @NO);
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); dialog[@"title"] = @"Other dialog";
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); [dialog removeObjectForKey:@"subrole"];
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  for (NSNumber *index in @[@0, @2, @3]) {
    dialog = review_selftest_dialog(); review_selftest_set_child(dialog, index.unsignedIntegerValue, @"title", @"Other label");
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  }
  for (NSNumber *index in @[@2, @3]) {
    dialog = review_selftest_dialog();
    dialog[@"children"] = [dialog[@"children"] arrayByAddingObject:dialog[@"children"][index.unsignedIntegerValue]];
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  }
  NSDictionary *multiple = @{ @"role": @"AXWindow", @"children": @[review_selftest_dialog(), review_selftest_dialog()] };
  REVIEW_CHECK([review_classify_tree(multiple, true).state isEqualToString:@"unavailable"]);
  NSArray *other_modals = @[
    @{ @"role": @"AXDialog", @"title": @"Other dialog" },
    @{ @"role": @"AXSheet", @"title": @"Other sheet" },
    @{ @"role": @"AXGroup", @"subrole": @"AXDialog", @"title": @"Other dialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXApplicationDialog", @"title": @"Other dialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXApplicationAlertDialog", @"title": @"Other alert" },
    @{ @"role": @"AXAlertDialog", @"title": @"Other alert" },
    @{ @"role": @"AXGroup", @"subrole": @"AXAlertDialog", @"title": @"Other alert" },
    @{ @"role": @"AXAlert", @"title": @"Other alert" }
  ];
  for (NSDictionary *other in other_modals) {
    NSDictionary *window = @{ @"role": @"AXWindow", @"children": @[review_selftest_dialog(), other] };
    REVIEW_CHECK([review_classify_tree(window, true).state isEqualToString:@"unavailable"]);
    dialog = review_selftest_dialog();
    dialog[@"children"] = [dialog[@"children"] arrayByAddingObject:other];
    REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
    NSMutableDictionary *hidden = [other mutableCopy]; hidden[@"hidden"] = @YES;
    window = @{ @"role": @"AXWindow", @"children": @[review_selftest_dialog(), hidden] };
    REVIEW_CHECK([review_classify_tree(window, true).state isEqualToString:@"ready"]);
  }
  dialog = review_selftest_dialog();
  dialog[@"children"] = [dialog[@"children"] arrayByAddingObject:@{ @"role": @"AXDialog", @"title": @"Other dialog" }];
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); review_selftest_set_child(dialog, 3, @"hidden", @YES);
  REVIEW_CHECK([review_classify_tree(dialog, true).state isEqualToString:@"unavailable"]);
  dialog = review_selftest_dialog(); dialog[@"hidden"] = @YES;
  REVIEW_CHECK(review_classify_tree(dialog, true).state == nil);
  dialog = review_selftest_dialog(); review_selftest_set_child(dialog, 1, @"value", @"Fixture findings B");
  ReviewCapture changed = review_classify_tree(dialog, true);
  REVIEW_CHECK([changed.state isEqualToString:@"ready"] && ![changed.token isEqualToString:ready.token]);
  dialog = review_selftest_dialog(); dialog[@"identity"] = @99;
  REVIEW_CHECK(![review_classify_tree(dialog, true).token isEqualToString:ready.token]);
  ReviewContinueSelftestState state = review_selftest_state(ready);
  bool attempted = false;
  REVIEW_CHECK(review_run_selftest_dispatch(&state, ready.token, &attempted) == NULL);
  REVIEW_CHECK(attempted && state.presses == 1 && state.context_reads == 3 && state.review_reads == 2);
  for (unsigned i = 0; i < 3; i++) {
    state = review_selftest_state(ready); state.contexts[i].window = 46;
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "context-changed"));
    REVIEW_CHECK(!attempted && state.presses == 0);
    state = review_selftest_state(ready); state.contexts[i].session_console = 2;
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "context-changed"));
    REVIEW_CHECK(!attempted && state.presses == 0);
    state = review_selftest_state(ready); state.context_errors[i] = "not-frontmost";
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "not-frontmost"));
    REVIEW_CHECK(!attempted && state.presses == 0);
  }
  for (unsigned i = 0; i < 2; i++) {
    state = review_selftest_state(ready); state.reviews[i] = unchecked;
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "review-unchecked"));
    REVIEW_CHECK(!attempted && state.presses == 0);
    state = review_selftest_state(ready); state.reviews[i] = changed;
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "review-changed"));
    REVIEW_CHECK(!attempted && state.presses == 0);
    state = review_selftest_state(ready); state.reviews[i] = (ReviewCapture){ .state = @"unavailable" };
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "review-unavailable"));
    REVIEW_CHECK(!attempted && state.presses == 0);
  }
  for (unsigned i = 0; i < 3; i++) {
    state = review_selftest_state(ready);
    if (i == 0) state.reviews[1].target = @"other-button";
    if (i == 1) state.reviews[1].checkbox = @"other-checkbox";
    if (i == 2) state.reviews[1].dialog = @"other-dialog";
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "review-changed"));
    REVIEW_CHECK(!attempted && state.presses == 0);
  }
  state = review_selftest_state(ready); state.press_result = kAXErrorCannotComplete;
  REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), "delivery-unknown"));
  REVIEW_CHECK(attempted && state.presses == 1);
  const char *final_errors[] = {"review-unchecked", "review-unavailable", "review-changed"};
  for (unsigned i = 0; i < sizeof(final_errors) / sizeof(final_errors[0]); i++) {
    const char *error = final_errors[i];
    state = review_selftest_state(ready); state.final_control_error = error;
    REVIEW_CHECK(approval_error_is(review_run_selftest_dispatch(&state, ready.token, &attempted), error));
    REVIEW_CHECK(!attempted && state.presses == 0 && state.review_reads == 2 && state.context_reads == 3);
  }
#undef REVIEW_CHECK
  printf("{\"checks\":%u,\"failures\":%u,\"live_io\":false}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
