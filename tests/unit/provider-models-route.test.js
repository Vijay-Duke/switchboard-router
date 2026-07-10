import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
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
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ data: liveModels }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/commandcode-connection/models"),
      { params: Promise.resolve({ id: "commandcode-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual(liveModels);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.commandcode.ai/provider/v1/models",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer user_test" }),
      }),
    );
    fetchMock.mockRestore();
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
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ data: liveModels }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/clinepass-connection/models"),
      { params: Promise.resolve({ id: "clinepass-connection" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual(liveModels);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer cline_test" }),
      }),
    );
    fetchMock.mockRestore();
  });

  it("falls back to the static registry when live discovery fails", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "cursor-connection",
      provider: "cursor",
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    });
    const fetchMock = vi.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
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
    fetchMock.mockRestore();
  });

  it("falls back to the expanded CommandCode catalog when discovery is unavailable", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "commandcode-fallback-connection",
      provider: "commandcode",
      apiKey: "user_test",
    });
    const fetchMock = vi.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
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
    fetchMock.mockRestore();
  });
});
