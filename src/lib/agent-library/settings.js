// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  AGENT_TARGETS,
  defaultLinkMode,
  ensureLibraryDirs,
  getLibraryRoot,
  getSettingsPath,
  getStatePath,
} from "./paths.js";
import { atomicWriteFile } from "./fs-utils.js";

/**
 * @typedef {object} TargetToggles
 * @property {boolean} skills
 * @property {boolean} mcp
 */

/**
 * @typedef {object} AgentLibrarySettings
 * @property {boolean} enabled
 * @property {"global"|"project"} scope
 * @property {string|null} projectPath
 * @property {"copy"|"symlink"} linkMode
 * @property {boolean} neverOverwriteUser
 * @property {boolean} includeProductSkills
 * @property {boolean} requireCatalogConfirm
 * @property {Record<string, TargetToggles>} targets
 */

/** @returns {AgentLibrarySettings} */
export function defaultSettings() {
  /** @type {Record<string, TargetToggles>} */
  const targets = {};
  for (const id of Object.keys(AGENT_TARGETS)) {
    targets[id] = { skills: true, mcp: true };
  }
  return {
    enabled: true,
    scope: "global",
    projectPath: null,
    linkMode: defaultLinkMode(),
    neverOverwriteUser: true, // hard safety — UI cannot disable without explicit opt-in
    includeProductSkills: true,
    requireCatalogConfirm: true,
    targets,
  };
}

/**
 * @param {Partial<AgentLibrarySettings>} [partial]
 * @returns {AgentLibrarySettings}
 */
/**
 * Deep-merge one target toggle object without flipping unspecified fields to true.
 * @param {TargetToggles} current
 * @param {Partial<TargetToggles>} patch
 */
function mergeTargetToggles(current, patch) {
  const cur = current || { skills: true, mcp: true };
  if (!patch || typeof patch !== "object") return { ...cur };
  return {
    skills: typeof patch.skills === "boolean" ? patch.skills : cur.skills !== false,
    mcp: typeof patch.mcp === "boolean" ? patch.mcp : cur.mcp !== false,
  };
}

function mergeSettings(partial = {}) {
  const base = defaultSettings();
  /** @type {Record<string, TargetToggles>} */
  const targets = {};
  for (const id of Object.keys(AGENT_TARGETS)) {
    targets[id] = { ...(base.targets[id] || { skills: true, mcp: true }) };
  }
  // Start from partial as full current when it already has all targets (load from disk)
  if (partial.targets && typeof partial.targets === "object") {
    for (const id of Object.keys(AGENT_TARGETS)) {
      const fromPartial = partial.targets[id];
      if (fromPartial && typeof fromPartial === "object") {
        targets[id] = mergeTargetToggles(targets[id], fromPartial);
      }
    }
  }
  const linkMode =
    partial.linkMode === "copy" || partial.linkMode === "symlink"
      ? partial.linkMode
      : base.linkMode;

  const scope = partial.scope === "project" ? "project" : "global";
  let projectPath = null;
  if (scope === "project" && partial.projectPath) {
    const p = String(partial.projectPath).trim();
    projectPath = p || null;
  }

  return {
    enabled: partial.enabled !== false,
    scope,
    projectPath,
    linkMode,
    neverOverwriteUser: partial.neverOverwriteUser !== false,
    includeProductSkills: partial.includeProductSkills !== false,
    requireCatalogConfirm: partial.requireCatalogConfirm !== false,
    targets,
  };
}

/**
 * Validate settings before apply/sync. Throws Error with code.
 * @param {AgentLibrarySettings} settings
 */
