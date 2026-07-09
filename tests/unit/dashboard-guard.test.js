import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // C1 default: requireApiKey on
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
    delete process.env.HOSTNAME;
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows remote public LLM API when requireApiKey is off", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    const response = await proxy(request("/v1/chat/completions", {
      host: "router.example.com",
      "x-9r-real-ip": "10.204.111.34",
    }));
    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects remote LLM by default (requireApiKey true) with no key", async () => {
    const response = await proxy(request("/v1/chat/completions", {
      host: "router.example.com",
    }));
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required");
  });

  it("rejects remote Host-spoof when requireApiKey is on and no key", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required");
  });

  it("ignores spoofed x-9r-real-ip when custom-server trust flag is unset (H1)", async () => {
    // Without SWITCHBOARD_TRUST_REAL_IP, spoofed loopback IP must not grant local access
    const response = await proxy(request("/api/settings", {
      host: "192.168.1.10:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));
    expect(response.status).toBe(403);
  });

  it("rejects Host-header loopback claim on a public bind with no trust flag (H1)", async () => {
    // Bare `next start` on 0.0.0.0: nothing derived the peer from the socket,
    // so a `Host: localhost` header proves nothing.
    process.env.HOSTNAME = "0.0.0.0";
    const response = await proxy(request("/api/settings", { host: "localhost:20128" }));
    expect(response.status).toBe(403);
  });

  it("allows loopback peer IP when trust flag is set", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/v1/chat/completions", {
      host: "router.example.com",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote LLM without key when requireApiKey is true", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required");
  });

  it("allows remote public LLM API with valid bearer API key when required", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key when required", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta with Google API key header when required", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("rejects API key in query string (M9 — headers only)", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
    delete process.env.HOSTNAME;
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only");
  });

  it("allows local-only route on loopback", async () => {
    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "tunnel.example.com",
      "x-9r-via-proxy": "1",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    const response = await proxy(request("/api/routing/learn", {
      host: "localhost:20128",
      origin: "https://evil.example",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects non-public /api/* from LAN without CLI token", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/settings", {
      host: "192.168.1.10:20128",
      "x-9r-real-ip": "192.168.1.20",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only");
  });

  it("allows non-public /api/* on loopback", async () => {
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("extracts bearer API keys before x-api-key", () => {
    const req = request("/v1/x", {
      authorization: "Bearer first",
      "x-api-key": "second",
    });
    expect(__test__.extractApiKey(req)).toBe("first");
  });

  it("extracts Google API keys after x-api-key", () => {
    const req = request("/v1/x", {
      "x-goog-api-key": "google-key",
    });
    expect(__test__.extractApiKey(req)).toBe("google-key");
  });
});
