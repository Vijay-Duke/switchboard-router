import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  hasValidCliToken: vi.fn(),
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

vi.mock("@/shared/utils/cliToken.js", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
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
    mocks.hasValidCliToken.mockImplementation(async (request) => (
      request.headers.get("x-switchboard-cli-token") === "cli-token"
    ));
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
    delete process.env.SWITCHBOARD_LOCAL_PEERS;
    process.env.HOSTNAME = "127.0.0.1"; // default: loopback bind (npm scripts)
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
      "x-switchboard-real-ip": "10.204.111.34",
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
      "x-switchboard-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required");
  });

  it("ignores spoofed x-switchboard-real-ip when custom-server trust flag is unset (H1)", async () => {
    // Without SWITCHBOARD_TRUST_REAL_IP, spoofed loopback IP must not grant local access
    const response = await proxy(request("/api/settings", {
      host: "192.168.1.10:20128",
      "x-switchboard-real-ip": "127.0.0.1",
    }));
    expect(response.status).toBe(403);
  });

  it("rejects Host: localhost on a wildcard bind with no socket proof (P0)", async () => {
    // A remote client controls Host. On HOSTNAME=0.0.0.0 without custom-server.js
    // there is no socket-derived IP, so locality cannot be established: fail closed.
    process.env.HOSTNAME = "0.0.0.0";
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only");
  });

  it("allows loopback dashboard on a wildcard bind behind custom-server", async () => {
    // custom-server.js sets the trust flag and rewrites the IP from the TCP socket.
    process.env.HOSTNAME = "0.0.0.0";
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
      "x-switchboard-real-ip": "127.0.0.1",
    }));
    expect(response).toBe(mocks.nextResponse);
  });

  it("fails closed when trust flag is set but the real-ip header is missing", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/settings", { host: "localhost:20128" }));
    expect(response.status).toBe(403);
  });

  it("still rejects LAN Host on wildcard bind without CLI token", async () => {
    process.env.HOSTNAME = "0.0.0.0";
    const response = await proxy(request("/api/settings", {
      host: "192.168.1.10:20128",
    }));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only");
  });

  it("treats an allowlisted socket peer as local (Docker bridge gateway)", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    process.env.SWITCHBOARD_LOCAL_PEERS = "172.17.0.0/16";
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
      "x-switchboard-real-ip": "172.17.0.1",
    }));
    expect(response).toBe(mocks.nextResponse);
  });

  it("does not extend the allowlist beyond its mask", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    process.env.SWITCHBOARD_LOCAL_PEERS = "172.17.0.0/16";
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      "x-switchboard-real-ip": "172.18.0.1",
    }));
    expect(response.status).toBe(403);
  });

  it("never applies the allowlist to a client header without the trust flag", async () => {
    process.env.HOSTNAME = "0.0.0.0";
    process.env.SWITCHBOARD_LOCAL_PEERS = "172.17.0.0/16";
    const response = await proxy(request("/api/settings", {
      host: "localhost:20128",
      "x-switchboard-real-ip": "172.17.0.1",
    }));
    expect(response.status).toBe(403);
  });

  it("matches allowlist entries by mask, not by string prefix", () => {
    process.env.SWITCHBOARD_LOCAL_PEERS = "10.1.2.0/24,192.168.5.7";
    expect(__test__.isTrustedPeer("10.1.2.255")).toBe(true);
    expect(__test__.isTrustedPeer("10.1.20.1")).toBe(false); // prefix-match trap
    expect(__test__.isTrustedPeer("192.168.5.7")).toBe(true);
    expect(__test__.isTrustedPeer("192.168.5.70")).toBe(false);
    expect(__test__.isTrustedPeer("127.0.0.1")).toBe(true); // loopback always
  });

  it("accepts IPv6 loopback in every Host/real-ip spelling", () => {
    for (const h of ["::1", "[::1]", "[::1]:20128", "::ffff:127.0.0.1", "127.0.0.1:20128", "localhost"]) {
      expect(__test__.isLoopbackHostname(h), h).toBe(true);
    }
    for (const h of ["", null, "[::1", "192.168.1.10:20128", "evil.example", "127.0.0.1.evil.com"]) {
      expect(__test__.isLoopbackHostname(h), String(h)).toBe(false);
    }
  });

  it("allows loopback peer IP when trust flag is set", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost:20128",
      "x-switchboard-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a hostile Host from a loopback peer (DNS rebinding)", async () => {
    // The socket says local, but the browser was lured to evil.example → 127.0.0.1.
    // Host validation must apply in the trusted-real-ip branch too.
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/settings", {
      host: "evil.example",
      "x-switchboard-real-ip": "127.0.0.1",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only");
  });

  it("rejects a hostile Host on a loopback bind (DNS rebinding)", async () => {
    process.env.HOSTNAME = "127.0.0.1";
    const response = await proxy(request("/api/settings", { host: "evil.example" }));
    expect(response.status).toBe(403);
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
    mocks.hasValidCliToken.mockImplementation(async (request) => (
      request.headers.get("x-switchboard-cli-token") === "cli-token"
    ));
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
    delete process.env.SWITCHBOARD_LOCAL_PEERS;
    process.env.HOSTNAME = "127.0.0.1"; // default: loopback bind (npm scripts)
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
      "x-switchboard-via-proxy": "1",
      "x-switchboard-real-ip": "127.0.0.1",
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
      "x-switchboard-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects non-public /api/* from LAN without CLI token", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const response = await proxy(request("/api/settings", {
      host: "192.168.1.10:20128",
      "x-switchboard-real-ip": "192.168.1.20",
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
