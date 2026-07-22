"use strict";

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function createImageDeliveryQueue(options = {}) {
  const deliver = options.deliver;
  if (typeof deliver !== "function") throw new TypeError("deliver must be a function");

  const isOpen = typeof options.isOpen === "function" ? options.isOpen : () => true;
  const bufferedAmount = typeof options.bufferedAmount === "function"
    ? options.bufferedAmount
    : () => 0;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const schedule = typeof options.schedule === "function" ? options.schedule : setTimeout;
  const cancel = typeof options.cancel === "function" ? options.cancel : clearTimeout;
  const resolvePolicy = typeof options.resolvePolicy === "function"
    ? options.resolvePolicy
    : () => options;
  const onAdaptiveChange = typeof options.onAdaptiveChange === "function"
    ? options.onAdaptiveChange
    : () => {};
  const fallbackPolicy = Object.freeze({
    lane: "default",
    minContextIntervalMs: finiteNonNegative(options.minContextIntervalMs, 80),
    minGlobalIntervalMs: finiteNonNegative(options.minGlobalIntervalMs, 28),
    maxBufferedBytes: finiteNonNegative(options.maxBufferedBytes, 64 * 1024),
    backpressureRetryMs: finiteNonNegative(options.backpressureRetryMs, 50),
    maxSlowdownMultiplier: finiteNonNegative(options.maxSlowdownMultiplier, 4) || 4,
    recoveryMs: finiteNonNegative(options.recoveryMs, 3_000)
  });

  const pendingByContext = new Map();
  const timerByContext = new Map();
  const lastSentAtByContext = new Map();
  const lastGlobalSentAtByLane = new Map();
  const adaptiveStateByLane = new Map();

  function policyFor(context) {
    const resolved = resolvePolicy(context) ?? {};
    return {
      lane: String(resolved.lane ?? fallbackPolicy.lane),
      minContextIntervalMs: finiteNonNegative(
        resolved.minContextIntervalMs,
        fallbackPolicy.minContextIntervalMs
      ),
      minGlobalIntervalMs: finiteNonNegative(
        resolved.minGlobalIntervalMs,
        fallbackPolicy.minGlobalIntervalMs
      ),
      maxBufferedBytes: finiteNonNegative(
        resolved.maxBufferedBytes,
        fallbackPolicy.maxBufferedBytes
      ),
      backpressureRetryMs: finiteNonNegative(
        resolved.backpressureRetryMs,
        fallbackPolicy.backpressureRetryMs
      ),
      maxSlowdownMultiplier: Math.max(1, finiteNonNegative(
        resolved.maxSlowdownMultiplier,
        fallbackPolicy.maxSlowdownMultiplier
      )),
      recoveryMs: finiteNonNegative(resolved.recoveryMs, fallbackPolicy.recoveryMs)
    };
  }

  function adaptiveState(lane) {
    if (!adaptiveStateByLane.has(lane)) {
      adaptiveStateByLane.set(lane, {
        slowdownMultiplier: 1,
        lastPressureAtMs: Number.NEGATIVE_INFINITY,
        lastRecoveryAtMs: Number.NEGATIVE_INFINITY
      });
    }
    return adaptiveStateByLane.get(lane);
  }

  function noteBackpressure(lane, policy, nowMs) {
    const state = adaptiveState(lane);
    const previousMultiplier = state.slowdownMultiplier;
    state.slowdownMultiplier = Math.min(
      policy.maxSlowdownMultiplier,
      Math.max(1.5, state.slowdownMultiplier * 1.5)
    );
    state.lastPressureAtMs = nowMs;
    state.lastRecoveryAtMs = nowMs;
    if (state.slowdownMultiplier !== previousMultiplier) {
      onAdaptiveChange(Object.freeze({
        lane,
        reason: "backpressure",
        slowdownMultiplier: state.slowdownMultiplier
      }));
    }
    return state;
  }

  function recoverLane(lane, policy, nowMs) {
    const state = adaptiveState(lane);
    if (state.slowdownMultiplier <= 1 || policy.recoveryMs <= 0) return state;
    const quietForMs = nowMs - state.lastPressureAtMs;
    const sinceRecoveryMs = nowMs - state.lastRecoveryAtMs;
    if (quietForMs >= policy.recoveryMs && sinceRecoveryMs >= policy.recoveryMs) {
      const previousMultiplier = state.slowdownMultiplier;
      state.slowdownMultiplier = Math.max(1, state.slowdownMultiplier / 1.5);
      state.lastRecoveryAtMs = nowMs;
      if (state.slowdownMultiplier !== previousMultiplier) {
        onAdaptiveChange(Object.freeze({
          lane,
          reason: "recovery",
          slowdownMultiplier: state.slowdownMultiplier
        }));
      }
    }
    return state;
  }

  function waitForContext(context, nowMs, intervalMs) {
    const lastSentAtMs = lastSentAtByContext.get(context);
    return Number.isFinite(lastSentAtMs)
      ? Math.max(0, intervalMs - (nowMs - lastSentAtMs))
      : 0;
  }

  function waitForGlobal(lane, nowMs, intervalMs) {
    const lastGlobalSentAtMs = lastGlobalSentAtByLane.get(lane);
    return Number.isFinite(lastGlobalSentAtMs)
      ? Math.max(0, intervalMs - (nowMs - lastGlobalSentAtMs))
      : 0;
  }

  function scheduleFlush(context, delayMs) {
    if (timerByContext.has(context)) return;
    const timer = schedule(() => {
      timerByContext.delete(context);
      flush(context);
    }, Math.max(1, Math.ceil(delayMs)));
    timerByContext.set(context, timer);
  }

  function flush(context) {
    if (!pendingByContext.has(context)) return false;
    if (!isOpen()) {
      pendingByContext.delete(context);
      return false;
    }

    const nowMs = now();
    const policy = policyFor(context);
    const socketBackpressured = finiteNonNegative(bufferedAmount(), 0) >= policy.maxBufferedBytes;
    const adaptive = socketBackpressured
      ? noteBackpressure(policy.lane, policy, nowMs)
      : recoverLane(policy.lane, policy, nowMs);
    const contextIntervalMs = policy.minContextIntervalMs * adaptive.slowdownMultiplier;
    const globalIntervalMs = policy.minGlobalIntervalMs * adaptive.slowdownMultiplier;
    const intervalWaitMs = Math.max(
      waitForContext(context, nowMs, contextIntervalMs),
      waitForGlobal(policy.lane, nowMs, globalIntervalMs)
    );
    const waitMs = socketBackpressured
      ? Math.max(intervalWaitMs, policy.backpressureRetryMs * adaptive.slowdownMultiplier)
      : intervalWaitMs;
    if (waitMs > 0) {
      scheduleFlush(context, waitMs);
      return false;
    }

    const payload = pendingByContext.get(context);
    pendingByContext.delete(context);
    if (deliver(context, payload) === false) return false;
    lastSentAtByContext.set(context, nowMs);
    lastGlobalSentAtByLane.set(policy.lane, nowMs);
    return true;
  }

  function enqueue(context, payload) {
    if (!isOpen()) return false;
    pendingByContext.set(context, payload);
    if (!timerByContext.has(context)) flush(context);
    return true;
  }

  function remove(context) {
    const timer = timerByContext.get(context);
    if (timer !== undefined) cancel(timer);
    timerByContext.delete(context);
    pendingByContext.delete(context);
    lastSentAtByContext.delete(context);
  }

  function resetLane(lane) {
    const key = String(lane ?? fallbackPolicy.lane);
    lastGlobalSentAtByLane.delete(key);
    adaptiveStateByLane.delete(key);
  }

  function clear() {
    for (const timer of timerByContext.values()) cancel(timer);
    timerByContext.clear();
    pendingByContext.clear();
    lastSentAtByContext.clear();
    lastGlobalSentAtByLane.clear();
    adaptiveStateByLane.clear();
  }

  function pendingCount() {
    return pendingByContext.size;
  }

  function laneSnapshot(lane) {
    const key = String(lane ?? fallbackPolicy.lane);
    const state = adaptiveStateByLane.get(key);
    return Object.freeze({
      lane: key,
      slowdownMultiplier: state?.slowdownMultiplier ?? 1,
      lastGlobalSentAtMs: lastGlobalSentAtByLane.get(key) ?? null
    });
  }

  return { enqueue, flush, remove, resetLane, clear, pendingCount, laneSnapshot };
}

module.exports = { createImageDeliveryQueue };
