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
  ".c", ".h", ".js", ".json", ".m", ".md", ".sh", ".svg", ".txt", ".xml", ".yaml", ".yml"
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

const profileManifest = path.join(
  root,
  "profiles/source/unpacked/BD0CCFE2-385C-472C-A7A9-57205644D475.sdProfile/manifest.json"
);
const profile = JSON.parse(fs.readFileSync(profileManifest, "utf8"));
if (profile.Device?.UUID) failures.push("profile source still contains a hardware UUID");
if (profile.Device?.Model !== "20GBJ9901") failures.push("profile source is not targeted at Stream Deck Neo");

if (failures.length > 0) {
  console.error("Release audit failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Release audit passed: no personal paths, device identifiers, secrets, or redistributed fonts detected.");
