// Guards the refactored USAGE_HANDLERS dispatch: unsupported → message, supported → routed.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub network so handlers don't hit real APIs; each call resolves an empty 200.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
  })),
}));

const load = () => import("../../open-sse/services/usage.js");
const SUPPORTED = [
  "github", "gemini-cli", "antigravity", "claude", "codex", "kiro",
  "qoder", "qwen", "iflow", "ollama", "glm", "glm-cn",
  "minimax", "minimax-cn", "vercel-ai-gateway", "codebuddy-cn", "kimi", "deepseek",
];

describe("usage dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unsupported provider → not-implemented message", async () => {
    const { getUsageForProvider } = await load();
    const res = await getUsageForProvider({ provider: "totally-unknown" });
    expect(res).toEqual({ message: "Usage API not implemented for totally-unknown" });
  });

  it("every supported provider routes to its handler (no fallback message)", async () => {
    const { getUsageForProvider } = await load();
    for (const provider of SUPPORTED) {
      const res = await getUsageForProvider({ provider, accessToken: "t", apiKey: "k" });
      // Routed handler must return an object and never the unsupported fallback
      expect(res, `${provider} routed`).toBeTypeOf("object");
      expect(res?.message).not.toBe(`Usage API not implemented for ${provider}`);
    }
  });
});

describe("usage persistence dispatch (P6)", () => {
  async function runNonStreaming({ clientKeyId }) {
    const { getOpenSseDeps, setOpenSseDeps } = await import("../../open-sse/runtimeDeps.js");
    const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

    // Hold the persistence dep open; whether the response waits on it is the contract under test.
    let resolveSave;
    const saveGate = new Promise((resolve) => { resolveSave = resolve; });
    const slowSave = vi.fn(() => saveGate);
    const prevSave = getOpenSseDeps().saveRequestUsage;
    setOpenSseDeps({ saveRequestUsage: slowSave });

    const responseBody = {
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const resultPromise = handleNonStreamingResponse({
      providerResponse: new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
      }),
      provider: "test-provider",
      model: "test-model",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "connection",
      clientKeyId,
      requestId: "req-p6-123",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: () => {},
      appendLog: () => {},
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
    });
    const winner = await Promise.race([
      resultPromise.then(() => "response"),
      new Promise((resolve) => setTimeout(() => resolve("timer"), 10)),
    ]);
    resolveSave();
    await resultPromise;
    setOpenSseDeps({ saveRequestUsage: prevSave });
    return { winner, slowSave };
  }

  it("does not await the usage save when no client key is involved", async () => {
    const { winner, slowSave } = await runNonStreaming({ clientKeyId: undefined });
    expect(winner).toBe("response");
    expect(slowSave).toHaveBeenCalledTimes(1);
    expect(slowSave.mock.calls[0][0]).toMatchObject({ requestId: "req-p6-123" });
  });

  it("awaits the usage save for client-keyed requests so spend limits see it", async () => {
    const { winner, slowSave } = await runNonStreaming({ clientKeyId: "client-key" });
    expect(winner).toBe("timer");
    expect(slowSave.mock.calls[0][0]).toMatchObject({ requestId: "req-p6-123", clientKeyId: "client-key" });
  });
});
