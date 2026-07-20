"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadReasoningOptionCatalog,
  reasoningOptionCatalog,
  tomlStringArray
} = require("../src/reasoning-options");

const MODELS = {
  models: [
    {
      slug: "gpt-sol",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" }
      ]
    },
    {
      slug: "gpt-luna",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" }
      ]
    }
  ]
};

test("reads the desktop enabled effort list in canonical order", () => {
  const config = `
model = "gpt-sol"

[desktop]
enabled-reasoning-efforts = [
  "ultra", # UI order is not the reasoning order
  "low", "medium", "high", "xhigh"
]
`;
  assert.deepEqual(tomlStringArray(config, "enabled-reasoning-efforts"), [
    "ultra", "low", "medium", "high", "xhigh"
  ]);
  assert.deepEqual(reasoningOptionCatalog(config, MODELS), {
    model: "gpt-sol",
    efforts: ["low", "medium", "high", "xhigh", "ultra"],
    source: "config+models"
  });
});

test("intersects global visibility with the selected model support", () => {
  const config = `
model = "gpt-luna"
[desktop]
enabled-reasoning-efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]
`;
  assert.deepEqual(reasoningOptionCatalog(config, MODELS).efforts, [
    "low", "medium", "high", "xhigh", "max"
  ]);
});

test("uses model support when the desktop visibility setting is absent", () => {
  const catalog = reasoningOptionCatalog('model = "gpt-sol"\n', MODELS);
  assert.equal(catalog.source, "models");
  assert.deepEqual(catalog.efforts, [
    "low", "medium", "high", "xhigh", "max", "ultra"
  ]);
});

test("tolerates either local cache file being absent or malformed", async () => {
  const files = new Map([
    ["config", 'model = "gpt-sol"\n[desktop]\nenabled-reasoning-efforts = ["low", "medium", "high"]\n'],
    ["models", "{not-json"]
  ]);
  const catalog = await loadReasoningOptionCatalog("config", "models", {
    readFile: async (file) => {
      if (!files.has(file)) throw new Error("missing");
      return files.get(file);
    }
  });
  assert.deepEqual(catalog, {
    model: "gpt-sol",
    efforts: ["low", "medium", "high"],
    source: "config"
  });
});
