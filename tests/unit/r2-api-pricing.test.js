import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPricing: vi.fn(),
  updatePricing: vi.fn(),
  resetPricing: vi.fn(),
  resetAllPricing: vi.fn(),
  getDefaultPricing: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getPricing: mocks.getPricing,
  updatePricing: mocks.updatePricing,
  resetPricing: mocks.resetPricing,
  resetAllPricing: mocks.resetAllPricing,
}));
vi.mock("open-sse/providers/pricing.js", () => ({ getDefaultPricing: mocks.getDefaultPricing }));

const pricingRoute = await import("../../src/app/api/pricing/route.js");
const defaultsRoute = await import("../../src/app/api/pricing/defaults/route.js");

describe("DELETE /api/pricing model-only guard (A13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPricing.mockResolvedValue({ openai: {} });
  });

  it("returns 400 and leaves pricing intact when model is set without provider", async () => {
    const res = await pricingRoute.DELETE(
      new Request("http://localhost:20128/api/pricing?model=gpt-4"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "provider is required when model is set" });
    expect(mocks.resetAllPricing).not.toHaveBeenCalled();
    expect(mocks.resetPricing).not.toHaveBeenCalled();
  });

  it("still resets a single model when both params are present", async () => {
    const res = await pricingRoute.DELETE(
      new Request("http://localhost:20128/api/pricing?provider=openai&model=gpt-4"),
    );
    expect(res.status).toBe(200);
    expect(mocks.resetPricing).toHaveBeenCalledWith("openai", "gpt-4");
    expect(mocks.resetAllPricing).not.toHaveBeenCalled();
  });

  it("still resets everything when neither param is present", async () => {
    const res = await pricingRoute.DELETE(new Request("http://localhost:20128/api/pricing"));
    expect(res.status).toBe(200);
    expect(mocks.resetAllPricing).toHaveBeenCalled();
  });
});

describe("GET /api/pricing/defaults (A14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves the default table from its own route", async () => {
    mocks.getDefaultPricing.mockReturnValue({ openai: { "gpt-4": { input: 1 } } });
    const res = await defaultsRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openai: { "gpt-4": { input: 1 } } });
  });

  it("pricing/route.js no longer exports the dead GET_DEFAULTS handler", () => {
    expect("GET_DEFAULTS" in pricingRoute).toBe(false);
  });
});
