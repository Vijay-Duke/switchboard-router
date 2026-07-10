import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

  it("repairs structurally invalid Pi provider catalogs during Apply", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({ providers: [] }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    expect(Array.isArray(config.providers)).toBe(false);
    expect(config.providers.switchboard.models.map((entry) => entry.id)).toEqual(payload.models);
    expect((await DELETE()).status).toBe(200);
  });

  it("ignores a malformed prior model list instead of crashing Apply", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({
      providers: { switchboard: { models: { id: "not-an-array" } } },
    }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({}));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post())).status).toBe(200);
    const config = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    expect(config.providers.switchboard.models.map((entry) => entry.id)).toEqual(payload.models);
    expect((await DELETE()).status).toBe(200);
  });

  it("does not mark a remote URL containing localhost text as a local Switchboard endpoint", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({
      providers: { switchboard: { baseUrl: "https://evil.example/localhost/v1", models: [] } },
    }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({}));
    const { GET } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    const status = await (await GET()).json();
    expect(status.hasSwitchboard).toBe(false);
  });

  it("recognizes its provider after Pi rewrites object keys in a different order", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({ providers: {} }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({}));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post())).status).toBe(200);

    const config = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    const provider = config.providers.switchboard;
    config.providers.switchboard = {
      models: provider.models,
      compat: provider.compat,
      authHeader: provider.authHeader,
      apiKey: provider.apiKey,
      api: provider.api,
      baseUrl: provider.baseUrl,
    };
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify(config));
    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8")).providers.switchboard).toBeUndefined();
  });

  it("scopes Pi to selected Switchboard models and restores prior settings", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({
      providers: {
        zai: { models: [{ id: "glm-4.5-air" }] },
        switchboard: { baseUrl: "https://prior.example/v1", models: [{ id: "prior/model" }] },
      },
    }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({
      theme: "dark",
      defaultProvider: "zai",
      defaultModel: "glm-4.5-air",
      enabledModels: ["zai/glm-4.5-air"],
    }));
    const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    const before = await (await GET()).json();
    expect(before.settings.scopeConfigured).toBe(false);
    expect((await POST(post())).status).toBe(200);
    const config = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    const settings = JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"));
    expect(config.providers.switchboard.models.map((entry) => entry.id)).toEqual(payload.models);
    expect(config.providers.zai.models[0].id).toBe("glm-4.5-air");
    expect(settings).toMatchObject({
      theme: "dark",
      defaultProvider: "switchboard",
      defaultModel: payload.defaultModel,
      enabledModels: payload.models.map((model) => `switchboard/${model}`),
    });
    const status = await (await GET()).json();
    expect(status.settings.defaultModel).toBe(payload.defaultModel);
    expect(status.settings.scopeConfigured).toBe(true);

    expect((await DELETE()).status).toBe(200);
    const restoredModels = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    const restoredSettings = JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"));
    expect(restoredModels.providers.switchboard).toEqual({
      baseUrl: "https://prior.example/v1",
      models: [{ id: "prior/model" }],
    });
    expect(restoredModels.providers.zai.models[0].id).toBe("glm-4.5-air");
    expect(restoredSettings).toEqual({
      theme: "dark",
      defaultProvider: "zai",
      defaultModel: "glm-4.5-air",
      enabledModels: ["zai/glm-4.5-air"],
    });

    // Reset is idempotent even when the user had a pre-existing provider named
    // switchboard, and a later Apply starts a fresh backup cycle.
    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"))).toEqual(restoredModels);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"))).toEqual(restoredSettings);
    expect((await POST(post())).status).toBe(200);
    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"))).toEqual(restoredModels);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"))).toEqual(restoredSettings);
  });

  it("does not restore a default model after the user switches away from Switchboard", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({ providers: {} }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({
      defaultProvider: "zai",
      defaultModel: "glm-4.5-air",
    }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    expect((await POST(post({ ...payload, models: ["switchboard/model"], defaultModel: "switchboard/model" }))).status).toBe(200);

    // Simulate a user selecting another provider while retaining the same
    // model-id string. Reset must not overwrite that current choice.
    const current = JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"));
    current.defaultProvider = "zai";
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify(current));
    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"))).toMatchObject({
      defaultProvider: "zai",
      defaultModel: "switchboard/model",
    });
  });

  it("serializes concurrent Pi applies so settings and models stay in the same generation", async () => {
    const piDir = path.join(home, ".pi/agent");
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "models.json"), JSON.stringify({ providers: {} }));
    await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    const first = ["provider-one/model-a", "provider-one/model-b"];
    const second = ["provider-two/model-a"];
    const [firstResponse, secondResponse] = await Promise.all([
      POST(post({ ...payload, models: first, defaultModel: first[0] })),
      POST(post({ ...payload, models: second, defaultModel: second[0] })),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const config = JSON.parse(await fs.readFile(path.join(piDir, "models.json"), "utf8"));
    const settings = JSON.parse(await fs.readFile(path.join(piDir, "settings.json"), "utf8"));
    const catalog = config.providers.switchboard.models.map((entry) => entry.id);
    expect([first, second]).toContainEqual(catalog);
    expect(settings.enabledModels).toEqual(catalog.map((model) => `switchboard/${model}`));
    expect(settings.defaultModel).toBe(catalog[0]);
    expect((await DELETE()).status).toBe(200);
  });

  it("writes a source-safe Grok env and restores the previous user configuration", async () => {
    const grokDir = path.join(home, ".grok");
    const settingsPath = path.join(grokDir, "user-settings.json");
    const envPath = path.join(grokDir, "switchboard.env");
    await fs.mkdir(grokDir, { recursive: true });
    const previousSettings = { theme: "dark", apiKey: "prior-key", defaultModel: "prior-model" };
    const previousEnv = "export CUSTOM_VALUE='keep'\n";
    await fs.writeFile(settingsPath, JSON.stringify(previousSettings));
    await fs.writeFile(envPath, previousEnv);
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/grok-settings/route.js");
    const hostile = {
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "key'$(printf PWNED);$HOME",
      model: "vendor/model'$(printf BAD)",
    };

    expect((await POST(post(hostile))).status).toBe(200);
    const sourced = execFileSync(
      "/bin/sh",
      [
        "-c",
        '. "$1"; printf "%s\\n%s\\n%s" "$GROK_API_KEY" "$GROK_BASE_URL" "$GROK_MODEL"',
        "sh",
        envPath,
      ],
      { encoding: "utf8" },
    );
    expect(sourced.split("\n")).toEqual([
      hostile.apiKey,
      `${hostile.baseUrl}/v1`,
      hostile.model,
    ]);
    expect((await POST(post({ ...hostile, apiKey: "bad\ncommand" }))).status).toBe(400);

    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(previousSettings);
    expect(await fs.readFile(envPath, "utf8")).toBe(previousEnv);
    expect((await DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(previousSettings);
    expect(await fs.readFile(envPath, "utf8")).toBe(previousEnv);
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
