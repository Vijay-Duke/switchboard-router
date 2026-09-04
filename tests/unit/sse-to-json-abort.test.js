import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  settleUsageStats: vi.fn(),
}));
vi.mock("../../open-sse/runtimeDeps.js", () => ({
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

import { convertChatCompletionsStreamToJson, convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();

function neverEndingStream(onCancel) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n"));
    },
    cancel: onCancel,
  });
}

function finishedStream(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function handlerArgs(stream, extra = {}) {
  return {
    providerResponse: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI,
    provider: "commandcode",
    model: "deepseek/test",
    body: { stream: false },
    stream: false,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "conn",
    apiKey: null,
    requestId: "req",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: vi.fn(),
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...extra,
  };
}

describe("SSE→JSON assembly honors client abort (H22)", () => {
  it("chat converter rejects with AbortError and cancels the upstream reader", async () => {
    const onCancel = vi.fn();
    const controller = new AbortController();
    const pending = convertChatCompletionsStreamToJson(neverEndingStream(onCancel), "m", { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("responses converter rejects promptly on an already-aborted signal", async () => {
    const onCancel = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(convertResponsesStreamToJson(neverEndingStream(onCancel), { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("the handler threads streamSignal into the converter", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const pending = handleForcedSSEToJson(handlerArgs(neverEndingStream(onCancel), { streamSignal: controller.signal }));
    setTimeout(() => controller.abort(), 5);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("SSE→JSON reasoning parity (H23)", () => {
  it("extracts <think> tags into reasoning_content like the non-stream path", async () => {
    const result = await handleForcedSSEToJson(handlerArgs(finishedStream([
      { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "<think>plan</think>answer" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ])));
    const json = await result.response.json();
    expect(json.choices[0].message.reasoning_content).toBe("plan");
    expect(json.choices[0].message.content).toBe("answer");
  });

  it("drops non-native reasoning_content only when content is present", async () => {
    const result = await handleForcedSSEToJson(handlerArgs(finishedStream([
      { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thought", content: "answer" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ])));
    const json = await result.response.json();
    expect(json.choices[0].message.reasoning_content).toBeUndefined();
    expect(json.choices[0].message.content).toBe("answer");
  });
});

describe("SSE→JSON success hook is fire-and-forget (H24)", () => {
  it("does not wait for a hung onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn(() => new Promise(() => {}));
    const started = Date.now();
    const result = await handleForcedSSEToJson(handlerArgs(finishedStream([
      { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    ]), { onRequestSuccess }));

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
