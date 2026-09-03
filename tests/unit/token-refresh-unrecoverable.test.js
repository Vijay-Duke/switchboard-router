/**
 * T11: permanent OAuth refresh failures (e.g. revoked `invalid_grant`
 * refresh token) must be classified as unrecoverable for every provider —
 * not just codex — so dead connections stop being retried on every request
 * and can be surfaced for re-auth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshQwenToken,
  refreshIflowToken,
  refreshGitHubToken,
  refreshWithRetry,
  isUnrecoverableRefreshError,
  classifyOAuthRefreshError,
} from "../../open-sse/services/tokenRefresh.js";
import {
  REAUTH_REQUIRED_STATUS,
  filterAvailableAccounts,
} from "../../open-sse/services/accountFallback.js";

function invalidGrantResponse() {
  return {
    ok: false,
    status: 400,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked",
        })
      ),
  };
}

function transientResponse() {
  return {
    ok: false,
    status: 500,
    text: () =>
      Promise.resolve(JSON.stringify({ error: "temporarily_unavailable" })),
  };
}

describe("token-refresh unrecoverable classification (T11)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("claude: 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshClaudeOAuthToken("rt-claude-dead", null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("google (gemini-cli/antigravity): 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshGoogleToken(
      "rt-google-dead",
      "test-client-id",
      "test-client-secret",
      null
    );
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("qwen: 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshQwenToken("rt-qwen-dead", null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("iflow: 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshIflowToken("rt-iflow-dead", null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("github: 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshGitHubToken("rt-github-dead", null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("generic: 400 invalid_grant returns the unrecoverable shape", async () => {
    fetchMock.mockResolvedValue(invalidGrantResponse());
    const result = await refreshAccessToken("grok-cli", "rt-generic-dead", {}, null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("transient failures still return null (retryable)", async () => {
    fetchMock.mockResolvedValue(transientResponse());
    const result = await refreshClaudeOAuthToken("rt-claude-flaky", null);
    expect(result).toBeNull();
  });

  it("success path is unchanged (tokens returned, no error marker)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
    });
    const result = await refreshClaudeOAuthToken("rt-claude-good", null);
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(isUnrecoverableRefreshError(result)).toBe(false);
  });

  it("classifyOAuthRefreshError flags invalid_grant as permanent", async () => {
    const failure = classifyOAuthRefreshError(
      JSON.stringify({ error: "invalid_grant" }),
      400
    );
    expect(failure.permanent).toBe(true);
    expect(failure.code).toBe("invalid_grant");
  });

  it("classifyOAuthRefreshError covers real provider bodies", () => {
    const perm = (body, status = 400) => classifyOAuthRefreshError(body, status).permanent;
    // Google: invalid_grant + "Token has been expired or revoked."
    expect(perm(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }))).toBe(true);
    // Anthropic-style nested error object
    const nested = classifyOAuthRefreshError(JSON.stringify({ error: { type: "invalid_grant", message: "Refresh token not found" } }), 400);
    expect(nested.permanent).toBe(true);
    expect(nested.code).toBe("invalid_grant");
    // GitHub
    expect(perm(JSON.stringify({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }), 200)).toBe(true);
    // Config errors and expired *access* tokens are not a revoked refresh token
    expect(perm(JSON.stringify({ error: "invalid_client" }), 401)).toBe(false);
    expect(perm(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "token expired" } }), 401)).toBe(false);
    // 5xx is transient whatever the body says
    expect(perm(JSON.stringify({ error: "invalid_grant" }), 502)).toBe(false);
    expect(perm("<html>Bad Gateway</html>", 502)).toBe(false);
  });

  it("github: HTTP 200 with bad_refresh_token body is unrecoverable", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }),
    });
    const result = await refreshGitHubToken("rt-github-200-dead", null);
    expect(result).toEqual({ error: "unrecoverable_refresh_error", code: "bad_refresh_token" });
  });

  it("github: HTTP 200 without access_token and without a permanent code is a transient null", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ error: "incorrect_client_credentials" }),
    });
    expect(await refreshGitHubToken("rt-github-200-odd", null)).toBeNull();
  });

  it("refreshWithRetry calls the fn exactly once on unrecoverable result", async () => {
    const fn = vi.fn().mockResolvedValue({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    const result = await refreshWithRetry(fn, 3, null);
    expect(result).toEqual({
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refreshWithRetry still retries transient null results", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const result = await refreshWithRetry(fn, 2, null);
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("filterAvailableAccounts skips reauth_required connections", async () => {
    const accounts = [
      { id: "dead", testStatus: REAUTH_REQUIRED_STATUS },
      { id: "live", testStatus: "active" },
    ];
    expect(filterAvailableAccounts(accounts).map((a) => a.id)).toEqual(["live"]);
    expect(REAUTH_REQUIRED_STATUS).toBe("reauth_required");
  });
});
