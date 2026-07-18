import { describe, expect, it } from "vitest";
import {
  buildCanonicalDisabledModelSet,
  getCompatibleProviderModelRows,
  getProviderCustomModelRows,
  getSelectableProviderModelRows,
  isCanonicalModelDisabled,
} from "@/shared/utils/providerCustomModels.js";

describe("provider custom model rows", () => {
  it("matches disabled IDs across casing and models prefixes", () => {
    const disabled = buildCanonicalDisabledModelSet(
      ["mixedcase/model"],
      "lite-llm",
    );

    expect(isCanonicalModelDisabled(
      disabled,
      "models/MixedCase/Model",
      "lite-llm",
    )).toBe(true);
  });

  it("keeps identical model IDs separate per provider", () => {
    const customModels = [
      { providerAlias: "ollama", id: "minimax-m2.5", type: "llm", name: "MiniMax M2.5" },
      { providerAlias: "opencode-go", id: "minimax-m2.5", type: "llm", name: "MiniMax M2.5" },
    ];

    expect(getProviderCustomModelRows({ customModels, providerAlias: "ollama" })).toEqual([
      {
        id: "minimax-m2.5",
        name: "MiniMax M2.5",
        fullModel: "ollama/minimax-m2.5",
        source: "custom",
        type: "llm",
      },
    ]);
    expect(getProviderCustomModelRows({ customModels, providerAlias: "opencode-go" })).toEqual([
      {
        id: "minimax-m2.5",
        name: "MiniMax M2.5",
        fullModel: "opencode-go/minimax-m2.5",
        source: "custom",
        type: "llm",
      },
    ]);
  });

  it("keeps legacy alias-backed models visible without duplicating custom models", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama", id: "custom-a", type: "llm", name: "Custom A" },
      ],
      modelAliases: {
        "custom-a": "ollama/custom-a",
        "legacy-b": "ollama/legacy-b",
        "other-provider": "opencode-go/legacy-b",
      },
      providerAlias: "ollama",
    });

    expect(rows).toEqual([
      {
        id: "custom-a",
        name: "Custom A",
        fullModel: "ollama/custom-a",
        source: "custom",
        type: "llm",
      },
      {
        id: "legacy-b",
        alias: "legacy-b",
        fullModel: "ollama/legacy-b",
        source: "legacyAlias",
        type: "llm",
      },
    ]);
  });

  it("filters built-in models and typed custom models", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama", id: "llama3", type: "llm", name: "Llama 3" },
        { providerAlias: "ollama", id: "custom-image", type: "image", name: "Custom Image" },
        { providerAlias: "ollama", id: "custom-llm", type: "llm", name: "Custom LLM" },
      ],
      providerAlias: "ollama",
      builtInModels: [{ id: "llama3" }],
      type: "llm",
    });

    expect(rows).toEqual([
      {
        id: "custom-llm",
        name: "Custom LLM",
        fullModel: "ollama/custom-llm",
        source: "custom",
        type: "llm",
      },
    ]);
  });
});

describe("compatible provider model rows", () => {
  it("merges a UUID provider's live catalog into its display-prefix picker group", () => {
    const providerId = "openai-compatible-responses-5f69ccc9-f1e2-4faa-acf6-d5551eab7cce";
    const rows = getCompatibleProviderModelRows({
      providerId,
      providerAlias: "lite-llm",
      customModels: [{ providerAlias: providerId, id: "openai/gpt-5.5", name: "Old GPT" }],
      modelAliases: { legacy: `${providerId}/vertex_ai/gemini-old` },
      liveModels: [
        { id: "lite-llm/openai/gpt-5.6-sol" },
        { id: "lite-llm/vertex_ai/gemini-3.1-flash-lite" },
      ],
      liveCatalogLoaded: true,
    });

    expect(rows.map((row) => row.value)).toEqual([
      "lite-llm/openai/gpt-5.6-sol",
      "lite-llm/vertex_ai/gemini-3.1-flash-lite",
    ]);
  });

  it("falls back to stored models before live discovery completes", () => {
    const providerId = "openai-compatible-chat-provider-id";
    const rows = getCompatibleProviderModelRows({
      providerId,
      providerAlias: "custom",
      customModels: [{ providerAlias: providerId, id: "manual", name: "Manual" }],
      modelAliases: { legacy: `${providerId}/legacy-model` },
    });

    expect(rows.map((row) => row.value)).toEqual([
      "custom/legacy-model",
      "custom/manual",
    ]);
  });
});

describe("selectable provider model rows", () => {
  it("merges static, imported, legacy, and live models into one provider catalog", () => {
    const rows = getSelectableProviderModelRows({
      providerAlias: "kr",
      builtInModels: [{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5" }],
      customModels: [{ providerAlias: "kr", id: "claude-sonnet-4.6", name: "Kiro Claude Sonnet 4.6", type: "llm" }],
      modelAliases: { "old-opus": "kr/claude-opus-4.6" },
      liveModels: [
        { id: "kr/claude-haiku-4.5", capabilities: { thinking: false } },
        { id: "kr/claude-sonnet-4.6" },
        { id: "kr/claude-opus-4.6" },
        { id: "kr/auto-thinking", capabilities: { thinking: true } },
      ],
      liveCatalogLoaded: true,
    });

    expect(rows.map((row) => row.value)).toEqual([
      "kr/claude-haiku-4.5",
      "kr/claude-sonnet-4.6",
      "kr/claude-opus-4.6",
      "kr/auto-thinking",
    ]);
    expect(rows.find((row) => row.value === "kr/claude-sonnet-4.6")?.name).toBe("Kiro Claude Sonnet 4.6");
    expect(rows.find((row) => row.value === "kr/claude-opus-4.6")?.name).toBe("old-opus");
    expect(rows.find((row) => row.value === "kr/auto-thinking")?.capabilities).toEqual({ thinking: true });
  });

  it("uses a successful live catalog as the availability source of truth", () => {
    const rows = getSelectableProviderModelRows({
      providerAlias: "kr",
      builtInModels: [
        { id: "available", name: "Available Static Name" },
        { id: "stale", name: "Stale Static Model" },
      ],
      liveModels: [{ id: "kr/available", capabilities: { thinking: true } }],
      liveCatalogLoaded: true,
    });

    expect(rows).toEqual([expect.objectContaining({
      id: "available",
      name: "Available Static Name",
      value: "kr/available",
      capabilities: { thinking: true },
    })]);
  });

  it("falls back to registered metadata when live discovery fails", () => {
    const rows = getSelectableProviderModelRows({
      providerAlias: "kr",
      builtInModels: [{ id: "static", name: "Static" }],
      customModels: [{ providerAlias: "kr", id: "custom", name: "Custom", type: "llm" }],
      modelAliases: { legacy: "kr/legacy-model" },
    });

    expect(rows.map((row) => row.value)).toEqual([
      "kr/static",
      "kr/custom",
      "kr/legacy-model",
    ]);
  });
});
