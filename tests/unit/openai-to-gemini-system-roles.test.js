import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const sysText = (out) => out.systemInstruction?.parts?.map((p) => p.text).join("") ?? "";

/**
 * Regression: the OpenAI→Gemini translator
 *  1. assigned systemInstruction per system message, so with more than one only
 *     the LAST survived; and
 *  2. had no `developer` branch, so developer-role messages were dropped
 *     entirely (the OpenAI path normalizes developer→system, this one didn't).
 */
describe("openaiToGeminiRequest system/developer roles", () => {
  it("concatenates multiple system messages", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [
        { role: "system", content: "first rule" },
        { role: "system", content: "second rule" },
        { role: "user", content: "hi" },
      ],
    });

    const text = sysText(out);
    expect(text).toContain("first rule");
    expect(text).toContain("second rule");
  });

  it("treats a developer message as system instead of dropping it", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [
        { role: "developer", content: "dev instruction" },
        { role: "user", content: "hi" },
      ],
    });

    expect(sysText(out)).toContain("dev instruction");
    // and it must not have leaked into the user turn
    const userTurns = out.contents.filter((c) => c.role === "user");
    expect(JSON.stringify(userTurns)).not.toContain("dev instruction");
  });
});
