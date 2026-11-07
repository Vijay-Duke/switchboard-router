// Gemini cannot express tuples and rejects type:"array" without items.
// (ported from upstream f6c59d30)
import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Gemini schema sanitizer — arrays", () => {
  it("converts single-type prefixItems to items", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { pt: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] } } });
    expect(out.properties.pt).toEqual({ type: "array", items: { type: "number" } });
  });

  it("strips prefixItems/additionalItems and keeps an explicit items", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { t: { type: "array", items: { type: "string" }, prefixItems: [{ type: "integer" }], additionalItems: false } } });
    expect(out.properties.t).toEqual({ type: "array", items: { type: "string" } });
  });

  it("fills a placeholder items on an array schema that has none", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { tags: { type: "array" } } });
    expect(out.properties.tags.items).toEqual({ type: "string" });
  });
});
