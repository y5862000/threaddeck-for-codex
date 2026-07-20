"use strict";

const fs = require("node:fs/promises");

const REASONING_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

function normalizeReasoningEfforts(values) {
  const observed = new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => REASONING_EFFORT_ORDER.includes(value))
  );
  return REASONING_EFFORT_ORDER.filter((value) => observed.has(value));
}

function unescapeTomlBasicString(value) {
  try {
    // TOML basic strings and JSON strings share the escape sequences used by
    // Codex's model and effort settings. The regular expressions above retain
    // the escapes, so wrapping the capture directly preserves them correctly.
    return JSON.parse(`"${String(value)}"`);
  } catch {
    return String(value);
  }
}

function tomlString(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text ?? "").match(
    new RegExp(`(?:^|\\n)\\s*${escapedKey}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "m")
  );
  return match ? unescapeTomlBasicString(match[1]) : null;
}

function tomlStringArray(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text ?? "").match(
    new RegExp(`(?:^|\\n)\\s*${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m")
  );
  if (!match) return [];
  return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((entry) => unescapeTomlBasicString(entry[1]));
}

function modelReasoningEfforts(modelCache, modelSlug) {
  const models = Array.isArray(modelCache?.models) ? modelCache.models : [];
  const normalizedSlug = String(modelSlug ?? "").trim().toLowerCase();
  const model = models.find((candidate) => [
    candidate?.slug,
    candidate?.id,
    candidate?.model,
    candidate?.display_name
  ].some((value) => String(value ?? "").trim().toLowerCase() === normalizedSlug));
  return normalizeReasoningEfforts(
    model?.supported_reasoning_levels?.map((level) => level?.effort ?? level)
  );
}

function reasoningOptionCatalog(configText, modelCache) {
  const model = tomlString(configText, "model");
  const enabled = normalizeReasoningEfforts(
    tomlStringArray(configText, "enabled-reasoning-efforts")
  );
  const supported = modelReasoningEfforts(modelCache, model);
  const visible = enabled.length > 0 && supported.length > 0
    ? enabled.filter((effort) => supported.includes(effort))
    : enabled.length > 0
      ? enabled
      : supported;
  return {
    model,
    efforts: visible.length >= 2 ? visible : [],
    source: enabled.length > 0
      ? supported.length > 0 ? "config+models" : "config"
      : supported.length > 0 ? "models" : "none"
  };
}

async function loadReasoningOptionCatalog(configPath, modelCachePath, options = {}) {
  const readFile = options.readFile ?? fs.readFile;
  const [configResult, modelResult] = await Promise.allSettled([
    readFile(configPath, "utf8"),
    readFile(modelCachePath, "utf8")
  ]);
  const configText = configResult.status === "fulfilled" ? configResult.value : "";
  let modelCache = null;
  if (modelResult.status === "fulfilled") {
    try {
      modelCache = JSON.parse(modelResult.value);
    } catch {
      modelCache = null;
    }
  }
  return reasoningOptionCatalog(configText, modelCache);
}

module.exports = {
  REASONING_EFFORT_ORDER,
  loadReasoningOptionCatalog,
  modelReasoningEfforts,
  normalizeReasoningEfforts,
  reasoningOptionCatalog,
  tomlString,
  tomlStringArray
};
