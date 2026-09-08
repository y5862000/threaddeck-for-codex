// Ordinary approvals focus the verified permission-card button and activate it
// with one Return (Allow once) or Space (Deny) pair. There is no unfocused
// approval shortcut or AXPress fallback.
// This deliberately supports known English terminal requests and the observed
// Ask permission card; unknown cards remain available for review in Codex.
static NSString *const APPROVAL_CARD_ALLOW = @"Allow once";
static NSString *const APPROVAL_CARD_DENY = @"Deny";
static NSArray *approval_card_visible_children(NSDictionary *node);

typedef struct {
  NSString *__strong state;
  NSString *__strong token;
  NSString *__strong reason;
  id __strong card;
  id __strong header;
  id __strong allow;
  id __strong deny;
} ApprovalCardCapture;

typedef struct {
  const char *(*prepare_keys)(const char *, void *);
  const char *(*read_context)(ApprovalShortcutContext *, void *);
  ApprovalCardCapture (*read_card)(pid_t, void *);
  bool (*same_element)(id, id, void *);
  const char *(*validate_controls)(ApprovalCardCapture, void *);
  const char *(*focus_button)(id, pid_t, void *);
  const char *(*validate_focus)(id, pid_t, void *);
  const char *(*post_keys)(id, void *);
  void *context;
} ApprovalCardOperations;

static NSArray *approval_card_prompts(void) {
  return @[@"Allow ChatGPT to run this command?", @"Do you want ChatGPT to run this command?",
    @"Do you want Codex to run this command?"];
}

static bool approval_card_has_prompt(NSDictionary *node) {
  for (NSString *prompt in approval_card_prompts()) if (review_has_label(node, prompt)) return true;
  return false;
}

static NSString *approval_card_name(NSDictionary *node) {
  for (NSString *key in @[@"title", @"description", @"value"]) {
    if ([node[key] isKindOfClass:NSString.class] && [node[key] length] > 0) return node[key];
  }
  return nil;
}

static bool approval_card_name_matches(NSString *name, NSString *label) {
  if ([name isEqualToString:label]) return true;
  // Only shortcuts known from this integration are accepted as a suffix. No
  // arbitrary text, case folding, or substring matches can select a button.
  NSArray *suffixes = [label isEqualToString:APPROVAL_CARD_ALLOW]
    ? @[@"↵", @"⏎", @"Enter", @"Return", @"⌃⌥⌘F13"]
    : @[@"Esc", @"Escape", @"⎋", @"⌃⌥⌘F14"];
  for (NSString *suffix in suffixes) {
    for (NSString *separator in @[@" ", @"", @"\n"]) {
      if ([name isEqualToString:[NSString stringWithFormat:@"%@%@%@", label, separator, suffix]]) return true;
    }
  }
  return false;
}

static bool approval_card_button(NSDictionary *node, NSString *label) {
  if (![node[@"role"] isEqualToString:@"AXButton"]) return false;
  NSString *name = approval_card_name(node);
  if (!approval_card_name_matches(name, label)) return false;
  if ([name isEqualToString:label]) return true;
  // Chromium may flatten the action and its known shortcut badge into a leaf.
  // The card classifier additionally requires the trusted application page,
  // main landmark and exact known permission structure before any dispatch.
  if (approval_card_visible_children(node).count == 0) return true;
  // A concatenated accessible name must also expose the exact action text in
  // its descendants, distinguishing the action from an arbitrary longer name.
  NSMutableArray *inside = [NSMutableArray array];
  review_collect_nodes(node, inside);
  for (NSDictionary *child in inside) {
    if (child != node && [child[@"role"] isEqualToString:@"AXStaticText"]
        && review_has_label(child, label)) return true;
  }
  return false;
}

static bool approval_card_alert(NSDictionary *node) {
  return [node[@"role"] isEqualToString:@"AXAlert"]
    || ([node[@"role"] isEqualToString:@"AXGroup"]
      && [node[@"subrole"] isEqualToString:@"AXApplicationAlert"]);
}

static bool approval_card_blocking_surface(NSDictionary *node) {
  return review_node_is_dialog(node)
    || [node[@"role"] isEqualToString:@"AXAlertDialog"]
    || [node[@"subrole"] isEqualToString:@"AXAlertDialog"]
    || [node[@"subrole"] isEqualToString:@"AXApplicationAlertDialog"]
    || [node[@"role"] isEqualToString:@"AXMenu"]
    || [node[@"role"] isEqualToString:@"AXMenuItem"];
}

static bool approval_card_contains(NSDictionary *root, NSDictionary *target) {
  if ([root[@"hidden"] boolValue]) return false;
  if (root == target) return true;
  for (NSDictionary *child in root[@"children"]) if (approval_card_contains(child, target)) return true;
  return false;
}

static NSArray *approval_card_visible_children(NSDictionary *node) {
  NSMutableArray *children = [NSMutableArray array];
  for (NSDictionary *child in node[@"children"]) if (![child[@"hidden"] boolValue]) [children addObject:child];
  return children;
}

static bool approval_card_ask_header(NSDictionary *node) {
  if (!approval_card_alert(node)) return false;
  NSArray *children = approval_card_visible_children(node);
  if (children.count != 2 || ![children[0][@"role"] isEqualToString:@"AXStaticText"]
      || !review_has_label(children[0], @"Ask permission") || ![children[1][@"role"] isEqualToString:@"AXGroup"]) return false;
  NSArray *reason = approval_card_visible_children(children[1]);
  return reason.count == 1 && [reason[0][@"role"] isEqualToString:@"AXStaticText"]
    && approval_card_name(reason[0]).length > 0;
}

static bool approval_card_ask_structure(NSDictionary *card, NSDictionary *header,
  NSDictionary *allow, NSDictionary *deny) {
  NSArray *children = approval_card_visible_children(card);
  if (children.count != 2 || children[0] != header || ![children[1][@"role"] isEqualToString:@"AXGroup"]) return false;
  NSArray *actions = approval_card_visible_children(children[1]);
  return actions.count == 2 && actions[0] == deny && actions[1] == allow;
}

static bool approval_card_trusted_web_area(NSDictionary *node) {
  if (![node[@"role"] isEqualToString:@"AXWebArea"] || ![node[@"url"] isKindOfClass:NSString.class]) return false;
  NSURLComponents *url = [NSURLComponents componentsWithString:node[@"url"]];
  // Observed through read-only AX on the installed Codex app, not inferred
  // from its PID. A browser/preview webarea must not impersonate app controls.
  return [url.scheme isEqualToString:@"app"] && [url.host isEqualToString:@"-"]
    && [url.percentEncodedPath isEqualToString:@"/index.html"]
    && url.user == nil && url.password == nil && url.port == nil && url.query == nil;
}

static NSString *approval_card_fingerprint(NSDictionary *tree) {
  NSString *review_token = tree != nil ? review_fingerprint(tree) : nil;
  return review_token.length == 67 ? [@"a1:" stringByAppendingString:[review_token substringFromIndex:3]] : nil;
}

