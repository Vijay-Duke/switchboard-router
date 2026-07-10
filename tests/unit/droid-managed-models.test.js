import { describe, expect, it } from "vitest";
import {
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
