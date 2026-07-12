// @ts-check
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentSkillsRoot } from "@/lib/agent-library/paths.js";
import { mergeJsonMcpConfig } from "@/lib/agent-library/mcp-adapters.js";
import { writeManagedMarker } from "@/lib/agent-library/markers.js";
import { installSkillMarkdown } from "@/lib/agent-library/skills-store.js";
import { applySync } from "@/lib/agent-library/sync.js";
import { defaultSettings } from "@/lib/agent-library/settings.js";

/** @type {string[]} */
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function readRenderedConfig(kind, servers) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-agent-harness-"));
  tempDirs.push(dir);
  const file = path.join(dir, "config.json");
  await mergeJsonMcpConfig(file, servers, {
    kind,
    neverOverwriteUser: true,
    previouslyManaged: [],
  });
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

describe("agent-library harness compatibility", () => {
  it("uses Codex's shared skill directories", () => {
    expect(getAgentSkillsRoot("codex")).toBe(path.join(os.homedir(), ".agents", "skills"));
    expect(getAgentSkillsRoot("codex", {
      scope: "project",
      projectPath: "/tmp/example-project",
    })).toBe("/tmp/example-project/.agents/skills");
  });

  it("renders OpenCode MCP transports and environment references in its native shape", async () => {
    const config = await readRenderedConfig("opencode", [
      {
        id: "sb-local",
        name: "Local",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: { TOKEN: "${TOKEN}" },
      },
      {
        id: "sb-http",
        name: "HTTP",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    ]);

    expect(config.mcp).toEqual({
      "sb-local": {
        type: "local",
        command: ["node", "server.mjs"],
        enabled: true,
        environment: { TOKEN: "{env:TOKEN}" },
      },
      "sb-http": {
        type: "remote",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer {env:TOKEN}" },
        enabled: true,
      },
    });
  });

  it("uses Gemini's transport discriminator for HTTP and SSE MCPs", async () => {
    const config = await readRenderedConfig("gemini", [
      {
        id: "sb-sse",
        name: "SSE",
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      {
        id: "sb-http",
        name: "HTTP",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    ]);

    expect(config.mcpServers).toEqual({
      "sb-sse": {
        url: "https://example.test/sse",
        type: "sse",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      "sb-http": {
        url: "https://example.test/mcp",
        type: "http",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    });
  });

  it("removes legacy managed Codex skill projections during sync", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "sb-agent-codex-migrate-"));
    tempDirs.push(project);
    const libraryRoot = path.join(project, ".switchboard", "agent-library");
    const skill = await installSkillMarkdown(libraryRoot, {
      id: "demo",
      markdown: "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
    });
    const legacySkill = path.join(project, ".codex", "skills", "sb-demo");
    await fs.mkdir(path.dirname(legacySkill), { recursive: true });
    await fs.symlink(skill.path, legacySkill, "dir");
    await writeManagedMarker(legacySkill, {
      skillId: "demo",
      libraryPath: skill.path,
      linkMode: "symlink",
    });

    const settings = defaultSettings();
    settings.scope = "project";
    settings.projectPath = project;
    settings.includeProductSkills = false;
    for (const target of Object.values(settings.targets)) {
      target.skills = false;
      target.mcp = false;
    }
    settings.targets.codex.skills = true;

    await applySync(settings);

    await expect(fs.lstat(legacySkill)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(project, ".agents", "skills", "sb-demo"))).resolves.toBeTruthy();
  });
});
