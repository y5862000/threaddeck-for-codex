"use strict";

const {
  ACTIONS,
  DEFAULT_PROFILE_PAGE_COUNT,
  MEDIA_COMMAND_BY_ACTION,
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
  ACTIONS.appSwitch,
  ACTIONS.fastMode,
  ACTIONS.reasoning
]);
const THREADS_PAGE_ACTIONS = new Set(RANKED_THREAD_ACTIONS);
const MEDIA_PAGE_ACTIONS = new Set(MEDIA_COMMAND_BY_ACTION.keys());
const PROFILE_PAGE_ACTIONS = [
  DASHBOARD_PAGE_ACTIONS,
  THREADS_PAGE_ACTIONS,
  MEDIA_PAGE_ACTIONS
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

function resolveProfilePageTarget(action, settings = {}, visibleActions = []) {
  const direction = PAGE_DIRECTION_BY_ACTION.get(action);
  if (!direction) return null;

  const configuredCount = integerSetting(settings?.pageCount);
  const pageCount = configuredCount && configuredCount > 0
    ? configuredCount
    : DEFAULT_PROFILE_PAGE_COUNT;
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
    pageCount,
    page: (currentPage + direction + pageCount) % pageCount,
    source: configuredPage === currentPage ? "settings" : "visible-actions"
  };
}

module.exports = {
  inferThreadDeckPage,
  resolveProfilePageTarget
};
