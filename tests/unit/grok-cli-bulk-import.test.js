import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
import { createProviderConnection } from "@/models";
import { POST } from "../../src/app/api/oauth/grok-cli/bulk-import/route.js";
const request = (body) => new Request("http://localhost/api/oauth/grok-cli/bulk-import", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); createProviderConnection.mockImplementation(async (row) => ({ ...row, id: "saved" })); });

describe("Grok CLI bulk import", () => {
  it("imports mixed token formats, isolates invalid accounts and returns no secrets", async () => {
    const response = await POST(request({ accounts: [
      { access_token: "access-1", refresh_token: "refresh-1", email: "a@example.com", expires_in: 3600 },
      { refresh_token: "missing-access" },
      { accessToken: "access-2", refreshToken: "refresh-2", email: "b@example.com" },
    ] }));
    const data = await response.json();
    expect(data).toMatchObject({ total: 3, success: 2, failed: 1 });
    expect(createProviderConnection).toHaveBeenCalledTimes(2);
    expect(createProviderConnection.mock.calls[0][0]).toMatchObject({ provider: "grok-cli", authType: "oauth", accessToken: "access-1", refreshToken: "refresh-1" });
    expect(new Date(createProviderConnection.mock.calls[0][0].expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(data)).not.toMatch(/access-1|refresh-1|access-2|refresh-2/);
  });

  it("rejects empty or non-JSON imports", async () => {
    expect((await POST(request([]))).status).toBe(400);
    expect((await POST(new Request("http://localhost", { method: "POST", body: "bad JSON" }))).status).toBe(400);
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});
