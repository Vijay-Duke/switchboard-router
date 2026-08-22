import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { GrokWebExecutor } from "../../open-sse/executors/grok-web.js";
import { PerplexityWebExecutor } from "../../open-sse/executors/perplexity-web.js";
import { GeminiCLIExecutor } from "../../open-sse/executors/gemini-cli.js";
import { QwenExecutor } from "../../open-sse/executors/qwen.js";
import { VertexExecutor } from "../../open-sse/executors/vertex.js";
import perplexityWeb from "../../open-sse/providers/registry/perplexity-web.js";

function emptySseResponse() {
  return new Response(new Blob(["data: [DONE]\n\n"]).stream(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const browserRequest = {
  model: "model",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials: { apiKey: "cookie" },
  proxyOptions: { enabled: true, url: "http://127.0.0.1:8080" },
};

describe("special executor identity cutovers", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(emptySseResponse());
  });

  it.each([
    ["grok-web", new GrokWebExecutor()],
    ["perplexity-web", new PerplexityWebExecutor()],
  ])("routes %s browser requests through Chrome with no ambient Node fallback", async (provider, executor) => {
    await executor.execute({ ...browserRequest, model: provider === "grok-web" ? "grok-4" : "pplx-auto" });

    const [, options, proxyOptions] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: "chrome", provider, format: provider });
    expect(proxyOptions).toEqual(browserRequest.proxyOptions);
  });

  it("uses the Gemini CLI identity for OAuth refresh", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "next", expires_in: 3600 }), { status: 200 }));
    const proxyOptions = { vercelRelayUrl: "https://relay.example/fetch" };

    await new GeminiCLIExecutor().refreshCredentials({ refreshToken: "refresh", projectId: "p" }, null, proxyOptions);

    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: "gemini-cli", provider: "gemini-cli", format: "gemini-cli" });
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("uses the Qwen identity for OAuth refresh", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "next", expires_in: 3600 }), { status: 200 }));
    const proxyOptions = { enabled: true, url: "http://127.0.0.1:8080" };

    await new QwenExecutor().refreshCredentials({ refreshToken: "refresh" }, null, proxyOptions);

    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: "qwen", provider: "qwen" });
    expect(options.format).toBeDefined();
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("uses the Vertex Partner registry identity for project probes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "projects/project-123/locations/global" } }), { status: 404 }));
    const proxyOptions = { enabled: true, url: "http://127.0.0.1:8080" };
    const executor = new VertexExecutor("vertex-partner");

    await executor.execute({
      model: "partner-model",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "vertex-key" },
      proxyOptions,
    });

    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: executor.config.identity, provider: "vertex-partner", format: executor.config.format });
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("uses the Vertex identity and proxy for ADC refresh during execute", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "vertex-access", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const proxyOptions = { enabled: true, url: "http://127.0.0.1:8080" };
    const executor = new VertexExecutor("vertex");
    const adc = JSON.stringify({
      type: "authorized_user",
      client_id: "vertex-client",
      client_secret: "vertex-secret",
      refresh_token: "vertex-execute-refresh",
      quota_project_id: "vertex-project",
    });

    await executor.execute({
      model: "gemini-2.5-flash",
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      stream: false,
      credentials: { apiKey: adc },
      proxyOptions,
    });

    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: executor.config.identity, provider: "vertex", format: executor.config.format });
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("uses the Vertex Partner identity and proxy for standalone ADC refresh", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "vertex-access", expires_in: 3600 }), { status: 200 }));
    const proxyOptions = { vercelRelayUrl: "https://relay.example/fetch" };
    const executor = new VertexExecutor("vertex-partner");
    const adc = JSON.stringify({
      type: "authorized_user",
      client_id: "vertex-partner-client",
      client_secret: "vertex-partner-secret",
      refresh_token: "vertex-standalone-refresh",
      quota_project_id: "vertex-project",
    });

    await executor.refreshCredentials({ apiKey: adc }, null, proxyOptions);

    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ identity: executor.config.identity, provider: "vertex-partner", format: executor.config.format });
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("registers Perplexity Web as a Chrome browser transport", () => {
    expect(perplexityWeb.transport.identity).toBe("chrome");
  });
});
