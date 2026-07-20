"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applySideChatLogLine,
  createSideChatDiscoveryState,
  openDiscoveredSideChats
} = require("../src/side-chat-state");

function uuidV7At(timestampMs, suffix) {
  const timestamp = timestampMs.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function responseLine(timestampMs, method, conversationId, originId = 1, errorCode = "null") {
  return `${new Date(timestampMs).toISOString()} info [AppServerConnection] response_routed conversationId=${conversationId} errorCode=${errorCode} hadPending=true method=${method} originWebcontentsId=${originId}`;
}

test("desktop fork/inject pairs preserve multiple Side Chats under one task", () => {
  const state = createSideChatDiscoveryState();
  const sessionStartedAtMs = Date.parse("2026-07-20T16:00:00.000Z");
  const parentId = "019f6bcb-ad00-7bf2-96a4-7a35f3709515";
  const firstAtMs = Date.parse("2026-07-20T16:42:43.581Z");
  const secondAtMs = Date.parse("2026-07-20T16:50:25.484Z");
  const firstId = uuidV7At(firstAtMs, 1);
  const secondId = uuidV7At(secondAtMs, 2);

  applySideChatLogLine(
    state,
    responseLine(firstAtMs - 2, "thread/fork", parentId),
    { sessionStartedAtMs }
  );
  applySideChatLogLine(
    state,
    responseLine(firstAtMs, "thread/inject_items", firstId),
    { sessionStartedAtMs }
  );
  applySideChatLogLine(
    state,
    responseLine(secondAtMs - 2, "thread/fork", parentId),
    { sessionStartedAtMs }
  );
  applySideChatLogLine(
    state,
    responseLine(secondAtMs, "thread/inject_items", secondId),
    { sessionStartedAtMs }
  );

  const open = openDiscoveredSideChats(state);
  assert.deepEqual(open.map(({ id }) => id), [secondId, firstId]);
  assert.deepEqual(open.map(({ parentId: id }) => id), [parentId, parentId]);
});

test("fork pairing stays scoped to the originating Codex window", () => {
  const state = createSideChatDiscoveryState();
  const startedAtMs = Date.parse("2026-07-20T17:00:00.000Z");
  const parentA = "019f6bcb-ad00-7bf2-96a4-7a35f3709515";
  const parentB = "019f560a-5ce0-7640-b3a2-822638dccd73";
  const firstAtMs = startedAtMs + 1_000;
  const secondAtMs = startedAtMs + 1_100;
  const sideA = uuidV7At(firstAtMs + 200, 3);
  const sideB = uuidV7At(secondAtMs + 200, 4);

  applySideChatLogLine(state, responseLine(firstAtMs, "thread/fork", parentA, 1), {
    sessionStartedAtMs: startedAtMs
  });
  applySideChatLogLine(state, responseLine(secondAtMs, "thread/fork", parentB, 7), {
    sessionStartedAtMs: startedAtMs
  });
  applySideChatLogLine(state, responseLine(secondAtMs + 200, "thread/inject_items", sideB, 7), {
    sessionStartedAtMs: startedAtMs
  });
  applySideChatLogLine(state, responseLine(firstAtMs + 400, "thread/inject_items", sideA, 1), {
    sessionStartedAtMs: startedAtMs
  });

  assert.equal(state.recordsById.get(sideA)?.parentId, parentA);
  assert.equal(state.recordsById.get(sideB)?.parentId, parentB);
});

test("unsubscribing closes only the matching Side Chat", () => {
  const state = createSideChatDiscoveryState();
  const startedAtMs = Date.parse("2026-07-20T18:00:00.000Z");
  const parentId = "019f6bcb-ad00-7bf2-96a4-7a35f3709515";
  const firstId = uuidV7At(startedAtMs + 1_000, 5);
  const secondId = uuidV7At(startedAtMs + 2_000, 6);

  for (const [index, sideId] of [firstId, secondId].entries()) {
    const atMs = startedAtMs + (index + 1) * 1_000;
    applySideChatLogLine(state, responseLine(atMs - 1, "thread/fork", parentId), {
      sessionStartedAtMs: startedAtMs
    });
    applySideChatLogLine(state, responseLine(atMs, "thread/inject_items", sideId), {
      sessionStartedAtMs: startedAtMs
    });
  }
  applySideChatLogLine(
    state,
    responseLine(startedAtMs + 3_000, "thread/unsubscribe", firstId),
    { sessionStartedAtMs: startedAtMs }
  );

  assert.deepEqual(openDiscoveredSideChats(state).map(({ id }) => id), [secondId]);
  assert.equal(state.closedAtById.has(firstId), true);
  assert.equal(state.closedAtById.has(secondId), false);
});

test("stale, failed, and now-persistent conversations cannot re-enter as Side Chats", () => {
  const state = createSideChatDiscoveryState();
  const startedAtMs = Date.parse("2026-07-20T19:00:00.000Z");
  const parentId = "019f6bcb-ad00-7bf2-96a4-7a35f3709515";
  const staleId = uuidV7At(startedAtMs - 60_000, 7);
  const failedId = uuidV7At(startedAtMs + 2_000, 8);
  const persistentId = uuidV7At(startedAtMs + 3_000, 9);

  applySideChatLogLine(state, responseLine(startedAtMs + 1_000, "thread/inject_items", staleId), {
    sessionStartedAtMs: startedAtMs
  });
  applySideChatLogLine(
    state,
    responseLine(startedAtMs + 2_000, "thread/inject_items", failedId, 1, "internal"),
    { sessionStartedAtMs: startedAtMs }
  );
  applySideChatLogLine(state, responseLine(startedAtMs + 2_999, "thread/fork", parentId), {
    sessionStartedAtMs: startedAtMs
  });
  applySideChatLogLine(state, responseLine(startedAtMs + 3_000, "thread/inject_items", persistentId), {
    sessionStartedAtMs: startedAtMs
  });

  assert.equal(state.recordsById.has(staleId), false);
  assert.equal(state.recordsById.has(failedId), false);
  assert.deepEqual(openDiscoveredSideChats(state, new Set([persistentId])), []);
});