static ApprovalCardCapture approval_card_classify_tree(NSDictionary *tree, bool complete) {
  ApprovalCardCapture unavailable = { .state = @"unavailable", .reason = @"scan-incomplete" };
  if (!complete || ![tree isKindOfClass:NSDictionary.class]) return unavailable;
  NSMutableArray *nodes = [NSMutableArray array];
  review_collect_nodes(tree, nodes);
  NSMutableArray *allows = [NSMutableArray array], *denies = [NSMutableArray array];
  NSMutableArray *headers = [NSMutableArray array], *web_areas = [NSMutableArray array];
  bool marker = false, blocked = false;
  for (NSDictionary *node in nodes) {
    if (approval_card_has_prompt(node) || review_has_label(node, @"Ask permission") || review_has_label(node, APPROVAL_CARD_ALLOW)
        || approval_card_button(node, APPROVAL_CARD_ALLOW)) marker = true;
    if (approval_card_blocking_surface(node)) blocked = true;
    if ([node[@"role"] isEqualToString:@"AXWebArea"]) [web_areas addObject:node];
    if (approval_card_button(node, APPROVAL_CARD_ALLOW)) [allows addObject:node];
    if (approval_card_button(node, APPROVAL_CARD_DENY)) [denies addObject:node];
    if (approval_card_alert(node)) {
      NSMutableArray *inside = [NSMutableArray array];
      review_collect_nodes(node, inside);
      bool terminal = false, prompt = false;
      for (NSDictionary *child in inside) {
        terminal |= review_has_label(child, @"Terminal");
        prompt |= approval_card_has_prompt(child);
      }
      if ((terminal && prompt) || approval_card_ask_header(node)) [headers addObject:node];
    }
  }
  if (!marker) return (ApprovalCardCapture){0};
  unavailable.token = approval_card_fingerprint(tree);
  if (blocked) { unavailable.reason = @"blocking-surface"; return unavailable; }
  if (allows.count != 1 || denies.count != 1) { unavailable.reason = @"actions-unavailable"; return unavailable; }
  if (headers.count != 1) { unavailable.reason = @"header-unavailable"; return unavailable; }
  unavailable.reason = @"card-structure";
  NSDictionary *allow = allows.firstObject, *deny = denies.firstObject, *header = headers.firstObject;
  NSDictionary *card = nil;
  NSUInteger card_size = NSUIntegerMax;
  for (NSDictionary *node in nodes) {
    if (![node[@"role"] isEqualToString:@"AXGroup"] || approval_card_alert(node)
        || !approval_card_contains(node, allow) || !approval_card_contains(node, deny)
        || !approval_card_contains(node, header)) continue;
    NSMutableArray *inside = [NSMutableArray array];
    review_collect_nodes(node, inside);
    if (inside.count < card_size) { card = node; card_size = inside.count; }
  }
  if (card == nil || card_size > 180) return unavailable;
  bool ask_structure = approval_card_ask_header(header);
  if (ask_structure && !approval_card_ask_structure(card, header, allow, deny)) return unavailable;
  if (!ask_structure && ((![approval_card_name(allow) isEqualToString:APPROVAL_CARD_ALLOW]
        && approval_card_visible_children(allow).count == 0)
      || (![approval_card_name(deny) isEqualToString:APPROVAL_CARD_DENY]
        && approval_card_visible_children(deny).count == 0))) return unavailable;
  unsigned owning_web_areas = 0;
  NSDictionary *owner = nil;
  for (NSDictionary *web in web_areas) if (approval_card_contains(web, card)) { owning_web_areas += 1; owner = web; }
  unavailable.reason = @"untrusted-surface";
  if (owning_web_areas != 1 || !approval_card_trusted_web_area(owner)) return unavailable;
  unsigned main_landmarks = 0;
  for (NSDictionary *node in nodes) {
    if ([node[@"role"] isEqualToString:@"AXGroup"] && [node[@"subrole"] isEqualToString:@"AXLandmarkMain"]
        && approval_card_contains(owner, node) && approval_card_contains(node, card)) main_landmarks += 1;
  }
  if (main_landmarks != 1) return unavailable;
  unavailable.reason = @"card-structure";
  NSMutableArray *inside = [NSMutableArray array];
  review_collect_nodes(card, inside);
  for (NSDictionary *node in inside) {
    // An input form, nested page, or another alert cannot be part of this
    // terminal permission card. The composer itself is outside the card.
    if ([node[@"role"] isEqualToString:@"AXTextField"] || [node[@"role"] isEqualToString:@"AXTextArea"]
        || [node[@"role"] isEqualToString:@"AXComboBox"] || [node[@"role"] isEqualToString:@"AXCheckBox"]
        || [node[@"role"] isEqualToString:@"AXWebArea"]
        || (approval_card_alert(node) && node != header)) return unavailable;
  }
  unavailable.token = approval_card_fingerprint(card);
  unavailable.reason = @"controls-unavailable";
  if (unavailable.token == nil || card[@"element"] == nil || header[@"element"] == nil
      || allow[@"element"] == nil || deny[@"element"] == nil
      || ![allow[@"enabled"] isEqual:@YES] || ![deny[@"enabled"] isEqual:@YES]
      || ![allow[@"pressable"] isEqual:@YES] || ![deny[@"pressable"] isEqual:@YES]
      || ![allow[@"focusable"] isEqual:@YES] || ![deny[@"focusable"] isEqual:@YES]) return unavailable;
  return (ApprovalCardCapture){ .state = @"ready", .token = unavailable.token,
    .card = card[@"element"], .header = header[@"element"], .allow = allow[@"element"], .deny = deny[@"element"] };
}

static ApprovalCardCapture approval_card_read_live(pid_t pid, void *unused) {
  (void)unused;
  ReviewScanBudget budget = { .complete = true };
  NSDictionary *tree = review_read_live_snapshot(pid, &budget);
  // A safety review takes precedence even if an ordinary card is still in AX.
  if (review_classify_tree(tree, budget.complete).state != nil) return (ApprovalCardCapture){ .state = @"unavailable" };
  return approval_card_classify_tree(tree, budget.complete);
}

static const char *approval_card_validate_live_controls(ApprovalCardCapture capture, void *unused) {
  (void)unused;
  NSArray *elements = @[capture.allow, capture.deny];
  NSArray *labels = @[APPROVAL_CARD_ALLOW, APPROVAL_CARD_DENY];
  for (NSUInteger i = 0; i < elements.count; i++) {
    NSDictionary *node = review_read_live_control(elements[i]);
    if (![node[@"role"] isEqualToString:@"AXButton"]
        || !approval_card_name_matches(approval_card_name(node), labels[i])) return "approval-changed";
    if (![node[@"enabled"] isEqual:@YES] || [node[@"hidden"] boolValue]) return "approval-unavailable";
    CFArrayRef actions = NULL;
    bool pressable = AXUIElementCopyActionNames((__bridge AXUIElementRef)elements[i], &actions) == kAXErrorSuccess
      && actions != NULL && [(__bridge NSArray *)actions containsObject:(__bridge NSString *)kAXPressAction];
    if (actions != NULL) CFRelease(actions);
    if (!pressable) return "approval-unavailable";
  }
  return NULL;
}

enum { APPROVAL_CARD_RETURN_KEY = 0x24, APPROVAL_CARD_SPACE_KEY = 0x31, APPROVAL_CARD_KEYPAD_ENTER_KEY = 0x4C };

