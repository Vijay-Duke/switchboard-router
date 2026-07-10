import { describe, expect, it } from "vitest";
import {
  createSwitchboardManagedModels,
  isSwitchboardManagedModel,
  normalizeManagedModelNames,
} from "../../src/app/api/cli-tools/droid-settings/managedModels.js";

describe("Droid managed model migration", () => {
  it("recognizes current and legacy Switchboard-owned entries", () => {
    expect(isSwitchboardManagedModel({ id: "custom:Switchboard-0" })).toBe(true);
    expect(isSwitchboardManagedModel({ id: "custom:9Router-12" })).toBe(true);
    expect(isSwitchboardManagedModel({ id: "custom:Personal-0" })).toBe(false);
    expect(isSwitchboardManagedModel({})).toBe(false);
  });

  it("derives stable official ids from display names and absolute array indexes", () => {
    const entries = createSwitchboardManagedModels(["cx/gpt-5.6", "glm/glm-5.2"], {
      startIndex: 3,
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-test",
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "custom:Switchboard-cx/gpt-5.6-3",
      "custom:Switchboard-glm/glm-5.2-4",
    ]);
    expect(entries.every((entry) => entry.index === undefined)).toBe(true);
  });

  it("deduplicates and normalizes model names before writing settings", () => {
    expect(normalizeManagedModelNames([
      "cx/gpt-5.6-sol",
      " cx/gpt-5.6-sol ",
      "",
      null,
      "glm/glm-5.2",
    ])).toEqual(["cx/gpt-5.6-sol", "glm/glm-5.2"]);
  });
});
