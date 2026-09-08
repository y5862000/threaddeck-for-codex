"use strict";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sharedExecutionState = { tail: Promise.resolve(), attempted: new Set() };

function normalizeApprovalIdentity(value) {
  if (!value || !THREAD_ID.test(value.threadId ?? "")
      || !["exec", "patch", "permissionRequest"].includes(value.kind)
      || !((typeof value.requestId === "string" && value.requestId.length > 0)
        || (Number.isSafeInteger(value.requestId) && value.requestId >= 0))
      || typeof value.hostId !== "string" || value.hostId.length === 0) return null;
  return {
    threadId: value.threadId.toLowerCase(),
    hostId: value.hostId,
    requestId: value.requestId,
    kind: value.kind
  };
}

function approvalIdentityKey(value) {
  const identity = normalizeApprovalIdentity(value);
  return identity ? JSON.stringify([
    identity.threadId, identity.hostId, identity.kind, identity.requestId
  ]) : null;
}

function isApprovalContextCurrent(isCurrent) {
  if (isCurrent == null) return true;
  try {
    return typeof isCurrent === "function" && isCurrent() === true;
  } catch {
    return false;
  }
}

// The queue is shared across action contexts and bridge instances. Capture the
// request at the original press, before queuing, so a second key cannot approve
// the next prompt merely because the first action finished while it waited.
class ApprovalControls {
  constructor({ readRequest, respond, executionState = sharedExecutionState }) {
    this.readRequest = readRequest;
    this.respond = respond;
    this.executionState = executionState;
  }

  execute(decision, threadId, options = {}) {
    if (!["approve", "decline"].includes(decision) || !THREAD_ID.test(threadId ?? "")) {
      return Promise.resolve({ ok: false, reason: "unavailable", delivery: "none" });
    }
    const isCurrent = options.isCurrent;
    const cancelled = () => ({ ok: false, reason: "cancelled", delivery: "none" });
    if (!isApprovalContextCurrent(isCurrent)) return Promise.resolve(cancelled());
    const expectedThreadId = threadId.toLowerCase();
    const capture = Promise.resolve().then(() => !isApprovalContextCurrent(isCurrent)
      ? null
      : Object.hasOwn(options, "request") ? options.request : this.readRequest(expectedThreadId))
      .then(normalizeApprovalIdentity, () => null);
    const execute = async () => {
      if (!isApprovalContextCurrent(isCurrent)) return cancelled();
      const request = await capture;
      if (!isApprovalContextCurrent(isCurrent)) return cancelled();
      if (!request || request.threadId !== expectedThreadId) {
        return { ok: false, reason: "unavailable", delivery: "none" };
      }
      const key = approvalIdentityKey(request);
      if (this.executionState.attempted.has(key)) {
        return { ok: false, reason: "already-handled", delivery: "none" };
      }
      let fresh;
      try {
        fresh = normalizeApprovalIdentity(await this.readRequest(expectedThreadId));
      } catch {
        if (!isApprovalContextCurrent(isCurrent)) return cancelled();
        return { ok: false, reason: "unavailable", delivery: "none" };
      }
      // A key context can disappear or change settings while this read awaits
      // the renderer. Cancellation is authoritative until dispatch begins.
      if (!isApprovalContextCurrent(isCurrent)) return cancelled();
      if (approvalIdentityKey(fresh) !== key) {
        return { ok: false, reason: "changed", delivery: "none" };
      }
      this.executionState.attempted.add(key);
      try {
        const result = await this.respond(decision, request, { isCurrent });
        if (result?.delivered === true) {
          // Codex's card callback starts its own async RPC and returns void.
          // Acknowledging invocation does not claim the request was resolved.
          return { ok: true, delivery: "invoked", request };
        }
        if (result?.delivered === false && result?.delivery === "none") {
          // The bridge proved that its synchronous pre-dispatch guard rejected
          // this request. A later deliberate press may inspect it again.
          this.executionState.attempted.delete(key);
          return { ok: false, reason: result.reason ?? "changed", delivery: "none" };
        }
      } catch {
        // Once respond has been called, even a disconnect labelled unavailable
        // may have followed successful dispatch. Never retry or fall back.
      }
      return { ok: false, reason: "delivery-unknown", delivery: "unknown" };
    };
    const result = this.executionState.tail.then(execute, execute);
    this.executionState.tail = result.then(() => {}, () => {});
    return result;
  }
}

