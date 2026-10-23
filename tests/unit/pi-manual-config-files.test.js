import { describe, expect, it } from "vitest";
import { buildPiManualConfigFiles, buildPiModelEntries } from "../../src/lib/cli/modelCatalog.js";
import { createPiCapsResolver } from "../../src/lib/cli/piCapsResolverCore.js";

describe("buildPiManualConfigFiles", () => {
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
