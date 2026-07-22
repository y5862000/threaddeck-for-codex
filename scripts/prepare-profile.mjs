import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [profileRoot, pluginManifestPath] = process.argv.slice(2);
if (!profileRoot || !pluginManifestPath) {
  throw new Error("usage: prepare-profile.mjs <profile-root> <plugin-manifest>");
}

const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
const pluginVersion = pluginManifest.Version;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(pluginVersion ?? "")) {
  throw new Error("plugin manifest has no valid four-part Version");
}

const manifests = [];
function collectManifestFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectManifestFiles(target);
    else if (entry.name === "manifest.json") manifests.push(target);
  }
}

let updatedActionCount = 0;
function updatePluginVersions(value) {
  if (!value || typeof value !== "object") return;
  if (value.Plugin?.UUID === "com.yechan.threaddeck") {
    value.Plugin.Version = pluginVersion;
    updatedActionCount += 1;
  }
  for (const nested of Object.values(value)) updatePluginVersions(nested);
}

collectManifestFiles(profileRoot);
for (const manifestPath of manifests) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  updatePluginVersions(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const stableTime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(manifestPath, stableTime, stableTime);
}

if (updatedActionCount === 0) {
  throw new Error("profile contains no ThreadDeck actions to version-stamp");
}
