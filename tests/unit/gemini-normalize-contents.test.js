// Shared Gemini contents normalization (openai->gemini, Claude->Antigravity
// envelope, Antigravity executor). Ported from upstream e7b5f09d, 30464bc2,
// 625df74d, eb373017.
import { describe, it, expect } from "vitest";
import { normalizeGeminiContents, sanitizeFunctionResponsePayload } from "../../open-sse/translator/formats/gemini.js";
import { isGemini4Model } from "../../open-sse/providers/modelFamilies.js";

describe("normalizeGeminiContents", () => {
  it("merges same-role turns, drops empty parts, opens on a user turn", () => {
    const out = normalizeGeminiContents([
      { role: "model", parts: [{ text: "hi" }] },
      { role: "user", parts: [{}, { text: "a" }] },
      { role: "user", parts: [{ text: "b" }] },
      { role: "model", parts: [] },
    ]);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "..." }] });
    expect(out[2]).toEqual({ role: "user", parts: [{ text: "a" }, { text: "b" }] });
    expect(out).toHaveLength(3);
  });

  it("closes a trailing model text turn with a user turn (no assistant prefill)", () => {
    const out = normalizeGeminiContents([{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ text: "a" }] }]);
    expect(out.at(-1)).toEqual({ role: "user", parts: [{ text: "Continue." }] });
  });

  it("answers trailing unresponded functionCalls with stub functionResponses", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "read", args: {} } }, { functionCall: { name: "ls", args: {} } }] },
    ]);
    expect(out.at(-1)).toEqual({ role: "user", parts: [
      { functionResponse: { id: "c1", name: "read", response: { result: "Continue." } } },
      { functionResponse: { name: "ls", response: { result: "Continue." } } },
    ] });
  });

  it("renames $ref inside functionResponse payloads", () => {
    const out = normalizeGeminiContents([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "fetch", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "fetch", response: { result: { a: [{ $ref: "#/$defs/x" }] } } } }] },
    ]);
    expect(out[2].parts[0].functionResponse.response).toEqual({ result: { a: [{ _ref: "#/$defs/x" }] } });
    expect(sanitizeFunctionResponsePayload("plain")).toBe("plain");
  });

  it("orders functionResponse parts last in merged user turns for Gemini 4 only", () => {
    const contents = () => [
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "f", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "f", response: { result: 1 } } }] },
      { role: "user", parts: [{ text: "next" }] },
    ];
    expect(normalizeGeminiContents(contents(), "gemini-4-argon")[2].parts.map(p => Object.keys(p)[0])).toEqual(["text", "functionResponse"]);
    expect(normalizeGeminiContents(contents(), "gemini-3-pro")[2].parts.map(p => Object.keys(p)[0])).toEqual(["functionResponse", "text"]);
  });
});

describe("isGemini4Model", () => {
  it("matches gemini-4 ids only", () => {
    expect(isGemini4Model("gemini-4-argon")).toBe(true);
    expect(isGemini4Model("models/gemini-4")).toBe(true);
    expect(isGemini4Model("gemini-4.1-pro")).toBe(true);
    expect(isGemini4Model("gemini-40")).toBe(false);
    expect(isGemini4Model("gemini-3-pro")).toBe(false);
  });
});
