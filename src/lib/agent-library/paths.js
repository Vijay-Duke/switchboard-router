// @ts-check
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

/** Namespace for Switchboard-managed skill dirs / MCP keys — never bare names. */
export const SB_NAMESPACE = "sb";

export const MANAGED_MARKER = ".switchboard-managed.json";

/** Agents that support Agent Skills and/or MCP config projection. */
export const AGENT_TARGETS = {
  claude: {
    id: "claude",
    label: "Claude Code",
    supportsSkills: true,
    supportsMcp: true,
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    supportsSkills: true,
    supportsMcp: true,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    supportsSkills: true,
    supportsMcp: true,
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    supportsSkills: true,
    supportsMcp: true,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    supportsSkills: true,
    supportsMcp: true,
  },
};

/**
 * @param {{ scope?: "global"|"project", projectPath?: string|null }} [opts]
 */
export function getLibraryRoot(opts = {}) {
  if (opts.scope === "project" && opts.projectPath) {
    const root = path.resolve(opts.projectPath);
    return path.join(root, ".switchboard", "agent-library");
  }
  return path.join(DATA_DIR, "agent-library");
}

export function getSkillsDir(libraryRoot) {
  return path.join(libraryRoot, "skills");
}

export function getMcpPath(libraryRoot) {
  return path.join(libraryRoot, "mcp", "servers.json");
}

export function getSettingsPath(libraryRoot) {
  return path.join(libraryRoot, "settings.json");
}

export function getStatePath(libraryRoot) {
  return path.join(libraryRoot, "state.json");
}

/**
 * Managed skill folder name on disk in the library (no namespace — library is ours).
 * Rejects path traversal (., .., empty, leading dots-only).
 */
export function librarySkillDirName(skillId) {
  let s = String(skillId || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  // Collapse path-segment hazards
  if (!s || s === "." || s === ".." || s.includes("..")) return "";
  // Must contain at least one alphanumeric
  if (!/[a-zA-Z0-9]/.test(s)) return "";
  return s;
}

/**
 * Destination skill directory name under an agent (namespaced to avoid collisions).
 * e.g. switchboard → sb-switchboard
 */
export function managedSkillDirName(skillId) {
  const base = librarySkillDirName(skillId);
  if (!base) return null;
  if (base.startsWith(`${SB_NAMESPACE}-`)) return base;
  return `${SB_NAMESPACE}-${base}`;
}

/**
 * Resolve agent skill install roots (global user-level by default).
 * Project scope uses paths under projectPath when provided.
 * @param {string} agentId
 * @param {{ scope?: "global"|"project", projectPath?: string|null }} [opts]
 * @returns {string|null}
 */
export function getAgentSkillsRoot(agentId, opts = {}) {
  const home = os.homedir();
  const project = opts.scope === "project" && opts.projectPath
    ? path.resolve(opts.projectPath)
    : null;

  switch (agentId) {
    case "claude":
      return project
        ? path.join(project, ".claude", "skills")
        : path.join(home, ".claude", "skills");
    case "codex":
      return project
        ? path.join(project, ".codex", "skills")
        : path.join(home, ".codex", "skills");
    case "opencode":
      return project
        ? path.join(project, ".opencode", "skills")
        : path.join(home, ".config", "opencode", "skills");
    case "gemini":
      return project
        ? path.join(project, ".gemini", "skills")
        : path.join(home, ".gemini", "skills");
    case "cursor":
      return project
        ? path.join(project, ".cursor", "skills")
        : path.join(home, ".cursor", "skills");
    default:
      return null;
  }
}

/**
 * MCP config file path for an agent.
 * @param {string} agentId
 * @param {{ scope?: "global"|"project", projectPath?: string|null }} [opts]
 * @returns {{ path: string, format: "json"|"toml", kind: string }|null}
 */
export function getAgentMcpConfig(agentId, opts = {}) {
  const home = os.homedir();
  const project = opts.scope === "project" && opts.projectPath
    ? path.resolve(opts.projectPath)
    : null;

  switch (agentId) {
    case "claude":
      // Project .mcp.json preferred when project scope; else user ~/.claude.json mcpServers
      if (project) {
        return {
          path: path.join(project, ".mcp.json"),
          format: "json",
          kind: "claude-project-mcp",
        };
      }
      return {
        path: path.join(home, ".claude.json"),
        format: "json",
        kind: "claude-user",
      };
    case "codex":
      return {
        path: project
          ? path.join(project, ".codex", "config.toml")
          : path.join(home, ".codex", "config.toml"),
        format: "toml",
        kind: "codex",
      };
    case "opencode":
      return {
        path: project
          ? path.join(project, "opencode.json")
          : path.join(home, ".config", "opencode", "opencode.json"),
        format: "json",
        kind: "opencode",
      };
    case "gemini":
      return {
        path: project
          ? path.join(project, ".gemini", "settings.json")
          : path.join(home, ".gemini", "settings.json"),
        format: "json",
        kind: "gemini",
      };
    case "cursor":
      return {
        path: project
          ? path.join(project, ".cursor", "mcp.json")
          : path.join(home, ".cursor", "mcp.json"),
        format: "json",
        kind: "cursor",
      };
    default:
      return null;
  }
}

export function ensureLibraryDirs(libraryRoot) {
  for (const dir of [
    libraryRoot,
    getSkillsDir(libraryRoot),
    path.join(libraryRoot, "mcp"),
  ]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function defaultLinkMode() {
  return process.platform === "win32" ? "copy" : "symlink";
}
