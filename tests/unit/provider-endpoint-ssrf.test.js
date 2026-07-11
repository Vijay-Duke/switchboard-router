import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn().mockResolvedValue({
  status: 200,
  headers: { get: () => "" },
  body: { cancel: vi.fn() },
});
const assertPublicUrlResolved = vi.fn(async (url) => {
  if (url.includes("169.254.169.254")) throw new Error("private IP");
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
vi.mock("../../open-sse/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved,
}));

const { AzureExecutor } = await import("../../open-sse/executors/azure.js");
const { QwenExecutor } = await import("../../open-sse/executors/qwen.js");

describe("provider-specific executor endpoints", () => {
  it("blocks an Azure endpoint before making a request", async () => {
    const executor = new AzureExecutor();

    await expect(executor.execute({
      model: "gpt-4o",
      body: {},
      stream: false,
      credentials: { apiKey: "secret", providerSpecificData: { azureEndpoint: "http://169.254.169.254" } },
    })).rejects.toThrow(/SSRF blocked/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a Qwen resource URL before making a request", async () => {
    const executor = new QwenExecutor();

    await expect(executor.execute({
      model: "qwen-coder",
      body: {},
      stream: false,
      credentials: { accessToken: "secret", providerSpecificData: { resourceUrl: "http://169.254.169.254" } },
    })).rejects.toThrow(/SSRF blocked/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
