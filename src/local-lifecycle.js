"use strict";

// Pure activity classification and lifecycle reduction for local rollout JSONL.

const { makeActivity } = require("./i18n");

function classifyToolActivity(input) {
  const text = String(input ?? "");
  if (!text) return null;
  if (/tools\.apply_patch|const\s+patch\s*=|\*\*\* Begin Patch/i.test(text)) return makeActivity("edit", "activity.editCode");
  if (/tools\.update_plan/i.test(text)) return makeActivity("edit", "activity.updatePlan");
  if (/tools\.(?:web__run|web\.run)|tools\.mcp__.*(?:search|browse)/i.test(text)) return makeActivity("search", "activity.webSearch");
  if (/tools\.(?:view_image|image_gen__imagegen)/i.test(text)) return makeActivity("inspect", /imagegen/i.test(text) ? "activity.generateImage" : "activity.inspectImage");
  if (/mcp__node_repl__js|sky\.(?:get_app_state|click|press_key|set_value|type_text|scroll)/i.test(text)) {
    return /get_app_state/i.test(text) ? makeActivity("inspect", "activity.inspectApp") : makeActivity("command", "activity.controlApp");
  }
  if (!/tools\.exec_command/i.test(text)) return makeActivity("command", "activity.runTool");
  if (/StreamDeck\/Plugins|com\.elgato\.StreamDeck\/Plugins/i.test(text) && /\b(?:cp|ditto|rsync)\b/i.test(text)) return makeActivity("command", "activity.installPlugin");
  if (/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|pytest|node\s+--test|cargo\s+test|go\s+test|vitest|jest/i.test(text)) return makeActivity("command", "activity.runTests");
  if (/node\s+--check|tsc\s+--noEmit|eslint|ruff\s+check|mypy/i.test(text)) return makeActivity("inspect", "activity.checkCode");
  if (/\bxmllint\b/i.test(text)) return makeActivity("inspect", "activity.checkLayout");
  if (/\bshasum\b/i.test(text)) return makeActivity("inspect", "activity.checkPackage");
  if (/rollout-|session_index\.jsonl|\.jsonl/i.test(text) && /\b(?:tail|jq)\b/i.test(text)) return makeActivity("inspect", "activity.readLogs");
  if (/\bsqlite3\b/i.test(text)) return makeActivity("inspect", "activity.loadTasks");
  if (/\bcodexbar\b/i.test(text)) return makeActivity("inspect", "activity.checkQuota");
  if (/\b(?:rg|grep|find|fd|mdfind)\b/i.test(text)) return makeActivity("search", "activity.findFiles");
  if (/\b(?:sed|head|tail|jq|ls|stat)\b/i.test(text)) return makeActivity("inspect", "activity.readFile");
  if (/\b(?:ps|pgrep|lsof)\b/i.test(text)) return makeActivity("inspect", "activity.checkProcess");
  if (/\b(?:python|python3)\b/i.test(text)) return makeActivity("command", "activity.runPython");
  if (/\b(?:npm|pnpm|yarn|bun)\b/i.test(text)) return makeActivity("command", "activity.runPackage");
  if (/\b(?:mkdir|cp|mv|rsync)\b/i.test(text)) return makeActivity("edit", "activity.organizeFiles");
  return makeActivity("command", "activity.runCommand");
}

function activityFromEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.type === "event_msg") {
    if (payload.type === "task_complete" || payload.type === "turn_aborted") return null;
    if (payload.type === "task_started" || payload.type === "user_message") return makeActivity("request", "activity.request");
    if (payload.type === "patch_apply_end") return makeActivity(payload.success === false ? "error" : "edit", payload.success === false ? "activity.patchFailed" : "activity.editCode");
    if (payload.type === "mcp_tool_call_end") {
      const server = String(payload?.invocation?.server ?? "");
      if (/node_repl/i.test(server)) return makeActivity("inspect", "activity.inspectApp");
      if (/web|browser|chrome/i.test(server)) return makeActivity("search", "activity.checkWeb");
      return makeActivity("inspect", "activity.checkResult");
    }
    if (payload.type === "agent_reasoning") return makeActivity("think", "activity.think");
    if (payload.type === "context_compacted") return makeActivity("edit", "activity.organizeChat");
    if (payload.type === "agent_message") return payload.phase === "final_answer"
      ? makeActivity("answer", "activity.replyReady")
      : makeActivity("answer", "activity.answer");
    return null;
  }
  if (event?.type === "response_item") {
    if (payload.type === "custom_tool_call") return classifyToolActivity(payload.input);
    if (payload.type === "reasoning") return makeActivity("think", "activity.think");
  }
  return null;
}

