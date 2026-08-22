import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

beforeEach(() => {
  mocks.getProviderConnectionById.mockReset();
  mocks.proxyAwareFetch.mockReset();
});

describe("provider model catalog route", () => {
  it("imports the complete live CommandCode catalog", async () => {
    const liveModels = [
      { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
      { id: "zai-org/GLM-5.2", name: "GLM 5.2" },
      { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash" },
    ];
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "commandcode-connection",
      provider: "commandcode",
      apiKey: "user_test",
    });
    mocks.proxyAwareFetch.mockResolvedValue(new Response(
      JSON.stringify({ data: liveModels }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const response = await GET(
      new Request("http://localhost/api/providers/commandcode-connection/models"),
      { params: Promise.resolve({ id: "commandcode-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual(liveModels);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.commandcode.ai/provider/v1/models",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer user_test" }),
        identity: "openai-node",
        provider: "commandcode",
        format: "commandcode",
      }),
      undefined,
    );
  });

  it("imports ClinePass models from its authenticated catalog", async () => {
    const liveModels = [
      { id: "cline-pass/glm-5.2", name: "GLM-5.2" },
      { id: "cline-pass/new-model", name: "New Model" },
    ];
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "clinepass-connection",
      provider: "clinepass",
      apiKey: "cline_test",
    });
    mocks.proxyAwareFetch.mockResolvedValue(new Response(
      JSON.stringify({ data: liveModels }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const response = await GET(
      new Request("http://localhost/api/providers/clinepass-connection/models"),
      { params: Promise.resolve({ id: "clinepass-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual(liveModels);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer cline_test" }),
        identity: "cline",
        provider: "clinepass",
        format: "openai",
      }),
      undefined,
    );
  });

  it("falls back to the static registry when live discovery fails", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "cursor-connection",
      provider: "cursor",
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    });
    mocks.proxyAwareFetch.mockRejectedValue(new Error("offline"));

    const response = await GET(
      new Request("http://localhost/api/providers/cursor-connection/models"),
      { params: Promise.resolve({ id: "cursor-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.warning).toMatch(/static registry catalog/i);
    expect(body.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "composer-2.5",
      "composer-2.5-fast",
    ]));
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api2.cursor.sh/aiserver.v1.AiService/GetUsableModels",
      expect.objectContaining({
        method: "POST",
        identity: "openai-node",
        provider: "cursor",
        format: "cursor",
      }),
      undefined,
    );
  });

  it("falls back to the expanded CommandCode catalog when discovery is unavailable", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "commandcode-fallback-connection",
      provider: "commandcode",
      apiKey: "user_test",
    });
    mocks.proxyAwareFetch.mockRejectedValue(new Error("offline"));

    const response = await GET(
      new Request("http://localhost/api/providers/commandcode-fallback-connection/models"),
      { params: Promise.resolve({ id: "commandcode-fallback-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.warning).toMatch(/static registry catalog/i);
    expect(body.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "moonshotai/Kimi-K2.7-Code",
      "zai-org/GLM-5.2",
      "stepfun/Step-3.7-Flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]));
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.commandcode.ai/provider/v1/models",
      expect.objectContaining({
        method: "GET",
        identity: "openai-node",
        provider: "commandcode",
        format: "commandcode",
      }),
      undefined,
    );
  });
});
