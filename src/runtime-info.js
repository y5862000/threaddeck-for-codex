"use strict";

const { normalizeLanguage } = require("./i18n");

function parseRegistrationInfo(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function runtimeLanguage(registrationInfo, override) {
  if (override) return normalizeLanguage(override);
  return normalizeLanguage(registrationInfo?.application?.language);
}

function runtimePlatform(registrationInfo) {
  const platform = String(registrationInfo?.application?.platform ?? "").toLowerCase();
  if (platform === "mac" || platform === "windows") return platform;
  return "unknown";
}

function runtimeCapabilities(registrationInfo) {
  const platform = runtimePlatform(registrationInfo);
  return Object.freeze({
    platform,
    supported: platform === "mac",
    nativeBridge: platform === "mac" ? "keybridge" : null,
    supportsCodexDesktopAutomation: platform === "mac",
    supportsMediaControl: platform === "mac"
  });
}

module.exports = {
  parseRegistrationInfo,
  runtimeCapabilities,
  runtimeLanguage,
  runtimePlatform
};
