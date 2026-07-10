import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseTOML } from "confbox";

const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
let home;

const payload = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: "sk-test",
  model: "cc/claude-sonnet-5",
  defaultModel: "cc/claude-sonnet-5",
  models: ["cx/gpt-5.6", "cc/claude-sonnet-5"],
};

const post = (body = payload) => new Request("http://localhost", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "switchboard-cli-models-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await fs.rm(home, { recursive: true, force: true });
});

describe("CLI catalog routes write native client schemas", () => {
  it("returns a client error for malformed scalar fields", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post({ ...payload, baseUrl: [] }))).status).toBe(400);
    expect((await POST(post({ ...payload, apiKey: { value: "bad" } }))).status).toBe(400);
  });

  it("writes Pi's models array", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = JSON.parse(await fs.readFile(path.join(home, ".pi/agent/models.json"), "utf8"));
    expect(config.providers.switchboard.models.map((entry) => entry.id)).toEqual(payload.models);
  });

  it("writes jcode's repeated model entries", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/jcode-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = parseTOML(await fs.readFile(path.join(home, ".jcode/config.toml"), "utf8"));
    expect(config.providers.switchboard.models.map((entry) => entry.id)).toEqual(payload.models);
    expect(config.providers.switchboard.default_model).toBe(payload.defaultModel);
  });

  it("writes Hermes's named custom provider catalog", async () => {
    const configPath = path.join(home, ".hermes/config.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "theme: dark\ncustom_providers:\n  - name: local\n    base_url: http://localhost:11434/v1\n");
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = parseYaml(await fs.readFile(configPath, "utf8"));
    const provider = config.custom_providers.find((entry) => entry.name === "switchboard");
    expect(Object.keys(provider.models)).toEqual(payload.models);
    expect(config.model).toMatchObject({ provider: "custom:switchboard", default: payload.defaultModel });
    expect((await DELETE()).status).toBe(200);
    const restored = parseYaml(await fs.readFile(configPath, "utf8"));
    expect(restored.theme).toBe("dark");
    expect(restored.custom_providers.map((entry) => entry.name)).toEqual(["local"]);

    const unmanaged = "model:\n  default: own/model\n  provider: custom\n  base_url: https://example.com/v1\n";
    await fs.writeFile(configPath, unmanaged);
    expect((await DELETE()).status).toBe(200);
    expect(await fs.readFile(configPath, "utf8")).toBe(unmanaged);
  });

  it("writes Kilo's provider model map", async () => {
    const configPath = path.join(home, ".config/kilo/kilo.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      permission: { edit: "ask" },
      model: "ollama/llama",
      provider: { switchboard: { name: "Prior Switchboard" }, ollama: {} },
    }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/kilo-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(Object.keys(config.provider.switchboard.models)).toEqual(payload.models);
    expect(config.model).toBe(`switchboard/${payload.defaultModel}`);
    expect((await DELETE()).status).toBe(200);
    const restored = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(restored.permission).toEqual({ edit: "ask" });
    expect(restored.model).toBe("ollama/llama");
    expect(restored.provider.switchboard).toEqual({ name: "Prior Switchboard" });
    expect(restored.provider.ollama).toEqual({});
  });

  it("writes Cline's registries and restores the prior extension settings", async () => {
    const dataDir = path.join(home, ".cline/data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "globalState.json"), JSON.stringify({
      theme: "dark",
      actModeApiProvider: "anthropic",
      planModeApiProvider: "anthropic",
      openAiBaseUrl: "https://prior.example/v1",
      actModeOpenAiModelId: "prior-act",
      planModeOpenAiModelId: "prior-plan",
    }));
    await fs.writeFile(path.join(dataDir, "secrets.json"), JSON.stringify({ openAiApiKey: "prior-key", other: "keep" }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/cline-settings/route.js");
    expect((await POST(post({ ...payload, actModel: payload.models[0], planModel: payload.models[1] }))).status).toBe(200);
    const providers = JSON.parse(await fs.readFile(path.join(home, ".cline/data/settings/providers.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(home, ".cline/data/settings/models.json"), "utf8"));
    expect(providers.providers.switchboard.defaultModelId).toBe(payload.defaultModel);
    expect(Object.keys(models.providers.switchboard.models)).toEqual(payload.models);
    expect((await DELETE()).status).toBe(200);
    const restoredState = JSON.parse(await fs.readFile(path.join(dataDir, "globalState.json"), "utf8"));
    const restoredSecrets = JSON.parse(await fs.readFile(path.join(dataDir, "secrets.json"), "utf8"));
    expect(restoredState).toMatchObject({
      theme: "dark",
      actModeApiProvider: "anthropic",
      planModeApiProvider: "anthropic",
      openAiBaseUrl: "https://prior.example/v1",
      actModeOpenAiModelId: "prior-act",
      planModeOpenAiModelId: "prior-plan",
    });
    expect(restoredSecrets).toEqual({ openAiApiKey: "prior-key", other: "keep" });
  });

  it("writes Aider aliases without losing unrelated YAML", async () => {
    const configPath = path.join(home, ".aider.conf.yml");
    await fs.writeFile(configPath, "dark-mode: true\n");
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/aider-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = parseYaml(await fs.readFile(configPath, "utf8"));
    expect(config["dark-mode"]).toBe(true);
    expect(config.alias).toHaveLength(2);
    if (process.platform !== "win32") {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
    expect((await DELETE()).status).toBe(200);
    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({ "dark-mode": true });
  });

  it("writes Gemini's native environment and keyed model definitions", async () => {
    const geminiDir = path.join(home, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(path.join(geminiDir, "settings.json"), JSON.stringify({
      model: { name: "prior-model", other: true },
      experimental: { dynamicModelConfiguration: false, other: true },
      modelConfigs: { modelDefinitions: { prior: { family: "switchboard", displayName: "Prior" } } },
    }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/gemini-cli-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const env = await fs.readFile(path.join(home, ".gemini/.env"), "utf8");
    const settings = JSON.parse(await fs.readFile(path.join(home, ".gemini/settings.json"), "utf8"));
    expect(env).toContain("GOOGLE_GEMINI_BASE_URL=\"http://127.0.0.1:20128\"");
    expect(env).not.toContain("OPENAI_BASE_URL");
    expect(Object.keys(settings.modelConfigs.modelDefinitions)).toEqual(payload.models);
    expect((await DELETE()).status).toBe(200);
    const restored = JSON.parse(await fs.readFile(path.join(geminiDir, "settings.json"), "utf8"));
    expect(restored.model).toEqual({ name: "prior-model", other: true });
    expect(restored.experimental).toEqual({ dynamicModelConfiguration: false, other: true });
    expect(restored.modelConfigs.modelDefinitions).toEqual({ prior: { family: "switchboard", displayName: "Prior" } });
  });

  it("fails Gemini configuration before changing the env when settings.json is invalid", async () => {
    const geminiDir = path.join(home, ".gemini");
    await fs.writeFile(path.join(geminiDir, "settings.json"), "{ invalid");
    await fs.rm(path.join(geminiDir, ".env"), { force: true });
    const { POST } = await import("../../src/app/api/cli-tools/gemini-cli-settings/route.js");
    expect((await POST(post())).status).toBe(500);
    await expect(fs.access(path.join(geminiDir, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores OpenClaw defaults, agent overrides, and per-agent providers", async () => {
    const openclawDir = path.join(home, ".openclaw");
    const agentDir = path.join(openclawDir, "agents", "worker");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(openclawDir, "openclaw.json"), JSON.stringify({
      models: { providers: { switchboard: { baseUrl: "https://prior.example/v1" }, ollama: {} } },
      agents: {
        defaults: {
          model: { primary: "ollama/llama" },
          models: { "switchboard/prior": { alias: "prior" }, "ollama/llama": {} },
        },
        list: [{ id: "worker", agentDir, model: "ollama/llama" }],
      },
    }));
    await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
      providers: { switchboard: { baseUrl: "https://agent-prior.example/v1" }, ollama: {} },
    }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/openclaw-settings/route.js");
    expect((await POST(post({ ...payload, agentModels: { worker: payload.models[1] } }))).status).toBe(200);
    const configuredAgent = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(configuredAgent.providers.switchboard.models.map((entry) => entry.id)).toEqual([
      payload.models[1],
      payload.models[0],
    ]);
    expect((await DELETE()).status).toBe(200);
    const restored = JSON.parse(await fs.readFile(path.join(openclawDir, "openclaw.json"), "utf8"));
    const restoredAgent = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(restored.models.providers.switchboard).toEqual({ baseUrl: "https://prior.example/v1" });
    expect(restored.agents.defaults.model.primary).toBe("ollama/llama");
    expect(restored.agents.defaults.models["switchboard/prior"]).toEqual({ alias: "prior" });
    expect(restored.agents.list[0].model).toBe("ollama/llama");
    expect(restoredAgent.providers.switchboard).toEqual({ baseUrl: "https://agent-prior.example/v1" });
  });

  it("does not roll back a manually changed DeepSeek endpoint", async () => {
    const deepseekDir = path.join(home, ".deepseek");
    await fs.mkdir(deepseekDir, { recursive: true });
    await fs.writeFile(path.join(deepseekDir, "config.toml"), "provider = \"deepseek\"\n[ui]\ntheme = \"dark\"\n");
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/deepseek-tui-settings/route.js");
    expect((await POST(post({ ...payload, model: payload.defaultModel }))).status).toBe(200);
    const changed = parseTOML(await fs.readFile(path.join(deepseekDir, "config.toml"), "utf8"));
    changed.providers.openai.base_url = "https://manual.example/v1";
    await fs.writeFile(path.join(deepseekDir, "config.toml"), `provider = \"openai\"\n[providers.openai]\nbase_url = \"${changed.providers.openai.base_url}\"\napi_key = \"manual\"\nmodel = \"manual\"\n[ui]\ntheme = \"dark\"\n`);
    expect((await DELETE()).status).toBe(200);
    const preserved = parseTOML(await fs.readFile(path.join(deepseekDir, "config.toml"), "utf8"));
    expect(preserved.providers.openai.base_url).toBe("https://manual.example/v1");
    expect(preserved.ui.theme).toBe("dark");
  });
});
