// Zed IDE auto-import + import routes (7a436d20 adaptation):
//   GET  /api/oauth/zed/auto-import → readZedIdeCredentials passthrough (zed-only)
//   POST /api/oauth/zed/import      → validate the pair upstream, save connection
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status || 200,
        headers: { "Content-Type": "application/json" },
      })),
  },
}));

const { readCredsMock, createConnectionMock, fetchUserMock } = vi.hoisted(() => ({
  readCredsMock: vi.fn(),
  createConnectionMock: vi.fn(),
  fetchUserMock: vi.fn(),
}));

vi.mock("@/lib/oauth/zedCredentials", () => ({
  readZedIdeCredentials: (...args) => readCredsMock(...args),
}));

vi.mock("@/models", () => ({
  createProviderConnection: (...args) => createConnectionMock(...args),
  getProviderConnections: vi.fn(async () => []),
}));

vi.mock("open-sse/shared/zedAuth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchZedAuthenticatedUser: fetchUserMock };
});

import { GET, POST } from "@/app/api/oauth/[provider]/[action]/route.js";

beforeEach(() => {
  readCredsMock.mockReset();
  createConnectionMock.mockReset();
  fetchUserMock.mockReset();
});

describe("GET auto-import", () => {
  it("is zed-only", async () => {
    const res = await GET(
      new Request("http://localhost/api/oauth/codex/auto-import"),
      { params: Promise.resolve({ provider: "codex", action: "auto-import" }) },
    );
    expect(res.status).toBe(400);
    expect(readCredsMock).not.toHaveBeenCalled();
  });

  it("returns the detected IDE session to the local caller", async () => {
    readCredsMock.mockResolvedValue({
      found: true,
      userId: "u-42",
      accessToken: "ide-access-token",
      systemId: "sys-42",
      credentialsUrl: "https://zed.dev",
    });
    const res = await GET(
      new Request("http://localhost/api/oauth/zed/auto-import"),
      { params: Promise.resolve({ provider: "zed", action: "auto-import" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.found).toBe(true);
    expect(data.userId).toBe("u-42");
    expect(data.accessToken).toBe("ide-access-token");
    expect(data.systemId).toBe("sys-42");
  });

  it("returns not-found diagnostics without failing", async () => {
    readCredsMock.mockResolvedValue({
      found: false,
      error: "Zed IDE session not found in the system keyring. Sign in to Zed, then retry.",
      credentialsUrl: "https://zed.dev",
    });
    const res = await GET(
      new Request("http://localhost/api/oauth/zed/auto-import"),
      { params: Promise.resolve({ provider: "zed", action: "auto-import" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.found).toBe(false);
    expect(data.error).toMatch(/Sign in to Zed/);
  });
});

describe("POST import", () => {
  const importReq = (body) =>
    new Request("http://localhost/api/oauth/zed/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const importParams = { params: Promise.resolve({ provider: "zed", action: "import" }) };

  it("is zed-only", async () => {
    const res = await POST(importReq({ accessToken: "t", userId: "u" }), {
      params: Promise.resolve({ provider: "codex", action: "import" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires accessToken + userId", async () => {
    const res = await POST(importReq({ accessToken: "only-token" }), importParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/accessToken and userId/);
  });

  it("rejects an invalid IDE session with 400", async () => {
    fetchUserMock.mockRejectedValue(new Error("401 Unauthorized"));
    const res = await POST(
      importReq({ accessToken: "stale", userId: "u-1", systemId: "sys-1" }),
      importParams,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not valid: 401/);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("validates upstream and saves the connection with identity fields", async () => {
    fetchUserMock.mockResolvedValue({
      email: "dev@example.com",
      name: "Dev Zed",
      default_organization_id: "org-9",
    });
    createConnectionMock.mockResolvedValue({
      id: "conn-import-1",
      provider: "zed",
      email: "dev@example.com",
    });

    const res = await POST(
      importReq({ accessToken: "ide-token", userId: "u-9", systemId: "sys-9" }),
      importParams,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.connection.id).toBe("conn-import-1");

    // The validated pair rode the "<userId> <token>" header upstream.
    const [credentialsArg] = fetchUserMock.mock.calls[0];
    expect(credentialsArg.accessToken).toBe("ide-token");
    expect(credentialsArg.providerSpecificData.userId).toBe("u-9");
    expect(credentialsArg.providerSpecificData.systemId).toBe("sys-9");

    const saved = createConnectionMock.mock.calls[0][0];
    expect(saved.provider).toBe("zed");
    expect(saved.authType).toBe("oauth");
    expect(saved.accessToken).toBe("ide-token");
    expect(saved.email).toBe("dev@example.com");
    expect(saved.providerSpecificData).toEqual({
      authMethod: "oauth",
      userId: "u-9",
      systemId: "sys-9",
      organizationId: "org-9",
    });
    expect(saved.testStatus).toBe("active");
  });
});
