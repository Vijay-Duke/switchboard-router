/** Round-2 response findings: gemini-to-openai (R1-X8/X10/X11/X12, R2-X29/X30/X31). */
import { describe, it, expect } from "vitest";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";

function fresh() {
  return {};
}

describe("R1-X8 prompt-feedback-only safety block", () => {
  it("emits content_filter terminal carrying prompt_tokens", () => {
    const out = geminiToOpenAIResponse({
      promptFeedback: { blockReason: "SAFETY" },
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0, totalTokenCount: 50 },
    }, fresh());
    expect(out).toHaveLength(2);
    const fin = out[1];
    expect(fin.choices[0].finish_reason).toBe("content_filter");
    expect(fin.usage.prompt_tokens).toBe(50);
  });
});

describe("R1-X10/R2-X31 sanitized tool ids", () => {
  it("name 'my.tool v2' yields charset-clean distinct ids", () => {
    const s = fresh();
    const a = geminiToOpenAIResponse({
      responseId: "r", candidates: [{ content: { parts: [{ functionCall: { name: "my.tool v2", args: {} } }] } }],
    }, s);
    const b = geminiToOpenAIResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: "my.tool v2", args: {} } }] } }],
    }, s);
    const idA = a.find((c) => c.choices[0].delta?.tool_calls)?.choices[0].delta.tool_calls[0].id;
    const idB = b.find((c) => c.choices[0].delta?.tool_calls)?.choices[0].delta.tool_calls[0].id;
    expect(idA).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(idB).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(idA).not.toBe(idB);
  });
});

describe("R1-X9/R2-X29 image parts as delta.images (OpenRouter shape)", () => {
  it("inlineData emits images[0].image_url with data URI and keeps delta.content a string", () => {
    const out = geminiToOpenAIResponse({
      responseId: "r",
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" } }] } }],
    }, fresh());
    const img = out.find((c) => Array.isArray(c.choices[0].delta?.images));
    expect(img.choices[0].delta.images[0].type).toBe("image_url");
    expect(img.choices[0].delta.images[0].image_url.url).toBe("data:image/png;base64,QUJD");
    // OpenAI clients concatenate delta.content — it must never be an array.
    expect(out.every((c) => c.choices[0].delta?.content === undefined || typeof c.choices[0].delta.content === "string")).toBe(true);
  });
});

describe("R1-X11 sig-carrying image not dropped", () => {
  it("image part with thoughtSignature still emits", () => {
    const out = geminiToOpenAIResponse({
      responseId: "r",
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" }, thoughtSignature: "sig" }] } }],
    }, fresh());
    expect(out.some((c) => Array.isArray(c.choices[0].delta?.images))).toBe(true);
  });
});

describe("first-leg EOF flush terminates", () => {
  it("flush after text yields one stop; virgin and post-finish flushes null", () => {
    expect(geminiToOpenAIResponse(null, fresh())).toBeNull();
    const state = fresh();
    geminiToOpenAIResponse({
      responseId: "r", candidates: [{ content: { parts: [{ text: "hi" }] } }],
    }, state);
    const flushed = geminiToOpenAIResponse(null, state);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].choices[0].finish_reason).toBe("stop");
    expect(geminiToOpenAIResponse(null, state)).toBeNull();
  });
});

describe("R1-X12/R2-X30 fileData parts", () => {
  it("image fileData yields image_url delta with the URI", () => {
    const out = geminiToOpenAIResponse({
      responseId: "r",
      candidates: [{ content: { parts: [{ fileData: { fileUri: "https://x/y.png", mimeType: "image/png" } }] } }],
    }, fresh());
    const img = out.find((c) => Array.isArray(c.choices[0].delta?.images));
    expect(img.choices[0].delta.images[0].image_url.url).toBe("https://x/y.png");
  });
});
