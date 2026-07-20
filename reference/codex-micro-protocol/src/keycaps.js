// The Codex Micro keycap catalogue, reverse-engineered from the ChatGPT app's
// `codex-micro-layout` module: every assignable key, its icon, its size, and the
// app command it triggers by default.
//
// IMPORTANT: the ChatGPT app renders these with OpenAI's own proprietary icon
// set. We do NOT ship those assets. Instead each icon name is mapped to a
// visually equivalent icon from Lucide (https://lucide.dev, ISC licensed), which
// we may redistribute. Swap in your own SVGs via assets/icons/ if you prefer.

/** App icon name -> Lucide icon name used to render it on the Stream Deck. */
export const ICON_TO_LUCIDE = Object.freeze({
  "lightning-outline": "zap",
  "check-circle": "circle-check",
  "x-circle": "circle-x",
  branch: "git-branch",
  mic: "mic",
  codex: "square-terminal", // no open "codex" glyph; closest neutral match
  bug: "bug",
  openai: "sparkles", // no open OpenAI glyph; neutral stand-in
  terminal: "terminal",
  download: "download",
  trash: "trash-2",
  compose: "square-pen",
  "pointer-outline": "mouse-pointer-2",
  star: "star",
  diff: "git-compare",
  "play-outline": "play",
  "pull-request": "git-pull-request",
  "pull-request-draft": "git-pull-request-draft",
  "pull-request-merged": "git-merge",
  paint: "paintbrush",
  flask: "flask-conical",
  confetti: "party-popper",
  clock: "clock",
  settings: "settings",
  "folder-plus": "folder-plus",
  "cloud-upload": "cloud-upload",
  "all-products": "layout-grid",
  empty: null,
});

/**
 * Full assignable keycap catalogue (id, app icon, size, default command).
 * Kept for reference and for building custom layouts.
 */
export const CATALOG = Object.freeze([
  { id: "FAST", icon: "lightning-outline", size: "single", command: "composer.toggleFastMode" },
  { id: "APPR", icon: "check-circle", size: "single", command: "approval.approve" },
  { id: "REJ", icon: "x-circle", size: "single", command: "approval.decline" },
  { id: "SPLIT", icon: "branch", size: "single", command: "forkThread" },
  { id: "MIC", icon: "mic", size: "double", command: "Push to talk" },
  { id: "CODEX", icon: "codex", size: "single", command: "composer.submit" },
  { id: "BUG", icon: "bug", size: "single", command: "feedback" },
  { id: "OAI", icon: "openai", size: "single", command: "Open OpenAI docs" },
  { id: "TERM", icon: "terminal", size: "single", command: "toggleTerminal" },
  { id: "DWN", icon: "download", size: "single", command: "copyConversationMarkdown" },
  { id: "DEL", icon: "trash", size: "single", command: "archiveThread" },
  { id: "NEW", icon: "compose", size: "single", command: "newTask" },
  { id: "NAV", icon: "pointer-outline", size: "single", command: "openBrowserTab" },
  { id: "MAGIC", icon: "star", size: "single", command: "toggleThreadPin" },
  { id: "DIFF", icon: "diff", size: "single", command: "toggleReviewTab" },
  { id: "PLAY", icon: "play-outline", size: "single", command: "environmentAction1" },
  { id: "GIT", icon: "diff", size: "single", command: "git.commit" },
  { id: "BRCH", icon: "pull-request-draft", size: "single", command: "toggleReviewTab" },
  { id: "MRG", icon: "pull-request-merged", size: "single", command: "toggleReviewTab" },
  { id: "PR", icon: "pull-request", size: "single", command: "git.createPullRequest" },
  { id: "PAINT", icon: "paint", size: "single", command: "composer.addPhotos" },
  { id: "LAB", icon: "flask", size: "single", command: "settings" },
  { id: "PARTY", icon: "confetti", size: "single", command: "openSideChat" },
  { id: "TIME", icon: "clock", size: "single", command: "manageTasks" },
  { id: "SETUP", icon: "settings", size: "single", command: "settings" },
  { id: "FOLD", icon: "folder-plus", size: "single", command: "openFolder" },
  { id: "UPL", icon: "cloud-upload", size: "single", command: "composer.addFiles" },
  { id: "APPS", icon: "all-products", size: "single", command: "openSkills" },
]);

/** id -> catalogue entry, for quick lookup. */
export const KEYCAP = Object.freeze(
  Object.fromEntries(CATALOG.map((k) => [k.id, k])),
);

/**
 * Default assignment of the six physical action keys to keycaps, matching the
 * Codex Micro's out-of-box layout (the onboarding illustration). The wide mic
 * key occupies the ACT10/ACT11 position.
 */
export const DEFAULT_ACTION_KEYS = Object.freeze([
  { keycode: "ACT06", keycap: "FAST" },
  { keycode: "ACT07", keycap: "APPR" },
  { keycode: "ACT08", keycap: "REJ" },
  { keycode: "ACT09", keycap: "SPLIT" },
  { keycode: "ACT10", keycap: "MIC" }, // wide key (ACT10/ACT11)
  { keycode: "ACT12", keycap: "CODEX" },
]);

/** Resolve a keycap id to the Lucide icon name that renders it (or null). */
export function lucideFor(keycapId) {
  const cap = KEYCAP[keycapId];
  if (!cap) return null;
  return ICON_TO_LUCIDE[cap.icon] ?? null;
}
