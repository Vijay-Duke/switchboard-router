// The custom prompt reaches the dispatched body only when enabled and non-blank.
// (ported from upstream 8a842043)
import { describe, it, expect } from "vitest";
import { injectCustomPrompt } from "../../open-sse/rtk/customPrompt.js";

describe("injectCustomPrompt", () => {
  it("appends to the OpenAI system message", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(injectCustomPrompt(body, "openai", "Answer in French.")).toBe(true);
    expect(JSON.stringify(body)).toContain("Answer in French.");
  });

  it("injects nothing for an empty or blank prompt", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const before = JSON.stringify(body);
    expect(injectCustomPrompt(body, "openai", "   ")).toBe(false);
    expect(injectCustomPrompt(body, "openai", undefined)).toBe(false);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("injects into the Claude system field", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectCustomPrompt(body, "claude", "House style: terse.");
    expect(JSON.stringify(body.system)).toContain("House style: terse.");
  });
});
