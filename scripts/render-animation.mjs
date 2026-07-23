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

function smootherStep01(value) {
  const x = Math.max(0, Math.min(1, Number(value) || 0));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function makeLoopSeamless(svgDirectory, { width, height, tailFrames }) {
  const frames = fs.readdirSync(svgDirectory)
    .filter((name) => name.endsWith(".svg"))
    .sort();
  if (frames.length < 2 || tailFrames < 2 || tailFrames > frames.length) {
    throw new Error(`Cannot make ${svgDirectory} seamless with ${tailFrames} tail frames.`);
  }
  const firstPath = path.join(svgDirectory, frames[0]);
  const firstSvg = fs.readFileSync(firstPath, "utf8");
  const tailStart = frames.length - tailFrames;
  for (let index = tailStart; index < frames.length; index += 1) {
    const framePath = path.join(svgDirectory, frames[index]);
    const progress = smootherStep01((index - tailStart) / (tailFrames - 1));
    if (progress >= 0.9995) {
      fs.writeFileSync(framePath, firstSvg);
      continue;
    }
    if (progress <= 0.0005) continue;
    const currentSvg = fs.readFileSync(framePath, "utf8");
    fs.writeFileSync(framePath, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image href="${svgDataUri(currentSvg)}" width="${width}" height="${height}"/>
  <image href="${svgDataUri(firstSvg)}" width="${width}" height="${height}" opacity="${progress.toFixed(4)}"/>
</svg>`);
  }
  const lastSvg = fs.readFileSync(path.join(svgDirectory, frames.at(-1)), "utf8");
  if (lastSvg !== firstSvg) throw new Error(`${svgDirectory} does not end on its first frame.`);
  console.log(`Blended the final ${tailFrames} frames of ${svgDirectory} back to its first frame.`);
}

function verifyOverviewEffortAnimation(svgDirectory) {
  const frames = fs.readdirSync(svgDirectory)
    .filter((name) => name.endsWith(".svg"))
    .sort();
  const values = [];
  const pressDepths = new Map();
  let taskCompleted = false;
  for (const frame of frames) {
    const outerSvg = fs.readFileSync(path.join(svgDirectory, frame), "utf8");
    for (const match of outerSvg.matchAll(/data-demo-key="(\d+)" data-press-depth="(-?[0-9.]+)"/g)) {
      const key = Number(match[1]);
      const depth = Number(match[2]);
      const observed = pressDepths.get(key) ?? { min: 0, max: 0 };
      observed.min = Math.min(observed.min, depth);
      observed.max = Math.max(observed.max, depth);
      pressDepths.set(key, observed);
    }
    const keySvgs = [...outerSvg.matchAll(/href="data:image\/svg\+xml;base64,([^"]+)"/g)]
      .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
    const pair = [keySvgs[4], keySvgs[5]].map((keySvg) => {
      const match = keySvg?.match(/data-reasoning-progress="([0-9.]+)"/);
      return match ? Number(match[1]) : null;
    });
    if (pair[0] === null) {
      // The task card deliberately replaces its track with a completion check
      // near the end of the demo; the dedicated control remains visible.
      if (values.length < Math.floor(frames.length * 0.75) || !Number.isFinite(pair[1])) {
        throw new Error(`${frame} lost an Effort track before the completion scene.`);
      }
      taskCompleted = true;
      continue;
    }
    if (taskCompleted || !pair.every(Number.isFinite) || Math.abs(pair[0] - pair[1]) > 0.001) {
      throw new Error(`${frame} does not keep the task and control Effort tracks in sync.`);
    }
    values.push(pair[0]);
  }
  const endpointValues = [0.41, 0.59, 0.88, 1];
  const intermediateValues = new Set(values
    .filter((value) => endpointValues.every((endpoint) => Math.abs(value - endpoint) > 0.002))
    .map((value) => value.toFixed(3)));
  if (intermediateValues.size < 12) {
    throw new Error(
      `Overview Effort tracks jump between levels; found only ${intermediateValues.size} interpolated values.`
    );
  }
  for (const key of [4, 5]) {
    const observed = pressDepths.get(key);
    if (!observed || observed.max < 0.95 || observed.min > -0.05) {
      throw new Error(`Overview key ${key} does not show a full press and spring return.`);
    }
  }
  console.log(`Verified ${intermediateValues.size} interpolated Effort positions in both overview tracks.`);
  console.log("Verified physical press depth and spring return on overview task and Effort keys.");
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
  verifyOverviewEffortAnimation(overviewSvgDirectory);
  makeLoopSeamless(overviewSvgDirectory, { width: 960, height: 507, tailFrames: 24 });
  execFileSync(process.execPath, [
    "src/plugin.js",
    "--language",
    "en",
    "--render-gesture-animations",
    gestureSvgDirectory
  ], { cwd: root, stdio: "inherit" });

  for (const scenario of [
    "task-hold-to-talk",
    "voice-hold-to-dictate",
    "send-long-press",
    "app-launcher-long-press"
  ]) {
    makeLoopSeamless(
      path.join(gestureSvgDirectory, scenario),
      { width: 960, height: 420, tailFrames: 12 }
    );
  }

  await renderGif(overviewSvgDirectory, overviewPngDirectory, overviewOutputPath, {
    width: 960,
    height: 507,
    framesPerSecond: 1000 / 30
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
      { width: 960, height: 420, framesPerSecond: 20 }
    );
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
