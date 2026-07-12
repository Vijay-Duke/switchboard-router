// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  AGENT_TARGETS,
  ensureLibraryDirs,
  getAgentMcpConfig,
  getAgentSkillsRoot,
  getLegacyAgentSkillsRoots,
  managedSkillDirName,
} from "./paths.js";
import {
  loadSettings,
  loadState,
  resolveLibraryRoot,
  saveState,
  defaultSettings,
  assertSettingsReady,
} from "./settings.js";
import {
  ensureProductSkillsInLibrary,
  getLibrarySkillPath,
  listLibrarySkills,
} from "./skills-store.js";
import { listMcpServers } from "./mcp-store.js";
import {
  canManagePath,
  writeManagedMarker,
  removeManagedMarker,
} from "./markers.js";
import { linkSkill, removePath, inspectLink } from "./link.js";
import { mergeCodexMcpConfig, mergeJsonMcpConfig } from "./mcp-adapters.js";
import { withAgentLibraryLock } from "./fs-utils.js";

/**
 * Remove a managed skill destination only if the ownership gate allows it.
 * Gate is checked immediately before mutate (TOCTOU).
 * @param {string} destDir
 * @param {string} libraryRoot
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string }>}
 */
async function safeRemoveManaged(destDir, libraryRoot) {
  const gate = await canManagePath(destDir, true, { libraryRoot });
  if (!gate.ok) return gate;
  await removePath(destDir);
  await removeManagedMarker(destDir);
  return { ok: true, reason: gate.reason };
}

/**
 * Remove a previous harness-specific skill projection after its replacement
 * has been written to the current discovery root.
 * @param {string} agentId
 * @param {string} currentRoot
 * @param {string[]} destNames
 * @param {Record<string, unknown>} scopeOpts
 * @param {string} libraryRoot
 * @param {boolean} dryRun
 * @param {any[]} results
 */
async function migrateLegacySkillRoots(
  agentId,
  currentRoot,
  destNames,
  scopeOpts,
  libraryRoot,
  dryRun,
  results
) {
  for (const legacyRoot of getLegacyAgentSkillsRoots(agentId, scopeOpts)) {
    if (legacyRoot === currentRoot) continue;
    for (const destName of destNames) {
      const destDir = path.join(legacyRoot, destName);
      try {
        await fs.lstat(destDir);
      } catch {
        continue;
      }
      if (dryRun) {
        const gate = await canManagePath(destDir, true, { libraryRoot });
        if (gate.ok) {
          results.push({
            agent: agentId,
            skillId: destName,
            dest: destDir,
            action: "would_remove_legacy",
          });
        }
        continue;
      }
      const removed = await safeRemoveManaged(destDir, libraryRoot);
      results.push({
        agent: agentId,
        skillId: destName,
        dest: destDir,
        action: removed.ok ? "removed_legacy" : "skipped_legacy_conflict",
        ...(removed.ok ? {} : { reason: removed.reason, message: removed.message }),
      });
    }
  }
}

/**
 * @param {import("./settings.js").AgentLibrarySettings} [settingsOverride]
 * @param {{ dryRun?: boolean, skillsOnly?: boolean, mcpOnly?: boolean }} [opts]
 */
export async function applySync(settingsOverride, opts = {}) {
  // Dry-run is read-only — skip exclusive lock so doctor/UI can preview freely
  if (opts.dryRun) {
    return applySyncBody(settingsOverride, opts);
  }
  try {
    return await withAgentLibraryLock(() => applySyncBody(settingsOverride, opts));
  } catch (e) {
    if (e?.code === "lock_timeout") {
      return {
        ok: false,
        error: "lock_timeout",
        message: e.message,
      };
    }
    throw e;
  }
}

/**
 * @param {import("./settings.js").AgentLibrarySettings} [settingsOverride]
 * @param {{ dryRun?: boolean, skillsOnly?: boolean, mcpOnly?: boolean }} [opts]
 */
