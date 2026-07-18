import { describe, expect, it } from "vitest";
import {
  buildAiderYaml,
  buildClineSettings,
  buildGeminiSettings,
  buildHermesYaml,
  buildJcodeProvider,
  buildKiloConfig,
  buildPiModelEntries,
  isNonEmptyString,
  isOptionalString,
  normalizeModelIds,
  removeAiderYaml,
  removeHermesYaml,
} from "../../src/lib/cli/modelCatalog.js";

const MODELS = ["cx/gpt-5.6", " cc/claude-sonnet-5 ", "cx/gpt-5.6", ""];

describe("CLI model catalog configuration", () => {
  it("normalizes model ids without changing their order", () => {
    expect(normalizeModelIds(MODELS)).toEqual(["cx/gpt-5.6", "cc/claude-sonnet-5"]);
  });

  it("rejects malformed scalar fields before routes write configuration", () => {
    expect(isNonEmptyString(" http://localhost ")).toBe(true);
    expect(isNonEmptyString([])).toBe(false);
    expect(isOptionalString(undefined)).toBe(true);
    expect(isOptionalString({ key: "not-a-string" })).toBe(false);
  });

  it("builds every selected Pi model while preserving existing metadata", () => {
    const entries = buildPiModelEntries(MODELS, [
      { id: "cx/gpt-5.6", name: "GPT", contextWindow: 42, reasoning: true },
    ], {
      "cx/gpt-5.6": "Cursor GPT 5.6",
      "cc/claude-sonnet-5": "Claude Sonnet",
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "cx/gpt-5.6",
      name: "Cursor GPT 5.6",
      contextWindow: 42,
      reasoning: true,
    });
    expect(entries[1]).toMatchObject({
      id: "cc/claude-sonnet-5",
      name: "Claude Sonnet",
    });
  });

  it("writes jcode's repeated provider model catalog and an explicit default", () => {
    expect(buildJcodeProvider({
      baseUrl: "http://127.0.0.1:20128/v1",
      models: MODELS,
      defaultModel: "cc/claude-sonnet-5",
    })).toMatchObject({
      default_model: "cc/claude-sonnet-5",
      model_catalog: true,
      models: [{ id: "cx/gpt-5.6" }, { id: "cc/claude-sonnet-5" }],
    });
  });

  it("updates and removes only the Switchboard Hermes provider", () => {
    const original = `theme: dark\ncustom_providers:\n  - name: local\n    base_url: http://localhost:11434/v1\n`;
    const configured = buildHermesYaml(original, {
      baseUrl: "http://127.0.0.1:20128/v1",
      models: MODELS,
      defaultModel: "cc/claude-sonnet-5",
    });

    expect(configured).toContain("name: switchboard");
    expect(configured).toContain("cx/gpt-5.6");
    expect(configured).toContain("cc/claude-sonnet-5");
    expect(configured).toContain("provider: custom:switchboard");
    expect(removeHermesYaml(configured)).toContain("name: local");
    expect(removeHermesYaml(configured)).toContain("theme: dark");
    expect(removeHermesYaml(configured)).not.toContain("name: switchboard");
  });

  it("writes Kilo's current provider registry and preserves unrelated config", () => {
    const next = buildKiloConfig({ permission: { edit: "ask" } }, {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-test",
      models: MODELS,
      defaultModel: "cc/claude-sonnet-5",
    });

    expect(next.permission).toEqual({ edit: "ask" });
    expect(next.model).toBe("switchboard/cc/claude-sonnet-5");
    expect(Object.keys(next.provider.switchboard.models)).toEqual(["cx/gpt-5.6", "cc/claude-sonnet-5"]);
    expect(next.provider.switchboard.options).toMatchObject({ apiKey: "sk-test", baseURL: "http://127.0.0.1:20128/v1" });
  });

  it("writes Cline's current provider and model registry without dropping other providers", () => {
    const next = buildClineSettings({
      providers: { providers: { ollama: { type: "ollama" } } },
      models: { providers: { ollama: { models: { llama: {} } } } },
    }, {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-test",
      models: MODELS,
      defaultModel: "cx/gpt-5.6",
    });

    expect(next.providers.providers.ollama).toEqual({ type: "ollama" });
    expect(next.models.providers.ollama.models).toEqual({ llama: {} });
    expect(next.providers.providers.switchboard.defaultModelId).toBe("cx/gpt-5.6");
    expect(Object.keys(next.models.providers.switchboard.models)).toEqual(["cx/gpt-5.6", "cc/claude-sonnet-5"]);
  });

  it("uses Gemini's native endpoint settings and explicit model definitions", () => {
    const next = buildGeminiSettings({
      ui: { theme: "dark" },
      modelConfigs: { modelDefinitions: { local: { family: "local", tier: "custom" } } },
    }, {
      models: MODELS,
      defaultModel: "cx/gpt-5.6",
    });

    expect(next.ui).toEqual({ theme: "dark" });
    expect(next.model.name).toBe("cx/gpt-5.6");
    expect(next.experimental.dynamicModelConfiguration).toBe(true);
    expect(Object.keys(next.modelConfigs.modelDefinitions)).toEqual([
      "local",
      "cx/gpt-5.6",
      "cc/claude-sonnet-5",
    ]);
  });

  it("round-trips Aider's managed keys without deleting unrelated YAML", () => {
    const original = `dark-mode: true\nread:\n  - README.md\n`;
    const configured = buildAiderYaml(original, {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-test",
      models: MODELS,
      defaultModel: "cc/claude-sonnet-5",
    });

    expect(configured).toContain("model: openai/cc/claude-sonnet-5");
    expect(configured).toContain("alias:");
    expect(configured).toContain("switchboard-cx-gpt-5-6:openai/cx/gpt-5.6");
    const restored = removeAiderYaml(configured);
    expect(restored).toContain("dark-mode: true");
    expect(restored).toContain("README.md");
    expect(restored).not.toContain("openai-api-base");
  });

  it("keeps Aider aliases unique when model ids normalize to the same slug", () => {
    const configured = buildAiderYaml("", {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-test",
      models: ["team/model", "team-model", "///"],
    });

    expect(configured).toContain("switchboard-team-model:openai/team/model");
    expect(configured).toContain("switchboard-team-model-2:openai/team-model");
    expect(configured).toContain("switchboard-model:openai////");
  });
});
