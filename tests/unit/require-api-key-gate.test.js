import { describe, it, expect, vi } from "vitest";
import { gateRequireApiKey } from "../../src/sse/utils/requireApiKeyGate.js";

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

  it("accepts a valid dashboard API key", async () => {
    const deps = makeDeps({
      isValidApiKey: vi.fn(async () => true),
    });
    const denied = await gateRequireApiKey({ requireApiKey: true }, "sk_test", deps);
    expect(denied).toBeNull();
  });
});
