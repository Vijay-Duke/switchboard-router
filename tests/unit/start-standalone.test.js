import { describe, expect, it } from "vitest";

const { resolveRuntime } = await import("../../scripts/start-standalone.mjs");

describe("start-standalone --runtime validation (L2)", () => {
  it("defaults to the current execPath", () => {
    expect(resolveRuntime(["node", "start-standalone.mjs"], "/fake/node")).toBe("/fake/node");
  });

  it("accepts a runtime value", () => {
    expect(resolveRuntime(["node", "s.mjs", "--runtime", "bun"], "/fake/node")).toBe("bun");
  });

  it("throws a usage error on bare --runtime", () => {
    expect(() => resolveRuntime(["node", "s.mjs", "--runtime"], "/fake/node")).toThrow(/--runtime <bin>/);
  });

  it("throws when --runtime is followed by another flag", () => {
    expect(() => resolveRuntime(["node", "s.mjs", "--runtime", "--foo"], "/fake/node")).toThrow(/--runtime <bin>/);
  });
});
