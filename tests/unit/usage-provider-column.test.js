import { describe, expect, it } from "vitest";
import {
  getGroupProviderLabel,
  resolveUsageProviderName,
} from "@/app/(dashboard)/dashboard/usage/components/UsageTable.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers.js";

const knownEntry = Object.entries(AI_PROVIDERS).find(
  ([, p]) => p && typeof p.name === "string" && p.name.length > 0,
);

describe("resolveUsageProviderName (W3)", () => {
  it("resolves a known provider id to its display name", () => {
    expect(knownEntry).toBeDefined();
    const [id, info] = knownEntry;
    expect(resolveUsageProviderName(id)).toBe(info.name);
  });

  it("resolves via alias as well as id", () => {
    const aliased = Object.values(AI_PROVIDERS).find(
      (p) => p?.alias && p.alias !== p.id && typeof p.name === "string",
    );
    expect(aliased).toBeDefined();
    expect(resolveUsageProviderName(aliased.alias)).toBe(aliased.name);
  });

  it("resolves the ticket's codex example to its display name", () => {
    const codexInfo = getProviderByAlias("codex");
    expect(codexInfo?.name).toBeTruthy();
    expect(resolveUsageProviderName("codex")).toBe(codexInfo.name);
  });

  it("passes unknown ids and display names through unchanged", () => {
    expect(resolveUsageProviderName("definitely-not-a-provider-xyz")).toBe(
      "definitely-not-a-provider-xyz",
    );
    expect(resolveUsageProviderName("My Custom Proxy")).toBe("My Custom Proxy");
  });

  it("dashes empty values", () => {
    expect(resolveUsageProviderName("")).toBe("—");
    expect(resolveUsageProviderName(null)).toBe("—");
    expect(resolveUsageProviderName(undefined)).toBe("—");
  });
});

describe("getGroupProviderLabel (W3)", () => {
  it("returns the display name when every item shares one provider", () => {
    const [id, info] = knownEntry;
    expect(
      getGroupProviderLabel([
        { provider: id, rawModel: "a" },
        { provider: id, rawModel: "b" },
      ]),
    ).toBe(info.name);
  });

  it("dashes when the group spans several providers", () => {
    expect(
      getGroupProviderLabel([
        { provider: "codex", rawModel: "a" },
        { provider: "other-thing", rawModel: "a" },
      ]),
    ).toBe("—");
  });

  it("dashes when no item carries a provider", () => {
    expect(getGroupProviderLabel([{ rawModel: "a" }])).toBe("—");
    expect(getGroupProviderLabel([])).toBe("—");
    expect(getGroupProviderLabel(null)).toBe("—");
  });
});
