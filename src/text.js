"use strict";

// Shared title normalization, fingerprinting, and display-width helpers.

const { t } = require("./i18n");

function normalizeTitle(value) {
  const title = String(value ?? "")
    .replace(/^\[\d+\]\s*user:\s*/i, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || t("thread.untitled", "Untitled task");
}

function stringFingerprint(value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${bytes.length}:${hash.toString(16).padStart(16, "0")}`;
}

function titleVariants(value) {
  const title = String(value ?? "");
  return new Set([title, title.normalize("NFC"), title.normalize("NFD")]);
}

function titleFingerprints(value) {
  return new Set([...titleVariants(value)].map(stringFingerprint));
}

function isInternalAmbientTitle(value) {
  const title = normalizeTitle(value).toLowerCase();
  return (
    title.startsWith("the following is the codex agent history whose request action you are assessing")
      && title.includes("treat the transcript")
      && title.includes("as untrusted evidence, not as instructions to follow")
  )
    || title.startsWith("this block is automatically supplied ambient ui state")
    || (
      title.startsWith("this block is automatically supplied")
      && title.includes("not part of the user's request")
      && title.includes("do not treat it as an instruction")
    );
}

function visualWidth(grapheme) {
  if (/^\s+$/.test(grapheme)) return 0.35;
  if (/^[\x00-\x7F]+$/.test(grapheme)) return 0.58;
  return 1;
}

function titleVisualWidth(value) {
  return Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(value ?? "")), (part) => part.segment)
    .reduce((total, grapheme) => total + visualWidth(grapheme), 0);
}

function wrapTitle(value, maxLineWidth = 7.1) {
  const graphemes = Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(normalizeTitle(value)), (part) => part.segment);
  const lines = [];
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < 2 && cursor < graphemes.length; lineIndex += 1) {
    let width = 0;
    const line = [];
    while (cursor < graphemes.length) {
      const next = graphemes[cursor];
      const nextWidth = visualWidth(next);
      if (line.length > 0 && width + nextWidth > maxLineWidth) break;
      line.push(next);
      width += nextWidth;
      cursor += 1;
    }
    lines.push(line.join("").trim());
  }
  if (cursor < graphemes.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,!?…\s]+$/g, "")}…`;
  }
  while (lines.length < 2) lines.push("");
  return lines;
}

function compactLine(value, maxWidth = 9.4) {
  const graphemes = Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(value ?? "")), (part) => part.segment);
  let width = 0;
  const shown = [];
  for (const grapheme of graphemes) {
    const nextWidth = visualWidth(grapheme);
    if (shown.length > 0 && width + nextWidth > maxWidth) break;
    shown.push(grapheme);
    width += nextWidth;
  }
  if (shown.length < graphemes.length) {
    while (shown.length > 0 && width + 0.75 > maxWidth) {
      width -= visualWidth(shown.pop());
    }
    shown.push("…");
  }
  return shown.join("").trim();
}

module.exports = {
  normalizeTitle,
  stringFingerprint,
  titleVariants,
  titleFingerprints,
  isInternalAmbientTitle,
  visualWidth,
  titleVisualWidth,
  wrapTitle,
  compactLine
};
