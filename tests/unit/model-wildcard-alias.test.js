import { describe, expect, it } from "vitest";
import { resolveModelAliasFromMap } from "../../open-sse/services/model.js";

describe("wildcard and glob model aliasing", () => {
  const aliases = {
    "gpt-4*": "openai/gpt-4.1",
    "claude-3-7*": "anthropic/claude-3-7-sonnet",
    "*-flash": "gemini/gemini-2.5-flash",
    "custom-alias": "deepseek/deepseek-r1",
    "my-combo-*": "smart-coding-combo",
  };

  it("resolves exact matches directly", () => {
    const result = resolveModelAliasFromMap("custom-alias", aliases);
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
  });

  it("resolves prefix wildcard patterns like gpt-4*", () => {
    const r1 = resolveModelAliasFromMap("gpt-4o", aliases);
    expect(r1).toEqual({ provider: "openai", model: "gpt-4.1" });

    const r2 = resolveModelAliasFromMap("gpt-4-turbo", aliases);
    expect(r2).toEqual({ provider: "openai", model: "gpt-4.1" });

    const r3 = resolveModelAliasFromMap("gpt-4o-mini", aliases);
    expect(r3).toEqual({ provider: "openai", model: "gpt-4.1" });
  });

  it("resolves prefix wildcard patterns like claude-3-7*", () => {
    const result = resolveModelAliasFromMap("claude-3-7-sonnet-20250219", aliases);
    expect(result).toEqual({ provider: "anthropic", model: "claude-3-7-sonnet" });
  });

  it("resolves suffix wildcard patterns like *-flash", () => {
    const result = resolveModelAliasFromMap("google-experimental-flash", aliases);
    expect(result).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("resolves wildcard aliases pointing to combo names", () => {
    const result = resolveModelAliasFromMap("my-combo-fast", aliases);
    expect(result).toEqual({ provider: null, model: "smart-coding-combo" });
  });

  it("returns null for non-matching model strings", () => {
    expect(resolveModelAliasFromMap("unmatched-model-xyz", aliases)).toBeNull();
  });
});
