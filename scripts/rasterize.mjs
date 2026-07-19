import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

function imageDimension(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive integer, received ${value}.`);
  }
  return number;
}

export async function rasterizeSvg(source, destination, width, height) {
  const outputWidth = imageDimension(width, "width");
  const outputHeight = imageDimension(height, "height");

  await sharp(source, { density: 144 })
    .resize(outputWidth, outputHeight, { fit: "fill" })
    .png()
    .toFile(destination);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [source, destination, width, height] = process.argv.slice(2);
  if (!source || !destination || width === undefined || height === undefined) {
    console.error("Usage: node scripts/rasterize.mjs <source.svg> <destination.png> <width> <height>");
    process.exitCode = 2;
  } else {
    await rasterizeSvg(source, destination, width, height);
  }
}
