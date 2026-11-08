import { beforeEach, describe, expect, it, vi } from "vitest";
const fx = vi.hoisted(() => ({ rows: new Map(), execute: vi.fn() }));
vi.mock("../../open-sse/runtimeDeps.js", async original => ({
  ...await original(), makeKvStore: () => ({
    get: async key => fx.rows.get(key), set: async (key, value) => fx.rows.set(key, value),
    remove: async key => fx.rows.delete(key), getAll: async () => Object.fromEntries(fx.rows),
  }),
}));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: fx.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
}) }));
const model = "gemini-2.5-flash";
const history = id => ({ model: `gemini/${model}`, messages: [
  { role: "user", content: "Read files" },
  { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content: "a.txt" },
], stream: false });
beforeEach(() => { vi.resetModules(); fx.rows.clear(); fx.execute.mockReset(); });
describe("Gemini persisted thought signatures", () => {
  it.each([null, "explicit-session"])("hydrates persisted signatures after a restart (session=%s)", async session => {
    const { captureClientSessionId } = await import("../../open-sse/utils/sessionManager.js");
    const body = history("call-restart");
    if (session) body.session_id = session;
    const credentials = { apiKey: "test", connectionId: "account" };
    const namespace = JSON.stringify(["client-a", "account", captureClientSessionId(body, credentials)]);
    const store = await import("../../open-sse/services/thoughtSignatureStore.js");
    store.storeGeminiThoughtSignature("call-restart", "PERSISTED_SIGNATURE", namespace, model);
    await Promise.resolve();
    vi.resetModules();
    // Translators must register in the fresh module graph, as in production.
    await import("../translator/registerAll.js");
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    fx.execute.mockResolvedValue({ response: Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), headers: {}, url: "https://generativelanguage.googleapis.com/test" });
    const result = await handleChatCore({ body, modelInfo: { provider: "gemini", model }, credentials,
      clientKeyId: "client-a", connectionId: "account", sourceFormatOverride: "openai" });
    expect(result.success).toBe(true);
    const request = fx.execute.mock.calls[0][0].body;
    const part = request.contents.flatMap(c => c.parts || []).find(p => p.functionCall);
    expect(part.thoughtSignature).toBe("PERSISTED_SIGNATURE");
  });
  it("isolates sessions even when call ids repeat and namespaces contain colons", async () => {
    const store = await import("../../open-sse/services/thoughtSignatureStore.js");
    store.storeGeminiThoughtSignature("c", "A", "a:b", model);
    store.storeGeminiThoughtSignature("b:c", "B", "a", model);
    expect(store.getGeminiThoughtSignatureSync("c", "a:b", model)).toBe("A");
    expect(store.getGeminiThoughtSignatureSync("b:c", "a", model)).toBe("B");
    expect(await store.getGeminiThoughtSignature("c", "other", model)).toBeNull();
    expect(store.getGeminiThoughtSignatureSync("c", null, model)).toBeNull();
  });
  it("retains non-streaming signatures under unique returned call ids", async () => {
    const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
    const store = await import("../../open-sse/services/thoughtSignatureStore.js");
    const response = { candidates: [{ content: { parts: [{ functionCall: { id: "native", name: "read", args: {} }, thoughtSignature: "NONSTREAM_SIG" }] } }] };
    const options = { sessionId: "client-session", model };
    const first = translateNonStreamingResponse(response, "gemini", options).choices[0].message.tool_calls[0].id;
    const second = translateNonStreamingResponse(response, "gemini", options).choices[0].message.tool_calls[0].id;
    expect(first).not.toBe(second);
    expect(store.getGeminiThoughtSignatureSync(first, options.sessionId, model)).toBe("NONSTREAM_SIG");
    expect(store.getGeminiThoughtSignatureSync("native", options.sessionId, model)).toBe("NONSTREAM_SIG");
  });
});
