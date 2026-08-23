import { beforeEach, describe, expect, it, vi } from "vitest";

const createProviderConnection = vi.hoisted(() => vi.fn(async (data) => ({ id: "connection-1", ...data })));

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
vi.mock("@/models", () => ({
  createProviderConnection,
  getProviderConnections: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  redactSecrets: (value) => value,
}));
vi.mock("@/shared/constants/config", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    APIKEY_PROVIDERS: {
      ...original.APIKEY_PROVIDERS,
      "selfhosted-stt": { id: "selfhosted-stt", name: "Self-hosted STT" },
      "selfhosted-tts": { id: "selfhosted-tts", name: "Self-hosted TTS" },
      "selfhosted-embedding": { id: "selfhosted-embedding", name: "Self-hosted Embedding" },
    },
  };
});
vi.mock("@/shared/constants/providers", async (importOriginal) => {
  const original = await importOriginal();
  const selfhosted = {
    "selfhosted-stt": { id: "selfhosted-stt", name: "Self-hosted STT" },
    "selfhosted-tts": { id: "selfhosted-tts", name: "Self-hosted TTS" },
    "selfhosted-embedding": { id: "selfhosted-embedding", name: "Self-hosted Embedding" },
  };
  return { ...original, AI_PROVIDERS: { ...original.AI_PROVIDERS, ...selfhosted } };
});

import { POST } from "@/app/api/providers/route.js";

function request(provider, { apiKey = "", baseUrl } = {}) {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, name: "Local", apiKey, providerSpecificData: { baseUrl } }),
  });
}

beforeEach(() => createProviderConnection.mockClear());

describe("self-hosted provider connections", () => {
  it.each(["selfhosted-stt", "selfhosted-tts", "selfhosted-embedding"])(
    "persists an explicit endpoint and permits an empty key for %s",
    async (provider) => {
      const response = await POST(request(provider, { baseUrl: "http://127.0.0.1:8080/v1" }));
      expect(response.status).toBe(201);
      expect(createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
        provider,
        apiKey: "",
        providerSpecificData: expect.objectContaining({ baseUrl: "http://127.0.0.1:8080/v1" }),
      }));
    },
  );

  it.each([
    ["selfhosted-stt", undefined],
    ["selfhosted-tts", ""],
    ["selfhosted-embedding", "file:///tmp/server"],
  ])("rejects a missing or non-http endpoint for %s", async (provider, baseUrl) => {
    const response = await POST(request(provider, { baseUrl }));
    expect(response.status).toBe(400);
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps API keys required for ordinary providers", async () => {
    const response = await POST(request("openai", { baseUrl: "http://127.0.0.1:8080/v1" }));
    expect(response.status).toBe(400);
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});
