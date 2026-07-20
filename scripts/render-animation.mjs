import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rasterizeSvg } from "./rasterize.mjs";

const root = path.resolve(import.meta.dirname, "..");
const overviewOutputPath = path.resolve(
  process.argv[2] || path.join(root, "docs", "media", "threaddeck-overview.gif")
);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "threaddeck-animation-"));
const mediaDirectory = path.join(root, "docs", "media");
const overviewSvgDirectory = path.join(temporaryDirectory, "overview-svg");
const overviewPngDirectory = path.join(temporaryDirectory, "overview-png");
const gestureSvgDirectory = path.join(temporaryDirectory, "gesture-svg");
const gesturePngDirectory = path.join(temporaryDirectory, "gesture-png");
const swiftModuleCacheDirectory = path.join(temporaryDirectory, "swift-module-cache");

function encodeGif(pngDirectory, outputPath, framesPerSecond) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(swiftModuleCacheDirectory, { recursive: true });
  const temporaryOutput = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}-${randomUUID()}.tmp.gif`
  );
  try {
    execFileSync("/usr/bin/xcrun", [
      "swift",
      path.join(root, "scripts", "encode-gif.swift"),
      pngDirectory,
      temporaryOutput,
      String(1 / framesPerSecond)
    ], {
      cwd: root,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: swiftModuleCacheDirectory,
        SWIFT_MODULECACHE_PATH: swiftModuleCacheDirectory
      },
      stdio: "inherit"
    });
    fs.renameSync(temporaryOutput, outputPath);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
  }
}

async function renderGif(svgDirectory, pngDirectory, outputPath, { width, height, framesPerSecond }) {
  fs.mkdirSync(pngDirectory, { recursive: true });
  const frames = fs.readdirSync(svgDirectory)
    .filter((name) => name.endsWith(".svg"))
    .sort();
  if (frames.length === 0) throw new Error(`The plugin renderer produced no frames in ${svgDirectory}.`);

  for (const frame of frames) {
    try {
      await rasterizeSvg(
        path.join(svgDirectory, frame),
        path.join(pngDirectory, frame.replace(/\.svg$/, ".png")),
        width,
        height
      );
    } catch (error) {
      throw new Error(`Could not rasterize ${frame}: ${error?.message ?? "unknown error"}`);
    }
  }
  encodeGif(pngDirectory, outputPath, framesPerSecond);
  console.log(`Rendered ${frames.length} frames to ${outputPath}`);
}

try {
  fs.mkdirSync(overviewSvgDirectory, { recursive: true });
  fs.mkdirSync(gestureSvgDirectory, { recursive: true });
  fs.mkdirSync(mediaDirectory, { recursive: true });

  execFileSync(process.execPath, [
    "src/plugin.js",
    "--language",
    "en",
    "--render-demo-animation",
    overviewSvgDirectory
  ], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [
    "src/plugin.js",
    "--language",
    "en",
    "--render-gesture-animations",
    gestureSvgDirectory
  ], { cwd: root, stdio: "inherit" });

  await renderGif(overviewSvgDirectory, overviewPngDirectory, overviewOutputPath, {
    width: 960,
    height: 507,
    framesPerSecond: 12
  });

  const gestures = [
    ["task-hold-to-talk", "task-hold-to-talk.gif"],
    ["voice-hold-to-dictate", "voice-hold-to-dictate.gif"],
    ["send-long-press", "send-long-press.gif"],
    ["app-launcher-long-press", "app-launcher-long-press.gif"]
  ];
  for (const [scenario, fileName] of gestures) {
    await renderGif(
      path.join(gestureSvgDirectory, scenario),
      path.join(gesturePngDirectory, scenario),
      path.join(mediaDirectory, fileName),
      { width: 960, height: 420, framesPerSecond: 10 }
    );
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
