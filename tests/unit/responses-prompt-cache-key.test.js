/**
 * Port of upstream 70ba0024: prompt_cache_key was silently dropped when
 * converting OpenAI Chat requests to Responses format, so clients lost their
 * stable cache routing. Preserve it in the chat → responses direction; the
 * responses → chat direction still drops it (no equivalent field).
 */
import { describe, expect, it } from "vitest";

const { openaiToOpenAIResponsesRequest, openaiResponsesToOpenAIRequest } =
  await import("../../open-sse/translator/request/openai-responses.js");

const CHAT_BODY = (extra = {}) => ({
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

describe("prompt_cache_key across the chat/responses translation", () => {
  it("preserves an explicit key when converting chat → responses", () => {
    const out = openaiToOpenAIResponsesRequest(
      "example-model",
      CHAT_BODY({ prompt_cache_key: "stable-cache-key" }),
      true,
      {},
    );

    expect(out.prompt_cache_key).toBe("stable-cache-key");
  });

  it("does not invent a key when the client sent none", () => {
    const out = openaiToOpenAIResponsesRequest("example-model", CHAT_BODY(), true, {});

    expect(out.prompt_cache_key).toBeUndefined();
  });

  it("still drops the key on the responses → chat direction", () => {
    const out = openaiResponsesToOpenAIRequest(
      "example-model",
      {
        model: "example-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        prompt_cache_key: "stable-cache-key",
      },
      true,
      {},
    );

    expect(out.prompt_cache_key).toBeUndefined();
  });
});
