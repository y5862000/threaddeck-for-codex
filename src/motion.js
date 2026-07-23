"use strict";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function smootherStep01(value) {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function easedProgress(startedAtMs, durationMs, nowMs = Date.now()) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 1;
  }
  return smootherStep01((nowMs - startedAtMs) / durationMs);
}

function interpolate(from, to, progress) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start)) return Number.isFinite(end) ? end : 0;
  if (!Number.isFinite(end)) return start;
  return start + (end - start) * clamp01(progress);
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(String(svg ?? "")).toString("base64")}`;
}

function crossfadeSvgFrames(fromSvg, toSvg, progress) {
  const amount = clamp01(progress);
  if (!fromSvg || amount >= 0.9995) return String(toSvg ?? fromSvg ?? "");
  if (!toSvg || amount <= 0.0005) return String(fromSvg);
  const fromOpacity = (1 - amount).toFixed(4);
  const toOpacity = amount.toFixed(4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <image href="${svgDataUri(fromSvg)}" width="144" height="144" opacity="${fromOpacity}"/>
  <image href="${svgDataUri(toSvg)}" width="144" height="144" opacity="${toOpacity}"/>
</svg>`;
}

module.exports = {
  clamp01,
  crossfadeSvgFrames,
  easedProgress,
  interpolate,
  smootherStep01
};
