// H43 — multipart Cloudflare models must refuse edit inputs instead of silently
// running text-to-image.
import { describe, it, expect, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));

import cloudflareAi from "../../open-sse/handlers/imageProviders/cloudflareAi.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const MODEL = "@cf/black-forest-labs/flux-2-dev";

describe("cloudflare multipart edit inputs", () => {
  it("adapter throws for image / mask on multipart models", async () => {
    await expect(cloudflareAi.buildBody(MODEL, { prompt: "p", image: "data:image/png;base64,AAAA" })).rejects.toThrow(/image editing is not supported/);
    await expect(cloudflareAi.buildBody(MODEL, { prompt: "p", mask: "data:image/png;base64,AAAA" })).rejects.toThrow(/image editing is not supported/);
    await expect(cloudflareAi.buildBody(MODEL, { prompt: "p", images: ["data:image/png;base64,AAAA"] })).rejects.toThrow(/image editing is not supported/);
  });

  it("plain text-to-image on multipart models still builds a FormData body", async () => {
    const form = await cloudflareAi.buildBody(MODEL, { prompt: "p", size: "512x512" });
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("prompt")).toBe("p");
  });

  it("surfaces as a 400 through the core, never reaching upstream", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "p", image: "data:image/png;base64,AAAA" },
      modelInfo: { provider: "cloudflare-ai", model: MODEL },
      credentials: { apiKey: "k", providerSpecificData: { accountId: "acc" } },
      log: null,
    });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toMatch(/image editing is not supported/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
