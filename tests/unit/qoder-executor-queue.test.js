import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(), proxyOptionsFromCredentials: () => null }));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  isQoderPat: (token) => token?.startsWith("pt-"),
  getQoderModelConfig: vi.fn(async () => ({ key: "ultimate", max_output_tokens: 100 })),
  resolveQoderModels: vi.fn(), resolveQoderCredentials: vi.fn(async credentials => credentials),
}));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";

const credentials = { accessToken: "dt-test", providerSpecificData: { userId: "test-user" } };
const frame = (body, statusCodeValue = 200) => `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(body) })}\n\n`;
const completed = () => new Response(frame({ choices: [{ delta: { content: "PONG" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const args = { model: "ultimate", body: { messages: [{ role: "user", content: "ping" }] }, stream: true, credentials };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Qoder executor queue recovery", () => {
  it("polls until ready without resubmitting queued inference and releases refused streams", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const queueBody = frame({ code: "10605", isQueued: true, modelKey: "ultimate", queueType: "RESOURCE_LIMIT" }, 429);
    let chatCalls = 0;
    let polls = 0;
    proxyAwareFetch.mockImplementation(async (_url, init) => {
      if (init.method === "GET") {
        polls++;
        return Response.json({ isQueued: polls < 3, queueType: "RESOURCE_LIMIT", retryAfterSeconds: 1 });
      }
      chatCalls++;
      if (chatCalls === 1) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(queueBody)); }, cancel: cancelled,
      }));
      return completed();
    });
    const pending = new QoderExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await pending;
    expect(await result.response.text()).toContain("PONG");
    expect(polls).toBe(3);
    expect(chatCalls).toBe(2);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("honours the queue deadline even when the server suggests a longer delay", async () => {
    vi.useFakeTimers();
    vi.stubEnv("QODER_MODEL_QUEUE_MAX_WAIT_MS", "50");
    proxyAwareFetch.mockImplementation(async (_url, init) => init.method === "GET"
      ? Response.json({ isQueued: true, retryAfterSeconds: 120 })
      : new Response(frame({ code: "10605", isQueued: true }, 429)));
    const pending = new QoderExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.response.status).toBe(503);
    expect(proxyAwareFetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("uses the CN region and provider identity for image upload and inference", async () => {
    proxyAwareFetch.mockImplementation(async (_url, init) => init.method === "PUT"
      ? Response.json({ imageUrl: "https://images.example/upload.png" }) : completed());
    const result = await new QoderExecutor("qoder-cn").execute({ ...args, body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }] } });
    expect(await result.response.text()).toContain("PONG");
    expect(proxyAwareFetch.mock.calls).toHaveLength(2);
    for (const [url, init] of proxyAwareFetch.mock.calls) {
      expect(new URL(url).hostname).toBe("gateway.qoder.com.cn");
      expect(init).toMatchObject({ provider: "qoder-cn", identity: "openai-node" });
    }
  });
});
