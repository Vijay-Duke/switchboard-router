import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

function options(model) {
  const body = {
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
  };
  return {
    body,
    modelInfo: { provider: "opencode-go", model },
    credentials: { apiKey: "sk-test" },
    sourceFormatOverride: "openai-responses",
    clientRawRequest: {
      endpoint: "/v1/responses",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
  };
}

describe("OpenCode Go chat coordinator routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyAwareFetch.mockResolvedValue(new Response("stop after request capture", { status: 400 }));
  });

  it("translates an unsupported Responses MiniMax request to Claude messages", async () => {
    await handleChatCore(options("minimax-m3"));

    const [url, request] = proxyAwareFetch.mock.calls[0];
    const body = JSON.parse(request.body);
    expect(url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(request.headers).toMatchObject({ "x-api-key": "sk-test" });
    expect(request.headers.Authorization).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(body.input).toBeUndefined();
  });

  it("keeps a supported DeepSeek Responses request on the native endpoint", async () => {
    await handleChatCore(options("deepseek-v4-pro"));

    const [url, request] = proxyAwareFetch.mock.calls[0];
    const body = JSON.parse(request.body);
    expect(url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(request.headers.Authorization).toBe("Bearer sk-test");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(body.messages).toBeUndefined();
  });
});
