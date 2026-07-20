import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pluginDirectory = path.join(root, "com.yechan.threaddeck.sdPlugin");
const manifestPath = path.join(pluginDirectory, "manifest.json");
const englishPath = path.join(pluginDirectory, "en.json");
const koreanPath = path.join(pluginDirectory, "ko.json");

const ROOT_COPY = {
  en: {
    Name: "ThreadDeck for Codex",
    Description: "A bilingual Stream Deck Neo dashboard for monitoring, switching, and dictating into Codex Desktop tasks on macOS."
  },
  ko: {
    Name: "ThreadDeck for Codex",
    Description: "macOS의 Codex Desktop 작업을 모니터링·전환하고 음성으로 후속 요청을 보내는 한영 지원 Stream Deck Neo 대시보드입니다."
  }
};

const ENGLISH_ACTIONS = new Map(Object.entries({
  "com.yechan.threaddeck.weekly": ["Weekly Codex quota", "Shows remaining weekly Codex capacity as a ring. Press to refresh now."],
  "com.yechan.threaddeck.thread1": ["Current Codex task", "Follows the task in Codex's active window. Tap to open it, or hold for 0.55 seconds, speak, and release to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread.top1": ["Top Codex task 1", "Tap to open the first sorted Codex task. Hold for 0.55 seconds, speak, and release to dictate and submit a follow-up. This action is independent from Current Codex task."],
  "com.yechan.threaddeck.thread2": ["Top Codex task 2", "Tap to open the second sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread3": ["Top Codex task 3", "Tap to open the third sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread4": ["Top Codex task 4", "Tap to open the fourth sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread5": ["Top Codex task 5", "Tap to open the fifth sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread6": ["Top Codex task 6", "Tap to open the sixth sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread7": ["Top Codex task 7", "Tap to open the seventh sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.thread8": ["Top Codex task 8", "Tap to open the eighth sorted Codex task, or hold to dictate and submit a follow-up."],
  "com.yechan.threaddeck.sidechat": ["Codex Side Chat", "Opens Side Chat with Option+Command+S and verifies that the new chat owns focus before voice, send, Fast mode, or effort actions continue."],
  "com.yechan.threaddeck.newthread": ["New Codex task", "Opens a new Codex task outside the selected project."],
  "com.yechan.threaddeck.voice": ["Codex dictation", "Starts dictation in the current composer while held and pauses supported media. Release to leave a draft without submitting it."],
  "com.yechan.threaddeck.send": ["Send to Codex", "Release quickly to send Return. Hold until the key turns blue, then release to send Command+Return."],
  "com.yechan.threaddeck.appswitch": ["Switch app", "Switches to the next macOS app with Command+Tab."],
  "com.yechan.threaddeck.fastmode": ["Codex Fast mode", "Toggles Fast mode for the current Codex task and shows only the verified state."],
  "com.yechan.threaddeck.reasoning": ["Codex effort + Fast mode", "Tap repeatedly to move effort immediately; after you stop, ThreadDeck applies only the final level. Hold for 0.6 seconds to toggle Fast mode immediately."],
  "com.yechan.threaddeck.media.previous": ["Previous track", "Moves to the previous media track."],
  "com.yechan.threaddeck.media.rewind": ["Rewind media", "Rewinds the current media."],
  "com.yechan.threaddeck.media.playpause": ["Play / pause media", "Plays or pauses the current media."],
  "com.yechan.threaddeck.media.forward": ["Fast-forward media", "Fast-forwards the current media."],
  "com.yechan.threaddeck.media.mute": ["Mute media", "Toggles system audio mute."],
  "com.yechan.threaddeck.media.volumedown": ["Volume down", "Lowers system audio volume."],
  "com.yechan.threaddeck.media.volumeup": ["Volume up", "Raises system audio volume."],
  "com.yechan.threaddeck.media.next": ["Next track", "Moves to the next media track."],
  "com.yechan.threaddeck.page.previous": ["Previous page", "Moves to the previous page in the ThreadDeck profile."],
  "com.yechan.threaddeck.page.next": ["Next page", "Moves to the next page in the ThreadDeck profile."]
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
const existingKorean = fs.existsSync(koreanPath) ? readJson(koreanPath) : localeFromManifest(manifest);
const korean = {
  ...existingKorean,
  Name: ROOT_COPY.ko.Name,
  Description: ROOT_COPY.ko.Description
};
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
