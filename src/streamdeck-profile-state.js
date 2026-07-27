"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PROFILES_ROOTS = [
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.elgato.StreamDeck",
    "ProfilesV3"
  )
];

function normalizedIdentifier(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function profilePageIds(manifest) {
  const values = Array.isArray(manifest?.Pages?.Pages) ? manifest.Pages.Pages : [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const id = normalizedIdentifier(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function pageManifestContainsActionContext(manifest, actionContext) {
  const expected = normalizedIdentifier(actionContext);
  if (!expected || !Array.isArray(manifest?.Controllers)) return false;
  for (const controller of manifest.Controllers) {
    const actions = controller?.Actions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) continue;
    for (const action of Object.values(actions)) {
      if (normalizedIdentifier(action?.ActionID) === expected) return true;
    }
  }
  return false;
}

function pageManifestContainsActionUUID(manifest, actionUUID) {
  const expected = normalizedIdentifier(actionUUID);
  if (!expected || !Array.isArray(manifest?.Controllers)) return false;
  for (const controller of manifest.Controllers) {
    const actions = controller?.Actions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) continue;
    for (const action of Object.values(actions)) {
      if (normalizedIdentifier(action?.UUID) === expected) return true;
    }
  }
  return false;
}

async function readJson(filePath, fileSystem = fs) {
  return JSON.parse(await fileSystem.readFile(filePath, "utf8"));
}

async function pageDirectoryMap(profilePath, fileSystem = fs) {
  const profilesPath = path.join(profilePath, "Profiles");
  const entries = await fileSystem.readdir(profilesPath, { withFileTypes: true });
  return new Map(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => [normalizedIdentifier(entry.name), path.join(profilesPath, entry.name)]));
}

async function stateForProfile(profilePath, actionContext, options = {}, fileSystem = fs) {
  const manifest = await readJson(path.join(profilePath, "manifest.json"), fileSystem);
  const pageIds = profilePageIds(manifest);
  if (pageIds.length === 0) return null;
  const directories = await pageDirectoryMap(profilePath, fileSystem);
  const currentId = normalizedIdentifier(manifest?.Pages?.Current);
  const candidates = currentId && pageIds.includes(currentId)
    ? [currentId, ...pageIds.filter((id) => id !== currentId)]
    : pageIds;

  const pageManifests = new Map();
  for (const pageId of candidates) {
    const directory = directories.get(pageId);
    if (!directory) continue;
    try {
      const pageManifest = await readJson(path.join(directory, "manifest.json"), fileSystem);
      pageManifests.set(pageId, pageManifest);
      if (!pageManifestContainsActionContext(pageManifest, actionContext)) continue;
      return {
        currentPage: pageIds.indexOf(pageId),
        pageCount: pageIds.length,
        source: "installed-profile"
      };
    } catch {
      // Stream Deck may replace a page manifest atomically while editing it.
      // Keep scanning the remaining profiles and let the caller fall back to
      // action settings if this one transiently cannot be read.
    }
  }

  // Stream Deck's key-event context is runtime-owned and is not guaranteed to
  // equal the ActionID persisted in ProfilesV3. When that exact match misses,
  // use only the named profile's declared current page and require that page
  // to contain the same ThreadDeck action UUID before trusting its index.
  const expectedProfileName = normalizedIdentifier(options.profileName);
  const profileName = normalizedIdentifier(manifest?.Name);
  if (expectedProfileName && profileName !== expectedProfileName) return null;
  const currentDirectory = directories.get(currentId);
  if (!currentId || !currentDirectory || !pageIds.includes(currentId)) return null;
  try {
    const currentManifest = pageManifests.get(currentId)
      ?? await readJson(path.join(currentDirectory, "manifest.json"), fileSystem);
    if (!pageManifestContainsActionUUID(currentManifest, options.actionUUID)) return null;
    return {
      currentPage: pageIds.indexOf(currentId),
      pageCount: pageIds.length,
      source: "installed-profile-current-action"
    };
  } catch {
    return null;
  }
}

async function readInstalledProfilePageState(actionContext, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const roots = Array.isArray(options.roots) && options.roots.length > 0
    ? options.roots
    : DEFAULT_PROFILES_ROOTS;
  for (const root of roots) {
    let entries;
    try {
      entries = await fileSystem.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".sdprofile")) continue;
      try {
        const state = await stateForProfile(
          path.join(root, entry.name),
          actionContext,
          options,
          fileSystem
        );
        if (state) return state;
      } catch {
        // One damaged or concurrently edited profile must not prevent another
        // installed profile from identifying the live action instance.
      }
    }
  }
  return null;
}

module.exports = {
  pageManifestContainsActionContext,
  pageManifestContainsActionUUID,
  profilePageIds,
  readInstalledProfilePageState
};
