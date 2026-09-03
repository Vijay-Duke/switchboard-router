// @ts-check
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentSkillsRoot, getAgentMcpConfig } from "@/lib/agent-library/paths.js";
import { mergeJsonMcpConfig, mergeCodexMcpConfig } from "@/lib/agent-library/mcp-adapters.js";
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

  it("projects MCP into omp's pi-mcp-agent config in Claude shape", async () => {
    const config = await readRenderedConfig("omp", [
      {
        id: "sb-local",
        name: "Local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
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

    // pi-mcp-adapter reads <agent-dir>/mcp.json with top-level mcpServers,
    // accepting { command, args, env } stdio and { url, headers } HTTP entries.
    expect(config.mcpServers).toEqual({
      "sb-local": {
        command: "npx",
        args: ["-y", "some-mcp"],
        env: { TOKEN: "${TOKEN}" },
      },
      "sb-http": {
        url: "https://example.test/mcp",
        type: "http",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    });
  });

  it("uses omp agent-dir paths for skills and MCP config", () => {
    expect(getAgentSkillsRoot("omp")).toBe(path.join(os.homedir(), ".pi", "agent", "skills"));
    expect(getAgentSkillsRoot("omp", { scope: "project", projectPath: "/tmp/p" })).toBeNull();
    expect(getAgentMcpConfig("omp")).toEqual({
      path: path.join(os.homedir(), ".pi", "agent", "mcp.json"),
      format: "json",
      kind: "omp",
    });
    expect(getAgentMcpConfig("omp", { scope: "project", projectPath: "/tmp/p" })).toEqual({
      path: "/tmp/p/.pi/mcp.json",
      format: "json",
      kind: "omp",
    });
  });

  it("round-trips Codex-only tunables (timeouts, per-tool config) through the TOML writer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-agent-codex-toml-"));
    tempDirs.push(dir);
    const file = path.join(dir, "config.toml");
    const res = await mergeCodexMcpConfig(file, [
      {
        id: "sb-xcode",
        name: "Xcode",
        transport: "stdio",
        command: "npx",
        args: ["-y", "xcodebuildmcp", "mcp"],
        env: { CWD: "/tmp" },
        startupTimeoutSec: 120,
        toolTimeoutSec: 600,
        tools: { build_run_sim: { approval_mode: "approve" } },
      },
      {
        id: "sb-typed",
        name: "Typed",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        tools: {
          evaluate: { approval_mode: "approve", output_token_limit: 4000 },
          legacy: { approval_mode: "approve", output_token_limit: "4000" },
        },
      },
      {
        id: "sb-remote",
        name: "Remote",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { "X-Custom": "literal" },
        startupTimeoutSec: 30,
        toolTimeoutSec: 120,
      },
    ], { neverOverwriteUser: true, previouslyManaged: [] });

    expect(res.skipped).toEqual([]);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain("startup_timeout_sec = 120");
    expect(raw).toContain("tool_timeout_sec = 600");
    expect(raw).toContain('[mcp_servers.sb-xcode.tools.build_run_sim]');
    expect(raw).toContain('approval_mode = "approve"');
    // Numeric tool values stay unquoted so Codex's strict parser accepts them.
    expect(raw).toContain('[mcp_servers.sb-typed.tools.evaluate]');
    expect(raw).toContain("output_token_limit = 4000");
    expect(raw).not.toContain('"4000"');
    // Legacy stringified limit is recovered as an integer; approval_mode untouched.
    expect(raw).toMatch(/\[mcp_servers\.sb-typed\.tools\.legacy\]\napproval_mode = "approve"\noutput_token_limit = 4000\n/);
    // Per-server timeouts also render on the HTTP branch.
    expect(raw).toMatch(/\[mcp_servers\.sb-remote\][\s\S]*?tool_timeout_sec = 120/);
  });

  it("projects Cursor MCP with ${env:NAME} interpolation and a stdio type", async () => {
    const config = await readRenderedConfig("cursor", [
      {
        id: "sb-local",
        name: "Local",
        transport: "stdio",
        command: "node",
        args: ["server.mjs", "--token", "${TOKEN}"],
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

    expect(config.mcpServers).toEqual({
      "sb-local": {
        type: "stdio",
        command: "node",
        args: ["server.mjs", "--token", "${env:TOKEN}"],
        env: { TOKEN: "${env:TOKEN}" },
      },
      "sb-http": {
        url: "https://example.test/mcp",
        type: "http",
        headers: { Authorization: "Bearer ${env:TOKEN}" },
      },
    });
  });

  it("projects Codex MCP secrets through env-native keys instead of ${VAR}", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-agent-codex-env-"));
    tempDirs.push(dir);
    const file = path.join(dir, "config.toml");
    const res = await mergeCodexMcpConfig(file, [
      {
        id: "sb-http",
        name: "HTTP",
        transport: "http",
        url: "https://example.test/mcp",
        headers: {
          Authorization: "Bearer ${TOKEN}",
          "X-Api-Key": "${API_KEY}",
          "X-Custom": "literal",
        },
      },
      {
        id: "sb-local",
        name: "Local",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: { TOKEN: "${TOKEN}", OTHER: "${TOKEN}" },
      },
    ], { neverOverwriteUser: true, previouslyManaged: [] });

    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain('bearer_token_env_var = "TOKEN"');
    expect(raw).toContain('[mcp_servers.sb-http.env_http_headers]\nX-Api-Key = "API_KEY"');
    expect(raw).toContain('X-Custom = "literal"');
    expect(raw).not.toContain("Bearer ${TOKEN}");
    expect(raw).toContain('env_vars = ["TOKEN"]');
    // env_vars is a bare key of [mcp_servers.sb-local]; it must precede the
    // [..env] sub-table or TOML would nest it as env.env_vars.
    const iTable = raw.indexOf("[mcp_servers.sb-local]");
    const iEnvVars = raw.indexOf('env_vars = ["TOKEN"]');
    const iEnvTable = raw.indexOf("[mcp_servers.sb-local.env]");
    expect(iTable).toBeGreaterThanOrEqual(0);
    expect(iEnvVars).toBeGreaterThan(iTable);
    expect(iEnvTable).toBeGreaterThan(iEnvVars);
    // Key!=name ref stays literal (no secret on disk) and is reported.
    expect(raw).toContain('OTHER = "${TOKEN}"');
    expect(res.skipped).toContainEqual({
      key: "sb-local.env.OTHER",
      reason: "codex_env_ref_unsupported",
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
