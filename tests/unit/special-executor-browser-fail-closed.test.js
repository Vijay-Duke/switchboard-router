import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
  vi.resetModules();
});

async function loadExecutor(name) {
  const nodeFetch = vi.fn().mockResolvedValue(new Response(new Blob(["data: [DONE]\n\n"]).stream(), { status: 200 }));
  globalThis.fetch = nodeFetch;
  vi.resetModules();
  const proxy = await import("../../open-sse/utils/proxyFetch.js");
  proxy.__setTransportLoadersForTests({
    nodeFetch,
    loadChromeFetch: async () => { throw new Error("impit unavailable"); },
  });
  const executors = name === "grok-web"
    ? await import("../../open-sse/executors/grok-web.js")
    : await import("../../open-sse/executors/perplexity-web.js");
  return {
    nodeFetch,
    executor: name === "grok-web" ? new executors.GrokWebExecutor() : new executors.PerplexityWebExecutor(),
  };
}

describe("browser executor transport failure", () => {
  it.each([
    ["grok-web", "grok-4"],
    ["perplexity-web", "pplx-auto"],
  ])("fails %s closed when Chrome transport is unavailable", async (provider, model) => {
    const { nodeFetch, executor } = await loadExecutor(provider);

    const { response } = await executor.execute({
      model,
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "cookie" },
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/chrome tls.*unavailable/i);
    expect(nodeFetch).not.toHaveBeenCalled();
  });
});
