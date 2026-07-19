import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const reviewedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT"
]);

const reviewedBuildOnlyPackages = new Map([
  ["@img/sharp-libvips-darwin-arm64", new Set(["1.2.4"])],
  ["@img/sharp-libvips-darwin-x64", new Set(["1.2.4"])]
]);
const buildOnlyLicense = "LGPL-3.0-or-later";
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sharpIsBuildOnly = manifest.devDependencies?.sharp === "0.34.5"
  && manifest.dependencies?.sharp === undefined
  && manifest.optionalDependencies?.sharp === undefined;

const output = execFileSync("pnpm", ["licenses", "list", "--json", "--prod=false"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});
const inventory = JSON.parse(output);
const invalidInventory = Object.entries(inventory).find(([, entries]) => !Array.isArray(entries));
if (invalidInventory) {
  console.error(`License audit failed: pnpm returned an invalid ${invalidInventory[0]} inventory entry.`);
  process.exit(1);
}

const exceptions = [];
const unreviewed = [];
for (const [license, entries] of Object.entries(inventory)) {
  if (reviewedLicenses.has(license)) continue;
  for (const entry of entries) {
    for (const version of entry.versions) {
      const isReviewedBuildTool = sharpIsBuildOnly
        && license === buildOnlyLicense
        && reviewedBuildOnlyPackages.get(entry.name)?.has(version);
      if (isReviewedBuildTool) exceptions.push(`${entry.name}@${version}`);
      else unreviewed.push(`${entry.name}@${version} (${license})`);
    }
  }
}

if (unreviewed.length > 0) {
  console.error(`License audit failed. Review these dependency licenses: ${unreviewed.join(", ")}`);
  process.exit(1);
}

const packageCount = Object.values(inventory)
  .flat()
  .reduce((count, entry) => count + entry.versions.length, 0);
const exceptionSummary = exceptions.length > 0
  ? `; ${exceptions.length} exact libvips build-only package version(s) use the reviewed LGPL exception`
  : "";
console.log(`License audit passed: ${packageCount} dependency versions match policy${exceptionSummary}.`);