async function applySyncBody(settingsOverride, opts = {}) {
  const settings = settingsOverride || defaultSettings();
  try {
    assertSettingsReady(settings);
  } catch (e) {
    return {
      ok: false,
      error: e?.code || "settings_invalid",
      message: e?.message || "Invalid settings",
    };
  }
  const libraryRoot = resolveLibraryRoot(settings);
  ensureLibraryDirs(libraryRoot);

  if (settings.includeProductSkills) {
    await ensureProductSkillsInLibrary(libraryRoot);
  }

  const skills = await listLibrarySkills(libraryRoot);
  const mcpServers = await listMcpServers(libraryRoot);
  const state = await loadState(libraryRoot);
  const scopeOpts = { scope: settings.scope, projectPath: settings.projectPath };

  /** @type {any[]} */
  const skillResults = [];
  /** @type {any[]} */
  const mcpResults = [];

  const doSkills = !opts.mcpOnly;
  const doMcp = !opts.skillsOnly;

  if (doSkills) {
    for (const [agentId, agent] of Object.entries(AGENT_TARGETS)) {
      if (!agent.supportsSkills) continue;
      if (settings.targets[agentId]?.skills === false) {
        skillResults.push({ agent: agentId, action: "skipped_disabled" });
        continue;
      }
      const root = getAgentSkillsRoot(agentId, scopeOpts);
      if (!root) continue;

      if (!opts.dryRun) {
        await fs.mkdir(root, { recursive: true });
      }

      for (const skill of skills) {
        const destName = managedSkillDirName(skill.id);
        if (!destName) continue;
        const destDir = path.join(root, destName);
        const srcDir = getLibrarySkillPath(libraryRoot, skill.id);
        if (!existsSync(path.join(srcDir, "SKILL.md"))) {
          skillResults.push({
            agent: agentId,
            skillId: skill.id,
            action: "missing_source",
          });
          continue;
        }

        const gate = await canManagePath(destDir, settings.neverOverwriteUser, {
          libraryRoot,
        });
        if (!gate.ok) {
          skillResults.push({
            agent: agentId,
            skillId: skill.id,
            dest: destDir,
            action: "conflict",
            reason: gate.reason,
            message: gate.message,
          });
          continue;
        }

        if (opts.dryRun) {
          skillResults.push({
            agent: agentId,
            skillId: skill.id,
            dest: destDir,
            action: "would_sync",
            linkMode: settings.linkMode,
          });
          continue;
        }

        // linkSkill re-validates ownership immediately before replace (TOCTOU)
        try {
          const linkRes = await linkSkill(
            srcDir,
            destDir,
            settings.linkMode,
            libraryRoot,
            { neverOverwriteUser: settings.neverOverwriteUser }
          );
          await writeManagedMarker(destDir, {
            skillId: skill.id,
            libraryPath: srcDir,
            linkMode: linkRes.mode,
          });
          skillResults.push({
            agent: agentId,
            skillId: skill.id,
            dest: destDir,
            action: "synced",
            ...linkRes,
          });

          if (!state.managedSkills) state.managedSkills = {};
          if (!state.managedSkills[agentId]) state.managedSkills[agentId] = [];
          if (!state.managedSkills[agentId].includes(destName)) {
            state.managedSkills[agentId].push(destName);
          }
        } catch (e) {
          if (e?.code === "conflict") {
            skillResults.push({
              agent: agentId,
              skillId: skill.id,
              dest: destDir,
              action: "conflict",
              reason: e.reason || "conflict",
              message: e.message,
            });
          } else {
            skillResults.push({
              agent: agentId,
              skillId: skill.id,
              dest: destDir,
              action: "error",
              error: e?.message || String(e),
            });
          }
        }
      }

      const legacyDestNames = [...new Set([
        ...(state.managedSkills?.[agentId] || []),
        ...skills.map((skill) => managedSkillDirName(skill.id)).filter(Boolean),
      ])];
      await migrateLegacySkillRoots(
        agentId,
        root,
        legacyDestNames,
        scopeOpts,
        libraryRoot,
        !!opts.dryRun,
        skillResults
      );

      // Remove managed skills no longer in library
      const managedList = [...(state.managedSkills?.[agentId] || [])];
      const desired = new Set(skills.map((s) => managedSkillDirName(s.id)));
      const stillManaged = [];
      for (const destName of managedList) {
        if (desired.has(destName)) {
          stillManaged.push(destName);
          continue;
        }
        const destDir = path.join(root, destName);
        if (opts.dryRun) {
          const gate = await canManagePath(destDir, true, { libraryRoot });
          if (!gate.ok) {
            stillManaged.push(destName);
            continue;
          }
          skillResults.push({
            agent: agentId,
            skillId: destName,
            dest: destDir,
            action: "would_remove",
          });
          continue;
        }
        const removed = await safeRemoveManaged(destDir, libraryRoot);
        if (!removed.ok) {
          stillManaged.push(destName);
          continue;
        }
        skillResults.push({
          agent: agentId,
          skillId: destName,
          dest: destDir,
          action: "removed_stale",
        });
      }
      if (state.managedSkills) state.managedSkills[agentId] = stillManaged;
    }
  }

  if (doMcp) {
    for (const [agentId, agent] of Object.entries(AGENT_TARGETS)) {
      if (!agent.supportsMcp) continue;
      if (settings.targets[agentId]?.mcp === false) {
        mcpResults.push({ agent: agentId, action: "skipped_disabled" });
        continue;
      }
      const cfg = getAgentMcpConfig(agentId, scopeOpts);
      if (!cfg) continue;

      const previouslyManaged = state.managedMcpKeys?.[agentId] || [];

      try {
        let res;
        if (cfg.format === "toml") {
          res = await mergeCodexMcpConfig(cfg.path, mcpServers, {
            neverOverwriteUser: settings.neverOverwriteUser,
            dryRun: opts.dryRun,
            previouslyManaged,
          });
        } else {
          res = await mergeJsonMcpConfig(cfg.path, mcpServers, {
            kind: cfg.kind,
            neverOverwriteUser: settings.neverOverwriteUser,
            dryRun: opts.dryRun,
            previouslyManaged,
          });
        }
        mcpResults.push({ agent: agentId, ...res });
        if (res.ok && !opts.dryRun) {
          if (!state.managedMcpKeys) state.managedMcpKeys = {};
          // Authoritative ownership = what we successfully wrote this apply.
          // Do not retain stale previouslyManaged keys (could later overwrite user sb-*).
          state.managedMcpKeys[agentId] = [...(res.written || [])];
        }
      } catch (e) {
        mcpResults.push({
          agent: agentId,
          ok: false,
          error: e?.message || String(e),
          path: cfg.path,
        });
      }
    }
  }

  if (!opts.dryRun) {
    state.lastSync = {
      at: new Date().toISOString(),
      skillCount: skills.length,
      mcpCount: mcpServers.length,
      linkMode: settings.linkMode,
      scope: settings.scope,
    };
    await saveState(libraryRoot, state);
  }

  const conflicts = skillResults.filter((r) => r.action === "conflict");
  return {
    ok: true,
    dryRun: !!opts.dryRun,
    libraryRoot,
    settings: {
      linkMode: settings.linkMode,
      scope: settings.scope,
      neverOverwriteUser: settings.neverOverwriteUser,
    },
    skills: skillResults,
    mcp: mcpResults,
    conflictCount: conflicts.length,
    summary: {
      skillsSynced: skillResults.filter((r) => r.action === "synced" || r.action === "would_sync").length,
      skillsConflicts: conflicts.length,
      mcpOk: mcpResults.filter((r) => r.ok).length,
      mcpFailed: mcpResults.filter((r) => r.ok === false).length,
    },
  };
}