export function assertSettingsReady(settings) {
  if (!settings.enabled) {
    const e = new Error("Agent Library sync is turned off in settings");
    // @ts-ignore
    e.code = "disabled";
    throw e;
  }
  if (settings.scope === "project") {
    const raw = settings.projectPath ? String(settings.projectPath).trim() : "";
    if (!raw) {
      const e = new Error(
        "Project scope requires an absolute project path — set it before Apply"
      );
      // @ts-ignore
      e.code = "project_path_missing";
      throw e;
    }
    // Must be absolute *before* resolve (resolve always returns absolute)
    if (!path.isAbsolute(raw)) {
      const e = new Error("Project path must be absolute (e.g. /Users/you/my-app)");
      // @ts-ignore
      e.code = "project_path_invalid";
      throw e;
    }
    const resolved = path.resolve(raw);
    if (!existsSync(resolved)) {
      const e = new Error(`Project path does not exist: ${resolved}`);
      // @ts-ignore
      e.code = "project_path_missing";
      throw e;
    }
    let st;
    try {
      st = statSync(resolved);
    } catch {
      const e = new Error(`Cannot access project path: ${resolved}`);
      // @ts-ignore
      e.code = "project_path_invalid";
      throw e;
    }
    if (!st.isDirectory()) {
      const e = new Error(`Project path is not a directory: ${resolved}`);
      // @ts-ignore
      e.code = "project_path_invalid";
      throw e;
    }
  }
}

/**
 * Content library root (skills + mcp) — may be project-scoped.
 * @param {AgentLibrarySettings} [settings]
 */
export function resolveLibraryRoot(settings) {
  const s = settings || defaultSettings();
  return getLibraryRoot({
    scope: s.scope,
    projectPath: s.projectPath,
  });
}

/** Control-plane settings always live in the global data dir. */
function getControlRoot() {
  return getLibraryRoot({ scope: "global", projectPath: null });
}

export async function loadSettings(_ignoredRoot) {
  const controlRoot = getControlRoot();
  ensureLibraryDirs(controlRoot);
  const p = getSettingsPath(controlRoot);
  let settings = defaultSettings();
  if (existsSync(p)) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      settings = mergeSettings(JSON.parse(raw));
    } catch {
      settings = defaultSettings();
    }
  }
  // Ensure content library for *actual* scope (not always global)
  ensureLibraryDirs(resolveLibraryRoot(settings));
  return settings;
}

/**
 * @param {string} [_ignoredRoot]
 * @param {Partial<AgentLibrarySettings> & { confirmAllowOverwrite?: boolean }} patch
 */
export async function saveSettings(_ignoredRoot, patch) {
  const controlRoot = getControlRoot();
  ensureLibraryDirs(controlRoot);
  const current = await loadSettings(controlRoot);

  // Deep-merge target toggles so a partial patch does not re-enable siblings
  /** @type {Record<string, TargetToggles>} */
  const mergedTargets = { ...current.targets };
  if (patch.targets && typeof patch.targets === "object") {
    for (const [id, t] of Object.entries(patch.targets)) {
      if (!AGENT_TARGETS[id]) continue;
      mergedTargets[id] = mergeTargetToggles(current.targets[id], t);
    }
  }

  const next = mergeSettings({
    ...current,
    ...patch,
    targets: mergedTargets,
  });

  if (patch.neverOverwriteUser === false && patch.confirmAllowOverwrite !== true) {
    next.neverOverwriteUser = true;
  }
  if (patch.confirmAllowOverwrite === true && patch.neverOverwriteUser === false) {
    next.neverOverwriteUser = false;
  }

  // Validate project path on save when enabling project scope
  if (next.scope === "project") {
    try {
      assertSettingsReady({ ...next, enabled: true });
    } catch (e) {
      // Allow saving project scope with empty path only if not applying yet —
      // still store but keep projectPath null if invalid empty
      if (e?.code === "project_path_missing" && !patch.projectPath) {
        next.projectPath = null;
      } else if (e?.code !== "disabled") {
        throw e;
      }
    }
  }

  await atomicWriteFile(
    getSettingsPath(controlRoot),
    JSON.stringify(next, null, 2)
  );
  ensureLibraryDirs(resolveLibraryRoot(next));
  return next;
}

export async function loadState(libraryRoot) {
  const root = libraryRoot || resolveLibraryRoot(await loadSettings());
  ensureLibraryDirs(root);
  const p = getStatePath(root);
  if (!existsSync(p)) {
    return { managedSkills: {}, managedMcpKeys: {}, lastSync: null, lastDoctor: null };
  }
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return { managedSkills: {}, managedMcpKeys: {}, lastSync: null, lastDoctor: null };
  }
}

/**
 * @param {string} libraryRoot
 * @param {object} state
 */
export async function saveState(libraryRoot, state) {
  ensureLibraryDirs(libraryRoot);
  await atomicWriteFile(
    getStatePath(libraryRoot),
    JSON.stringify(state, null, 2)
  );
}
