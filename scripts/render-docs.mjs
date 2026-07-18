import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const mediaDir = path.join(root, "docs", "media");
const darkSvg = path.join(mediaDir, "neo-preview.svg");
const lightSvg = path.join(mediaDir, "neo-preview-light.svg");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-docs-"));

function runNode(...arguments_) {
  execFileSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
}

function rasterize(source, destination, width, height) {
  execFileSync("/usr/bin/sips", [
    "-s", "format", "png",
    "-z", String(height), String(width),
    source,
    "--out", destination
  ], { stdio: "ignore" });
}

function embeddedKeys(previewPath) {
  const preview = fs.readFileSync(previewPath, "utf8");
  return [...preview.matchAll(/href="data:image\/svg\+xml;base64,([^"]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
}

fs.mkdirSync(mediaDir, { recursive: true });
runNode("src/plugin.js", "--render-demo", darkSvg);
runNode("src/plugin.js", "--render-demo-light", lightSvg);

rasterize(darkSvg, path.join(mediaDir, "neo-preview.png"), 1372, 724);
rasterize(lightSvg, path.join(mediaDir, "neo-preview-light.png"), 1372, 724);

const keys = embeddedKeys(darkSvg);
const selectedKeys = new Map([
  ["quota-key.png", 0],
  ["side-chat-key.png", 1],
  ["working-task-key.png", 4],
  ["completed-task-key.png", 7]
]);

for (const [fileName, index] of selectedKeys) {
  if (!keys[index]) throw new Error(`Missing key ${index} in ${darkSvg}`);
  const temporarySvg = path.join(temporaryDirectory, `${index}.svg`);
  fs.writeFileSync(temporarySvg, keys[index]);
  rasterize(temporarySvg, path.join(mediaDir, fileName), 288, 288);
}

console.log(`Rendered documentation images in ${mediaDir}`);