/**
 * Remove only Switchboard-managed skills/MCP from targets.
 */
export async function cleanSync(settingsOverride) {
  try {
    return await withAgentLibraryLock(() => cleanSyncBody(settingsOverride));
  } catch (e) {
    if (e?.code === "lock_timeout") {
      return { ok: false, error: "lock_timeout", message: e.message };
    }
    throw e;
  }
}

/**
 * @param {import("./settings.js").AgentLibrarySettings} [settingsOverride]
 */
async function cleanSyncBody(settingsOverride) {
  const settings = settingsOverride || (await loadSettings());
  try {
    assertSettingsReady({ ...settings, enabled: true });
  } catch (e) {
    if (e?.code === "project_path_missing" || e?.code === "project_path_invalid") {
      return { ok: false, error: e.code, message: e.message };
    }
  }
  const libraryRoot = resolveLibraryRoot(settings);
  const state = await loadState(libraryRoot);
  const scopeOpts = { scope: settings.scope, projectPath: settings.projectPath };
  const results = [];

  for (const [agentId, agent] of Object.entries(AGENT_TARGETS)) {
    if (agent.supportsSkills && settings.targets[agentId]?.skills !== false) {
      const root = getAgentSkillsRoot(agentId, scopeOpts);
      const managed = state.managedSkills?.[agentId] || [];
      if (root) {
        for (const destName of managed) {
          const destDir = path.join(root, destName);
          const removed = await safeRemoveManaged(destDir, libraryRoot);
          if (removed.ok) {
            results.push({
              agent: agentId,
              type: "skill",
              dest: destDir,
              action: "removed",
            });
          } else {
            results.push({
              agent: agentId,
              type: "skill",
              dest: destDir,
              action: "skipped_conflict",
              reason: removed.reason,
              message: removed.message,
            });
          }
        }
        await migrateLegacySkillRoots(
          agentId,
          root,
          managed,
          scopeOpts,
          libraryRoot,
          false,
          results
        );
        if (state.managedSkills) state.managedSkills[agentId] = [];
      }
    }

    if (agent.supportsMcp && settings.targets[agentId]?.mcp !== false) {
      const cfg = getAgentMcpConfig(agentId, scopeOpts);
      const previouslyManaged = state.managedMcpKeys?.[agentId] || [];
      if (cfg) {
        if (cfg.format === "toml") {
          await mergeCodexMcpConfig(cfg.path, [], {
            neverOverwriteUser: true,
            previouslyManaged,
          });
        } else {
          await mergeJsonMcpConfig(cfg.path, [], {
            kind: cfg.kind,
            neverOverwriteUser: true,
            previouslyManaged,
          });
        }
        results.push({ agent: agentId, type: "mcp", path: cfg.path, action: "cleared_managed" });
      }
      if (state.managedMcpKeys) state.managedMcpKeys[agentId] = [];
    }
  }

  state.lastSync = { at: new Date().toISOString(), cleaned: true };
  await saveState(libraryRoot, state);
  return { ok: true, results };
}

