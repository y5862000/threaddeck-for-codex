"use strict";

const {
  ACTIONS,
  DEFAULT_PROFILE_PAGE_COUNT,
  PAGE_DIRECTION_BY_ACTION,
  RANKED_THREAD_ACTIONS
} = require("./config");

const DASHBOARD_PAGE_ACTIONS = new Set([
  ACTIONS.weekly,
  ACTIONS.thread1,
  ACTIONS.sideChat,
  ACTIONS.newThread,
  ACTIONS.voice,
  ACTIONS.send,
  ACTIONS.fastMode,
  ACTIONS.reasoning
]);
const THREADS_PAGE_ACTIONS = new Set(RANKED_THREAD_ACTIONS);
const PROFILE_PAGE_ACTIONS = [
  DASHBOARD_PAGE_ACTIONS,
  THREADS_PAGE_ACTIONS
];

function integerSetting(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function inferThreadDeckPage(visibleActions = []) {
  const actions = new Set(visibleActions);
  const matches = PROFILE_PAGE_ACTIONS.flatMap((pageActions, page) => (
    [...pageActions].some((action) => actions.has(action)) ? [page] : []
  ));
  return matches.length === 1 ? matches[0] : null;
}

function pageDirectionFromSettings(action, settings = {}) {
  const configured = String(settings?.pageDirection ?? "").trim().toLowerCase();
  if (configured === "next") return 1;
  if (configured === "previous") return -1;
  return PAGE_DIRECTION_BY_ACTION.get(action) ?? null;
}

function resolveProfilePageTarget(action, settings = {}, visibleActions = []) {
  const direction = pageDirectionFromSettings(action, settings);
  if (!direction) return null;

  const pageCount = DEFAULT_PROFILE_PAGE_COUNT;
  const configuredPage = integerSetting(settings?.currentPage);
  const inferredPage = inferThreadDeckPage(visibleActions);
  const currentPage = configuredPage !== null
    && configuredPage >= 0
    && configuredPage < pageCount
    ? configuredPage
    : inferredPage !== null && inferredPage < pageCount
      ? inferredPage
      : null;
  if (currentPage === null) return null;

  return {
    currentPage,
    direction,
    pageCount,
    page: (currentPage + direction + pageCount) % pageCount,
    source: configuredPage === currentPage ? "settings" : "visible-actions"
  };
}

module.exports = {
  inferThreadDeckPage,
  pageDirectionFromSettings,
  resolveProfilePageTarget
};
