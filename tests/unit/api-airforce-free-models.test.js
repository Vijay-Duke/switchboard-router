import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), ssrf: vi.fn(async () => {}) }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: mocks.ssrf }));
import airforce from "open-sse/providers/registry/api-airforce.js";
import { clearProviderModelCache, resolveProviderModels } from "open-sse/services/providerModels.js";
import { GET } from "@/app/api/providers/suggested-models/route.js";
const models = [
  { id: "gpt-oss-120b", tier: "free", supports_chat: true, context_length: 131072 },
  { id: "chat:free", supports_chat: true },
  { id: "paid", tier: "paid", supports_chat: true },
  { id: "media:free", supports_chat: true, media_type: "image" },
  { id: "nochat", tier: "free", supports_chat: false },
];
afterEach(() => { vi.clearAllMocks(); clearProviderModelCache(); });
describe("Airforce free catalog", () => {
  it("exposes current static models and required stream transport", () => {
    expect(airforce.models.map(m => m.id)).toEqual(["gpt-oss-120b", "gpt-oss-20b", "kimi-k2.7-code"]);
    expect(airforce.transport).toMatchObject({ identity: "openai-node", forceStream: true });
    expect(airforce.passthroughModels).toBe(true);
  });
  it("filters authenticated live discovery to free chat models with proxy identity", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ data: models }));
    const result = await resolveProviderModels({ provider: "api-airforce", apiKey: "test-key" });
    expect(result.models.map(m => m.id)).toEqual(["chat:free", "gpt-oss-120b"]);
    expect(mocks.fetch).toHaveBeenCalledWith(airforce.modelsFetcher.url, expect.objectContaining({
      provider: "api-airforce", identity: "openai-node", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }), undefined);
  });
  it("uses the same filter for public suggestions, with SSRF and redirect guards", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ data: models }));
    const params = new URLSearchParams(airforce.modelsFetcher);
    const response = await GET(new Request(`http://localhost/api/providers/suggested-models?${params}`));
    expect(response.status).toBe(200);
    expect((await response.json()).data.map(m => m.id)).toEqual(["chat:free", "gpt-oss-120b"]);
    expect(mocks.ssrf).toHaveBeenCalledWith(airforce.modelsFetcher.url);
    expect(mocks.fetch).toHaveBeenCalledWith(airforce.modelsFetcher.url, expect.objectContaining({ provider: "api-airforce", redirect: "error" }));
  });
  it("rejects arbitrary URLs before fetching", async () => {
    const response = await GET(new Request("http://localhost/api/providers/suggested-models?url=http://127.0.0.1/secret&type=airforce-free"));
    expect(response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
