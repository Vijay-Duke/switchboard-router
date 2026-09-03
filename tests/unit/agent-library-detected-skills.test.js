// @ts-check
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Redirect every homedir() consumer (getAgentSkillsRoot) to a sandbox.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  const fake = path.join(actual.tmpdir(), `sb-detected-${process.pid}`);
  return {
    ...actual,
    default: { ...actual, homedir: () => fake },
  };
});

import os from "node:os";
import { listDetectedAgentSkills, installSkillMarkdown } from "@/lib/agent-library/skills-store.js";
import { applySync } from "@/lib/agent-library/sync.js";
import { defaultSettings } from "@/lib/agent-library/settings.js";

const HOME = os.homedir();

/**
 * @param {string} agentRoot e.g. ~/.claude/skills
 * @param {string} name skill folder name
 * @param {string} [markdown]
 */
async function seedSkill(agentRoot, name, markdown) {
  const dir = path.join(agentRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    markdown ?? `---\nname: ${name}\ndescription: ${name} desc\n---\n`,
    "utf-8"
  );
}

beforeAll(async () => {
  await fs.mkdir(HOME, { recursive: true });
});

afterAll(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});

describe("listDetectedAgentSkills", () => {
  it("lists skills across agent roots, deduped by folder name", async () => {
    const claude = path.join(HOME, ".claude", "skills");
    const codex = path.join(HOME, ".agents", "skills");
    await seedSkill(claude, "shared-skill");
    await seedSkill(codex, "shared-skill");
    await seedSkill(codex, "codex-only");

    // decoys: no SKILL.md
    await fs.mkdir(path.join(claude, "not-a-skill"), { recursive: true });
    await fs.writeFile(path.join(claude, "loose-file.md"), "x", "utf-8");

    const out = await listDetectedAgentSkills({ scope: "global" });
    const ids = out.map((s) => s.id);
    expect(ids).toContain("shared-skill");
    expect(ids).toContain("codex-only");
    expect(ids).not.toContain("not-a-skill");
    expect(ids).not.toContain("loose-file.md");

    const shared = out.find((s) => s.id === "shared-skill");
    expect(shared?.agents).toEqual(["claude", "codex"]);
    expect(shared?.title).toBe("shared-skill");
    expect(shared?.description).toBe("shared-skill desc");
    expect(shared?.managedBySwitchboard).toBe(false);
  });

  it("flags sb- namespaced dirs as Switchboard-managed", async () => {
    await seedSkill(path.join(HOME, ".claude", "skills"), "sb-switchboard");
    const out = await listDetectedAgentSkills({ scope: "global" });
    expect(out.find((s) => s.id === "sb-switchboard")?.managedBySwitchboard).toBe(true);
  });

  it("parses quoted frontmatter and survives unreadable SKILL.md", async () => {
    const claude = path.join(HOME, ".claude", "skills");
    await seedSkill(claude, "quoted", '---\nname: "Real Name"\ndescription: \'quoted desc\'\n---\n');
    await seedSkill(claude, "broken", "placeholder");
    await fs.chmod(path.join(claude, "broken", "SKILL.md"), 0o000).catch(() => {});

    const out = await listDetectedAgentSkills({ scope: "global" });
    const q = out.find((s) => s.id === "quoted");
    expect(q?.title).toBe("Real Name");
    expect(q?.description).toBe("quoted desc");
    // unreadable file → falls back to folder name, no throw
    expect(out.find((s) => s.id === "broken")?.title).toBe("broken");
  });

  it("returns [] when no agent roots exist and never throws", async () => {
    const empty = path.join(HOME, "empty-home-case");
    // no dirs created under this fake project scope
    const out = await listDetectedAgentSkills({
      scope: "project",
      projectPath: path.join(empty, "proj"),
    });
    expect(out).toEqual([]);
  });

  it("project scope reads project-local agent dirs only", async () => {
    const proj = path.join(HOME, "myproj");
    await seedSkill(path.join(proj, ".claude", "skills"), "proj-skill");
    await seedSkill(path.join(HOME, ".claude", "skills"), "global-skill");

    const out = await listDetectedAgentSkills({ scope: "project", projectPath: proj });
    const ids = out.map((s) => s.id);
    expect(ids).toContain("proj-skill");
    // omp has no project-scope root; claude project root used, global dirs not read
    const projSkill = out.find((s) => s.id === "proj-skill");
    expect(projSkill?.agents).toEqual(["claude"]);
  });
});

describe("applySync opencode skill dedupe", () => {
  it("skips opencode skill projection when claude/codex cover the scope", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "sb-opencode-dedupe-"));
    try {
      const libraryRoot = path.join(project, ".switchboard", "agent-library");
      await installSkillMarkdown(libraryRoot, {
        id: "demo",
        markdown: "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
      });

      const settings = defaultSettings();
      settings.scope = "project";
      settings.projectPath = project;
      settings.includeProductSkills = false;
      for (const target of Object.values(settings.targets)) {
        target.skills = false;
        target.mcp = false;
      }
      settings.targets.claude.skills = true;
      settings.targets.codex.skills = true;
      settings.targets.opencode.skills = true;

      const res = await applySync(settings);
      expect(res.ok).toBe(true);
      // OpenCode also discovers .claude/skills and .agents/skills, so its
      // own projection is skipped instead of triplicating sb-demo.
      expect(res.skills).toContainEqual({
        agent: "opencode",
        action: "skipped_covered_by",
        by: ["claude", "codex"],
      });
      expect(
        res.skills.filter((r) => r.agent === "claude" && r.action === "synced")
      ).toHaveLength(1);
      expect(
        res.skills.filter((r) => r.agent === "codex" && r.action === "synced")
      ).toHaveLength(1);
      await expect(
        fs.lstat(path.join(project, ".opencode", "skills", "sb-demo"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("still projects opencode skills when claude and codex are off", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "sb-opencode-solo-"));
    try {
      const libraryRoot = path.join(project, ".switchboard", "agent-library");
      await installSkillMarkdown(libraryRoot, {
        id: "demo",
        markdown: "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
      });

      const settings = defaultSettings();
      settings.scope = "project";
      settings.projectPath = project;
      settings.includeProductSkills = false;
      for (const target of Object.values(settings.targets)) {
        target.skills = false;
        target.mcp = false;
      }
      settings.targets.opencode.skills = true;

      const res = await applySync(settings);
      expect(res.ok).toBe(true);
      expect(
        res.skills.filter((r) => r.agent === "opencode" && r.action === "synced")
      ).toHaveLength(1);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