static bool approval_card_event_pair(const char *decision, ApprovalShortcutKeyEvent events[2]) {
  if (decision == NULL) return false;
  CGKeyCode key;
  if (strcmp(decision, "approve") == 0) key = APPROVAL_CARD_RETURN_KEY;
  else if (strcmp(decision, "decline") == 0) key = APPROVAL_CARD_SPACE_KEY;
  else return false;
  events[0] = (ApprovalShortcutKeyEvent){ key, 0, true };
  events[1] = (ApprovalShortcutKeyEvent){ key, 0, false };
  return true;
}

typedef struct {
  CGEventRef down;
  CGEventRef up;
  NSTimeInterval deadline;
} ApprovalCardLiveActivation;

static uint64_t approval_card_packet_tag(uint32_t nonce) {
  // Diagnostic identification only; this is not an authorization credential.
  return UINT64_C(0x5444434100000000) | nonce;
}

typedef struct {
  void (*post)(CGEventRef, void *);
  void (*wait)(useconds_t, void *);
  void *context;
} ApprovalCardPacketOperations;

static void approval_card_emit_pair(ApprovalCardLiveActivation *state, ApprovalCardPacketOperations ops) {
  ops.post(state->down, ops.context);
  ops.wait(9000, ops.context);
  ops.post(state->up, ops.context);
  ops.wait(9000, ops.context);
}

static const char *approval_card_input_error(CGEventFlags flags, bool space_held, bool return_held, bool keypad_enter_held) {
  CGEventFlags interference = kCGEventFlagMaskShift | kCGEventFlagMaskControl
    | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand | kCGEventFlagMaskSecondaryFn;
  // Caps Lock alone does not alter activation. Never mix this pair with a
  // user's modifiers or an already held activation key.
  return (flags & interference) != 0 || space_held || return_held || keypad_enter_held ? "input-active" : NULL;
}

static const char *approval_card_live_input_error(void) {
  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)
    | CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  bool space_held = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, APPROVAL_CARD_SPACE_KEY)
    || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, APPROVAL_CARD_SPACE_KEY);
  bool return_held = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, APPROVAL_CARD_RETURN_KEY)
    || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, APPROVAL_CARD_RETURN_KEY);
  bool keypad_enter_held = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, APPROVAL_CARD_KEYPAD_ENTER_KEY)
    || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, APPROVAL_CARD_KEYPAD_ENTER_KEY);
  return approval_card_input_error(flags, space_held, return_held, keypad_enter_held);
}

static const char *approval_card_activation_budget(ApprovalCardLiveActivation *state) {
  return state->deadline > 0 && NSProcessInfo.processInfo.systemUptime < state->deadline
    ? NULL : "activation-timeout";
}

static const char *approval_card_prepare_live_keys(const char *decision, void *opaque) {
  ApprovalCardLiveActivation *state = opaque;
  // A monotonic guard prevents input after a slow AX operation has consumed
  // the helper's budget. The caller additionally has a 2200 ms hard timeout.
  state->deadline = NSProcessInfo.processInfo.systemUptime + 1.8;
  const char *error = approval_card_live_input_error();
  if (error != NULL) return error;
  if (!CGPreflightPostEventAccess()) return "permission-denied";
  ApprovalShortcutKeyEvent events[2];
  if (!approval_card_event_pair(decision, events)) return "invalid-arguments";
  // Use the existing post_key transport's raw virtual keys. Return and Space
  // need no Unicode override; retain the complete pair before changing focus.
  state->down = create_key_event(events[0].key, events[0].down, events[0].flags, NULL, 0);
  state->up = create_key_event(events[1].key, events[1].down, events[1].flags, NULL, 0);
  if (state->down == NULL || state->up == NULL) return "event-unavailable";
  uint64_t tag = approval_card_packet_tag(arc4random());
  CGEventSetIntegerValueField(state->down, kCGEventSourceUserData, (int64_t)tag);
  CGEventSetIntegerValueField(state->up, kCGEventSourceUserData, (int64_t)tag);
  CGEventSetIntegerValueField(state->down, kCGKeyboardEventAutorepeat, 0);
  CGEventSetIntegerValueField(state->up, kCGKeyboardEventAutorepeat, 0);
  return approval_card_activation_budget(state);
}

static const char *approval_card_activation_context(ApprovalShortcutContext *context, void *opaque) {
  ApprovalCardLiveActivation *state = opaque;
  const char *error = approval_card_activation_budget(state);
  if (error != NULL) return error;
  error = approval_read_live_context(context, NULL);
  return error != NULL ? error : approval_card_activation_budget(state);
}

static const char *approval_card_validate_live_focus(id target, pid_t pid, void *opaque) {
  ApprovalCardLiveActivation *state = opaque;
  const char *error = approval_card_activation_budget(state);
  if (error != NULL) return error;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.processIdentifier != pid || ![front.bundleIdentifier isEqualToString:@"com.openai.codex"]) return "not-frontmost";
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (app == NULL) return "focus-unavailable";
  AXUIElementSetMessagingTimeout(app, 0.06);
  CFTypeRef focused = NULL;
  AXError read = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused);
  CFRelease(app);
  bool exact = read == kAXErrorSuccess && focused != NULL
    && CFGetTypeID(focused) == AXUIElementGetTypeID()
    && CFEqual(focused, (__bridge CFTypeRef)target);
  if (focused != NULL) CFRelease(focused);
  if (!exact) return "focus-unverified";
  front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.processIdentifier != pid || ![front.bundleIdentifier isEqualToString:@"com.openai.codex"]) return "not-frontmost";
  error = approval_card_live_input_error();
  return error != NULL ? error : approval_card_activation_budget(state);
}

static const char *approval_card_focus_live_button(id target, pid_t pid, void *opaque) {
  ApprovalCardLiveActivation *state = opaque;
  const char *error = approval_card_activation_budget(state);
  if (error != NULL) return error;
  error = approval_card_live_input_error();
  if (error != NULL) return error;
  AXUIElementRef button = (__bridge AXUIElementRef)target;
  AXUIElementSetMessagingTimeout(button, 0.06);
  Boolean settable = false;
  if (AXUIElementIsAttributeSettable(button, kAXFocusedAttribute, &settable) != kAXErrorSuccess
      || !settable) return "focus-unavailable";
  error = approval_card_activation_budget(state);
  if (error != NULL) return error;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.processIdentifier != pid || ![front.bundleIdentifier isEqualToString:@"com.openai.codex"]) return "not-frontmost";
  if (AXUIElementSetAttributeValue(button, kAXFocusedAttribute, kCFBooleanTrue) != kAXErrorSuccess) return "focus-unavailable";
  NSTimeInterval deadline = MIN(state->deadline, NSProcessInfo.processInfo.systemUptime + 0.12);
  do {
    error = approval_card_validate_live_focus(target, pid, opaque);
    if (error == NULL || strcmp(error, "focus-unverified") != 0) return error;
    if (NSProcessInfo.processInfo.systemUptime >= deadline) break;
    usleep(8000);
  } while (NSProcessInfo.processInfo.systemUptime < deadline);
  return "focus-unverified";
}

static void approval_card_post_live_event(CGEventRef event, void *opaque) {
  (void)opaque;
  CGEventPost(kCGHIDEventTap, event);
}

