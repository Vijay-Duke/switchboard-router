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

// Gemini protobuf predicates: items only on arrays, properties/required only on
// objects; multi-type unions pick the structural type. (ported from upstream 8db1f4ae)
describe("Gemini schema sanitizer — type predicates", () => {
  it("strips items/properties/required from schemas whose type forbids them", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { s: { type: "string", items: { type: "string" }, properties: { x: { type: "string" } }, required: ["x"] } } });
    expect(out.properties.s).toEqual({ type: "string" });
  });

  it("types untyped array items from their structure", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { rows: { type: "array", items: { properties: { a: { type: "string" } } } } } });
    expect(out.properties.rows.items.type).toBe("object");
  });

  it("keeps params literally named items/properties/required", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: { items: { type: "array", items: { type: "integer" } }, properties: { type: "string" }, required: { type: "boolean" } }, required: ["items"] });
    expect(Object.keys(out.properties)).toEqual(["items", "properties", "required"]);
    expect(out.required).toEqual(["items"]);
  });

  it("resolves multi-type unions by structure, then string", () => {
    const out = cleanJSONSchemaForAntigravity({ type: "object", properties: {
      o: { type: ["string", "object"], properties: { k: { type: "string" } } },
      a: { type: ["string", "array"], items: { type: "integer" } },
      b: { type: ["boolean", "string", "null"] },
    } });
    expect(out.properties.o.type).toBe("object");
    expect(out.properties.a).toEqual({ type: "array", items: { type: "integer" } });
    expect(out.properties.b.type).toBe("string");
  });
});