/**
 * Health check across library + agent projections.
 * Report generation is lock-free; state persistence is under the exclusive lock
 * so lastDoctor does not clobber a concurrent apply's lastSync.
 */
export async function runDoctor(settingsOverride) {
  const settings = settingsOverride || defaultSettings();
  const libraryRoot = resolveLibraryRoot(settings);
  ensureLibraryDirs(libraryRoot);
  const skills = await listLibrarySkills(libraryRoot);
  const mcpServers = await listMcpServers(libraryRoot);
  const scopeOpts = { scope: settings.scope, projectPath: settings.projectPath };
  const issues = [];
  const checks = [];

  checks.push({
    id: "library",
    ok: true,
    message: `Library at ${libraryRoot} (${skills.length} skills, ${mcpServers.length} MCP servers)`,
  });

  if (settings.scope === "project" && !settings.projectPath) {
    issues.push({
      severity: "error",
      code: "project_path_missing",
      message: "Project scope selected but no project path set",
    });
  }

  for (const [agentId, agent] of Object.entries(AGENT_TARGETS)) {
    if (settings.targets[agentId]?.skills !== false && agent.supportsSkills) {
      const root = getAgentSkillsRoot(agentId, scopeOpts);
      for (const skill of skills) {
        const destName = managedSkillDirName(skill.id);
        if (!root) continue;
        const destDir = path.join(root, destName);
        const info = inspectLink(destDir);
        if (!info.exists) {
          issues.push({
            severity: "warn",
            code: "skill_not_synced",
            agent: agentId,
            skillId: skill.id,
            message: `${agent.label}: ${destName} not present — run Apply`,
          });
        } else if (info.broken) {
          issues.push({
            severity: "error",
            code: "skill_broken_symlink",
            agent: agentId,
            skillId: skill.id,
            path: destDir,
            message: `${agent.label}: ${destName} is a broken symlink — re-Apply`,
          });
        } else {
          const gate = await canManagePath(destDir, true, { libraryRoot });
          if (!gate.ok) {
            issues.push({
              severity: "error",
              code: "skill_conflict",
              agent: agentId,
              skillId: skill.id,
              path: destDir,
              message: `${agent.label}: ${destName} exists but is not Switchboard-managed`,
            });
          } else {
            checks.push({
              id: `skill:${agentId}:${skill.id}`,
              ok: true,
              message: `${agent.label} ← ${destName} (${info.type})`,
            });
          }
        }
      }
    }

    if (settings.targets[agentId]?.mcp !== false && agent.supportsMcp) {
      const cfg = getAgentMcpConfig(agentId, scopeOpts);
      if (cfg) {
        const exists = existsSync(cfg.path);
        checks.push({
          id: `mcp-file:${agentId}`,
          ok: true,
          message: `${agent.label} MCP config ${exists ? "found" : "will be created"}: ${cfg.path}`,
        });
      }
    }
  }

  // Secret hygiene
  for (const s of mcpServers) {
    if (s.env) {
      for (const [k, v] of Object.entries(s.env)) {
        if (
          typeof v === "string" &&
          v.length > 12 &&
          !v.includes("${") &&
          /^(sk-|ghp_|xox|AKIA|key-)/i.test(v)
        ) {
          issues.push({
            severity: "warn",
            code: "possible_secret_in_library",
            mcpId: s.id,
            envKey: k,
            message: `MCP ${s.id} env.${k} looks like a raw secret — prefer \${ENV_VAR} references`,
          });
        }
      }
    }
  }

  const report = {
    ok: issues.filter((i) => i.severity === "error").length === 0,
    at: new Date().toISOString(),
    libraryRoot,
    linkMode: settings.linkMode,
    platform: process.platform,
    checks,
    issues,
  };

  try {
    await withAgentLibraryLock(async () => {
      const state = await loadState(libraryRoot);
      state.lastDoctor = report;
      await saveState(libraryRoot, state);
    });
  } catch (e) {
    // Doctor result still useful if state write loses the lock race
    if (e?.code !== "lock_timeout") throw e;
    report.statePersistSkipped = true;
  }
  return report;
}
