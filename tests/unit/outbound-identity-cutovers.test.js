import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getAntigravityUsage } from "../../open-sse/services/usage/google.js";
import { getGitHubUsage } from "../../open-sse/services/usage/github.js";
import { resolveCopilotModels, clearCopilotModelCache } from "../../open-sse/services/copilotModels.js";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("outbound identity cutovers", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearCopilotModelCache();
  });

  it("wraps raw Cursor headers without changing its Connect-ES identity", () => {
    const headers = new CursorExecutor().wrapOutboundHeaders({
      authorization: "Bearer cursor-token",
      "user-agent": "connect-es/1.6.1",
      "x-switchboard-debug": "switchboard",
    });

    expect(headers.authorization).toBe("Bearer cursor-token");
    const userAgent = Object.entries(headers).find(([name]) => name.toLowerCase() === "user-agent")?.[1];
    expect(userAgent).toBe("connect-es/1.6.1");
    expect(headers["x-switchboard-debug"]).toBeUndefined();
    expect(Object.entries(headers).some(([name, value]) => /switchboard/i.test(`${name}:${value}`))).toBe(false);
  });

  it("passes Antigravity identity on refresh and usage without x-request-source", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }))
      .mockResolvedValueOnce(jsonResponse({ models: {} }));

    await new AntigravityExecutor().refreshCredentials({ refreshToken: "refresh" });
    await getAntigravityUsage("access", {});

    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ identity: "antigravity", provider: "antigravity", format: "antigravity" });
      expect(Object.keys(options.headers || {}).map((key) => key.toLowerCase())).not.toContain("x-request-source");
    }
  });

  it("uses the Copilot identity for chat headers, token refresh, models, and usage", async () => {
    const executor = new GithubExecutor();
    const chatHeaders = executor.buildHeaders({ copilotToken: "copilot" }, false);
    expect(chatHeaders["user-agent"]).toBeUndefined();
    expect(chatHeaders["editor-version"]).toBeUndefined();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: "new-copilot", expires_at: 123 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-5", name: "GPT-5", capabilities: { type: "chat" }, policy: { state: "enabled" } }] }))
      .mockResolvedValueOnce(jsonResponse({ monthly_quotas: {}, limited_user_quotas: {} }));

    await executor.refreshCopilotToken("github-token");
    await resolveCopilotModels({ accessToken: "github-token", providerSpecificData: { copilotToken: "copilot" } });
    await getGitHubUsage("github-token", {});

    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ identity: "copilot", provider: "github", format: "openai" });
    }
  });
  it("passes provider identity through default OAuth refresh helpers", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: "new", refresh_token: "next", expires_in: 60 }));

    await new DefaultExecutor("qwen").refreshCredentials({ refreshToken: "refresh" });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.provider).toBe("qwen");
    expect(options.format).toBeDefined();
  });

});
