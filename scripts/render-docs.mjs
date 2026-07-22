import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rasterizeSvg } from "./rasterize.mjs";

const root = path.resolve(import.meta.dirname, "..");
const mediaDir = path.join(root, "docs", "media");
const darkSvg = path.join(mediaDir, "neo-preview.svg");
const lightSvg = path.join(mediaDir, "neo-preview-light.svg");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-docs-"));
const completedKeySvg = path.join(temporaryDirectory, "completed-task-key.svg");

function runNode(...arguments_) {
  execFileSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
}

function embeddedKeys(previewPath) {
  const preview = fs.readFileSync(previewPath, "utf8");
  return [...preview.matchAll(/href="data:image\/svg\+xml;base64,([^"]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
}

function roundedKeySvg(svg) {
  const data = Buffer.from(svg).toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><clipPath id="documentationKeyClip"><rect width="144" height="144" rx="22"/></clipPath></defs>
  <image width="144" height="144" clip-path="url(#documentationKeyClip)" href="data:image/svg+xml;base64,${data}"/>
</svg>\n`;
}

try {
  fs.mkdirSync(mediaDir, { recursive: true });
  runNode("src/plugin.js", "--language", "en", "--render-demo", darkSvg);
  runNode("src/plugin.js", "--language", "en", "--render-demo-light", lightSvg);
  runNode("src/plugin.js", "--language", "en", "--render-completed-key", completedKeySvg);

  await rasterizeSvg(darkSvg, path.join(mediaDir, "neo-preview.png"), 1372, 724);
  await rasterizeSvg(lightSvg, path.join(mediaDir, "neo-preview-light.png"), 1372, 724);

  const keys = embeddedKeys(darkSvg);
  const selectedKeys = new Map([
    ["quota-key.png", 0],
    ["side-chat-key.png", 1],
    ["working-task-key.png", 4]
  ]);

  for (const [fileName, index] of selectedKeys) {
    if (!keys[index]) throw new Error(`Missing key ${index} in ${darkSvg}`);
    const temporarySvg = path.join(temporaryDirectory, `${index}.svg`);
    fs.writeFileSync(temporarySvg, roundedKeySvg(keys[index]));
    await rasterizeSvg(temporarySvg, path.join(mediaDir, fileName), 288, 288);
  }
  const roundedCompletedKeySvg = path.join(temporaryDirectory, "completed-task-key-rounded.svg");
  fs.writeFileSync(
    roundedCompletedKeySvg,
    roundedKeySvg(fs.readFileSync(completedKeySvg, "utf8"))
  );
  await rasterizeSvg(
    roundedCompletedKeySvg,
    path.join(mediaDir, "completed-task-key.png"),
    288,
    288
  );

  console.log(`Rendered documentation images in ${mediaDir}`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
