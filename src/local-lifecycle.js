"use strict";

// Pure activity classification and lifecycle reduction for local rollout JSONL.

function classifyToolActivity(input) {
  const text = String(input ?? "");
  if (!text) return null;
  if (/tools\.apply_patch|const\s+patch\s*=|\*\*\* Begin Patch/i.test(text)) return { kind: "edit", label: "코드 수정" };
  if (/tools\.update_plan/i.test(text)) return { kind: "edit", label: "계획 정리" };
  if (/tools\.(?:web__run|web\.run)|tools\.mcp__.*(?:search|browse)/i.test(text)) return { kind: "search", label: "웹 검색" };
  if (/tools\.(?:view_image|image_gen__imagegen)/i.test(text)) return { kind: "inspect", label: /imagegen/i.test(text) ? "이미지 생성" : "이미지 확인" };
  if (/mcp__node_repl__js|sky\.(?:get_app_state|click|press_key|set_value|type_text|scroll)/i.test(text)) {
    return /get_app_state/i.test(text) ? { kind: "inspect", label: "앱 화면 확인" } : { kind: "command", label: "앱 조작" };
  }
  if (!/tools\.exec_command/i.test(text)) return { kind: "command", label: "도구 실행" };
  if (/StreamDeck\/Plugins|com\.elgato\.StreamDeck\/Plugins/i.test(text) && /\b(?:cp|ditto|rsync)\b/i.test(text)) return { kind: "command", label: "플러그인 설치" };
  if (/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|pytest|node\s+--test|cargo\s+test|go\s+test|vitest|jest/i.test(text)) return { kind: "command", label: "테스트 실행" };
  if (/node\s+--check|tsc\s+--noEmit|eslint|ruff\s+check|mypy/i.test(text)) return { kind: "inspect", label: "코드 검증" };
  if (/\bxmllint\b/i.test(text)) return { kind: "inspect", label: "화면 구조 검증" };
  if (/\bshasum\b/i.test(text)) return { kind: "inspect", label: "설치 파일 확인" };
  if (/rollout-|session_index\.jsonl|\.jsonl/i.test(text) && /\b(?:tail|jq)\b/i.test(text)) return { kind: "inspect", label: "활동 기록 확인" };
  if (/\bsqlite3\b/i.test(text)) return { kind: "inspect", label: "작업 목록 확인" };
  if (/\bcodexbar\b/i.test(text)) return { kind: "inspect", label: "사용량 확인" };
  if (/\b(?:rg|grep|find|fd|mdfind)\b/i.test(text)) return { kind: "search", label: "파일 검색" };
  if (/\b(?:sed|head|tail|jq|ls|stat)\b/i.test(text)) return { kind: "inspect", label: "파일 내용 확인" };
  if (/\b(?:ps|pgrep|lsof)\b/i.test(text)) return { kind: "inspect", label: "실행 상태 확인" };
  if (/\b(?:python|python3)\b/i.test(text)) return { kind: "command", label: "Python 실행" };
  if (/\b(?:npm|pnpm|yarn|bun)\b/i.test(text)) return { kind: "command", label: "패키지 명령" };
  if (/\b(?:mkdir|cp|mv|rsync)\b/i.test(text)) return { kind: "edit", label: "파일 정리" };
  return { kind: "command", label: "명령 실행" };
}

function activityFromEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.type === "event_msg") {
    if (payload.type === "task_complete" || payload.type === "turn_aborted") return null;
    if (payload.type === "task_started" || payload.type === "user_message") return { kind: "request", label: "요청 분석" };
    if (payload.type === "patch_apply_end") return { kind: payload.success === false ? "error" : "edit", label: payload.success === false ? "수정 실패" : "코드 수정" };
    if (payload.type === "mcp_tool_call_end") {
      const server = String(payload?.invocation?.server ?? "");
      if (/node_repl/i.test(server)) return { kind: "inspect", label: "앱 화면 확인" };
      if (/web|browser|chrome/i.test(server)) return { kind: "search", label: "웹 결과 확인" };
      return { kind: "inspect", label: "도구 결과 확인" };
    }
    if (payload.type === "agent_reasoning") return { kind: "think", label: "생각 중" };
    if (payload.type === "context_compacted") return { kind: "edit", label: "대화 정리" };
    if (payload.type === "agent_message") return payload.phase === "final_answer"
      ? { kind: "answer", label: "답변 완료" }
      : { kind: "answer", label: "답변 작성" };
    return null;
  }
  if (event?.type === "response_item") {
    if (payload.type === "custom_tool_call") return classifyToolActivity(payload.input);
    if (payload.type === "reasoning") return { kind: "think", label: "생각 중" };
  }
  return null;
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
    }
    if (event?.type !== "event_msg") {
      if (lifecycle.foundStart && lifecycle.reasoningEffort && lifecycle.serviceTier !== undefined) return true;
      continue;
    }
    const type = event?.payload?.type;
    if (type === "thread_settings_applied") {
      const settings = event?.payload?.thread_settings ?? {};
      if (!lifecycle.reasoningEffort && typeof settings.reasoning_effort === "string") {
        lifecycle.reasoningEffort = settings.reasoning_effort;
      }
      if (lifecycle.serviceTier === undefined && Object.hasOwn(settings, "service_tier")) {
        lifecycle.serviceTier = typeof settings.service_tier === "string" ? settings.service_tier : "default";
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
    }
    if (lifecycle.foundStart && lifecycle.reasoningEffort && lifecycle.serviceTier !== undefined) return true;
  }
  return false;
}

module.exports = {
  classifyToolActivity,
  activityFromEvent,
  consumeLifecycleLines
};
