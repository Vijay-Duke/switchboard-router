import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { VertexExecutor } from "../../open-sse/executors/vertex.js";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("executor proxyAwareFetch identity triple", () => {
  it("VertexExecutor.execute passes identity/provider/format", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const proxyOptions = { enabled: true, url: "http://127.0.0.1:8080" };
    const executor = new VertexExecutor("vertex");

    await executor.execute({
      model: "gemini-2.5-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "vertex-raw-key" },
      proxyOptions,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options, passedProxy] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({
      identity: "openai-node",
      provider: "vertex",
      format: "vertex",
    });
    expect(passedProxy).toEqual(proxyOptions);
  });

  it("QoderExecutor chat call and model catalog fetch pass identity/provider/format", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        chat: [{
          key: "auto",
          enable: true,
          display_name: "Auto",
          max_input_tokens: 131_072,
          max_output_tokens: 4096,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 400));
    const proxyOptions = { enabled: true, url: "http://127.0.0.1:8080" };

    await new QoderExecutor().execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {
        accessToken: "qoder-token",
        providerSpecificData: { userId: "user-1", machineId: "machine-1" },
      },
      proxyOptions,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, catalogOptions, catalogProxy] = fetchMock.mock.calls[0];
    expect(catalogOptions).toMatchObject({
      identity: "openai-node",
      provider: "qoder",
      format: "openai",
    });
    expect(catalogProxy).toEqual(proxyOptions);

    const [, chatOptions, chatProxy] = fetchMock.mock.calls[1];
    expect(chatOptions).toMatchObject({
      identity: "openai-node",
      provider: "qoder",
      format: "openai",
    });
    expect(chatProxy).toEqual(proxyOptions);
  });
});
