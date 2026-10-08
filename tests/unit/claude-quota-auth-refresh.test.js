import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), updateProviderConnectionCredentialsIfCurrent: vi.fn(), getExecutor: vi.fn(), resolveConnectionProxyConfig: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnectionById: mocks.getProviderConnectionById, updateProviderConnectionCredentialsIfCurrent: mocks.updateProviderConnectionCredentialsIfCurrent }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: mocks.getExecutor }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { GET } from "../../src/app/api/usage/[connectionId]/route.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ id: "auth-refresh-account", provider: "claude", authType: "oauth", accessToken: "old-access", refreshToken: "existing-refresh" });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.updateProviderConnectionCredentialsIfCurrent.mockImplementation(async (id, expected, patch) => ({ ...expected, ...patch }));
});

describe("Claude quota route OAuth refresh", () => {
  it("refreshes once after a genuine subscription401 and returns actual quota windows", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: "new-access", expiresIn: 28800 }));
    mocks.getExecutor.mockReturnValue({ needsRefresh: () => false, refreshCredentials });
    proxyAwareFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ five_hour: { utilization: 42, resets_at: "2026-10-08T08:00:00Z" } }));
    const response = await GET(new Request("http://localhost/api/usage/auth-refresh-account"), { params: Promise.resolve({ connectionId: "auth-refresh-account" }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.quotas["session (5h)"].used).toBe(42);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.updateProviderConnectionCredentialsIfCurrent).toHaveBeenCalledWith("auth-refresh-account", expect.objectContaining({ accessToken: "old-access" }), expect.objectContaining({ accessToken: "new-access" }));
    expect(proxyAwareFetch.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(proxyAwareFetch.mock.calls.every(([url]) => url.endsWith("/api/oauth/usage"))).toBe(true);
  });
});
