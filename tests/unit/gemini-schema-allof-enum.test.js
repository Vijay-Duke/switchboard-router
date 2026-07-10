import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

/**
 * Regression: two schema-cleaning bugs that made Gemini/Antigravity reject
 * perfectly valid tool schemas with a 400.
 *
 *  1. mergeAllOf() copied only `properties` and `required` out of allOf items,
 *     so a `$ref`-expanded scalar (`allOf: [{ type, enum }]`) lost both.
 *  2. convertEnumValuesToStrings() stringified enum values but only *added*
 *     type:"string" when no type existed — leaving `type:"integer"` next to
 *     string enum values.
 */
describe("cleanJSONSchemaForAntigravity", () => {
  it("keeps type and enum when flattening an allOf-wrapped scalar", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        color: { allOf: [{ type: "string", enum: ["red", "green"], description: "hue" }] },
      },
    });

    const color = cleaned.properties.color;
    expect(color.allOf).toBeUndefined();
    expect(color.type).toBe("string");
    expect(color.enum).toEqual(["red", "green"]);
    expect(color.description).toBe("hue");
  });

  it("does not let an allOf item clobber a key set on the parent", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        x: { description: "parent wins", allOf: [{ type: "string", description: "child" }] },
      },
    });
    expect(cleaned.properties.x.description).toBe("parent wins");
    expect(cleaned.properties.x.type).toBe("string");
  });

  it("retypes a numeric enum to string rather than leaving a type mismatch", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: { level: { type: "integer", enum: [1, 2, 3] } },
    });

    expect(cleaned.properties.level.type).toBe("string");
    expect(cleaned.properties.level.enum).toEqual(["1", "2", "3"]);
  });

  it("normalizes an enum that only appears after the allOf merge", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: { n: { allOf: [{ type: "integer", enum: [10, 20] }] } },
    });

    expect(cleaned.properties.n.type).toBe("string");
    expect(cleaned.properties.n.enum).toEqual(["10", "20"]);
  });

  it("still merges properties and required across allOf items", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });

    expect(Object.keys(cleaned.properties).sort()).toEqual(["a", "b"]);
    expect(cleaned.required.sort()).toEqual(["a", "b"]);
    expect(cleaned.type).toBe("object");
  });
});
