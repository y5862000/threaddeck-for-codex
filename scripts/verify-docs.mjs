import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const markdownFiles = [
  ...fs.readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, name)),
  ...fs.readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, "docs", name))
];
const failures = [];

function checkTarget(file, target) {
  if (/^(?:https?:|mailto:|#)/.test(target)) return;
  const decoded = decodeURIComponent(target.split("#", 1)[0]);
  if (!decoded) return;
  const resolved = path.resolve(path.dirname(file), decoded);
  if (!fs.existsSync(resolved)) {
    failures.push(`${path.relative(root, file)}: missing ${target}`);
  }
}

for (const file of markdownFiles) {
  const contents = fs.readFileSync(file, "utf8");
  for (const match of contents.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) checkTarget(file, match[1]);
  for (const match of contents.matchAll(/(?:href|src)="([^"]+)"/g)) checkTarget(file, match[1]);
}

const requiredImages = [
  "docs/media/neo-preview.png",
  "docs/media/neo-preview-light.png",
  "docs/media/threaddeck-demo.gif",
  "docs/media/quota-key.png",
  "docs/media/working-task-key.png",
  "docs/media/completed-task-key.png",
  "docs/media/side-chat-key.png"
];
for (const image of requiredImages) {
  const target = path.join(root, image);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) failures.push(`${image}: missing or empty`);
}

if (failures.length > 0) {
  console.error("Documentation verification failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Documentation verification passed: ${markdownFiles.length} Markdown files and ${requiredImages.length} images checked.`);
