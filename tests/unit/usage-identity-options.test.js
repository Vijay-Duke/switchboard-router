import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getClaudeUsage } from "../../open-sse/services/usage/claude.js";
import {
  consumeCodexRateLimitResetCredit,
  getCodexRateLimitResetCredits,
  getCodexUsage,
} from "../../open-sse/services/usage/codex.js";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const expectIdentity = (options, identity, provider, format) => {
  expect(options).toMatchObject({ identity, provider, format });
};

describe("usage request identities", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Claude CLI identity for OAuth and legacy usage calls", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({ organization_id: "org-1", plan: "Max" }))
      .mockResolvedValueOnce(jsonResponse({ requests: 1 }));

    await getClaudeUsage("claude-token", { enabled: true });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [, options, proxyOptions] of proxyAwareFetch.mock.calls) {
      expectIdentity(options, "claude-cli", "claude", "claude");
      expect(proxyOptions).toEqual({ enabled: true });
    }
  });

  it("uses Codex CLI identity for usage, reset lookup, and reset consumption", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ rate_limit: {} }))
      .mockResolvedValueOnce(jsonResponse({ available_count: 0, credits: [] }))
      .mockResolvedValueOnce(jsonResponse({ code: "no_credit", windows_reset: 0 }));

    await getCodexUsage("codex-token", { enabled: true });
    await getCodexRateLimitResetCredits("codex-token", { enabled: true });
    await consumeCodexRateLimitResetCredit("codex-token", "redeem-1", { enabled: true });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [, options, proxyOptions] of proxyAwareFetch.mock.calls) {
      expectIdentity(options, "codex-cli", "codex", "codex");
      expect(proxyOptions).toEqual({ enabled: true });
    }
  });
});
