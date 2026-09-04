/** Round-2 request-translator findings X18–X22 (antigravity-to-openai). */
import { describe, it, expect } from "vitest";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.js";

const contents = (parts, role = "user") => ({ contents: [{ role, parts }] });

describe("X18 thinkingLevel map", () => {
  const run = (thinkingConfig) => antigravityToOpenAIRequest("m", {
    ...contents([{ text: "hi" }]),
    generationConfig: { thinkingConfig },
  }, true).reasoning_effort;
  it.each([["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"]])(
    "thinkingLevel %s → %s", (level, effort) => {
      expect(run({ thinkingLevel: level })).toBe(effort);
    },
  );
  it("budget-only still maps", () => {
    expect(run({ thinkingBudget: 20000 })).toBe("high");
  });
  it("neither yields no reasoning_effort", () => {
    expect(run({})).toBeUndefined();
  });
});

describe("X19 toolConfig reverse map", () => {
  const run = (toolConfig) => antigravityToOpenAIRequest("m", {
    ...contents([{ text: "hi" }]),
    toolConfig,
  }, true).tool_choice;
  it("NONE → none", () => {
    expect(run({ functionCallingConfig: { mode: "NONE" } })).toBe("none");
  });
  it("ANY with names → required / forced", () => {
    expect(run({ functionCallingConfig: { mode: "ANY" } })).toBe("required");
    expect(run({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } }))
      .toEqual({ type: "function", function: { name: "f" } });
  });
});

describe("X20 functionResponse error status", () => {
  it("error status yields is_error", () => {
    const out = antigravityToOpenAIRequest("m", contents([
      { functionResponse: { id: "a", name: "f", status: "ERROR", response: { result: "boom" } } },
    ]), true);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool.is_error).toBe(true);
  });
  it("success omits is_error", () => {
    const out = antigravityToOpenAIRequest("m", contents([
      { functionResponse: { id: "a", name: "f", response: { result: "ok" } } },
    ]), true);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool.is_error).toBeUndefined();
  });
});

describe("X21 co-located call-before-result", () => {
  it("assistant message precedes tool results", () => {
    const out = antigravityToOpenAIRequest("m", contents([
      { functionCall: { id: "a", name: "f", args: {} } },
      { functionResponse: { id: "a", name: "f", response: { result: "r" } } },
    ]), true);
    const roles = out.messages.map((m) => m.role);
    expect(roles[0]).toBe("assistant");
    expect(roles).toContain("tool");
    expect(roles.indexOf("assistant")).toBeLessThan(roles.indexOf("tool"));
  });
});

describe("X22 systemInstruction separator", () => {
  it("multi-part system keeps boundaries", () => {
    const out = antigravityToOpenAIRequest("m", {
      systemInstruction: { parts: [{ text: "a" }, { text: "b" }] },
      ...contents([{ text: "hi" }]),
    }, true);
    expect(out.messages[0]).toMatchObject({ role: "system", content: "a\nb" });
  });
});
