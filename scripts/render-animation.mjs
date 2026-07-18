import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputPath = path.resolve(
  process.argv[2] || path.join(root, "docs", "media", "threaddeck-demo.gif")
);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-animation-"));
const svgDirectory = path.join(temporaryDirectory, "svg");
const pngDirectory = path.join(temporaryDirectory, "png");

function rasterize(source, destination) {
  execFileSync("/usr/bin/sips", [
    "-s", "format", "png",
    "-z", "507", "960",
    source,
    "--out", destination
  ], { stdio: "ignore" });
}

try {
  fs.mkdirSync(svgDirectory, { recursive: true });
  fs.mkdirSync(pngDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  execFileSync(process.execPath, [
    "src/plugin.js",
    "--render-demo-animation",
    svgDirectory
  ], { cwd: root, stdio: "inherit" });

  const frames = fs.readdirSync(svgDirectory)
    .filter((name) => name.endsWith(".svg"))
    .sort();
  if (frames.length === 0) throw new Error("The plugin renderer produced no animation frames.");

  for (const frame of frames) {
    rasterize(
      path.join(svgDirectory, frame),
      path.join(pngDirectory, frame.replace(/\.svg$/, ".png"))
    );
  }

  execFileSync("/usr/bin/xcrun", [
    "swift",
    path.join(root, "scripts", "encode-gif.swift"),
    pngDirectory,
    outputPath,
    String(1 / 12)
  ], { cwd: root, stdio: "inherit" });

  console.log(`Rendered animated documentation demo at ${outputPath}`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
