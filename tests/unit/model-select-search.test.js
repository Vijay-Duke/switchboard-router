import { describe, expect, it } from "vitest";
import {
  filterModelGroupsByQuery,
  getCompatibleProviderModelRows,
  getSelectableProviderModelRows,
} from "@/shared/utils/providerCustomModels.js";

const GROUPS = {
  crofai: {
    name: "CrofAI",
    alias: "crofai",
    color: "#123456",
    models: [
      { id: "model-01", name: "Alpha One", value: "crofai/model-01" },
      { id: "model-02", name: "Beta Two", value: "crofai/model-02" },
      { id: "special-thing", name: "Special Thing", value: "crofai/special-thing" },
      { id: "zzz", name: "Zulu", value: "crofai/zzz" },
    ],
  },
  other: {
    name: "Other",
    alias: "other",
    color: "#654321",
    models: [{ id: "croissant", name: "Croissant", value: "other/croissant" }],
  },
};

describe("filterModelGroupsByQuery (W1)", () => {
  it("keeps every model in the group when the provider name matches", () => {
    // Ticket scenario: typing "cro" for provider "CrofAI" must keep all
    // models, not just the ones matching by their own name.
    const groups = {
      crofai: {
        name: "CrofAI",
        alias: "zz",
        models: [
          { id: "m1", name: "Alpha", value: "zz/m1" },
          { id: "m2", name: "Beta", value: "zz/m2" },
        ],
      },
    };
    const out = filterModelGroupsByQuery(groups, "cro");
    expect(Object.keys(out)).toEqual(["crofai"]);
    expect(out.crofai.models).toHaveLength(2);
  });

  it("matches a full provider-name query without dropping sibling groups by model text", () => {
    const out = filterModelGroupsByQuery(GROUPS, "crofai");
    expect(Object.keys(out)).toEqual(["crofai"]);
    expect(out.crofai.models).toHaveLength(4);
  });

  it("matches case-insensitively", () => {
    const out = filterModelGroupsByQuery(GROUPS, "CROFAI");
    expect(out.crofai.models).toHaveLength(4);
  });

  it("filters by model name or id when the provider name does not match", () => {
    const out = filterModelGroupsByQuery(
      { crofai: GROUPS.crofai },
      "special",
    );
    expect(out.crofai.models.map((m) => m.id)).toEqual(["special-thing"]);
  });

  it("matches the full provider/model value so an alias prefix query works", () => {
    const out = filterModelGroupsByQuery(GROUPS, "crofai/");
    expect(Object.keys(out)).toEqual(["crofai"]);
    expect(out.crofai.models).toHaveLength(4);
  });

  it("matches across groups on model text", () => {
    const out = filterModelGroupsByQuery(GROUPS, "croissant");
    expect(Object.keys(out)).toEqual(["other"]);
  });

  it("drops groups with zero matching models", () => {
    const out = filterModelGroupsByQuery(GROUPS, "no-such-model-xyz");
    expect(out).toEqual({});
  });

  it("returns groups untouched when the query is blank", () => {
    expect(filterModelGroupsByQuery(GROUPS, "   ")).toBe(GROUPS);
    expect(filterModelGroupsByQuery(GROUPS, "")).toBe(GROUPS);
  });

  it("tolerates missing groups and missing model fields", () => {
    expect(filterModelGroupsByQuery(null, "x")).toEqual({});
    expect(filterModelGroupsByQuery(undefined, "x")).toEqual({});
    const out = filterModelGroupsByQuery(
      { odd: { name: "Odd", models: [{ value: "odd/thing" }] } },
      "thing",
    );
    expect(out.odd.models).toHaveLength(1);
  });
});

describe("live rows are not custom (W1b)", () => {
  it("marks live-discovered models without metadata as not custom", () => {
    const rows = getSelectableProviderModelRows({
      providerAlias: "codex",
      builtInModels: [{ id: "gpt-5", name: "GPT 5" }],
      liveModels: [
        { id: "codex/gpt-5" },
        { id: "codex/brand-new-live-model" },
      ],
      liveCatalogLoaded: true,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.isCustom).toBe(false);
  });

  it("keeps isCustom for rows the user added via the custom-models list", () => {
    const rows = getSelectableProviderModelRows({
      providerAlias: "codex",
      builtInModels: [],
      customModels: [
        { providerAlias: "codex", id: "my-model", name: "My Model", type: "llm" },
      ],
      liveModels: [{ id: "codex/my-model" }],
      liveCatalogLoaded: true,
    });
    expect(rows).toEqual([
      expect.objectContaining({ value: "codex/my-model", isCustom: true }),
    ]);
  });

  it("marks compatible-provider live rows without metadata as not custom", () => {
    const providerId = "openai-compatible-chat-node-id";
    const rows = getCompatibleProviderModelRows({
      providerId,
      providerAlias: "cursor-node",
      customModels: [{ providerAlias: providerId, id: "mine", name: "Mine" }],
      liveModels: [
        { id: "cursor-node/mine" },
        { id: "cursor-node/live-discovered" },
      ],
      liveCatalogLoaded: true,
    });
    expect(
      rows.find((r) => r.value === "cursor-node/live-discovered")?.isCustom,
    ).toBe(false);
    expect(rows.find((r) => r.value === "cursor-node/mine")?.isCustom).toBe(
      true,
    );
  });
});
