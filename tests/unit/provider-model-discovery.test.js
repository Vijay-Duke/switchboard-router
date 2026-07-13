import { afterEach, describe, expect, it, vi } from "vitest";

import cursor from "../../open-sse/providers/registry/cursor.js";
import commandcode from "../../open-sse/providers/registry/commandcode.js";
import {
  clearProviderModelCache,
  modelsUrlFromBase,
  parseCursorModels,
  resolveProviderModels,
} from "../../open-sse/services/providerModels.js";
import { encodeField } from "../../open-sse/utils/cursorProtobuf.js";
import { fetchSuggestedModels } from "../../src/shared/utils/providerModelsFetcher.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  clearProviderModelCache();
});

describe("provider model discovery", () => {
  it("uses CommandCode's authenticated Provider API catalog", async () => {
    const liveModels = [
      { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
      { id: "zai-org/GLM-5.2-Fast", name: "GLM 5.2 Fast" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
    ];
    global.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: liveModels }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await resolveProviderModels({
      id: "commandcode-connection",
      provider: "commandcode",
      apiKey: "user_test",
    });

    expect(result.models).toEqual(liveModels);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.commandcode.ai/provider/v1/models",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer user_test" }),
      }),
    );
  });

  it("keeps the current CommandCode catalog in the static fallback", () => {
    const ids = commandcode.models.map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining([
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.7-Code-Highspeed",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen3.7-Max",
      "Qwen/Qwen3.7-Plus",
      "stepfun/Step-3.7-Flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]));
  });

  it("does not query authenticated catalogs through the anonymous suggestions helper", async () => {
    global.fetch = vi.fn();
    await expect(fetchSuggestedModels({
      url: "https://api.commandcode.ai/provider/v1/models",
      type: "openai",
      requiresAuth: true,
    })).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps Cursor Composer 2.5 variants in the static fallback catalog", () => {
    const ids = cursor.models.map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["composer-2.5", "composer-2.5-fast"]));
  });

  it("derives standard model endpoints from provider chat endpoints", () => {
    expect(modelsUrlFromBase("https://api.example.com/v1/chat/completions"))
      .toBe("https://api.example.com/v1/models");
    expect(modelsUrlFromBase("https://api.example.com/v1/messages"))
      .toBe("https://api.example.com/v1/models");
    expect(modelsUrlFromBase("https://ollama.com/api/chat"))
      .toBe("https://ollama.com/api/tags");
    expect(modelsUrlFromBase("not a URL")).toBeNull();
  });

  it("parses Cursor's unary usable-model response with display metadata", () => {
    const payload = Buffer.concat([
      Buffer.from(encodeField(1, 2, Buffer.concat([
        Buffer.from(encodeField(1, 2, "composer-2.5")),
        Buffer.from(encodeField(3, 2, "composer-2.5")),
        Buffer.from(encodeField(4, 2, "Composer 2.5")),
      ]))),
      Buffer.from(encodeField(1, 2, Buffer.concat([
        Buffer.from(encodeField(1, 2, "gpt-5.6-sol-high")),
        Buffer.from(encodeField(3, 2, "gpt-5.6-sol-high")),
        Buffer.from(encodeField(4, 2, "GPT-5.6 Sol 1M High")),
      ]))),
    ]);
    const models = parseCursorModels(payload);

    expect(models).toEqual([
      { id: "composer-2.5", name: "Composer 2.5", displayModelId: "composer-2.5" },
      { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol 1M High", displayModelId: "gpt-5.6-sol-high" },
    ]);
  });

  it("discovers Cursor models using its current unary usable-model endpoint", async () => {
    const responsePayload = Buffer.concat([
      Buffer.from(encodeField(1, 2, Buffer.concat([
        Buffer.from(encodeField(1, 2, "composer-2.5")),
        Buffer.from(encodeField(4, 2, "Composer 2.5")),
      ]))),
      Buffer.from(encodeField(1, 2, Buffer.concat([
        Buffer.from(encodeField(1, 2, "gpt-5.6-sol-high")),
        Buffer.from(encodeField(4, 2, "GPT-5.6 Sol 1M High")),
      ]))),
    ]);
    global.fetch = vi.fn().mockResolvedValue(new Response(
      responsePayload,
      { status: 200, headers: { "content-type": "application/proto" } },
    ));

    const result = await resolveProviderModels({
      id: "cursor-connection",
      provider: "cursor",
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    });

    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "gpt-5.6-sol-high",
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api2.cursor.sh/aiserver.v1.AiService/GetUsableModels",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: expect.any(Uint8Array),
        headers: expect.objectContaining({
          Authorization: "Bearer cursor-token",
          "Content-Type": "application/proto",
          "Content-Length": "0",
          "Connect-Protocol-Version": "1",
        }),
      }),
    );
    expect(global.fetch.mock.calls[0][1].body).toHaveLength(0);
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty("x-cursor-checksum");
  });

  it("reads Cursor protobuf from Node-fetch-style responses used by the packaged server", async () => {
    const responsePayload = Buffer.from(encodeField(1, 2, Buffer.concat([
      Buffer.from(encodeField(1, 2, "gpt-5.6-sol-high")),
      Buffer.from(encodeField(4, 2, "GPT-5.6 Sol 1M High")),
    ])));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      buffer: vi.fn().mockResolvedValue(responsePayload),
    });

    const result = await resolveProviderModels({
      id: "cursor-packaged-response",
      provider: "cursor",
      accessToken: "cursor-token",
    });

    expect(result.models).toEqual([
      { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol 1M High" },
    ]);
  });

  it("does not cache ephemeral calls across credential values", async () => {
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ data: [{ id: "model-a" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const first = await resolveProviderModels({
      provider: "openai",
      accessToken: "first-secret",
    });
    const second = await resolveProviderModels({
      provider: "openai",
      accessToken: "rotated-secret",
    });

    expect(first).toEqual({ models: [{ id: "model-a", name: "model-a" }] });
    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
