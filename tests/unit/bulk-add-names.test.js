import { describe, expect, it } from "vitest";
import { parseBulkKeyLine } from "../../src/app/(dashboard)/dashboard/providers/[id]/bulkKeyLine.js";

describe("parseBulkKeyLine", () => {
  it("splits name|key and keeps later pipes in the key", () => {
    expect(parseBulkKeyLine("work|sk-abc")).toEqual({ baseName: "work", apiKey: "sk-abc" });
    expect(parseBulkKeyLine("work|a|b")).toEqual({ baseName: "work", apiKey: "a|b" });
  });

  it("auto-names a bare key", () => {
    expect(parseBulkKeyLine("  sk-only  ")).toEqual({ baseName: "Key", apiKey: "sk-only" });
    expect(parseBulkKeyLine("|sk-x")).toEqual({ baseName: "Key", apiKey: "sk-x" });
  });

  it("keeps an LLM|id|secret token whole (case-insensitive)", () => {
    expect(parseBulkKeyLine("LLM|123|secret")).toEqual({ baseName: "LLM", apiKey: "LLM|123|secret" });
    expect(parseBulkKeyLine(" llm|9|s ")).toEqual({ baseName: "LLM", apiKey: "llm|9|s" });
  });
});
