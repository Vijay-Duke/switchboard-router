/** Round-2 findings X7 (gemini content parts) and X69 (sampling clamp). */
import { describe, it, expect } from "vitest";
import { convertOpenAIContentToParts } from "../../open-sse/translator/formats/gemini.js";
import { clampSampling } from "../../open-sse/translator/concerns/params.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";

describe("X7 file and bridge-image parts", () => {
  it("file_id-only file becomes a fileData part", () => {
    const parts = convertOpenAIContentToParts([
      { type: "file", file: { file_id: "file-abc123" } },
    ]);
    expect(parts).toEqual([{ fileData: { fileUri: "file-abc123" } }]);
  });
  it("claude-bridge image block converts via its source", () => {
    const b64 = convertOpenAIContentToParts([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    ]);
    expect(b64).toEqual([{ inlineData: { mime_type: "image/png", data: "AAA" } }]);
    const url = convertOpenAIContentToParts([
      { type: "image", source: { type: "url", url: "https://x/i.png" } },
    ]);
    expect(url).toEqual([{ fileData: { fileUri: "https://x/i.png", mimeType: "image/*" } }]);
  });
  it("data-uri file still becomes inlineData", () => {
    const parts = convertOpenAIContentToParts([
      { type: "file", file: { file_data: "data:text/plain;base64,aGk=" } },
    ]);
    expect(parts).toEqual([{ inlineData: { mime_type: "text/plain", data: "aGk=" } }]);
  });
});

describe("X69 clampSampling", () => {
  it("temperature 5 → 2; negative top_p → 0", () => {
    expect(clampSampling({ temperature: 5 }).temperature).toBe(2);
    expect(clampSampling({ temperature: -1 }).temperature).toBe(0);
    expect(clampSampling({ top_p: -0.5 }).top_p).toBe(0);
    expect(clampSampling({ topP: 7 }).topP).toBe(1);
  });
  it("top_k floors at 0", () => {
    expect(clampSampling({ top_k: 2.7 }).top_k).toBe(2);
    expect(clampSampling({ topK: -3 }).topK).toBe(0);
  });
  it("in-range values pass through; unknown keys untouched", () => {
    expect(clampSampling({ temperature: 0.7, top_p: 0.9, other: 99 }))
      .toEqual({ temperature: 0.7, top_p: 0.9, other: 99 });
  });
  it("NaN / undefined / non-numeric pass through untouched", () => {
    const out = clampSampling({ temperature: NaN, top_p: undefined, top_k: "5" });
    expect(Number.isNaN(out.temperature)).toBe(true);
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBe("5");
  });
  it("per-target temperature ceiling: Claude 0–1, Gemini 0–2, Ollama unclamped", () => {
    expect(clampSampling({ temperature: 1.5 }, { maxTemperature: 1 }).temperature).toBe(1);
    const claude = openaiToClaudeRequest("m", { messages: [{ role: "user", content: "hi" }], temperature: 1.5 }, true);
    expect(claude.temperature).toBe(1);
    const gemini = openaiToGeminiRequest("gemini-2.0-flash", { messages: [{ role: "user", content: "hi" }], temperature: 1.5 }, true);
    expect(gemini.generationConfig.temperature).toBe(1.5);
    const ollama = openaiToOllamaRequest("m", { messages: [{ role: "user", content: "hi" }], temperature: 5 }, true);
    expect(ollama.options.temperature).toBe(5);
  });
  it("gemini translator clamps end-to-end", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      temperature: 5, top_p: -1,
    }, true);
    expect(out.generationConfig.temperature).toBe(2);
    expect(out.generationConfig.topP).toBe(0);
  });
});
