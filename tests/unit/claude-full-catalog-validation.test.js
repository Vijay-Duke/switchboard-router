import { describe, expect, it } from "vitest";
import { findUnavailableClaudeCatalogModels } from "../../src/app/api/cli-tools/claude-full-catalog/route.js";
import {
  FREE_PROVIDERS,
  getProviderAlias,
} from "../../src/shared/constants/providers.js";

describe("Claude full-catalog save validation", () => {
  it("accepts active provider prefixes and existing combos", () => {
    expect(findUnavailableClaudeCatalogModels(
      ["llm/model-a", "coding-auto"],
      [{
        provider: "openai-compatible-test",
        isActive: true,
        providerSpecificData: { prefix: "llm" },
      }],
      [{ name: "coding-auto", kind: null }],
    )).toEqual([]);
  });

  it("rejects selections whose provider or combo was removed", () => {
    expect(findUnavailableClaudeCatalogModels(
      ["removed/model-a", "removed-combo"],
      [],
      [],
    )).toEqual(["removed/model-a", "removed-combo"]);
  });

  it("accepts connected-free LLM providers that need no stored connection", () => {
    const noAuthEntry = Object.entries(FREE_PROVIDERS).find(([, provider]) => {
      const kinds = provider.serviceKinds || ["llm"];
      return provider.noAuth && kinds.includes("llm");
    });
    expect(noAuthEntry).toBeTruthy();
    const [providerId] = noAuthEntry;
    const alias = getProviderAlias(providerId);

    expect(findUnavailableClaudeCatalogModels(
      [`${alias}/model-a`],
      [],
      [],
    )).toEqual([]);
  });
});
