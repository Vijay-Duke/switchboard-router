import { beforeEach, describe, expect, it, vi } from "vitest";

// Ported from upstream e10da160. Switchboard persists through the
// settleUsageStats seam (canonicalised tokens, client-key-aware) instead of
// writing @/lib/usageDb directly, so that is what the test observes.
const mocks = vi.hoisted(() => ({
  handleImageGenerationCore: vi.fn(),
  settleUsageStats: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({
    accessToken: "provider-token",
    connectionId: "connection-a",
    connectionName: "Codex A",
  }),
  markAccountUnavailable: vi.fn(),
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => "client-key",
}));
vi.mock("@/lib/db/index.js", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: "client-key-id", lease: null }),
  runWithClientKeyLease: async (_lease, work) => work(),
}));
vi.mock("../../src/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: async (_meta, work) => work(),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "codex", model: "gpt-6-sol-image" }),
  getComboModels: async () => null,
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.handleImageGenerationCore,
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  settleUsageStats: mocks.settleUsageStats,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("../../open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));

import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

const request = () => new Request("http://localhost/v1/images/generations", {
  method: "POST",
  headers: { Authorization: "Bearer client-key" },
  body: JSON.stringify({ model: "cx/gpt-6-sol-image", prompt: "draw a cat" }),
});

describe("Codex image usage persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settleUsageStats.mockResolvedValue(undefined);
    mocks.clearAccountError.mockResolvedValue(undefined);
  });

  it("persists exact provider-reported input/output tokens", async () => {
    const tokens = { prompt_tokens: 321, completion_tokens: 654, total_tokens: 975, cached_tokens: 111, reasoning_tokens: 22 };
    mocks.handleImageGenerationCore.mockImplementation(async ({ onUsage, onRequestSuccess }) => {
      await onUsage?.(tokens);
      await onRequestSuccess?.();
      return { success: true, response: Response.json({ data: [{ b64_json: "image" }] }) };
    });

    await handleImageGeneration(request());

    expect(mocks.settleUsageStats).toHaveBeenCalledTimes(1);
    expect(mocks.settleUsageStats).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-6-sol-image",
      connectionId: "connection-a",
      clientKeyId: "client-key-id",
      endpoint: "/v1/images/generations",
      tokens,
      label: "IMAGE USAGE",
    });
  });

  it("does not persist fabricated usage when upstream usage is absent", async () => {
    mocks.handleImageGenerationCore.mockImplementation(async ({ onUsage, onRequestSuccess }) => {
      await onUsage?.({ prompt_tokens: "n/a" });
      await onRequestSuccess?.();
      return { success: true, response: Response.json({ data: [{ b64_json: "image" }] }) };
    });

    await handleImageGeneration(request());

    expect(mocks.settleUsageStats).not.toHaveBeenCalled();
  });
});
