"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  pageManifestContainsActionContext,
  profilePageIds,
  readInstalledProfilePageState
} = require("../src/streamdeck-profile-state");

test("profile page parsing is case-insensitive and finds the exact action instance", () => {
  assert.deepEqual(profilePageIds({
    Pages: { Pages: ["PAGE-A", "page-b", "PAGE-A", null] }
  }), ["page-a", "page-b"]);
  assert.equal(pageManifestContainsActionContext({
    Controllers: [
      { Actions: null },
      { Actions: { "3,1": { ActionID: "ABC-123" } } }
    ]
  }, "abc-123"), true);
});

test("installed profile state supports an arbitrary number of pages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threaddeck-profiles-"));
  const profile = path.join(root, "EXAMPLE.sdProfile");
  const profiles = path.join(profile, "Profiles");
  const pageIds = Array.from({ length: 9 }, (_, index) => `page-${index}`);
  const actionContext = "page-navigation-action";
  try {
    await fs.mkdir(profiles, { recursive: true });
    await fs.writeFile(path.join(profile, "manifest.json"), JSON.stringify({
      Name: "ThreadDeck for Codex",
      Pages: {
        Current: pageIds[8],
        Default: pageIds[0],
        Pages: pageIds
      }
    }));
    for (const [index, pageId] of pageIds.entries()) {
      const page = path.join(profiles, pageId.toUpperCase());
      await fs.mkdir(page, { recursive: true });
      await fs.writeFile(path.join(page, "manifest.json"), JSON.stringify({
        Controllers: [{
          Type: "Keypad",
          Actions: index === 8
            ? { "3,1": { ActionID: actionContext } }
            : {}
        }]
      }));
    }

    assert.deepEqual(
      await readInstalledProfilePageState(actionContext, { roots: [root] }),
      { currentPage: 8, pageCount: 9, source: "installed-profile" }
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
