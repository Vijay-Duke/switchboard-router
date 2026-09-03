import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
const { getProviderCredentials } = vi.hoisted(() => ({ getProviderCredentials: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials }));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials }));

import { POST, estimateAnthropicInputTokens } from "../../src/app/api/v1/messages/count_tokens/route.js";

function post(body, headers = {}) {
  return POST(new Request("https://switchboard.local/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  getProviderCredentials.mockReset();
});

describe("count_tokens upstream proxy", () => {
  it("forwards claude-provider bodies with the claude-cli identity and returns upstream input_tokens", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ input_tokens: 42 }),
    });
    getProviderCredentials.mockResolvedValue({
      accessToken: "sk-ant-oauth-token",
      connectionName: "claude-conn",
    });

    const response = await post(
      {
        model: "claude/claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello world" }],
      },
      { "user-agent": "claude-cli/2.1.0 (external, cli)", "anthropic-beta": "claude-code-20250219" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ input_tokens: 42 });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(options).toMatchObject({
      method: "POST",
      identity: "claude-cli",
      provider: "claude",
      format: "claude",
    });
    expect(options.headers["Authorization"]).toBe("Bearer sk-ant-oauth-token");
    // Provider-prefixed model is stripped to the bare upstream id.
    expect(JSON.parse(options.body).model).toBe("claude-sonnet-4-20250514");
    // Real client identity headers ride along as the wrap overlay.
    expect(options.overlay).toMatchObject({ "anthropic-beta": "claude-code-20250219" });
    // Same per-model beta set the chat path sends.
    expect(options.headers["Anthropic-Beta"]).toEqual(expect.stringContaining("oauth-2025-04-20"));
    // Upstream call is bounded so a hung provider cannot stall Claude Code.
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the estimator on an upstream 401 instead of surfacing the auth error", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) });
    getProviderCredentials.mockResolvedValue({ accessToken: "expired" });

    const response = await post({
      model: "claude/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ input_tokens: 3 });
  });

  it("answers non-claude providers from the estimator without an upstream call", async () => {
    getProviderCredentials.mockResolvedValue({ accessToken: "tok" });

    const response = await post({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ input_tokens: 3 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("falls back to the estimator when upstream fails", async () => {
    proxyAwareFetch.mockRejectedValue(new Error("upstream down"));
    getProviderCredentials.mockResolvedValue({ accessToken: "tok" });

    const response = await post({
      model: "anthropic/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ input_tokens: 3 });
  });

  it("falls back to the estimator when there are no credentials", async () => {
    getProviderCredentials.mockResolvedValue(null);

    const response = await post({
      model: "claude/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ input_tokens: 3 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("count_tokens estimator image cap", () => {
  it("counts an image block as a flat estimate instead of base64 length/4", () => {
    const tokens = estimateAnthropicInputTokens({
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) },
        }],
      }],
    });
    expect(tokens).toBe(400);
  });
});
