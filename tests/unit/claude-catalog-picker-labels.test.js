import { describe, expect, it } from "vitest";
import {
  buildClaudeCatalogLabelsHeader,
  buildClaudeFullCatalogProfile,
  buildClaudeFullCatalogHeaders,
  fingerprintClaudeGatewayKey,
  normalizeClaudeCatalogPickerLabels,
  readClaudeCatalogPickerLabelsFromCustomHeaders,
} from "../../src/shared/claudeGateway.js";

describe("Claude catalog picker labels", () => {
  it("compares saved gateway keys without exposing their value", () => {
    expect(fingerprintClaudeGatewayKey("sk-one")).toBe(fingerprintClaudeGatewayKey("sk-one"));
    expect(fingerprintClaudeGatewayKey("sk-one")).not.toBe(fingerprintClaudeGatewayKey("sk-two"));
    expect(fingerprintClaudeGatewayKey("sk-one")).not.toContain("sk-one");
  });

  it("round-trips picker labels through custom headers", () => {
    const models = ["kr/prod/claude-opus-4-8", "coding-auto"];
    const labels = {
      "kr/prod/claude-opus-4-8": "KR Opus APAC",
      "coding-auto": "Coding auto",
    };
    const headers = buildClaudeFullCatalogHeaders(models, labels);
    const parsed = readClaudeCatalogPickerLabelsFromCustomHeaders(headers);

    expect(parsed).toEqual(labels);
    expect(buildClaudeCatalogLabelsHeader(models, labels)).toBeTruthy();
  });

  it("drops labels for models outside the catalog selection", () => {
    expect(normalizeClaudeCatalogPickerLabels({
      "kr/prod/claude-opus-4-8": "KR Opus",
      "stale/model": "Stale",
    }, ["kr/prod/claude-opus-4-8"])).toEqual({
      "kr/prod/claude-opus-4-8": "KR Opus",
    });
  });

  it("sanitizes abusive header labels", () => {
    expect(normalizeClaudeCatalogPickerLabels({
      "kr/prod/claude-opus-4-8": "KR · Opus\nInjected",
      "other/model": "Ignored",
    }, ["kr/prod/claude-opus-4-8"])).toEqual({
      "kr/prod/claude-opus-4-8": "KR | Opus Injected",
    });
  });

  it("rejects catalogs that exceed the safe request-header budget", () => {
    const models = Array.from(
      { length: 100 },
      (_, index) => `long-provider/model-${index}-${"x".repeat(80)}`,
    );

    expect(() => buildClaudeFullCatalogProfile({
      baseUrl: "http://127.0.0.1:20128",
      gatewayKey: "sk-test",
      models,
      pickerLabels: Object.fromEntries(models.map((model) => [model, `Label ${model}`])),
    })).toThrow("catalog is too large");
  });
});
