/** Round-2 request-translator findings X11–X17 (gemini-to-openai). */
import { describe, it, expect } from "vitest";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const bare = {
  contents: [{ role: "user", parts: [{ text: "hello" }] }],
};
const enveloped = {
  request: {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  },
};

describe("X11 enveloped gemini-cli shape", () => {
  it("enveloped and bare shapes produce identical messages", () => {
    const a = geminiToOpenAIRequest("m", structuredClone(bare), true);
    const b = geminiToOpenAIRequest("m", structuredClone(enveloped), true);
    expect(b.messages).toEqual(a.messages);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0].content).toBe("hello");
  });
});

describe("X12 parallel same-name call ids", () => {
  const twoCalls = () => ({
    contents: [
      {
        role: "model",
        parts: [
          { functionCall: { name: "f", args: { n: 1 } } },
          { functionCall: { name: "f", args: { n: 2 } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "f", response: { result: "r1" } } },
          { functionResponse: { name: "f", response: { result: "r2" } } },
        ],
      },
    ],
  });
  it("two same-name calls get distinct ids", () => {
    const out = geminiToOpenAIRequest("m", twoCalls(), true);
    const ids = out.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.tool_calls || [])
      .map((tc) => tc.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
  it("matching responses pair to distinct tool_call_ids", () => {
    // Through the registered (pre-split) entry: co-located responses split
    // into separate tool messages that pair back to their calls.
    const out = translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "m", twoCalls(), true);
    const callIds = new Set(
      out.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls || []).map((tc) => tc.id),
    );
    const resultIds = out.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(resultIds).toHaveLength(2);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  });
});

describe("X12 positional pairing when only calls carry ids", () => {
  it("id-less responses take the n-th same-name call's id", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [
        { role: "model", parts: [
          { functionCall: { id: "call_up_1", name: "f", args: {} } },
          { functionCall: { name: "f", args: {} } },
        ] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: { result: "r1" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: { result: "r2" } } }] },
      ],
    }, true);
    const callIds = out.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls).map((tc) => tc.id);
    const resultIds = out.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(callIds).toEqual(["call_up_1", "call_f_1"]);
    expect(resultIds).toEqual(["call_up_1", "call_f_1"]);
  });
});

describe("X13 toolConfig reverse map", () => {
  const run = (toolConfig) => geminiToOpenAIRequest("m", {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    toolConfig,
  }, true).tool_choice;
  it("NONE → none", () => {
    expect(run({ functionCallingConfig: { mode: "NONE" } })).toBe("none");
  });
  it("ANY → required", () => {
    expect(run({ functionCallingConfig: { mode: "ANY" } })).toBe("required");
  });
  it("ANY with one allowed name → forced function", () => {
    expect(run({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } }))
      .toEqual({ type: "function", function: { name: "f" } });
  });
  it("AUTO → auto", () => {
    expect(run({ functionCallingConfig: { mode: "AUTO" } })).toBe("auto");
  });
});

describe("X14 fileData parts", () => {
  it("image fileData becomes image_url", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{
        role: "user",
        parts: [{ fileData: { fileUri: "https://x/y.png", mimeType: "image/png" } }],
      }],
    }, true);
    const content = out.messages[0].content;
    expect(JSON.stringify(content)).toContain("https://x/y.png");
  });
  it("non-image fileData becomes a [File:] note", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{
        role: "user",
        parts: [{ fileData: { fileUri: "gs://b/f.pdf", mimeType: "application/pdf" } }],
      }],
    }, true);
    expect(JSON.stringify(out.messages[0].content)).toContain("[File: gs://b/f.pdf]");
  });
});

describe("X15 co-located order preserved", () => {
  it("mixed [text, fr1, fr2] keeps order through the fixed entry", () => {
    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: "turn text" },
          { functionResponse: { id: "a", name: "f", response: { result: "r1" } } },
          { functionResponse: { id: "b", name: "g", response: { result: "r2" } } },
        ],
      }],
    };
    const out = translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "m", body, true);
    const texts = out.messages.map((m) => JSON.stringify(m.content));
    const textIdx = texts.findIndex((t) => t.includes("turn text"));
    const r1Idx = texts.findIndex((t) => t.includes("r1"));
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(r1Idx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(r1Idx);
  });
});

describe("X16 empty-string tool result", () => {
  it('"" does not degrade to "{}"', () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{
        role: "user",
        parts: [{ functionResponse: { id: "a", name: "f", response: { result: "" } } }],
      }],
    }, true);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool.content).toBe('""');
  });
});

describe("X17 thinkingBudget map", () => {
  it("numeric budget maps to effort", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 20000 } },
    }, true);
    expect(out.reasoning_effort).toBe("high");
  });
});