static void approval_card_wait_live_event(useconds_t delay, void *opaque) {
  (void)opaque;
  usleep(delay);
}

static const char *approval_card_post_live_keys(id target, void *opaque) {
  (void)target;
  // Match post_key's pulse and exit dwell without intervening AX reads. Both
  // events already exist; never fall back to AXPress or send another pair.
  approval_card_emit_pair(opaque, (ApprovalCardPacketOperations){
    .post = approval_card_post_live_event, .wait = approval_card_wait_live_event
  });
  return NULL;
}

static const char *approval_card_dispatch(const char *decision, pid_t pid, NSString *window_token,
  NSString *card_token, ApprovalCardOperations ops, bool *attempted) {
  *attempted = false;
  if (decision == NULL || (strcmp(decision, "approve") != 0 && strcmp(decision, "decline") != 0)) return "invalid-arguments";
  const char *error = ops.prepare_keys(decision, ops.context);
  if (error != NULL) return error;
  ApprovalCardCapture previous = {0};
  for (unsigned i = 0; i < 2; i++) {
    ApprovalShortcutContext context = {0};
    error = ops.read_context(&context, ops.context);
    if (error != NULL) return error;
    if (!approval_context_matches(context, pid, window_token)) return "context-changed";
    ApprovalCardCapture current = ops.read_card(pid, ops.context);
    if (![current.state isEqualToString:@"ready"] || current.card == nil || current.header == nil
        || current.allow == nil || current.deny == nil) return "approval-unavailable";
    if (![current.token isEqualToString:card_token]) return "approval-changed";
    if (i > 0 && (!ops.same_element(previous.card, current.card, ops.context)
        || !ops.same_element(previous.header, current.header, ops.context)
        || !ops.same_element(previous.allow, current.allow, ops.context)
        || !ops.same_element(previous.deny, current.deny, ops.context))) return "approval-changed";
    previous = current;
    if (i == 0) {
      error = ops.validate_controls(current, ops.context);
      if (error != NULL) return error;
      error = ops.read_context(&context, ops.context);
      if (error != NULL) return error;
      if (!approval_context_matches(context, pid, window_token)) return "context-changed";
      id target = strcmp(decision, "approve") == 0 ? current.allow : current.deny;
      error = ops.focus_button(target, pid, ops.context);
      if (error != NULL) return error;
      // The second complete scan rebinds the trusted card after focus, without
      // performing any activation if focus changed the card or request.
    }
  }
  error = ops.validate_controls(previous, ops.context);
  if (error != NULL) return error;
  // This final check occurs after all potentially slower AX reads, immediately
  // before activation. Nothing sets a checkbox or widens permission.
  ApprovalShortcutContext context = {0};
  error = ops.read_context(&context, ops.context);
  if (error != NULL) return error;
  if (!approval_context_matches(context, pid, window_token)) return "context-changed";
  id target = strcmp(decision, "approve") == 0 ? previous.allow : previous.deny;
  error = ops.validate_focus(target, pid, ops.context);
  if (error != NULL) return error;
  *attempted = true;
  return ops.post_keys(target, ops.context) == NULL ? NULL : "delivery-unknown";
}

static NSDictionary *approval_card_context_metadata(ApprovalCardCapture capture) {
  if (capture.state == nil) return nil;
  return @{ @"state": capture.state, @"token": capture.token != nil ? capture.token : NSNull.null,
    @"reason": capture.reason != nil ? capture.reason : NSNull.null };
}

