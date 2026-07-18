import { execFileSync } from "node:child_process";

const reviewedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT"
]);

const output = execFileSync("pnpm", ["licenses", "list", "--json", "--prod=false"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});
const inventory = JSON.parse(output);
const unreviewed = Object.keys(inventory).filter((license) => !reviewedLicenses.has(license));

if (unreviewed.length > 0) {
  console.error(`License audit failed. Review these dependency licenses: ${unreviewed.join(", ")}`);
  process.exit(1);
}

const packageCount = Object.values(inventory)
  .flat()
  .reduce((count, entry) => count + entry.versions.length, 0);
console.log(`License audit passed: ${packageCount} dependency versions use reviewed permissive licenses.`);
