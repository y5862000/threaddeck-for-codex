import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pluginDirectory = path.join(root, "com.yechan.threaddeck.sdPlugin");
const packagePath = path.join(root, "package.json");
const manifestPath = path.join(pluginDirectory, "manifest.json");
const englishPath = path.join(pluginDirectory, "en.json");
const koreanPath = path.join(pluginDirectory, "ko.json");

const ROOT_COPY = {
  en: {
    Name: "ThreadDeck for Codex",
    Description: "A bilingual Stream Deck Neo dashboard for monitoring and controlling Codex Desktop tasks on macOS."
  },
  ko: {
    Name: "ThreadDeck for Codex",
    Description: "macOS의 Codex Desktop 작업을 모니터링하고 제어하는 한영 지원 Stream Deck Neo 대시보드입니다."
  }
};

const ENGLISH_ACTIONS = new Map(Object.entries({
  "com.yechan.threaddeck.weekly": ["Weekly Codex quota", "Shows remaining weekly Codex capacity as a ring. Press to refresh now."],
  "com.yechan.threaddeck.thread1": ["Codex task", "Choose Current or Top 1–8 in the Property Inspector. Tap to open it, or hold for 0.55 seconds to dictate and submit a follow-up."],
  "com.yechan.threaddeck.newthread": ["Codex command", "Choose New task, Side Chat, or Send in the Property Inspector."],
  "com.yechan.threaddeck.voice": ["Codex dictation", "Starts dictation in the current Codex composer while held. Release to leave a draft without submitting it."],
  "com.yechan.threaddeck.reasoning": ["Codex effort + Fast mode", "Tap repeatedly to move effort immediately; after you stop, ThreadDeck applies only the final level. Hold for 0.6 seconds to toggle Fast mode immediately."],
  "com.yechan.threaddeck.thread.top1": ["Top Codex task 1", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread2": ["Top Codex task 2", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread3": ["Top Codex task 3", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread4": ["Top Codex task 4", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread5": ["Top Codex task 5", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread6": ["Top Codex task 6", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread7": ["Top Codex task 7", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.thread8": ["Top Codex task 8", "Legacy task slot retained for existing profiles."],
  "com.yechan.threaddeck.sidechat": ["Codex Side Chat", "Legacy command retained for existing profiles."],
  "com.yechan.threaddeck.send": ["Send to Codex", "Legacy command retained for existing profiles."],
  "com.yechan.threaddeck.fastmode": ["Codex Fast mode", "Legacy Fast mode action retained for existing profiles."],
  "com.yechan.threaddeck.page.previous": ["Previous page", "Internal navigation for the recommended ThreadDeck profile."]
}));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function localeFromManifest(manifest) {
  return Object.fromEntries([
    ["Name", manifest.Name],
    ["Description", manifest.Description],
    ...manifest.Actions.map((action) => [action.UUID, {
      Name: action.Name,
      Tooltip: action.Tooltip
    }])
  ]);
}

function localeFromEnglish(manifest) {
  return Object.fromEntries([
    ["Name", ROOT_COPY.en.Name],
    ["Description", ROOT_COPY.en.Description],
    ...manifest.Actions.map((action) => {
      const copy = ENGLISH_ACTIONS.get(action.UUID);
      if (!copy) throw new Error(`Missing English localization for ${action.UUID}`);
      return [action.UUID, { Name: copy[0], Tooltip: copy[1] }];
    })
  ]);
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const manifest = readJson(manifestPath);
const packageVersion = readJson(packagePath).version;
if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error(`Unsupported package version for Stream Deck manifest: ${packageVersion}`);
}
const existingKorean = fs.existsSync(koreanPath) ? readJson(koreanPath) : localeFromManifest(manifest);
const korean = Object.fromEntries([
  ["Name", ROOT_COPY.ko.Name],
  ["Description", ROOT_COPY.ko.Description],
  ...manifest.Actions.map((action) => [action.UUID, existingKorean[action.UUID]])
]);
const english = localeFromEnglish(manifest);
for (const action of manifest.Actions) {
  const copy = ENGLISH_ACTIONS.get(action.UUID);
  const koreanCopy = korean[action.UUID];
  if (!koreanCopy?.Name || !koreanCopy?.Tooltip) {
    throw new Error(`Missing Korean localization for ${action.UUID}`);
  }
  action.Name = copy[0];
  action.Tooltip = copy[1];
}
manifest.Name = ROOT_COPY.en.Name;
manifest.Description = ROOT_COPY.en.Description;
manifest.SupportURL = "https://github.com/y5862000/threaddeck-for-codex/blob/main/docs/TROUBLESHOOTING.md";
manifest.Version = `${packageVersion}.0`;

const expected = new Map([
  [manifestPath, serialized(manifest)],
  [englishPath, serialized(english)],
  [koreanPath, serialized(korean)]
]);
const checkOnly = process.argv.includes("--check");
for (const [filePath, contents] of expected) {
  if (checkOnly) {
    const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (actual !== contents) throw new Error(`Localization is out of sync: ${path.relative(root, filePath)}`);
  } else {
    fs.writeFileSync(filePath, contents);
    console.log(`Updated ${path.relative(root, filePath)}`);
  }
}
