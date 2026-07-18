import { describe, expect, it } from "vitest";
import {
  buildClaudeCatalogLabelsHeader,
  buildClaudeFullCatalogHeaders,
  normalizeClaudeCatalogPickerLabels,
  readClaudeCatalogPickerLabelsFromCustomHeaders,
} from "../../src/shared/claudeGateway.js";

describe("Claude catalog picker labels", () => {
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
      "kr/prod/claude-opus-4-8": "KR\nInjected",
      "other/model": "Ignored",
    }, ["kr/prod/claude-opus-4-8"])).toEqual({
      "kr/prod/claude-opus-4-8": "KR Injected",
    });
  });
});
