/**
 * Port of upstream 2abe8b85: tool schemas carrying keywords the Gemini schema
 * proto has no field for (contains, unevaluatedProperties, unevaluatedItems,
 * contentSchema) are rejected by the Gemini API with
 * "Unknown name ...: Cannot find field", failing the whole request. They must
 * be stripped alongside the existing unsupported constraints.
 */
import { describe, it, expect } from "vitest";
import { UNSUPPORTED_SCHEMA_CONSTRAINTS, cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Gemini schema cleaning — 2020-12 keyword strip", () => {
  it("lists contains and unevaluated* / contentSchema as unsupported", () => {
    for (const kw of ["contains", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
      expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain(kw);
    }
  });

  it("strips contains from nested array items", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string", contains: { type: "string" } },
          uniqueItems: true,
        },
      },
    });
    expect(cleaned.properties.list.items.contains).toBeUndefined();
    expect(cleaned.properties.list.items.type).toBe("string");
  });

  it("strips unevaluatedProperties/unevaluatedItems/contentSchema at any depth", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        inner: {
          type: "object",
          unevaluatedProperties: false,
          contentSchema: { type: "string" },
        },
        rows: { type: "array", items: { type: "object", unevaluatedItems: false } },
      },
    });
    expect(cleaned.properties.inner.unevaluatedProperties).toBeUndefined();
    expect(cleaned.properties.inner.contentSchema).toBeUndefined();
    expect(cleaned.properties.rows.items.unevaluatedItems).toBeUndefined();
  });
});
