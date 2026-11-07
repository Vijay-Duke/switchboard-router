import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: Next.js loads route handlers and instrumentation (background
// refresh, quota auto-ping) as separate module graphs in one process. With
// module-level locks each graph refreshed the same single-use Claude refresh
// token on its own; Anthropic saw the replay and revoked the whole login
// ("OAuth access token has expired" every few days until the account was
// re-added). Two fresh module instances stand in for the two bundles here.

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function singleUseTokenServer() {
  const seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mocks.fetch.mockImplementation(async (url, options) => {
    if (!String(url).includes("/oauth/token")) return json({}, 404);
    const token = JSON.parse(options.body).refresh_token;
    seen.push(token);
    if (seen.filter(t => t === token).length > 1) {
      return json({ error: "invalid_grant", error_description: "Refresh token already used" }, 400);
    }
    await gate;
    return json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 28800 });
  });
  return { seen, release };
}

async function loadSeparateBundle() {
  vi.resetModules();
  return import("../../open-sse/services/oauthCredentialManager.js");
}

const credentials = () => ({
  connectionId: "claude-account", provider: "claude", authType: "oauth",
  accessToken: "old-access", refreshToken: "single-use-refresh",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

beforeEach(() => mocks.fetch.mockReset());

describe("OAuth refresh coordination across Next.js bundles", () => {
  it("spends a Claude refresh token once when route and background bundles refresh together", async () => {
    const server = singleUseTokenServer();
    const routeBundle = await loadSeparateBundle();
    const backgroundBundle = await loadSeparateBundle();
    expect(routeBundle).not.toBe(backgroundBundle);

    const chat = routeBundle.refreshProviderCredentials("claude", credentials(), log);
    const background = backgroundBundle.refreshProviderCredentials("claude", credentials(), log);
    await vi.waitFor(() => expect(server.seen.length).toBeGreaterThan(0));
    server.release();

    const results = await Promise.all([chat, background]);
    expect(server.seen).toEqual(["single-use-refresh"]);
    expect(results.map(r => r.refreshToken)).toEqual(["fresh-refresh", "fresh-refresh"]);
  });

  it("routes the Claude executor's 401 refresh through the shared lock", async () => {
    const server = singleUseTokenServer();
    const managerBundle = await loadSeparateBundle();
    vi.resetModules();
    const { getExecutor } = await import("../../open-sse/executors/index.js");

    const proactive = managerBundle.refreshProviderCredentials("claude", credentials(), log);
    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    const reactive = getExecutor("claude").refreshCredentials(credentials(), log);
    server.release();

    const [first, second] = await Promise.all([proactive, reactive]);
    expect(server.seen).toEqual(["single-use-refresh"]);
    expect(second.accessToken).toBe(first.accessToken);
    expect(second.expiresAt).toBeTruthy();
  });

  it("reports a reused Claude refresh token as unrecoverable instead of a silent null", async () => {
    mocks.fetch.mockResolvedValue(json({ error: "invalid_grant" }, 400));
    vi.resetModules();
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const result = await getExecutor("claude").refreshCredentials(credentials(), log);
    expect(result).toMatchObject({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
  });
});
