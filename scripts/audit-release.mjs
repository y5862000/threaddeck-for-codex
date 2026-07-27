import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const checkedRoots = [
  "src",
  "test",
  "native",
  "profiles/source",
  "com.yechan.threaddeck.sdPlugin"
].map((entry) => path.join(root, entry));

const forbiddenNames = [
  /\.DS_Store$/i,
  /chatgpt\.png$/i,
  /\.(?:ttf|otf|woff2?)$/i
];

const forbiddenText = [
  { label: "personal absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "source device serial", pattern: /A7BSA5371J1CMQ/ },
  { label: "legacy plugin identifier", pattern: /com\.yechan\.codexdeck/ },
  { label: "legacy plugin name", pattern: /Codex Deck/ },
  { label: "redistributed OpenAI font reference", pattern: /OpenAI\s*Sans/i },
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/ }
];

const textExtensions = new Set([
  ".c", ".css", ".h", ".html", ".js", ".json", ".m", ".md", ".sh", ".svg", ".txt", ".xml", ".yaml", ".yml"
]);

const failures = [];

function visit(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
    return;
  }

  const relative = path.relative(root, target);
  for (const pattern of forbiddenNames) {
    if (pattern.test(relative)) failures.push(`${relative}: forbidden file`);
  }

  if (!textExtensions.has(path.extname(target).toLowerCase())) return;
  const contents = fs.readFileSync(target, "utf8");
  for (const { label, pattern } of forbiddenText) {
    if (pattern.test(contents)) failures.push(`${relative}: ${label}`);
  }
}

for (const target of checkedRoots) visit(target);

const pluginManifestPath = path.join(root, "com.yechan.threaddeck.sdPlugin/manifest.json");
const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
const visibleActionUuids = pluginManifest.Actions
  .filter((action) => action.VisibleInActionsList !== false)
  .map((action) => action.UUID);
const expectedVisibleActionUuids = [
  "com.yechan.threaddeck.weekly",
  "com.yechan.threaddeck.thread1",
  "com.yechan.threaddeck.newthread",
  "com.yechan.threaddeck.voice",
  "com.yechan.threaddeck.reasoning",
  "com.yechan.threaddeck.page.previous"
];
if (JSON.stringify(visibleActionUuids) !== JSON.stringify(expectedVisibleActionUuids)) {
  failures.push("Marketplace action list is not the six-action Codex-focused layout");
}
for (const uuid of [
  "com.yechan.threaddeck.thread1",
  "com.yechan.threaddeck.newthread",
  "com.yechan.threaddeck.page.previous"
]) {
  const action = pluginManifest.Actions.find((candidate) => candidate.UUID === uuid);
  if (action?.PropertyInspectorPath !== "property-inspector/index.html") {
    failures.push(`${uuid} has no grouped-action Property Inspector`);
  }
}
if (pluginManifest.Actions.some((action) => (
  action.UUID === "com.yechan.threaddeck.appswitch"
  || action.UUID.startsWith("com.yechan.threaddeck.media.")
))) {
  failures.push("Marketplace manifest still exposes app-switch or manual media controls");
}

const profileManifest = path.join(
  root,
  "profiles/source/unpacked/BD0CCFE2-385C-472C-A7A9-57205644D475.sdProfile/manifest.json"
);
const profile = JSON.parse(fs.readFileSync(profileManifest, "utf8"));
if (profile.Device?.UUID) failures.push("profile source still contains a hardware UUID");
if (profile.Device?.Model !== "20GBJ9901") failures.push("profile source is not targeted at Stream Deck Neo");
if (profile.Pages?.Pages?.length !== 2) failures.push("recommended profile is not the two-page Codex layout");

const expectedProfileActions = {
  THREADDECK: {
    "0,0": { uuid: "com.yechan.threaddeck.weekly" },
    "1,0": { uuid: "com.yechan.threaddeck.newthread", settings: { command: "new-task" } },
    "2,0": { uuid: "com.yechan.threaddeck.newthread", settings: { command: "side-chat" } },
    "3,0": { uuid: "com.yechan.threaddeck.newthread", settings: { command: "send" } },
    "0,1": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "current" } },
    "1,1": { uuid: "com.yechan.threaddeck.reasoning" },
    "2,1": { uuid: "com.yechan.threaddeck.voice" },
    "3,1": { uuid: "com.yechan.threaddeck.page.previous", settings: { currentPage: 0, pageDirection: "previous" } }
  },
  THREADS: {
    "0,0": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top1" } },
    "1,0": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top2" } },
    "2,0": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top3" } },
    "3,0": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top4" } },
    "0,1": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top5" } },
    "1,1": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top6" } },
    "2,1": { uuid: "com.yechan.threaddeck.thread1", settings: { taskSource: "top7" } },
    "3,1": { uuid: "com.yechan.threaddeck.page.previous", settings: { currentPage: 1, pageDirection: "previous" } }
  }
};
const profilePagesRoot = path.join(path.dirname(profileManifest), "Profiles");
const profilePages = fs.readdirSync(profilePagesRoot).flatMap((entry) => {
  const pageManifest = path.join(profilePagesRoot, entry, "manifest.json");
  return fs.existsSync(pageManifest)
    ? [JSON.parse(fs.readFileSync(pageManifest, "utf8"))]
    : [];
});
for (const [pageName, expectedActions] of Object.entries(expectedProfileActions)) {
  const page = profilePages.find((candidate) => candidate.Name === pageName);
  const actions = page?.Controllers?.find((controller) => controller.Type === "Keypad")?.Actions;
  if (!actions) {
    failures.push(`recommended profile is missing ${pageName}`);
    continue;
  }
  for (const [coordinate, expected] of Object.entries(expectedActions)) {
    const action = actions[coordinate];
    if (action?.UUID !== expected.uuid) {
      failures.push(`recommended profile ${pageName} ${coordinate} is not ${expected.uuid}`);
      continue;
    }
    for (const [key, value] of Object.entries(expected.settings ?? {})) {
      if (action.Settings?.[key] !== value) {
        failures.push(`recommended profile ${pageName} ${coordinate} setting ${key} is not ${value}`);
      }
    }
  }
}
if (profilePages.some((page) => page.Name === "MEDIA")) {
  failures.push("recommended profile still contains a MEDIA page");
}

if (failures.length > 0) {
  console.error("Release audit failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Release audit passed: no personal paths, device identifiers, secrets, or redistributed fonts detected.");
