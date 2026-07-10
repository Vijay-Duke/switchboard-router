import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { gateRequireApiKey } from "../../src/sse/utils/requireApiKeyGate.js";

const originalHostname = process.env.HOSTNAME;

function requestWithHeaders(headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return { headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null } };
}

function makeDeps(overrides = {}) {
  return {
    isValidApiKey: vi.fn(async () => false),
    log: { warn: vi.fn() },
    errorResponse: (status, message) => ({ status, body: { error: message } }),
    HTTP_STATUS: { UNAUTHORIZED: 401 },
    request: { headers: { get: () => null } },
    hasValidCliToken: vi.fn(async () => false),
    ...overrides,
  };
}

describe("gateRequireApiKey", () => {
  beforeEach(() => {
    process.env.HOSTNAME = "0.0.0.0";
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
    delete process.env.SWITCHBOARD_TRUST_REAL_IP;
  });

  it("allows when requireApiKey is off", async () => {
    const deps = makeDeps();
    const denied = await gateRequireApiKey({ requireApiKey: false }, null, deps);
    expect(denied).toBeNull();
    expect(deps.isValidApiKey).not.toHaveBeenCalled();
  });

  it("rejects missing API key when required", async () => {
    const deps = makeDeps();
    const denied = await gateRequireApiKey({ requireApiKey: true }, null, deps);
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe("Missing API key");
  });

  it("allows valid CLI token without dashboard API key (model probes)", async () => {
    const deps = makeDeps({
      hasValidCliToken: vi.fn(async () => true),
    });
    const denied = await gateRequireApiKey({ requireApiKey: true }, null, deps);
    expect(denied).toBeNull();
    expect(deps.isValidApiKey).not.toHaveBeenCalled();
    expect(deps.hasValidCliToken).toHaveBeenCalled();
  });

  it("allows a verified loopback request without a persisted API key", async () => {
    process.env.HOSTNAME = "127.0.0.1";
    const deps = makeDeps({
      request: requestWithHeaders({ host: "127.0.0.1:20128" }),
    });

    const denied = await gateRequireApiKey({ requireApiKey: true }, "sk_switchboard", deps);

    expect(denied).toBeNull();
    expect(deps.isValidApiKey).not.toHaveBeenCalled();
    expect(deps.hasValidCliToken).not.toHaveBeenCalled();
  });

  it("does not treat a proxied request as local", async () => {
    process.env.SWITCHBOARD_TRUST_REAL_IP = "1";
    const deps = makeDeps({
      request: requestWithHeaders({
        host: "127.0.0.1:20128",
        "x-switchboard-real-ip": "127.0.0.1",
        "x-switchboard-via-proxy": "1",
      }),
    });

    const denied = await gateRequireApiKey({ requireApiKey: true }, "sk_switchboard", deps);

    expect(denied.status).toBe(401);
    expect(deps.isValidApiKey).toHaveBeenCalledWith("sk_switchboard");
  });

  it("accepts a valid dashboard API key", async () => {
    const deps = makeDeps({
      isValidApiKey: vi.fn(async () => true),
    });
    const denied = await gateRequireApiKey({ requireApiKey: true }, "sk_test", deps);
    expect(denied).toBeNull();
  });
});
