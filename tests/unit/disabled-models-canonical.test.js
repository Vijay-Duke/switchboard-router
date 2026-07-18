import { describe, expect, it } from "vitest";
import {
  normalizeDisabledModelIds,
  removeEnabledModelIds,
} from "../../src/lib/db/repos/disabledModelsRepo.js";

describe("disabled model canonical IDs", () => {
  it("normalizes casing and models prefixes before storage", () => {
    expect(normalizeDisabledModelIds("lite-llm", [
      "models/MixedCase/Model",
      "mixedcase/model",
    ])).toEqual(["mixedcase/model"]);
  });

  it("re-enables a canonical model from its raw provider ID", () => {
    expect(removeEnabledModelIds(
      "lite-llm",
      ["mixedcase/model", "other/model"],
      ["models/MixedCase/Model"],
    )).toEqual(["other/model"]);
  });
});
