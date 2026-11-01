import { describe, expect, it } from "vitest";
import { buildPiManualConfigFiles, buildPiModelEntries } from "../../src/lib/cli/modelCatalog.js";
import { createPiCapsResolver } from "../../src/lib/cli/piCapsResolverCore.js";

describe("buildPiManualConfigFiles", () => {
  it("repairs stale DeepSeek metadata and exposes max in both Pi config files", () => {
    const id = "command-code/deepseek/deepseek-v4.1-flash";
    const files = buildPiManualConfigFiles({
      baseUrl: "http://127.0.0.1:20128/v1", apiKey: "test", models: [id], defaultModel: id,
      capsResolver: createPiCapsResolver(),
      previousModels: [{ id, reasoning: false, thinkingLevelMap: { max: null } }],
    });
    const entry = JSON.parse(files.find((file) => file.filename.endsWith("models.json")).content)
      .providers.switchboard.models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.thinkingLevelMap).toEqual({
      off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    expect(entry.thinking.efforts).toEqual(["high", "max"]);
    expect(files.find((file) => file.filename.endsWith("models.yml")).content)
      .toContain('"max":"max"');
  });

  it("includes thinking metadata for reasoning models", () => {
    const capsResolver = createPiCapsResolver();
    const configs = buildPiManualConfigFiles({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      models: ["muse/muse-wonder-1.0-max"],
      defaultModel: "muse/muse-wonder-1.0-max",
      capsResolver,
    });
    const yml = configs.find((c) => c.filename.includes("models.yml"));
    expect(yml?.content).toContain("thinkingLevelMap");
    expect(yml?.content).toContain("reasoning: true");
    const json = configs.find((c) => c.filename.includes("models.json"));
    const parsed = JSON.parse(json.content);
    const entry = parsed.providers.switchboard.models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.thinkingLevelMap).toBeTruthy();
  });

  it("matches buildPiModelEntries output used by Apply", () => {
    const capsResolver = createPiCapsResolver();
    const models = ["openai/gpt-5.2"];
    const entries = buildPiModelEntries(models, [], {}, capsResolver);
    const [fromManual] = buildPiManualConfigFiles({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      models,
      defaultModel: models[0],
      capsResolver,
    }).filter((c) => c.filename.includes("models.json"));
    const parsed = JSON.parse(fromManual.content);
    expect(parsed.providers.switchboard.models).toEqual(entries);
  });
});