function composerSettingsFromEvent(event) {
  if (event?.type !== "event_msg"
      || event?.payload?.type !== "thread_settings_applied") return null;
  const settings = event?.payload?.thread_settings ?? {};
  const reasoningEffort = typeof settings.reasoning_effort === "string"
    ? settings.reasoning_effort
    : null;
  const serviceTier = Object.hasOwn(settings, "service_tier")
    ? typeof settings.service_tier === "string" ? settings.service_tier : "default"
    : undefined;
  if (!reasoningEffort && serviceTier === undefined) return null;
  const timestampMs = Date.parse(event?.timestamp ?? "");
  return {
    reasoningEffort,
    serviceTier,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null
  };
}

function lifecycleHasTurnSettings(lifecycle) {
  return Boolean(lifecycle.foundStart && lifecycle.reasoningEffort
    && lifecycle.serviceTier !== undefined);
}

function lifecycleHasComposerSettings(lifecycle) {
  return Boolean(lifecycle.nextReasoningEffort
    || lifecycle.nextServiceTier !== undefined);
}

function consumeLifecycleLines(lines, lifecycle) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!lifecycle.activity) lifecycle.activity = activityFromEvent(event);
    if (event?.type === "turn_context") {
      const effort = event?.payload?.effort;
      if (!lifecycle.reasoningEffort && typeof effort === "string") lifecycle.reasoningEffort = effort;
      if (lifecycle.serviceTier === undefined
          && Object.hasOwn(event?.payload ?? {}, "service_tier")) {
        lifecycle.serviceTier = typeof event.payload.service_tier === "string"
          ? event.payload.service_tier
          : "default";
      }
      if (!lifecycle.turnId && typeof event?.payload?.turn_id === "string") {
        lifecycle.turnId = event.payload.turn_id;
      }
    }
    if (event?.type !== "event_msg") {
      if (lifecycleHasTurnSettings(lifecycle)
          && lifecycleHasComposerSettings(lifecycle)) return true;
      continue;
    }
    const type = event?.payload?.type;
    const composerSettings = composerSettingsFromEvent(event);
    if (composerSettings) {
      // The newest settings event is the live composer selection: it applies
      // to the next run, not retroactively to a turn that is already running.
      if (!lifecycle.nextReasoningEffort && composerSettings.reasoningEffort) {
        lifecycle.nextReasoningEffort = composerSettings.reasoningEffort;
      }
      if (lifecycle.nextServiceTier === undefined
          && composerSettings.serviceTier !== undefined) {
        lifecycle.nextServiceTier = composerSettings.serviceTier;
      }
      if (!Number.isFinite(lifecycle.nextSettingsAtMs)
          && Number.isFinite(composerSettings.timestampMs)) {
        lifecycle.nextSettingsAtMs = composerSettings.timestampMs;
      }

      // Codex emits the settings snapshot immediately before task_started.
      // While scanning backwards, only the first settings row *past* that
      // start boundary belongs to the running/completed turn. Settings seen
      // before finding the boundary happened later and remain next-turn only.
      if (lifecycle.foundStart) {
        const belongsToTurnStart = !Number.isFinite(composerSettings.timestampMs)
          || !Number.isFinite(lifecycle.startedAtMs)
          || composerSettings.timestampMs <= lifecycle.startedAtMs + 1_000;
        if (belongsToTurnStart) {
          if (!lifecycle.reasoningEffort && composerSettings.reasoningEffort) {
            lifecycle.reasoningEffort = composerSettings.reasoningEffort;
          }
          if (lifecycle.serviceTier === undefined
              && composerSettings.serviceTier !== undefined) {
            lifecycle.serviceTier = composerSettings.serviceTier;
          }
        }
      }
    }
    const timestampMs = Date.parse(event?.timestamp ?? "");
    const validTimestamp = Number.isFinite(timestampMs) ? timestampMs : null;
    if (!lifecycle.status) {
      if (type === "task_complete") {
        lifecycle.status = "completed";
        lifecycle.endedAtMs = validTimestamp;
      } else if (type === "turn_aborted") {
        lifecycle.status = "stopped";
        lifecycle.endedAtMs = validTimestamp;
      } else if (type === "task_started" || type === "user_message") {
        lifecycle.status = "working";
      }
    }
    if (lifecycle.status && type === "task_started" && !lifecycle.foundStart) {
      lifecycle.startedAtMs = validTimestamp;
      lifecycle.foundStart = true;
      if (!lifecycle.turnId && typeof event?.payload?.turn_id === "string") {
        lifecycle.turnId = event.payload.turn_id;
      }
    }
    if (lifecycleHasTurnSettings(lifecycle)
        && lifecycleHasComposerSettings(lifecycle)) return true;
  }
  return false;
}

module.exports = {
  classifyToolActivity,
  composerSettingsFromEvent,
  activityFromEvent,
  consumeLifecycleLines
};