// Runs only inside an existing, compatible renderer transport. No module
// imports, synthetic HID activation, keyboard events, or global command runner
// are used: the visible card supplies the exact request-bound once/deny action.
// The semantic card/owner props were inspected in Codex 26.901.51231. Unknown
// surfaces (including config changes, sharing, and input forms) fail closed.
function inspectApprovalSurface(expectedThreadId, decision = null) {
  const normalizeThreadId = (value) => {
    if (typeof value !== "string") return null;
    const match = value.match(/(?:^|[:/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return match?.[1]?.toLowerCase() ?? null;
  };
  const visible = (element) => Boolean(element?.isConnected
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden"
    && !element.closest('[inert], [aria-hidden="true"]'));
  const expected = normalizeThreadId(expectedThreadId);
  if (!expected) return null;
  const focused = document.activeElement;
  if (focused?.closest('[data-app-shell-tab-panel-controller="right"], [data-tab-id^="sidechat:"]')) return null;
  if ([...document.querySelectorAll('[role="dialog"], [role="menu"]')].some(visible)) return null;
  const composers = [...document.querySelectorAll('[data-codex-composer-root]')]
    .filter((element) => visible(element)
      && !element.closest('[data-app-shell-tab-panel-controller="right"], [data-tab-id^="sidechat:"]'));
  // The above-composer portal is a child of the composer root in current
  // Codex. Scope the identity read to that main composer, including when the
  // sidebar is unmounted, and reject conflicting portals during navigation.
  const portalIds = composers.flatMap((element) => (
    [...element.querySelectorAll('[data-above-composer-conversation-id]')]
      .filter((portal) => visible(portal) && portal.closest('[data-codex-composer-root]') === element)
      .map((portal) => normalizeThreadId(portal.getAttribute('data-above-composer-conversation-id')))
  ));
  if (portalIds.some((id) => id === null)) return null;
  const currentIds = new Set(portalIds);
  if (currentIds.size !== 1 || !currentIds.has(expected)) return null;
  for (const selected of document.querySelectorAll(
    '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], '
      + '[data-app-action-sidebar-thread-id][aria-current="page"]'
  )) {
    const selectedId = normalizeThreadId(selected.getAttribute('data-app-action-sidebar-thread-id'));
    if (selectedId) currentIds.add(selectedId);
  }
  if (currentIds.size !== 1 || !currentIds.has(expected)) return null;

  const surfaces = [...document.querySelectorAll('[data-codex-approval-surface]')].filter(visible);
  // Multiple cards include background agents and cannot be disambiguated by a
  // single current-task command. Do not silently choose the first one.
  if (surfaces.length !== 1) return null;
  const surface = surfaces[0];
  const reactKey = Object.getOwnPropertyNames(surface).find((key) => key.startsWith('__reactFiber$'));
  let fiber = reactKey ? surface[reactKey] : null;
  const rootOf = (value) => {
    let root = value;
    for (let depth = 0; root?.return && depth < 200; depth++) root = root.return;
    return root?.return ? null : root;
  };
  // React may retain the host element's original fiber after a commit. Resolve
  // its current branch before reading callbacks; the alternate can still carry
  // the previous request even though the DOM now displays its replacement.
  let root = rootOf(fiber);
  if (!root?.stateNode?.current) return null;
  if (root.stateNode.current !== root) {
    fiber = fiber?.alternate;
    root = rootOf(fiber);
    if (!root || root.stateNode?.current !== root) return null;
  }
  let actions = null;
  let owner = null;
  for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== "object") continue;
    if (!actions && typeof props.actions?.onApprove === "function"
        && typeof props.actions?.onDeny === "function") actions = props.actions;
    if (!actions) continue;
    if (props.item && ["exec", "patch"].includes(props.item.type)
        && props.item.approvalRequestId != null) {
      owner = {
        threadId: normalizeThreadId(props.conversationId),
        hostId: props.hostId,
        requestId: props.item.approvalRequestId,
        kind: props.item.type
      };
      break;
    }
    if (props.pendingRequest?.permissions
        && props.pendingRequest.requestId != null && props.conversationId) {
      owner = {
        threadId: normalizeThreadId(props.conversationId),
        hostId: props.hostId,
        requestId: props.pendingRequest.requestId,
        kind: "permissionRequest"
      };
      break;
    }
    // The immediate card owner must identify its request. Never keep walking
    // through an unknown owner to reuse an unrelated ancestor's pending item.
    if (props.conversationId || props.item || props.pendingRequest) return null;
  }
  if (!owner || owner.threadId !== expected || typeof owner.hostId !== "string"
      || owner.hostId.length === 0 || actions.isLoading === true
      || (decision === "approve" && actions.approveDisabled === true) || actions.disableHotkeys === true
      || actions.approveLabel != null
      || !((typeof owner.requestId === "string" && owner.requestId.length > 0)
        || (Number.isSafeInteger(owner.requestId) && owner.requestId >= 0))) return null;
  const buttons = [...surface.querySelectorAll('button')].filter(visible);
  // Optional scope and leading buttons have independent disabled states. The
  // verified card's primary once/deny callbacks use the action state above;
  // an unrelated disabled secondary button must not disable those controls.
  if (buttons.length < 2) return null;
  return { identity: owner, actions, surface };
}

function approvalRequestExpression(threadId) {
  if (!THREAD_ID.test(threadId ?? "")) throw new TypeError("A current task UUID is required.");
  return `(() => {
    const inspect = ${inspectApprovalSurface.toString()};
    return inspect(${JSON.stringify(threadId.toLowerCase())})?.identity ?? null;
  })()`;
}

function approvalResponseExpression(decision, value) {
  const identity = normalizeApprovalIdentity(value);
  if (!["approve", "decline"].includes(decision) || !identity) {
    throw new TypeError("A decision and exact approval request are required.");
  }
  return `(() => {
    const inspect = ${inspectApprovalSurface.toString()};
    const expected = ${JSON.stringify(identity)};
    const candidate = inspect(expected.threadId, ${JSON.stringify(decision)});
    if (!candidate || candidate.identity.threadId !== expected.threadId
        || candidate.identity.hostId !== expected.hostId
        || candidate.identity.kind !== expected.kind
        || candidate.identity.requestId !== expected.requestId) {
      return { delivered: false, delivery: 'none', reason: 'changed' };
    }
    // Inspection and this exact callback are synchronous in the same renderer
    // turn, so navigation/request updates cannot retarget the action in between.
    const action = candidate.actions[${JSON.stringify(decision === "approve" ? "onApprove" : "onDeny")}];
    action();
    return { delivered: true };
  })()`;
}

module.exports = {
  ApprovalControls,
  approvalIdentityKey,
  approvalRequestExpression,
  approvalResponseExpression,
  isApprovalContextCurrent,
  normalizeApprovalIdentity
};
