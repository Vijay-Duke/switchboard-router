// H46 — embeddings input validation and local caps.
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn().mockResolvedValue(null) }));
vi.mock("../../open-sse/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn().mockResolvedValue(undefined) }));

import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";

const ok = () => Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }], model: "m", usage: {} });
const run = (input) => handleEmbeddingsCore({
  body: { model: "text-embedding-3-small", input },
  modelInfo: { provider: "openai", model: "text-embedding-3-small" },
  credentials: { apiKey: "k" },
  log: null,
});

beforeEach(() => { proxyAwareFetch.mockReset(); });

describe("embeddings validation (H46)", () => {
  it.each([
    ["empty array", []],
    ["non-string item", [123]],
    ["empty item", ["ok", ""]],
    ["whitespace string", "   "],
    ["null", null],
    ["object", { text: "x" }],
  ])("%s → 400 without calling upstream", async (_label, input) => {
    const result = await run(input);
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("batch over 256 items → 400", async () => {
    const result = await run(Array.from({ length: 257 }, (_, i) => `item ${i}`));
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toMatch(/1-256/);
  });

  it("total chars over 1M → 400", async () => {
    const result = await run("x".repeat(1024 * 1024 + 1));
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toMatch(/exceeds/);
  });

  it("valid string and array inputs reach the provider", async () => {
    proxyAwareFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    expect((await run("hello")).success).toBe(true);
    expect((await run(["a", "b"])).success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });
});
