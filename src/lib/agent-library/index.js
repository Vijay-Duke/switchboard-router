// @ts-check
/**
 * Switchboard Agent Library — public API for dashboard routes.
 * Internal helpers live in sibling modules; only surface what routes need.
 */
import {
  loadSettings,
  loadState,
  resolveLibraryRoot,
  saveSettings,
} from "./settings.js";
import { ensureLibraryDirs, AGENT_TARGETS } from "./paths.js";
import {
  ensureProductSkillsInLibrary,
  listLibrarySkills,
  installSkillMarkdown,
  removeLibrarySkill,
} from "./skills-store.js";
import {
  listMcpServers,
  upsertMcpServer,
  removeMcpServer,
} from "./mcp-store.js";
import { applySync, cleanSync, runDoctor } from "./sync.js";
import { CATALOG_PRESETS, installFromUrl, previewUrl } from "./catalog.js";
import {
  checkSkillUpdates,
  previewSkillUpdate,
  updateSkillFromSource,
} from "./updates.js";
import { exportAgentSyncLayout } from "./export-agentsync.js";
import { isPathInside } from "./markers.js";

export {
  loadSettings,
  saveSettings,
  resolveLibraryRoot,
  listLibrarySkills,
  ensureProductSkillsInLibrary,
  installSkillMarkdown,
  removeLibrarySkill,
  listMcpServers,
  upsertMcpServer,
  removeMcpServer,
  applySync,
  cleanSync,
  runDoctor,
  CATALOG_PRESETS,
  installFromUrl,
  previewUrl,
  checkSkillUpdates,
  previewSkillUpdate,
  updateSkillFromSource,
  exportAgentSyncLayout,
  isPathInside,
};

/**
 * Dashboard overview: settings + library inventory.
 * @param {import("./settings.js").AgentLibrarySettings} [settings]
 */
export async function getOverview(settings) {
  const s = settings || (await loadSettings());
  const root = resolveLibraryRoot(s);
  ensureLibraryDirs(root);
  if (s.includeProductSkills) {
    await ensureProductSkillsInLibrary(root);
  }
  const [skills, mcp, state] = await Promise.all([
    listLibrarySkills(root),
    listMcpServers(root),
    loadState(root),
  ]);
  return {
    settings: s,
    libraryRoot: root,
    skills,
    mcpServers: mcp,
    state,
    agents: AGENT_TARGETS,
  };
}