static int print_codex_task_action_context(void) {
  ApprovalShortcutContext context = {0};
  const char *error = approval_read_live_context(&context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  ReviewScanBudget budget = { .complete = true };
  NSDictionary *tree = review_read_live_snapshot(context.pid, &budget);
  ReviewCapture review = review_classify_tree(tree, budget.complete);
  ApprovalCardCapture card = review.state == nil ? approval_card_classify_tree(tree, budget.complete) : (ApprovalCardCapture){0};
  ApprovalShortcutContext final_context = {0};
  error = approval_read_live_context(&final_context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  if (!approval_context_matches(final_context, context.pid, approval_context_token(context))) return approval_print_error("context-changed", 1);
  NSDictionary *review_metadata = review_context_metadata(review), *card_metadata = approval_card_context_metadata(card);
  NSDictionary *result = @{ @"pid": @(context.pid), @"token": approval_context_token(context),
    @"review": review_metadata != nil ? review_metadata : NSNull.null,
    @"approval": card_metadata != nil ? card_metadata : NSNull.null,
    @"scanDiagnostics": review_scan_summary(budget) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
  if (data == nil) return approval_print_error("context-unavailable", 1);
  printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
}

static int codex_approval_card(int argc, char **argv) {
  if (argc != 6 || (strcmp(argv[2], "approve") != 0 && strcmp(argv[2], "decline") != 0)
      || strlen(argv[4]) > 64 || strlen(argv[5]) != 67 || strncmp(argv[5], "a1:", 3) != 0) return approval_print_error("invalid-arguments", 64);
  for (unsigned i = 3; i < 67; i++) if (!isxdigit((unsigned char)argv[5][i])) return approval_print_error("invalid-arguments", 64);
  char *end = NULL;
  errno = 0;
  long pid = strtol(argv[3], &end, 10);
  if (errno != 0 || end == argv[3] || *end != '\0' || pid <= 1 || pid > INT_MAX) return approval_print_error("invalid-arguments", 64);
  bool attempted = false;
  ApprovalCardLiveActivation activation = {0};
  const char *error = approval_card_dispatch(argv[2], (pid_t)pid,
    [NSString stringWithUTF8String:argv[4]], [NSString stringWithUTF8String:argv[5]], (ApprovalCardOperations){
      .prepare_keys = approval_card_prepare_live_keys,
      .read_context = approval_card_activation_context, .read_card = approval_card_read_live,
      .same_element = review_same_live_element, .validate_controls = approval_card_validate_live_controls,
      .focus_button = approval_card_focus_live_button, .validate_focus = approval_card_validate_live_focus,
      .post_keys = approval_card_post_live_keys, .context = &activation
    }, &attempted);
  if (activation.down != NULL) CFRelease(activation.down);
  if (activation.up != NULL) CFRelease(activation.up);
  if (error != NULL) {
    if (!attempted) return approval_print_error(error, 1);
    printf("{\"sent\":null,\"error\":\"delivery-unknown\"}\n");
    return 1;
  }
  // HID event emission is not approval resolution. Never retry here.
  printf("{\"sent\":true}\n");
  return 0;
}

static NSDictionary *approval_card_diagnostics(NSDictionary *tree, ReviewScanBudget budget) {
  NSMutableArray *nodes = [NSMutableArray array];
  if (tree != nil) review_collect_nodes(tree, nodes);
  unsigned allow = 0, deny = 0, prompts = 0, terminal = 0, ask = 0, alerts = 0, blocking = 0, trusted = 0;
  unsigned allow_enabled = 0, deny_enabled = 0, allow_pressable = 0, deny_pressable = 0, allow_focusable = 0, deny_focusable = 0;
  for (NSDictionary *node in nodes) {
    bool is_allow = approval_card_button(node, APPROVAL_CARD_ALLOW), is_deny = approval_card_button(node, APPROVAL_CARD_DENY);
    allow += is_allow; deny += is_deny;
    allow_enabled += is_allow && [node[@"enabled"] isEqual:@YES];
    deny_enabled += is_deny && [node[@"enabled"] isEqual:@YES];
    allow_pressable += is_allow && [node[@"pressable"] isEqual:@YES];
    deny_pressable += is_deny && [node[@"pressable"] isEqual:@YES];
    allow_focusable += is_allow && [node[@"focusable"] isEqual:@YES];
    deny_focusable += is_deny && [node[@"focusable"] isEqual:@YES];
    prompts += approval_card_has_prompt(node); terminal += review_has_label(node, @"Terminal");
    ask += review_has_label(node, @"Ask permission"); trusted += approval_card_trusted_web_area(node);
    alerts += approval_card_alert(node); blocking += approval_card_blocking_surface(node);
  }
  ApprovalCardCapture capture = approval_card_classify_tree(tree, budget.complete);
  return @{ @"scan": review_scan_diagnostics(budget), @"state": capture.state != nil ? capture.state : @"absent",
    @"reason": capture.reason != nil ? capture.reason : NSNull.null,
    @"knownLabels": @{ @"Allow once": @(allow), @"Deny": @(deny), @"Terminal": @(terminal), @"Ask permission": @(ask), @"commandPrompt": @(prompts) },
    @"controls": @{ @"allowEnabled": @(allow_enabled), @"denyEnabled": @(deny_enabled),
      @"allowPressable": @(allow_pressable), @"denyPressable": @(deny_pressable),
      @"allowFocusable": @(allow_focusable), @"denyFocusable": @(deny_focusable) },
    @"alerts": @(alerts), @"blockingSurfaces": @(blocking), @"trustedWebAreas": @(trusted) };
}

static int print_codex_approval_card_diagnostics(void) {
  ApprovalShortcutContext context = {0};
  const char *error = approval_read_live_context(&context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  ReviewScanBudget budget = { .complete = true };
  NSDictionary *tree = review_read_live_snapshot(context.pid, &budget);
  ApprovalShortcutContext final_context = {0};
  error = approval_read_live_context(&final_context, NULL);
  if (error != NULL) return approval_print_error(error, 1);
  if (!approval_context_matches(final_context, context.pid, approval_context_token(context))) return approval_print_error("context-changed", 1);
  // Fixed labels, aggregate roles and states only; never output the tree,
  // request/command text, window or task identities, or captured tokens.
  NSData *data = [NSJSONSerialization dataWithJSONObject:approval_card_diagnostics(tree, budget) options:0 error:NULL];
  if (data == nil) return approval_print_error("diagnostics-unavailable", 1);
  printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
}

static NSMutableDictionary *approval_card_selftest_fixture(void) {
  return [@{ @"role": @"AXGroup", @"element": @"card-1", @"identity": @1, @"path": @"0/0/0",
    @"children": @[
      @{ @"role": @"AXGroup", @"subrole": @"AXApplicationAlert", @"element": @"header-2", @"identity": @2,
        @"children": @[
          @{ @"role": @"AXStaticText", @"value": @"Terminal", @"identity": @3 },
          @{ @"role": @"AXStaticText", @"value": @"Allow ChatGPT to run this command?", @"identity": @4 }
        ] },
      @{ @"role": @"AXStaticText", @"value": @"Fixture private command A", @"identity": @5 },
      @{ @"role": @"AXButton", @"title": @"Deny", @"enabled": @YES, @"pressable": @YES, @"focusable": @YES,
        @"element": @"deny-6", @"identity": @6 },
      @{ @"role": @"AXButton", @"title": @"Allow once", @"enabled": @YES, @"pressable": @YES, @"focusable": @YES,
        @"element": @"allow-7", @"identity": @7 }
    ] } mutableCopy];
}

static NSMutableDictionary *approval_card_selftest_ask_fixture(void) {
  NSMutableDictionary *card = approval_card_selftest_fixture();
  NSArray *existing = card[@"children"];
  card[@"children"] = @[
    @{ @"role": @"AXGroup", @"subrole": @"AXApplicationAlert", @"element": @"ask-header", @"identity": @20,
      @"children": @[
        @{ @"role": @"AXStaticText", @"value": @"Ask permission", @"identity": @21 },
        @{ @"role": @"AXGroup", @"children": @[
          @{ @"role": @"AXStaticText", @"value": @"Fixture private justification A", @"identity": @22 }
        ] }
      ] },
    @{ @"role": @"AXGroup", @"children": @[existing[2], existing[3]] }
  ];
  return card;
}

static NSDictionary *approval_card_selftest_window(NSDictionary *card, NSArray *siblings) {
  return @{ @"role": @"AXWindow", @"children": @[
    @{ @"role": @"AXWebArea", @"url": @"app://-/index.html", @"children": @[
      @{ @"role": @"AXGroup", @"subrole": @"AXLandmarkMain",
        @"children": [@[card] arrayByAddingObjectsFromArray:siblings != nil ? siblings : @[]] }
    ] }
  ] };
}

typedef struct {
  ApprovalShortcutContext contexts[4];
  const char *context_errors[4];
  ApprovalCardCapture cards[2];
  unsigned context_reads, card_reads, presses, validations, prepared, focuses, focus_checks, events;
  AXError press_result;
  const char *control_errors[2];
  const char *prepare_error;
  const char *focus_error;
  const char *focus_check_error;
  CGKeyCode prepared_key;
  id __strong target;
  id __strong focused_target;
} ApprovalCardSelftestState;

static const char *approval_card_selftest_prepare(const char *decision, void *opaque) {
  ApprovalCardSelftestState *state = opaque;
  state->prepared += 1;
  ApprovalShortcutKeyEvent events[2];
  if (!approval_card_event_pair(decision, events)) return "invalid-arguments";
  state->prepared_key = events[0].key;
  return state->prepare_error;
}

static const char *approval_card_selftest_context(ApprovalShortcutContext *context, void *opaque) {
  ApprovalCardSelftestState *state = opaque;
  unsigned index = state->context_reads++;
  if (index > 3) return "unexpected-read";
  *context = state->contexts[index];
  return state->context_errors[index];
}

static ApprovalCardCapture approval_card_selftest_read(pid_t pid, void *opaque) {
  (void)pid;
  ApprovalCardSelftestState *state = opaque;
  unsigned index = state->card_reads++;
  return index < 2 ? state->cards[index] : (ApprovalCardCapture){ .state = @"unavailable" };
}

static const char *approval_card_selftest_controls(ApprovalCardCapture capture, void *opaque) {
  (void)capture;
  ApprovalCardSelftestState *state = opaque;
  unsigned index = state->validations++;
  return index < 2 ? state->control_errors[index] : "unexpected-validation";
}

static const char *approval_card_selftest_focus(id target, pid_t pid, void *opaque) {
  (void)pid;
  ApprovalCardSelftestState *state = opaque;
  state->focuses += 1;
  state->focused_target = target;
  return state->focus_error;
}

static const char *approval_card_selftest_verify_focus(id target, pid_t pid, void *opaque) {
  (void)pid;
  ApprovalCardSelftestState *state = opaque;
  state->focus_checks += 1;
  if (![target isEqual:state->focused_target]) return "focus-unverified";
  return state->focus_check_error;
}

static const char *approval_card_selftest_press(id target, void *opaque) {
  ApprovalCardSelftestState *state = opaque;
  state->presses += 1;
  state->events += state->press_result == kAXErrorSuccess ? 2 : 1;
  state->target = target;
  return state->press_result == kAXErrorSuccess ? NULL : "delivery-unknown";
}

static ApprovalCardSelftestState approval_card_selftest_state(ApprovalCardCapture capture) {
  return (ApprovalCardSelftestState){
    .contexts = {{123,45,501,1},{123,45,501,1},{123,45,501,1},{123,45,501,1}},
    .cards = {capture,capture}, .press_result = kAXErrorSuccess
  };
}

static const char *approval_card_selftest_dispatch(const char *decision, ApprovalCardSelftestState *state,
  NSString *token, bool *attempted) {
  return approval_card_dispatch(decision, 123, @"v2:123:45:501:1", token, (ApprovalCardOperations){
    .prepare_keys = approval_card_selftest_prepare,
    .read_context = approval_card_selftest_context, .read_card = approval_card_selftest_read,
    .same_element = review_same_live_element, .validate_controls = approval_card_selftest_controls,
    .focus_button = approval_card_selftest_focus, .validate_focus = approval_card_selftest_verify_focus,
    .post_keys = approval_card_selftest_press, .context = state
  }, attempted);
}

static void approval_card_selftest_post_event(CGEventRef event, void *opaque) {
  [(__bridge NSMutableArray *)opaque addObject:(__bridge id)event];
}

static void approval_card_selftest_wait_event(useconds_t delay, void *opaque) {
  [(__bridge NSMutableArray *)opaque addObject:@(delay)];
}

static int approval_card_selftest(void) {
  // Fixtures and injected operations only. No application reads or input.
  unsigned checks = 0, failures = 0;
#define CARD_CHECK(condition) do { checks += 1; if (!(condition)) { failures += 1; fprintf(stderr, "approval-card-selftest line %d failed\n", __LINE__); } } while (0)
  NSMutableDictionary *card = approval_card_selftest_fixture();
  NSDictionary *window = approval_card_selftest_window(card, nil);
  ApprovalCardCapture ready = approval_card_classify_tree(window, true);
  CARD_CHECK([ready.state isEqualToString:@"ready"] && ready.token.length == 67
    && [ready.token hasPrefix:@"a1:"] && ready.allow != nil && ready.deny != nil);
  CARD_CHECK([approval_card_classify_tree(window, true).token isEqualToString:ready.token]);
  CARD_CHECK(approval_card_classify_tree(@{ @"role": @"AXWindow", @"children": @[] }, true).state == nil);
  CARD_CHECK([approval_card_classify_tree(window, false).state isEqualToString:@"unavailable"]);
  CARD_CHECK([approval_card_classify_tree(nil, true).state isEqualToString:@"unavailable"]);
  CARD_CHECK(approval_card_context_metadata((ApprovalCardCapture){0}) == nil);
  CARD_CHECK([approval_card_context_metadata(ready)[@"state"] isEqualToString:@"ready"]);
  CARD_CHECK(approval_card_context_metadata(ready)[@"reason"] == NSNull.null);
  CARD_CHECK([review_url_string(@"app://-/index.html") isEqualToString:@"app://-/index.html"]);
  CARD_CHECK([review_url_string([NSURL URLWithString:@"app://-/index.html"]) isEqualToString:@"app://-/index.html"]);
  CARD_CHECK(review_url_string(NSNull.null) == nil && review_url_string(nil) == nil);
  for (id url in @[@"https://example.invalid/index.html", @"http://-/index.html", @"file:///index.html",
      @"app://other/index.html", @"app://-/other.html", @"app://user@-/index.html", @"app://-:80/index.html",
      @"app://-/index.html?preview=true", @"app://-/%69ndex.html", NSNull.null]) {
    NSMutableDictionary *foreign = [@{ @"role": @"AXWebArea", @"children": @[
      @{ @"role": @"AXGroup", @"subrole": @"AXLandmarkMain", @"children": @[approval_card_selftest_ask_fixture()] }
    ] } mutableCopy];
    if (url != NSNull.null) foreign[@"url"] = url;
    NSDictionary *sibling_window = @{ @"role": @"AXWindow", @"children": @[
      @{ @"role": @"AXWebArea", @"url": @"app://-/index.html", @"children": @[] }, foreign
    ] };
    ApprovalCardCapture foreign_capture = approval_card_classify_tree(sibling_window, true);
    CARD_CHECK([foreign_capture.state isEqualToString:@"unavailable"] && [foreign_capture.reason isEqualToString:@"untrusted-surface"]);
  }
  NSDictionary *no_main = @{ @"role": @"AXWindow", @"children": @[
    @{ @"role": @"AXWebArea", @"url": @"app://-/index.html", @"children": @[approval_card_selftest_ask_fixture()] }
  ] };
  CARD_CHECK([approval_card_classify_tree(no_main, true).state isEqualToString:@"unavailable"]);
  NSDictionary *nested_web = @{ @"role": @"AXWebArea", @"url": @"app://-/index.html", @"children": @[
    @{ @"role": @"AXGroup", @"subrole": @"AXLandmarkMain", @"children": @[approval_card_selftest_ask_fixture()] }
  ] };
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(nested_web, nil), true).state isEqualToString:@"unavailable"]);
  NSDictionary *nested_main = @{ @"role": @"AXGroup", @"subrole": @"AXLandmarkMain", @"children": @[approval_card_selftest_ask_fixture()] };
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(nested_main, nil), true).state isEqualToString:@"unavailable"]);
  card = approval_card_selftest_ask_fixture();
  ApprovalCardCapture ask = approval_card_classify_tree(approval_card_selftest_window(card, nil), true);
  CARD_CHECK([ask.state isEqualToString:@"ready"] && [ask.allow isEqual:@"allow-7"] && [ask.deny isEqual:@"deny-6"]);
  for (NSArray *names in @[@[@"Deny Esc", @"Allow once ⏎"], @[@"Deny⌃⌥⌘F14", @"Allow once⌃⌥⌘F13"]]) {
    NSMutableDictionary *flat = approval_card_selftest_ask_fixture();
    NSMutableDictionary *actions = [flat[@"children"][1] mutableCopy];
    review_selftest_set_child(actions, 0, @"title", names[0]);
    review_selftest_set_child(actions, 1, @"title", names[1]);
    review_selftest_set_child(flat, 1, @"children", actions[@"children"]);
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(flat, nil), true).state isEqualToString:@"ready"]);
  }
  NSMutableDictionary *ask_header = [card[@"children"][0] mutableCopy];
  NSMutableDictionary *ask_reason = [ask_header[@"children"][1] mutableCopy];
  review_selftest_set_child(ask_reason, 0, @"value", @"Fixture private justification B");
  review_selftest_set_child(ask_header, 1, @"children", ask_reason[@"children"]);
  review_selftest_set_child(card, 0, @"children", ask_header[@"children"]);
  CARD_CHECK(![approval_card_classify_tree(approval_card_selftest_window(card, nil), true).token isEqualToString:ask.token]);
  for (NSString *label in @[@"Always allow", @"Request", @"Ask Permission"]) {
    card = approval_card_selftest_ask_fixture();
    ask_header = [card[@"children"][0] mutableCopy]; review_selftest_set_child(ask_header, 0, @"value", label);
    review_selftest_set_child(card, 0, @"children", ask_header[@"children"]);
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  }
  card = approval_card_selftest_ask_fixture();
  NSArray *ask_actions = card[@"children"][1][@"children"];
  review_selftest_set_child(card, 1, @"children", @[ask_actions[1], ask_actions[0]]);
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  card = approval_card_selftest_ask_fixture();
  card[@"children"] = [card[@"children"] arrayByAddingObject:@{ @"role": @"AXButton", @"title": @"Always allow" }];
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  card = approval_card_selftest_ask_fixture();
  review_selftest_set_child(card, 1, @"children", @[
    @{ @"role": @"AXGroup", @"children": @[ask_actions[0]] },
    @{ @"role": @"AXGroup", @"children": @[ask_actions[1]] }
  ]);
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  for (NSString *prompt in approval_card_prompts()) {
    card = approval_card_selftest_fixture();
    NSMutableDictionary *header = [card[@"children"][0] mutableCopy];
    review_selftest_set_child(header, 1, @"value", prompt);
    review_selftest_set_child(card, 0, @"children", header[@"children"]);
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"ready"]);
  }
  card = approval_card_selftest_fixture();
  review_selftest_set_child(card, 0, @"role", @"AXAlert");
  review_selftest_set_child(card, 0, @"subrole", nil);
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"ready"]);
  for (NSNumber *index in @[@2,@3]) {
    NSString *label = index.intValue == 2 ? APPROVAL_CARD_DENY : APPROVAL_CARD_ALLOW;
    NSArray *names = index.intValue == 2 ? @[@"Deny Esc", @"Deny⎋", @"Deny\n⌃⌥⌘F14"]
      : @[@"Allow once ⏎", @"Allow once↵", @"Allow once\n⌃⌥⌘F13"];
    for (NSString *name in names) {
      card = approval_card_selftest_fixture();
      review_selftest_set_child(card, index.unsignedIntegerValue, @"title", name);
      CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
      review_selftest_set_child(card, index.unsignedIntegerValue, @"children", @[
        @{ @"role": @"AXStaticText", @"value": label }
      ]);
      CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"ready"]);
    }
    for (NSString *key in @[@"enabled", @"pressable", @"focusable", @"element"]) {
      card = approval_card_selftest_fixture(); review_selftest_set_child(card, index.unsignedIntegerValue, key, nil);
      CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
      if (![key isEqualToString:@"element"]) {
        review_selftest_set_child(card, index.unsignedIntegerValue, key, @NO);
        CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
      }
    }
    for (NSString *name in @[@"Always allow", @"Allow all edits", @"Allow once and more", @"Deny everything", @"Continue", @"allow once"]) {
      card = approval_card_selftest_fixture(); review_selftest_set_child(card, index.unsignedIntegerValue, @"title", name);
      CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
    }
    card = approval_card_selftest_fixture(); review_selftest_set_child(card, index.unsignedIntegerValue, @"hidden", @YES);
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  }
  NSArray *blockers = @[
    @{ @"role": @"AXDialog" }, @{ @"role": @"AXSheet" }, @{ @"role": @"AXAlertDialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXApplicationDialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXApplicationAlertDialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXDialog" },
    @{ @"role": @"AXGroup", @"subrole": @"AXAlertDialog" },
    @{ @"role": @"AXMenu" }, @{ @"role": @"AXMenuItem" }
  ];
  for (NSDictionary *blocker in blockers) {
    card = approval_card_selftest_fixture();
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, @[blocker]), true).state isEqualToString:@"unavailable"]);
    NSMutableDictionary *hidden = [blocker mutableCopy]; hidden[@"hidden"] = @YES;
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, @[hidden]), true).state isEqualToString:@"ready"]);
    card[@"children"] = [card[@"children"] arrayByAddingObject:blocker];
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  }
  card = approval_card_selftest_fixture();
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, @[approval_card_selftest_fixture()]), true).state isEqualToString:@"unavailable"]);
  CARD_CHECK([approval_card_classify_tree(card, true).state isEqualToString:@"unavailable"]);
  for (NSNumber *index in @[@0,@2,@3]) {
    card = approval_card_selftest_fixture(); card[@"children"] = [card[@"children"] arrayByAddingObject:card[@"children"][index.unsignedIntegerValue]];
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  }
  for (NSString *role in @[@"AXTextField", @"AXTextArea", @"AXComboBox", @"AXCheckBox", @"AXWebArea", @"AXAlert"]) {
    card = approval_card_selftest_fixture(); card[@"children"] = [card[@"children"] arrayByAddingObject:@{ @"role": role }];
    CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);
  }
  card = approval_card_selftest_fixture();
  card[@"children"] = [card[@"children"] arrayByAddingObjectsFromArray:@[
    @{ @"role": @"AXButton", @"title": @"Always allow", @"element": @"broader-1" },
    @{ @"role": @"AXButton", @"title": @"Approval options", @"element": @"broader-2" }
  ]];
  ApprovalCardCapture options = approval_card_classify_tree(approval_card_selftest_window(card, nil), true);
  CARD_CHECK([options.state isEqualToString:@"ready"] && [options.allow isEqual:@"allow-7"] && [options.deny isEqual:@"deny-6"]);
  card = approval_card_selftest_fixture();
  review_selftest_set_child(card, 1, @"value", @"Fixture private command B");
  ApprovalCardCapture changed = approval_card_classify_tree(approval_card_selftest_window(card, nil), true);
  CARD_CHECK(![changed.token isEqualToString:ready.token]);
  card = approval_card_selftest_fixture(); review_selftest_set_child(card, 3, @"identity", @999);
  CARD_CHECK(![approval_card_classify_tree(approval_card_selftest_window(card, nil), true).token isEqualToString:ready.token]);
  card = approval_card_selftest_fixture(); card[@"path"] = @"0/1/0";
  CARD_CHECK(![approval_card_classify_tree(approval_card_selftest_window(card, nil), true).token isEqualToString:ready.token]);
  card = approval_card_selftest_fixture(); card[@"hidden"] = @YES;
  CARD_CHECK(approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state == nil);
  card = approval_card_selftest_fixture();
  NSMutableArray *large = [card[@"children"] mutableCopy];
  for (unsigned i = 0; i < 180; i++) [large addObject:@{ @"role": @"AXStaticText" }];
  card[@"children"] = large;
  CARD_CHECK([approval_card_classify_tree(approval_card_selftest_window(card, nil), true).state isEqualToString:@"unavailable"]);

  ReviewScanBudget budget = { .visited = 20, .complete = true };
  NSDictionary *diagnostics = approval_card_diagnostics(window, budget);
  NSData *data = [NSJSONSerialization dataWithJSONObject:diagnostics options:0 error:NULL];
  NSString *serialized = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  CARD_CHECK([diagnostics[@"state"] isEqualToString:@"ready"]);
  CARD_CHECK([diagnostics[@"knownLabels"][@"Allow once"] isEqual:@1]);
  CARD_CHECK([serialized rangeOfString:@"Fixture private"].location == NSNotFound);
  CARD_CHECK([serialized rangeOfString:@"a1:"].location == NSNotFound && [serialized rangeOfString:@"allow-7"].location == NSNotFound);
  review_scan_stop(&budget, "node-limit");
  CARD_CHECK([approval_card_diagnostics(window, budget)[@"state"] isEqualToString:@"unavailable"]);

  bool attempted = false;
  for (NSString *decision in @[@"approve",@"decline"]) {
    ApprovalCardSelftestState state = approval_card_selftest_state(ready);
    CARD_CHECK(approval_card_selftest_dispatch(decision.UTF8String, &state, ready.token, &attempted) == NULL);
    CARD_CHECK(attempted && state.presses == 1 && state.card_reads == 2 && state.context_reads == 4 && state.validations == 2
      && state.prepared == 1 && state.focuses == 1 && state.focus_checks == 1 && state.events == 2);
    CARD_CHECK([state.target isEqual:([decision isEqualToString:@"approve"] ? ready.allow : ready.deny)]);
    CARD_CHECK(state.prepared_key == ([decision isEqualToString:@"approve"] ? 0x24 : 0x31));
    state = approval_card_selftest_state(ready); state.press_result = kAXErrorCannotComplete;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch(decision.UTF8String, &state, ready.token, &attempted), "delivery-unknown"));
    CARD_CHECK(attempted && state.presses == 1 && state.events == 1);
  }
  ApprovalCardSelftestState state = approval_card_selftest_state(ready);
  CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("always-allow", &state, ready.token, &attempted), "invalid-arguments"));
  CARD_CHECK(!attempted && state.presses == 0 && state.context_reads == 0);
  for (unsigned i = 0; i < 4; i++) {
    state = approval_card_selftest_state(ready); state.contexts[i].window = 46;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), "context-changed"));
    CARD_CHECK(!attempted && state.presses == 0);
    state = approval_card_selftest_state(ready); state.context_errors[i] = "not-frontmost";
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), "not-frontmost"));
    CARD_CHECK(!attempted && state.presses == 0);
  }
  for (unsigned i = 0; i < 2; i++) {
    state = approval_card_selftest_state(ready); state.cards[i] = changed;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), "approval-changed"));
    CARD_CHECK(!attempted && state.presses == 0);
    state = approval_card_selftest_state(ready); state.cards[i].state = @"unavailable";
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), "approval-unavailable"));
    CARD_CHECK(!attempted && state.presses == 0);
  }
  for (unsigned i = 0; i < 4; i++) {
    state = approval_card_selftest_state(ready);
    if (i == 0) state.cards[1].card = @"different-card";
    if (i == 1) state.cards[1].header = @"different-header";
    if (i == 2) state.cards[1].allow = @"different-allow";
    if (i == 3) state.cards[1].deny = @"different-deny";
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), "approval-changed"));
    CARD_CHECK(!attempted && state.presses == 0);
  }
  for (unsigned i = 0; i < 2; i++) {
    for (NSString *error in @[@"approval-unavailable", @"approval-changed"]) {
      state = approval_card_selftest_state(ready); state.control_errors[i] = error.UTF8String;
      CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), error.UTF8String));
      CARD_CHECK(!attempted && state.presses == 0 && state.events == 0 && state.card_reads == i + 1 && state.validations == i + 1);
    }
  }
  for (NSString *error in @[@"event-unavailable", @"input-active", @"permission-denied", @"activation-timeout"]) {
    state = approval_card_selftest_state(ready); state.prepare_error = error.UTF8String;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), error.UTF8String));
    CARD_CHECK(!attempted && state.events == 0 && state.prepared == 1 && state.focuses == 0 && state.card_reads == 0);
  }
  for (NSString *error in @[@"focus-unavailable", @"focus-unverified", @"input-active", @"activation-timeout"]) {
    state = approval_card_selftest_state(ready); state.focus_error = error.UTF8String;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), error.UTF8String));
    CARD_CHECK(!attempted && state.events == 0 && state.focuses == 1 && state.card_reads == 1);
  }
  for (NSString *error in @[@"focus-unverified", @"input-active", @"activation-timeout", @"not-frontmost"]) {
    state = approval_card_selftest_state(ready); state.focus_check_error = error.UTF8String;
    CARD_CHECK(approval_error_is(approval_card_selftest_dispatch("approve", &state, ready.token, &attempted), error.UTF8String));
    CARD_CHECK(!attempted && state.events == 0 && state.focuses == 1 && state.card_reads == 2 && state.context_reads == 4);
  }
  ApprovalShortcutKeyEvent pair[2];
  CARD_CHECK(approval_card_event_pair("approve", pair));
  CARD_CHECK(pair[0].key == 0x24 && pair[1].key == 0x24 && pair[0].down && !pair[1].down
    && pair[0].flags == 0 && pair[1].flags == 0);
  CARD_CHECK(approval_card_event_pair("decline", pair));
  CARD_CHECK(pair[0].key == 0x31 && pair[1].key == 0x31 && pair[0].down && !pair[1].down
    && pair[0].flags == 0 && pair[1].flags == 0);
  CARD_CHECK(!approval_card_event_pair("always-allow", pair));
  CARD_CHECK(!approval_card_event_pair(NULL, pair));
  NSMutableArray *packet_calls = [NSMutableArray array];
  ApprovalCardLiveActivation packet = { .down = (__bridge CGEventRef)@"fixture-down", .up = (__bridge CGEventRef)@"fixture-up" };
  approval_card_emit_pair(&packet, (ApprovalCardPacketOperations){
    .post = approval_card_selftest_post_event, .wait = approval_card_selftest_wait_event,
    .context = (__bridge void *)packet_calls
  });
  CARD_CHECK(([packet_calls isEqual:@[@"fixture-down", @9000, @"fixture-up", @9000]]));
  CARD_CHECK(approval_card_packet_tag(0) == UINT64_C(0x5444434100000000));
  CARD_CHECK(approval_card_packet_tag(UINT32_MAX) == UINT64_C(0x54444341FFFFFFFF));
  CARD_CHECK(approval_card_input_error(0, false, false, false) == NULL);
  CARD_CHECK(approval_card_input_error(kCGEventFlagMaskAlphaShift, false, false, false) == NULL);
  CGEventFlags modifiers[] = {kCGEventFlagMaskShift, kCGEventFlagMaskControl, kCGEventFlagMaskAlternate,
    kCGEventFlagMaskCommand, kCGEventFlagMaskSecondaryFn};
  for (unsigned i = 0; i < sizeof(modifiers) / sizeof(modifiers[0]); i++) {
    CARD_CHECK(approval_error_is(approval_card_input_error(modifiers[i], false, false, false), "input-active"));
  }
  CARD_CHECK(approval_error_is(approval_card_input_error(0, true, false, false), "input-active"));
  CARD_CHECK(approval_error_is(approval_card_input_error(0, false, true, false), "input-active"));
  CARD_CHECK(approval_error_is(approval_card_input_error(0, false, false, true), "input-active"));
#undef CARD_CHECK
  printf("{\"checks\":%u,\"failures\":%u,\"live_io\":false}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
