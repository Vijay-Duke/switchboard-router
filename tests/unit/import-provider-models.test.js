import { describe, expect, it } from "vitest";
import {
  asServiceKind,
  inferModelType,
  normalizeImportedModel,
} from "@/shared/utils/importProviderModels.js";
import { getModelKind } from "@/shared/constants/models.js";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels.js";

describe("import provider models", () => {
  it("treats Anthropic/Z.AI catalog type 'model' as llm", () => {
    expect(asServiceKind("model")).toBe("llm");
    expect(inferModelType("glm-5.3", { type: "model" })).toBe("llm");
    expect(normalizeImportedModel({
      id: "glm-5.3",
      display_name: "GLM-5.3",
      type: "model",
    }, "glm")).toEqual({
      id: "glm-5.3",
      name: "GLM-5.3",
      type: "llm",
    });
  });

  it("still classifies real non-chat kinds from explicit type", () => {
    expect(inferModelType("text-embedding-3", { type: "embedding" })).toBe("embedding");
    expect(inferModelType("tts-1", { kind: "tts" })).toBe("tts");
  });

  it("does not hide discovered GLM rows that only have type 'model'", () => {
    expect(getModelKind({ id: "glm-5.2", type: "model" })).toBe("llm");
    expect(getProviderCustomModelRows({
      customModels: [
        { providerAlias: "glm", id: "glm-5-turbo", type: "model", name: "GLM-5-Turbo" },
      ],
      providerAlias: "glm",
      type: "llm",
    })).toEqual([
      {
        id: "glm-5-turbo",
        name: "GLM-5-Turbo",
        fullModel: "glm/glm-5-turbo",
        source: "custom",
        type: "llm",
      },
    ]);
  });
});
