import { describe, expect, it } from "vitest";
import {
  assignClaudeCatalogDisplayRows,
  buildClaudeCatalogDisplayNameMap,
  buildClaudeCatalogPickerLabelsPayload,
  formatClaudeCatalogDisplayLabel,
  formatClaudeCatalogDisplayName,
} from "../../src/shared/claudeCatalogDisplay.js";

describe("claudeCatalogDisplay", () => {
  it("distinguishes kr, cr, and lite-llm opus routes in picker labels", () => {
    expect(formatClaudeCatalogDisplayLabel("kr/prod/claude-opus-4-8")).toBe("kr | opus 4.8");
    expect(formatClaudeCatalogDisplayLabel("cr/prod/claude-opus-4-8")).toBe("cr | opus 4.8");
    expect(
      formatClaudeCatalogDisplayLabel(
        "lite-llm/bedrock-ap-southeast-2/anthropic.claude-opus-4-8",
      ),
    ).toBe("llm | apac | bedrock | opus 4.8");
  });

  it("keeps short combo names unchanged", () => {
    expect(formatClaudeCatalogDisplayLabel("coding-auto")).toBe("coding-auto");
  });

  it("disambiguates colliding labels within one catalog selection", () => {
    const labels = buildClaudeCatalogDisplayNameMap([
      "kr/prod/claude-opus-4-8",
      "kr/backup/claude-opus-4-8",
    ]);

    expect(labels.get("kr/prod/claude-opus-4-8")).toBe("kr | opus 4.8 | prod");
    expect(labels.get("kr/backup/claude-opus-4-8")).toBe("kr | opus 4.8 | backup");
    expect(labels.get("kr/prod/claude-opus-4-8")).not.toBe(labels.get("kr/backup/claude-opus-4-8"));
  });

  it("disambiguates models that share the same route prefix", () => {
    const labels = buildClaudeCatalogDisplayNameMap([
      "kr/prod/claude-opus-4-8",
      "kr/prod/claude-sonnet-4-8",
    ]);

    expect(labels.get("kr/prod/claude-opus-4-8")).not.toBe(labels.get("kr/prod/claude-sonnet-4-8"));
  });

  it("formats labels from a precomputed map for gateway discovery", () => {
    const labels = buildClaudeCatalogDisplayNameMap(["lite-llm/openai/gpt-5.6-sol"]);
    expect(formatClaudeCatalogDisplayName("lite-llm/openai/gpt-5.6-sol", labels))
      .toBe("llm | openai | gpt 5.6");
  });

  it("disambiguates duplicate auto labels in the save payload", () => {
    const payload = buildClaudeCatalogPickerLabelsPayload([
      { value: "kr/prod/claude-opus-4-8", labelCustom: false },
      { value: "kr/backup/claude-opus-4-8", labelCustom: false },
    ]);

    expect(payload["kr/prod/claude-opus-4-8"]).toBe("kr | opus 4.8 | prod");
    expect(payload["kr/backup/claude-opus-4-8"]).toBe("kr | opus 4.8 | backup");
    expect(payload["kr/prod/claude-opus-4-8"]).not.toBe(payload["kr/backup/claude-opus-4-8"]);
  });

  it("keeps custom labels while disambiguating the rest of the catalog", () => {
    const rows = assignClaudeCatalogDisplayRows([
      { value: "kr/prod/claude-opus-4-8", label: "My KR Opus", labelCustom: true },
      { value: "kr/backup/claude-opus-4-8", labelCustom: false },
    ]);

    expect(rows[0].label).toBe("My KR Opus");
    expect(rows[1].label).toBe("kr | opus 4.8 | backup");
  });
});
